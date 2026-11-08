package main

// 2026-11-08 P1：同一条 Pion PeerConnection 里送音频（Opus），时间戳用同一时钟。
// 编码器用 syscall 直接调 opus.dll（libopus 1.3，BSD 许可；无需 cgo/gcc）。
// 协议（screen-server -> 侧车 TCP）："PAAU" + uint64 LE tsMicros + uint32 LE pcmBytes + PCM(s16le 48k stereo)
//
// 2026-11-08 P1b：两轨改成同一个 epoch 的时间轴——
//   · 音频：首个 PCM 块的到达时刻起算，之后按内容采样数累计（采样级平滑，不受管道抖动影响），
//     内容时间和真实时间偏差超过 100ms（音频管道卡顿/重启）时重新贴回 epoch；
//   · 视频：帧到达时刻直接换算（见 main.go 的 videoTs）。
//   · -audio-delay 可选：把音频整轨推后 N 毫秒再发，用来对齐视频链路（采集→编码→推流）
//     固有的、比音频多出来的那段延迟。浏览器只会"把画面往后挪"去对齐声音，
//     所以画面本来就晚的时候必须由发送端把声音补后，否则永远对不上。

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/pion/rtp"
)

type opusEncoder struct {
	dll    *syscall.DLL
	enc    uintptr
	encode *syscall.Proc
	mu     sync.Mutex
	out    []byte
}

func newOpusEncoder(dllPath string) (*opusEncoder, error) {
	dll, err := syscall.LoadDLL(dllPath)
	if err != nil {
		return nil, err
	}
	create, err := dll.FindProc("opus_encoder_create")
	if err != nil {
		return nil, err
	}
	encFn, err := dll.FindProc("opus_encode")
	if err != nil {
		return nil, err
	}
	var encErr int32
	// 48000Hz / 2ch / OPUS_APPLICATION_AUDIO=2048
	h, _, _ := create.Call(48000, 2, 2048, uintptr(unsafe.Pointer(&encErr)))
	if h == 0 || encErr != 0 {
		return nil, fmt.Errorf("opus_encoder_create err=%d", encErr)
	}
	return &opusEncoder{dll: dll, enc: h, encode: encFn, out: make([]byte, 4000)}, nil
}

// encodePCM: pcm 是 s16le 交错立体声；返回 Opus 包
func (o *opusEncoder) encodePCM(pcm []byte) ([]byte, error) {
	if len(pcm) < 2 || len(pcm)%4 != 0 {
		return nil, fmt.Errorf("bad pcm len %d", len(pcm))
	}
	samples := len(pcm) / 4 // 每声道采样数（立体声交错：字节/4）
	o.mu.Lock()
	defer o.mu.Unlock()
	n, _, _ := o.encode.Call(o.enc, uintptr(unsafe.Pointer(&pcm[0])), uintptr(samples), uintptr(unsafe.Pointer(&o.out[0])), uintptr(len(o.out)))
	if int32(n) < 0 {
		return nil, fmt.Errorf("opus_encode err=%d", int32(n))
	}
	packet := make([]byte, int(n))
	copy(packet, o.out[:int(n)])
	return packet, nil
}

func (o *opusEncoder) close() {
	if o.dll != nil {
		_ = o.dll.Release()
	}
}

// startAudioFeed 监听音频帧（带 µs 时间戳），编码后发给所有会话的同一条 PC。
func startAudioFeed(addr string, enc *opusEncoder) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		logf("audio feed listen %s: %v", addr, err)
		return
	}
	logf("audio feed listening %s", addr)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				logf("audio accept: %v", err)
				return
			}
			go readAudioFeed(conn, enc)
		}
	}()
}

// audioOut 是编码好、等着往 RTP 里写的一包音频。
type audioOut struct {
	due     time.Time
	payload []byte
	ts      uint32
}

// writeAudioAll 把一包 Opus 数据写给所有已就绪会话（每会话自己的序号）。
func writeAudioAll(payload []byte, ts uint32) {
	audioMu.Lock()
	for _, s := range sessions {
		if s.aTrack == nil || !s.ready.Load() {
			continue
		}
		pkt := &rtp.Packet{
			Header:  rtp.Header{Version: 2, SequenceNumber: s.aSeq, Timestamp: ts, Marker: true},
			Payload: payload,
		}
		if err := s.aTrack.WriteRTP(pkt); err != nil {
			continue
		}
		s.aSeq++
		s.aSent.Add(1)
	}
	audioMu.Unlock()
	// 音频内容时间（µs，相对 epoch）：ts 是 48kHz 计数，换算回微秒。
	lastAudioTsUs.Store(int64(ts) * 1_000_000 / 48000)
}

func readAudioFeed(conn net.Conn, enc *opusEncoder) {
	defer conn.Close()
	hdr := make([]byte, 16)
	var tsAcc uint32
	var inited bool

	// 发送端延迟队列（-audio-delay）：只在这一条音频管道里排队，
	// 用独立的 goroutine 按 "入队时刻 + delay" 到期吐包，不跟着 PCM 到达节奏抖。
	queue := make(chan audioOut, 64)
	delay := time.Duration(audioDelayMs) * time.Millisecond
	if audioDelayMs > 0 {
		go func() {
			for p := range queue {
				if wait := time.Until(p.due); wait > 0 {
					time.Sleep(wait)
				}
				writeAudioAll(p.payload, p.ts)
			}
		}()
		var closeOnce sync.Once
		defer closeOnce.Do(func() { close(queue) })
	}

	epochTicks := func() uint32 { return uint32(usSinceEpoch() * 48000 / 1_000_000) }

	for {
		if _, err := io.ReadFull(conn, hdr); err != nil {
			return
		}
		if string(hdr[0:4]) != "PAAU" {
			logf("audio feed bad magic %q", hdr[0:4])
			return
		}
		n := binary.LittleEndian.Uint32(hdr[12:16])
		if n == 0 || n > 16384 {
			return
		}
		pcm := make([]byte, n)
		if _, err := io.ReadFull(conn, pcm); err != nil {
			return
		}
		packet, err := enc.encodePCM(pcm)
		if err != nil {
			continue
		}
		if !inited {
			// 与视频轨同 epoch：音频时间轴从"这一块到达的时刻"起算。
			tsAcc = epochTicks()
			inited = true
		}
		// 诊断：这一块 PCM 的峰值（0..1）。排"没声音"时一眼就能看出
		// 是协议里根本没声音、还是编码/发送丢了。
		var peak int32
		for i := 0; i+1 < len(pcm); i += 2 {
			v := int32(int16(binary.LittleEndian.Uint16(pcm[i:])))
			if v < 0 {
				v = -v
			}
			if v > peak {
				peak = v
			}
		}
		audioPeak.Store(int64(peak))
		audioPeakAt.Store(time.Now().UnixMilli())
		audioPcmBlocks.Add(1)
		samplesPerCh := uint32(len(pcm) / 4) // 48k 立体声 16bit：每声道采样数
		// 内容累计和真实到达时间差太多（音频管道断过/设备换过）就贴回 epoch，
		// 否则音频时间轴会和视频越走越远。
		drift := int64(tsAcc) - int64(epochTicks())
		if drift > 4800 || drift < -4800 { // ±100ms
			tsAcc = epochTicks()
		}
		ts := tsAcc
		tsAcc += samplesPerCh
		if audioDelayMs > 0 {
			select {
			case queue <- audioOut{due: time.Now().Add(delay), payload: packet, ts: ts}:
			default: // 队列满：丢这一包，宁可短暂断续也不要拖时间轴
			}
		} else {
			writeAudioAll(packet, ts)
		}
	}
}

var (
	audioMu = sync.Mutex{}
)
