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
	// 2026-11-08 修：原来这里传的是 2048 = OPUS_APPLICATION_VOIP（语音通话模式），
	// 桌面音频（音乐/视频/系统声音）用它会被 SILK 语音优化处理，听起来发闷、忽高忽低
	// ——用户反馈的"声音到后面变形了"就是这个。改成 OPUS_APPLICATION_AUDIO=2049，
	// 并显式设码率/复杂度/信号类型（opus_encode_ctl，全部是单 int 参数的控制项）。
	h, _, _ := create.Call(48000, 2, 2049, uintptr(unsafe.Pointer(&encErr)))
	if h == 0 || encErr != 0 {
		return nil, fmt.Errorf("opus_encoder_create err=%d", encErr)
	}
	o := &opusEncoder{dll: dll, enc: h, encode: encFn, out: make([]byte, 4000)}
	if ctl, err := dll.FindProc("opus_encoder_ctl"); err == nil {
		set := func(name string, req, val int) {
			if r, _, _ := ctl.Call(h, uintptr(req), uintptr(val)); int32(r) < 0 {
				logf("opus ctl %s(%d)=%d 失败: %d", name, req, val, int32(r))
			}
		}
		set("BITRATE", 4002, 96000)            // 96kbps 立体声，音乐够用（原来默认约 32k）
		set("VBR", 4006, 1)                    // 变码率
		set("COMPLEXITY", 4010, 8)             // 质量优先（0-10）
		set("SIGNAL", 4024, 3002)              // OPUS_SIGNAL_MUSIC
		set("DTX", 4016, 0)                    // 关不连续传输（DTX 会让静音段听起来"断"）
		set("INBAND_FEC", 4012, 0)             // 关带内 FEC（会额外占带宽、偶发杂音）
		set("PACKET_LOSS_PERC", 4014, 0)
		logf("opus: 编码器已按桌面音频配置（AUDIO 模式 / 96kbps / 复杂度 8 / MUSIC）")
	}
	return o, nil
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
		audioEncErr.Add(1)
		return nil, fmt.Errorf("opus_encode err=%d", int32(n))
	}
	packet := make([]byte, int(n))
	copy(packet, o.out[:int(n)])
	// 2026-11-08 诊断：包里每包字节数能看出码率是否真的生效（96kbps 立体声约 240 B/20ms…）
	audioEncErr.Store(0)
	audioPayloadLast.Store(int64(len(packet)))
	if int64(len(packet)) > audioPayloadMax.Load() {
		audioPayloadMax.Store(int64(len(packet)))
	}
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
	startAudioPacer()
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
	lastAudioWriteAt.Store(time.Now().UnixMilli())
	audioWrites.Add(1)
}

// audioPkt 是编码好、等着按节拍吐出去的一包音频。
type audioPkt struct {
	at      time.Time // 进入发送队列的时刻（用来算"已经压了多久"）
	payload []byte
	ts      uint32
}

// 所有音频连接共用一条输出队列 + 一个节拍器：
//   · 节拍器（4ms tick，一次最多吐一包）把音频从"跟着 PCM 到达抖"变成"按 10ms 匀速"；
//   · 同时按 audioTargetMs() 把音频整体压后，用来对齐视频链路固有的延迟。
func startAudioPacer() {
	go audioPacer()
}

func audioPacer() {
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	q := make([]audioPkt, 0, 40)
	curMs := audioDelayLearned.Load() // 上一次会话学到的值（0 = 还没学到）
	audioDelayCur.Store(curMs)
	frozen := curMs > 0 // 有历史值就直接用，不再中途动
	steps := 0
	lastStep := time.Now()
	for now := range tick.C {
		// 收包
		for len(audioCh) > 0 {
			q = append(q, <-audioCh)
		}
		if len(q) > 40 { // 超过 400ms 就丢最旧的：宁可断续，也不让音频延迟无限堆高
			drop := len(q) - 40
			q = q[drop:]
			audioDropped.Add(uint64(drop))
		}
		// 2026-11-08 P1c：**最多调两步，之后冻结**。
		// 实测中途反复微调（+13ms、-20ms…）会让 Chrome 的 NetEq 每次都重新涨缓冲
		// （音频抖动缓冲 58→165ms 一路爬），反而越调越歪。
		// 起步那次采样常常被启动抖动污染（实测 4 秒时算出 83ms，真实值只有 ~30ms），
		// 所以要求"已经写了 5 秒音频"再算，并允许纠一次。
		if audioAutoAlign && audioDelayMs == 0 && !frozen &&
			steps < 2 && audioWrites.Load() > 500 && now.Sub(lastStep) > 6*time.Second {
			target := audioTargetMs(curMs)
			if d := target - curMs; d > 20 || d < -20 {
				curMs = target
				audioDelayCur.Store(curMs)
				audioDelayLearned.Store(curMs)
				steps++
				lastStep = now
				if steps >= 2 {
					frozen = true
				}
				logf("自动对齐：音频压后 %dms（第 %d 步，实测 视频到达−音频内容 = %dms）", curMs, steps, skewEmaUs.Load()/1000)
			} else {
				frozen = true
				logf("自动对齐：实测差 %dms，不需要再压（冻结在 %dms）", skewEmaUs.Load()/1000, curMs)
			}
		}
		audioQueued.Store(int64(len(q)))
		// 把到期的包都吐出去（Windows ticker 实际十几毫秒一次，必须一次吐完，
		// 否则喂不动 100 包/秒，队列会越积越多）。
		delay := time.Duration(curMs) * time.Millisecond
		n := 0
		for len(q) > 0 && now.Sub(q[0].at) >= delay {
			p := q[0]
			q = q[1:]
			writeAudioAll(p.payload, p.ts)
			n++
			if n > 60 {
				break
			}
		}
	}
}

// audioTargetMs 算出音频应该比视频压后多少毫秒。
//   · -audio-delay N  > 0：按固定值（手动，关自动）；
//   · 否则自动：用视频到达时刻 − 音频内容时刻的慢速均值做积分，
//     目标是把两者差压到 0（也就是"同一个真实时刻，两轨同时发出去"）。
func audioTargetMs(curMs int64) int64 {
	if audioDelayMs > 0 {
		return int64(audioDelayMs)
	}
	if !audioAutoAlign {
		return 0
	}
	ema := skewEmaUs.Load()
	if ema == 0 {
		return curMs
	}
	t := curMs - ema/1000
	if t < 0 {
		t = 0
	}
	if t > 400 {
		t = 400
	}
	return t
}

func readAudioFeed(conn net.Conn, enc *opusEncoder) {
	defer conn.Close()
	hdr := make([]byte, 16)
	var tsAcc uint32
	var inited bool

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
		// 2026-11-08 修：原来 ±100ms 就强行把时间戳贴回真实时间 —— 实测时钟漂移只有 ~24ppm，
		// 这样每小时会跳一次 100ms，NetEq 每次都要补/丢一段（听起来就是"变形/忽快忽慢"）。
		// 放到 2 秒：只兜真正的管道卡死，正常漂移交给接收端自适应。
		drift := int64(tsAcc) - int64(epochTicks())
		if drift > 96000 || drift < -96000 {
			tsAcc = epochTicks()
			audioTsSnaps.Add(1)
			logf("音频时间戳贴回真实时间（漂移 %dms）", drift/48)
		} else {
			// 2026-11-10：慢速 PLL（治"越听越不同步"）。
			// 实测（线上 19 分钟采样）：音频源每秒只投 99.0~99.4 块（应 100 块），
			// 这里的时间轴是按"收到的采样数"累加的 → 每秒落后 6~12ms；攒到 3 秒被上面的
			// 兜底"贴回真实时间"一次（日志里反复出现 -2.8s/-3.2s），用户听到的就是
			// "声音越来越慢，然后突然跳一下"。缺的块数 × 10ms 与贴回总量完全对得上。
			// 现在每个块按误差比例纠偏（drift/8，最多 ±6 tick = ±125µs ≈ 1.25%/块），
			// 把时间轴平滑拉回真实时间；接收端 NetEq 据此做 1% 级的轻微伸缩，听感上基本无感，
			// 但音画不会越走越偏（也就不会再触发那个 2 秒的大跳）。
			const maxStepTicks = 6
			step := drift / 8
			if step > maxStepTicks {
				step = maxStepTicks
			} else if step < -maxStepTicks {
				step = -maxStepTicks
			}
			if step != 0 {
				tsAcc = uint32(int64(tsAcc) - step)
				audioPllFixes.Add(1)
			}
		}
		ts := tsAcc
		tsAcc += samplesPerCh
		// 2026-11-08 P1d：**一律先入队，绝不在这条读连接里直接写 RTP**。
		// 实测生产：WriteRTP 会阻塞（音频和 20Mbps 视频共用一条 UDP/TURN 通道，
		// 网络拥塞时写不出去），读循环一停 TCP 里就堆了 430KB+ ≈ 2.2 秒音频，
		// 表现是"声音比画面晚两秒"，而抖动缓冲看不出任何异常。
		// 队列满了丢**最旧**的：宁可偶尔断一下，也不让音频永久落后。
		if len(audioCh) >= cap(audioCh)-1 {
			select {
			case <-audioCh:
				audioDropped.Add(1)
			default:
			}
		}
		select {
		case audioCh <- audioPkt{at: time.Now(), payload: packet, ts: ts}:
		default:
			audioDropped.Add(1)
		}
	}
}
var (
	audioMu = sync.Mutex{}
)
