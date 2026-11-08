package main

// 2026-11-08 P1：同一条 Pion PeerConnection 里送音频（Opus），时间戳用同一时钟。
// 编码器用 syscall 直接调 opus.dll（libopus 1.3，BSD 许可；无需 cgo/gcc）。
// 协议（screen-server -> 侧车 TCP）："PAAU" + uint64 LE tsMicros + uint32 LE pcmBytes + PCM(s16le 48k stereo)

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"sync"
	"syscall"
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

func readAudioFeed(conn net.Conn, enc *opusEncoder) {
	defer conn.Close()
	hdr := make([]byte, 16)
	var tsAcc uint32
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
		samplesPerCh := len(pcm) / 4 // 48k 立体声 16bit：每声道采样数
		ts := tsAcc
		tsAcc += uint32(samplesPerCh)
		audioMu.Lock()
		for _, s := range sessions {
			if s.aTrack == nil || !s.ready.Load() {
				continue
			}
			pkt := &rtp.Packet{
				Header:  rtp.Header{Version: 2, SequenceNumber: s.aSeq, Timestamp: ts, Marker: true},
				Payload: packet,
			}
			if err := s.aTrack.WriteRTP(pkt); err != nil {
				continue
			}
			s.aSeq++
			s.aSent.Add(1)
		}
		audioMu.Unlock()
	}
}
var (
	audioMu = sync.Mutex{}
)
