// B 方案侧车：Pion WebRTC H.264 推流（2026-11-05 稳定性改造）
//
// 与旧版的区别（都是"稳定"相关）：
//  1. 每次 /offer 都新建一条 PeerConnection（旧版进程启动时建一条、SDP 缓存复用，
//     页面刷新/手机切网后再来就永远协商不上）；
//  2. 帧泵按会话各自排队，慢的一端不会拖住另一端；新会话先等关键帧（IDR）再开推，
//     避免浏览器从半路解码、花屏/黑屏；
//  3. 内置 TURN 中继（绑定 tailnet 地址 + 本机回环），手机在运营商 NAT 后面
//     靠 relay 候选也能连上；凭据每次启动随机生成，经 /offer 下发给页面；
//  4. /health 给 Node 侧做会话/帧龄观测，用来按需启停 ffmpeg；
//  5. HTTP 只监听 127.0.0.1（由 Node 同源代理），不再对外暴露信令端口。
//
// 编译（2026-11-10 起必须这样）：go build -trimpath -buildvcs=false -o rtc-h264.exe .
//   `-trimpath` 不能省：不加的话 Go 会把构建机的绝对路径写进 exe（实测泄漏
//   `C:/Users/<用户名>/.../go/src/...` 与 `D:/download/办共/...` 上千处），
//   发布包里一搜就出来，属于隐私泄漏。
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/turn/v4"
	"github.com/pion/webrtc/v4"
)

const sidecarVersion = "0.6.0"   // 2026-11-12：HEVC P1（H265 打包 + H265 SDP fmtp/sprop + codec 选择）

// 2026-11-08 P1b：两轨共用同一个时钟原点（epoch）——视频按"帧到达侧车的时刻"、
// 音频按"内容累计时间 + epoch 起点"。之前视频轨用 TrackLocalStaticSample，
// RTP 时间戳是按帧率合成的（每帧固定 +1/60 秒），采集/编码实际不是 60fps 时
// 视频时间轴就跟真实时间脱节；音频却是累计真实时长，两条轨对不上。
var epoch = time.Now()

// usSinceEpoch 返回相对 epoch 的微秒数（单调时钟，不受系统改时间影响）。
func usSinceEpoch() int64 { return time.Since(epoch).Microseconds() }

// ---------------------------------------------------------------- 会话

// frame.tsUs 是这一帧到达侧车（=编码输出）的时刻，微秒，相对 epoch。
// 视频 RTP 时间戳就用它换算：ts = tsUs * 90000 / 1e6。
type frame struct {
	data []byte
	key  bool
	tsUs int64
}

type session struct {
	id        string
	codec     string // "h264" | "hevc"（日志/诊断用）
	pc        *webrtc.PeerConnection
	track     *webrtc.TrackLocalStaticRTP
	payloader rtp.Payloader // H264Payloader 或 H265Payloader（RFC 7798 单 NAL + FU）
	vSeq      uint16
	vTsCache  uint32
	vHasTs    bool
	aTrack    *webrtc.TrackLocalStaticRTP
	aSeq      uint16
	aSent     atomic.Uint64
	ch        chan frame
	done      chan struct{}
	created   time.Time
	answered  atomic.Bool
	ready     atomic.Bool
	stopped   atomic.Bool
	closeOne  sync.Once
	keyMu     sync.Mutex
	needKey   bool
	sent      atomic.Uint64
	lastSent  atomic.Int64
	dropped   atomic.Uint64
}

// videoTs 把到达微秒换算成 90kHz RTP 时间戳，并保证同一会话内严格递增
// （同一 µs 内到两帧、或到达顺序抖动时，RTP 时间戳回退会让浏览器把帧丢掉）。
func (s *session) videoTs(tsUs int64) uint32 {
	ts := uint32(tsUs * 90000 / 1_000_000)
	if s.vHasTs && ts <= s.vTsCache {
		ts = s.vTsCache + 1
	}
	s.vTsCache = ts
	s.vHasTs = true
	return ts
}

func (s *session) pump() {
	for {
		select {
		case <-s.done:
			return
		case f := <-s.ch:
			if !s.ready.Load() {
				continue
			}
			s.keyMu.Lock()
			if s.needKey {
				if !f.key {
					s.keyMu.Unlock()
					continue
				}
				s.needKey = false
			}
			s.keyMu.Unlock()

			// 2026-11-08 P1b：自己分包 + 真实到达时间戳写 RTP（不再用
			// TrackLocalStaticSample 的合成时间戳）。H.264 的 FU-A / STAP-A 由
			// codecs.H264Payloader 负责，序号自己递增，同一帧的所有分片共用一个时间戳。
			ts := s.videoTs(f.tsUs)
			payloads := s.payloader.Payload(packetMTU, f.data)
			if len(payloads) == 0 {
				continue
			}
			writeErr := false
			for i, pl := range payloads {
				pkt := &rtp.Packet{
					Header: rtp.Header{
						Version:        2,
						Marker:         i == len(payloads)-1,
						SequenceNumber: s.vSeq,
						Timestamp:      ts,
					},
					Payload: pl,
				}
				if err := s.track.WriteRTP(pkt); err != nil {
					logf("session %s WriteRTP: %v", s.id, err)
					writeErr = true
					break
				}
				s.vSeq++
			}
			if writeErr {
				go dropSession(s.id, "write-error")
				return
			}
			s.sent.Add(1)
			s.lastSent.Store(time.Now().UnixMilli())
			lastVideoTsUs.Store(f.tsUs)
			// 自动对齐的输入：视频到达时刻 − 音频内容时刻（慢速均值，约 1 秒窗口）。
			// 音频断过（超过 400ms 没写出）就不采信，避免把旧值当基准。
			if a := lastAudioTsUs.Load(); a > 0 && time.Now().UnixMilli()-lastAudioWriteAt.Load() < 400 {
				sk := f.tsUs - a
				if sk < -500_000 {
					sk = -500_000
				} else if sk > 500_000 {
					sk = 500_000
				}
				if old := skewEmaUs.Load(); old == 0 {
					skewEmaUs.Store(sk)
				} else {
					skewEmaUs.Store(old + (sk-old)/60)
				}
			}
		}
	}
}

func (s *session) feed(f frame) {
	select {
	case s.ch <- f:
	default:
		s.dropped.Add(1)
		droppedFrames.Add(1)
		// 2026-11-10：队列满被丢掉一帧 = 参考帧链断了。
		// 关键点：丢帧时我们**不推进 RTP 序号**，接收端根本不知道少了一帧，
		// 于是后面依赖这一帧的 P 帧全部缺参考帧 —— 表现为连着花屏，直到下一个 IDR
		// （GOP 0.5 秒，看着就是"画面偶尔花一下"）。
		// 这里改成一丢帧就让该会话等下一个关键帧再推：画面最多停半秒，但不会再出花屏。
		// 注意：只在这里置位（真丢帧）。绝不要拿 PLI/FIR 置位 —— 之前踩过：
		// PLI 成串 → 长期没帧 → 页面判冻结 → 主动重连 → 死循环。
		s.keyMu.Lock()
		s.needKey = true
		s.keyMu.Unlock()
	}
}

// ---------------------------------------------------------------- 全局状态

var (
	audioEnabled bool
	api          *webrtc.API
	// settingEngine 是全局 ICE/端口配置。H264 会话用全局 api（默认 codec 表，保持 1.0.22 行为）；
	// HEVC 会话在 newHEVCAPI 里用它复制一份，只注册 H265+Opus。
	settingEngine webrtc.SettingEngine
	sampleDur     = time.Second / 60
	// packetMTU 与 Pion 内部 outboundMTU 一致（1200，扣掉 12 字节 RTP 头）。
	packetMTU = uint16(1188)

	mu       sync.Mutex
	sessions = map[string]*session{}
	live     []*session // 已 answer 且存活的会话（帧广播目标）

	turnMu   sync.Mutex
	turnPort int
	turnUser string
	turnPass string
	turnHost string
	turnOK   bool
	turnSrv  *turn.Server

	framesIn      atomic.Uint64
	droppedFrames atomic.Uint64
	idleFrames    atomic.Uint64 // 没有观众时收到的帧（不算丢帧，只是没人要）
	gapMarks      atomic.Uint64 // 2026-11-10：上游标记"之前丢过帧"的次数（生产上要盯它）
	lastGapLog    atomic.Int64
	lastFrameUnix atomic.Int64
	startedAt     = time.Now()

	// 2026-11-08 P1b 诊断：两条轨最近一次写出的绝对时间（µs，相对 epoch）。
	// 两者之差 = 「视频链路比音频链路多延迟了多少」，也就是用户在手机上看到的音画差，
	// 用 /health 的 avSkewMs 暴露出来（负=画面晚、正=声音晚）。
	lastVideoTsUs atomic.Int64
	lastAudioTsUs atomic.Int64
	audioDelayMs  int
	// 2026-11-08 P1c：发送端自动音画对齐。
	// Pion 的 sender report 把 RTP 时间戳锚在"发包时刻"，浏览器因此认为两条轨都是
	// "刚刚采集的"，它只会把画面往后挪（声音是基准），结构上无法修正"画面本来就晚"。
	// 所以必须在发送端把声音也压后，目标是让"同一个真实时刻"的两轨同时发出去。
	audioAutoAlign   bool
	audioDelayCur    atomic.Int64 // 当前实际压后（毫秒）
	skewEmaUs        atomic.Int64 // 视频到达时刻 − 音频内容时刻 的慢速均值（µs）
	lastAudioWriteAt atomic.Int64 // 最近一次真正写出音频的墙钟（毫秒）
	audioCh          = make(chan audioPkt, 40) // 40 包 ≈ 400ms：拥塞时靠"丢最旧"把音频延迟钉死，绝不让它堆到几秒
	audioQueued      atomic.Int64
	audioDelayLearned atomic.Int64
	audioWrites      atomic.Uint64 // 累计写出的音频包数（自动对齐要等音频稳定后再决策） // 上一次会话学到的音频压后值（跨会话复用，避免每场都重新抖一次）
	audioDropped     atomic.Uint64
	// 音频输入诊断：最近一块 PCM 的峰值（0..32767）与到达时间、块数。
	audioPeak      atomic.Int64
	audioPeakAt    atomic.Int64
	audioPcmBlocks atomic.Uint64
	// 2026-11-08 音频编码诊断：最近一包字节数、最大包、编码错误数、时间戳回贴次数。
	// 96kbps 立体声每包约 240 B；如果是几十字节，说明码率没设上（会被磨成"变形"）。
	audioEncErr      atomic.Uint64
	audioPayloadLast atomic.Int64
	audioPayloadMax  atomic.Int64
	audioTsSnaps     atomic.Uint64

	logPath string

	maxSessions = 4
	offerTTL    = 45 * time.Second
)

func logf(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	line := time.Now().Format("2006-01-02 15:04:05.000") + " " + msg
	fmt.Println(line)
	if logPath == "" {
		return
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	io.WriteString(f, line+"\n")
	f.Close()
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b)
}

// ---------------------------------------------------------------- TURN

func startTurn(ips []string, port int, override string) {
	if port <= 0 {
		logf("turn: disabled (-turn-port 0)")
		return
	}
	relay := override
	if relay == "" && len(ips) > 0 {
		relay = ips[0]
	}
	if relay == "" {
		logf("turn: 没有可用地址（无 tailnet IP，也没给 -turn-ip），跳过")
		return
	}
	if net.ParseIP(relay) == nil {
		logf("turn: 中继地址非法 %q", relay)
		return
	}
	realm := "pa"
	user := "pa"
	pass := randHex(12)
	addr := net.ParseIP(relay)
	newGen := func() *turn.RelayAddressGeneratorStatic {
		return &turn.RelayAddressGeneratorStatic{RelayAddress: addr, Address: "0.0.0.0"}
	}
	// 两个监听口：tailnet 地址（手机用）+ 本机回环（本机浏览器/自测用）。
	// 中继地址统一用 tailnet 地址——手机和本机都够得着。
	var conns []turn.PacketConnConfig
	for _, bind := range []string{relay, "127.0.0.1"} {
		pc, err := net.ListenPacket("udp4", net.JoinHostPort(bind, strconv.Itoa(port)))
		if err != nil {
			logf("turn: 监听 %s:%d 失败: %v", bind, port, err)
			continue
		}
		conns = append(conns, turn.PacketConnConfig{PacketConn: pc, RelayAddressGenerator: newGen()})
	}
	if len(conns) == 0 {
		return
	}
	srv, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(username string, _ string, _ net.Addr) ([]byte, bool) {
			if username != user {
				return nil, false
			}
			return turn.GenerateAuthKey(user, realm, pass), true
		},
		PacketConnConfigs: conns,
	})
	if err != nil {
		logf("turn: 启动失败: %v", err)
		return
	}
	turnSrv = srv
	turnMu.Lock()
	turnPort, turnUser, turnPass, turnHost, turnOK = port, user, pass, relay, true
	turnMu.Unlock()
	logf("turn: 监听 udp :%d，中继地址 %s", port, relay)
}

// ---------------------------------------------------------------- 地址

func tailnetIPs() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifc := range ifaces {
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.To4() == nil {
				continue
			}
			ip := ipnet.IP.To4()
			if ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127 {
				out = append(out, ip.String())
			}
		}
	}
	return out
}

// 离线模式（局域网/电脑热点）下，ICE 还要把本机局域网 IPv4 作为 host 候选广播出去，
// 否则手机在同一个 Wi-Fi 里只能看到 tailnet 地址、连不上。跳过虚拟网卡（VMware/Hyper-V 等）。
func lanIPs() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(ifc.Name)
		if strings.Contains(name, "vmware") || strings.Contains(name, "vethernet") || strings.Contains(name, "virtualbox") || strings.Contains(name, "tailscale") || strings.Contains(name, "loopback") {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.To4() == nil {
				continue
			}
			ip := ipnet.IP.To4()
			if (ip[0] == 10) || (ip[0] == 192 && ip[1] == 168) || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) {
				out = append(out, ip.String())
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- 会话管理

func newSession(opts offerOpts) (*session, error) {
	hevc := opts.isHEVC()
	var pc *webrtc.PeerConnection
	var err error
	if hevc {
		a, aerr := newHEVCAPI(h265Fmtp(opts), &settingEngine)
		if aerr != nil {
			return nil, aerr
		}
		pc, err = a.NewPeerConnection(webrtc.Configuration{})
	} else {
		pc, err = api.NewPeerConnection(webrtc.Configuration{})
	}
	if err != nil {
		return nil, err
	}
	id := randHex(6)
	// 2026-11-08 P1b：视频轨改成 TrackLocalStaticRTP（自己给真实到达时间戳），
	// 不再用 TrackLocalStaticSample 的"每帧 +1/fps"合成时间戳。
	codecName := "h264"
	var vcodec webrtc.RTPCodecCapability
	var pay rtp.Payloader
	if hevc {
		// 2026-11-12 HEVC P1：H265 的 fmtp 同时进 MediaEngine（见 newHEVCAPI）和 Track，
		// 前者决定 offer 里的 a=fmtp（Chrome 靠它匹配 profile-id=1），后者参与答案匹配。
		codecName = "hevc"
		vcodec = webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH265,
			ClockRate:   90000,
			SDPFmtpLine: h265Fmtp(opts),
		}
		// SkipAggregation：只发"单 NAL / FU"两种包，不发 AP（聚合包）。
		// VPS/SPS/PPS 各占一个 RTP 包，IRAP 按 FU 分片；这是 RFC 7798 里最保守的组合。
		pay = &codecs.H265Payloader{SkipAggregation: true}
	} else {
		vcodec = webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeH264,
			ClockRate: 90000,
			// 2026-11-10：原来写死 42c032（Baseline 3.2），但实际编码是 Main profile（日志 avc1.4D4032）。
			// 接收端按 SDP 声明配置解码器，声明 Baseline 却收到 Main 帧，iPhone 的 VideoToolbox 会解码异常/退回软解，
			// 表现为积压 → 缓冲一路涨（安卓和 iPhone 17 Pro 都一样）。改成与实际编码一致的 Main 3.2。
			SDPFmtpLine: "profile-level-id=4D0032;packetization-mode=1;level-asymmetry-allowed=1",
		}
		pay = &codecs.H264Payloader{}
	}
	track, err := webrtc.NewTrackLocalStaticRTP(vcodec, "video", "pa-"+id)
	if err != nil {
		pc.Close()
		return nil, err
	}
	if _, err = pc.AddTrack(track); err != nil {
		pc.Close()
		return nil, err
	}
	var aTrack *webrtc.TrackLocalStaticRTP
	if audioEnabled {
		aTrack, err = webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "pa-"+id)
		if err != nil {
			pc.Close()
			return nil, err
		}
		if _, err = pc.AddTrack(aTrack); err != nil {
			pc.Close()
			return nil, err
		}
	}
	s := &session{
		id:        id,
		codec:     codecName,
		pc:        pc,
		track:     track,
		payloader: pay,
		aTrack:    aTrack,
		ch:        make(chan frame, 30),   // 2026-11-10：3 太浅。实测 100fps 时丢帧率 18.5%（每 5 帧丢 1 帧），而 H.264 的 P 帧依赖前序帧，丢一帧就会连锁花屏。30 帧≈0.3 秒缓冲。
		done:      make(chan struct{}),
		created:   time.Now(),
		needKey:   true,
	}
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		logf("session %s connection=%s", id, st.String())
		switch st {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			dropSession(id, "pc-"+st.String())
		case webrtc.PeerConnectionStateDisconnected:
			// 手机锁屏/切网会短暂 disconnected，给 15 秒自愈；一直不回来就回收，
			// 否则页面每刷新一次就留一条死会话在广播列表里。
			go func() {
				time.Sleep(15 * time.Second)
				if s.stopped.Load() {
					return
				}
				if s.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
					dropSession(id, "ice-disconnected")
				}
			}()
		}
	})
	go s.pump()
	return s, nil
}

func dropSession(id, why string) {
	mu.Lock()
	s := sessions[id]
	if s == nil {
		mu.Unlock()
		return
	}
	delete(sessions, id)
	out := live[:0]
	for _, x := range live {
		if x.id != id {
			out = append(out, x)
		}
	}
	live = out
	mu.Unlock()
	s.closeOne.Do(func() {
		s.stopped.Store(true)
		close(s.done)
		s.pc.Close()
		logf("session %s 关闭（%s）", id, why)
	})
}

func liveCount() int {
	mu.Lock()
	defer mu.Unlock()
	return len(live)
}

// feedFrame 把一帧广播给所有会话。
func feedFrame(data []byte, key bool) {
	feedFrameGap(data, key, false)
}

// feedFrameGap 同上。gap=true 表示"这一帧之前，上游（Node 解析/转发那段）已经丢过帧了"：
// 接收端看不到这种丢失（丢帧时我们不会推进 RTP 序号），所以必须由我们让会话停下来等下一个关键帧。
// 帧格式：[4 字节大端长度][1 字节 flags]，flags bit0=关键帧，bit1=gap。
func feedFrameGap(data []byte, key bool, gap bool) {
	framesIn.Add(1)
	now := time.Now()
	lastFrameUnix.Store(now.UnixMilli())
	// 到达时刻（微秒，相对 epoch）：这就是视频 RTP 时间戳的基准。
	tsUs := now.Sub(epoch).Microseconds()
	mu.Lock()
	ls := live
	mu.Unlock()
	if len(ls) == 0 {
		// 2026-11-08：没人看的时候每一帧都算"丢帧"会把这个计数器彻底污染
		// （实测空闲几十分钟后 dropped 变成上万，报障时完全没法用）。单独记。
		idleFrames.Add(1)
		return
	}
	if gap {
		gapMarks.Add(1)
		// 每秒最多记一条：上游卡一次可能连着丢很多帧，别把日志刷满
		nw := now.UnixMilli()
		if last := lastGapLog.Load(); nw-last > 1000 {
			lastGapLog.Store(nw)
			logf("上游丢帧（gap 标记）：%d 个会话等下一个关键帧再推", len(ls))
		}
		for _, s := range ls {
			s.keyMu.Lock()
			s.needKey = true
			s.keyMu.Unlock()
		}
	}
	for _, s := range ls {
		if s.stopped.Load() {
			continue
		}
		s.feed(frame{data: data, key: key, tsUs: tsUs})
	}
}

// ---------------------------------------------------------------- HTTP

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func handleOffer(w http.ResponseWriter, r *http.Request) {
	// 2026-11-12 HEVC P1：/offer 可选带 JSON body（Node 从 hvcC 解出来的 sprop/profile/level）。
	// 也支持 ?codec=hevc 便于单测/手工验证（不带 sprop 也能跑：参数集在关键帧码流里）。
	var opts offerOpts
	if r.Body != nil {
		if b, err := io.ReadAll(io.LimitReader(r.Body, 64<<10)); err == nil && len(b) > 0 {
			_ = json.Unmarshal(b, &opts)
		}
	}
	if q := strings.TrimSpace(r.URL.Query().Get("codec")); q != "" {
		opts.Codec = q
	}
	if opts.isHEVC() {
		opts.Codec = "hevc"
	} else {
		opts.Codec = "h264"
	}

	// 先清掉长时间没 answer 的残留，避免页面反复重试把表撑大
	mu.Lock()
	for id, s := range sessions {
		if !s.answered.Load() && time.Since(s.created) > offerTTL {
			mu.Unlock()
			dropSession(id, "offer-expired")
			mu.Lock()
		}
	}
	mu.Unlock()

	s, err := newSession(opts)
	if err != nil {
		logf("offer: new session 失败: %v", err)
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	mu.Lock()
	sessions[s.id] = s
	mu.Unlock()

	offer, err := s.pc.CreateOffer(nil)
	if err != nil {
		dropSession(s.id, "create-offer")
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	gathered := webrtc.GatheringCompletePromise(s.pc)
	if err = s.pc.SetLocalDescription(offer); err != nil {
		dropSession(s.id, "set-local")
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	select {
	case <-gathered:
	case <-time.After(3 * time.Second):
		logf("session %s ICE 收集超时（继续用已有候选）", s.id)
	}
	ld := s.pc.LocalDescription()
	if ld == nil || ld.SDP == "" {
		dropSession(s.id, "no-local-sdp")
		writeJSON(w, 500, map[string]string{"error": "no local description"})
		return
	}
	turnMu.Lock()
	tp, tu, tw, tok, th := turnPort, turnUser, turnPass, turnOK, turnHost
	turnMu.Unlock()
	if s.codec == "hevc" {
		logf("session %s offer 就绪（HEVC：%s；sdp %d 字节，已有 %d 路会话）", s.id,
			describeSprop("vps", opts.SpropVPS)+" "+describeSprop("sps", opts.SpropSPS)+" "+describeSprop("pps", opts.SpropPPS),
			len(ld.SDP), liveCount())
	} else {
		logf("session %s offer 就绪（sdp %d 字节，已有 %d 路会话）", s.id, len(ld.SDP), liveCount())
	}
	writeJSON(w, 200, map[string]any{
		"ok":       true,
		"sid":      s.id,
		"type":     "offer",
		"sdp":      ld.SDP,
		"codec":    s.codec,
		"turnOk":   tok,
		"turnPort": tp,
		"turnUser": tu,
		"turnPass": tw,
		"turnHost": th,
		"version":  sidecarVersion,
	})
	go func() {
		time.Sleep(offerTTL)
		if !s.answered.Load() {
			dropSession(s.id, "no-answer-timeout")
		}
	}()
}

func handleAnswer(w http.ResponseWriter, r *http.Request) {
	var a struct {
		SID  string `json:"sid"`
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&a); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	if a.SDP == "" {
		writeJSON(w, 400, map[string]string{"error": "empty sdp"})
		return
	}
	mu.Lock()
	s := sessions[a.SID]
	mu.Unlock()
	if s == nil {
		writeJSON(w, 404, map[string]string{"error": "unknown sid"})
		return
	}
	if s.answered.Load() {
		writeJSON(w, 409, map[string]string{"error": "already answered"})
		return
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: a.SDP}); err != nil {
		logf("session %s answer 失败: %v", s.id, err)
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	s.answered.Store(true)
	s.keyMu.Lock()
	s.needKey = true
	s.keyMu.Unlock()
	s.ready.Store(true)
	// 2026-11-10：读 RTCP。浏览器发现花屏/丢包会发 PLI/FIR 请求关键帧，之前完全没人读，
	// 于是只能干等 ffmpeg 的下一个定期 IDR（GOP 0.5 秒）。现在收到就置 needKey，
	// 帧泵会跳过非关键帧直到下一个 IDR（画面短暂冻结，比花屏干净）。
	// 节流 500ms：PLI 往往成串到达，不节流会把画面冻成幻灯片。
	go func() {
		var lastPLI int64
		buf := make([]byte, 2000)
		for _, snd := range s.pc.GetSenders() {
			sender := snd
			go func() {
				for {
					n, _, err := sender.Read(buf)
					if err != nil {
						return
					}
					pkts, e := rtcp.Unmarshal(buf[:n])
					if e != nil {
						continue
					}
					for _, p := range pkts {
						switch p.(type) {
						case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
							now := time.Now().UnixMilli()
							if now-atomic.LoadInt64(&lastPLI) < 500 {
								continue
							}
							atomic.StoreInt64(&lastPLI, now)
							// 2026-11-10 实测结论：不要用 needKey 响应 PLI。
							// 实测两次都出现「PLI 成串 → needKey 长期置位 → 丢非关键帧 → 长时间没帧 →
							// 页面按 2.5 秒冻结判定主动重连」的死循环（日志里十几秒一个新会话）。
							// 花屏恢复改用另外两条（都已经在跑）：
							//   ① NACK responder：零星丢包当场重传，根本不用等关键帧；
							//   ② GOP 0.25 秒：真丢包时最多 0.25 秒就自然出现下一个 IDR。
							// 这里只记日志，用于诊断（看浏览器到底在多久要一次关键帧）。
							logf("session %s 收到 PLI/FIR（仅记录，不丢弃帧；靠 NACK + 0.25s GOP 恢复）", s.id)
						}
					}
				}
			}()
		}
	}()
	now := time.Now().UnixMilli()
	mu.Lock()
	live = append(live, s)
	over := len(live) - maxSessions
	var victims []string
	if over > 0 {
		for i := 0; i < over; i++ {
			victims = append(victims, live[i].id)
		}
	}
	// 新会话接上时，顺手清掉早就没有输出的僵死会话（页面刷新留下的 disconnected 老 PC）
	for _, x := range live {
		if x.id == s.id || x.stopped.Load() {
			continue
		}
		ls := x.lastSent.Load()
		if ls == 0 || now-ls > 10000 {
			victims = append(victims, x.id)
		}
	}
	mu.Unlock()
	for _, id := range victims {
		dropSession(id, "回收僵死/超量会话")
	}
	logf("session %s answer 完成，当前 %d 路", s.id, liveCount())
	writeJSON(w, 200, map[string]any{"ok": true, "sid": s.id, "sessions": liveCount()})
}

func handleClose(w http.ResponseWriter, r *http.Request) {
	sid := r.URL.Query().Get("sid")
	if sid == "" {
		var a struct {
			SID string `json:"sid"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&a)
		sid = a.SID
	}
	if sid != "" {
		dropSession(sid, "client-close")
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// 只给本机 Node 用：Node 被 supervisor 重启后，先把上一代残留的侧车收掉再拉新的，
// 否则端口被占、新进程起不来，页面会拿到旧版本/旧 TURN 凭据的侧车。
func handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}
	logf("收到 /shutdown，准备退出")
	writeJSON(w, 200, map[string]any{"ok": true})
	go func() {
		time.Sleep(120 * time.Millisecond)
		os.Exit(0)
	}()
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	last := lastFrameUnix.Load()
	age := int64(-1)
	if last > 0 {
		age = time.Now().UnixMilli() - last
	}
	mu.Lock()
	pending := 0
	for _, s := range sessions {
		if !s.answered.Load() {
			pending++
		}
	}
	n := len(live)
	h264Live, hevcLive := 0, 0
	for _, s := range live {
		if s.codec == "hevc" {
			hevcLive++
		} else {
			h264Live++
		}
	}
	mu.Unlock()
	turnMu.Lock()
	tok, tp := turnOK, turnPort
	turnMu.Unlock()
	// P1b 诊断：视频/音频两条轨最近写出的绝对时间差（毫秒）。
	// 负值 = 视频比音频晚（画面慢），正值 = 声音晚。手机上的实际音画差基本等于它。
	vUs, aUs := lastVideoTsUs.Load(), lastAudioTsUs.Load()
	skew := int64(-99999)
	if vUs > 0 && aUs > 0 {
		skew = (vUs - aUs) / 1000
	}
	writeJSON(w, 200, map[string]any{
		"ok":           true,
		"version":      sidecarVersion,
		"uptimeSec":    int64(time.Since(startedAt).Seconds()),
		"sessions":     n,
		"h264Sessions": h264Live,
		"hevcSessions": hevcLive,
		"pending":      pending,
		"lastFrameMs":  age,
		"framesIn":     framesIn.Load(),
		"dropped":      droppedFrames.Load(),
		"gapMarks":     gapMarks.Load(),
		"turnOk":       tok,
		"turnPort":     tp,
		"avSkewMs":     skew,
		"avResidualMs": skew - audioDelayCur.Load(),
		"audioDelayMs": audioDelayCur.Load(),
		"audioAlignOn": audioAutoAlign,
		"audioAlignTarget": audioTargetMs(audioDelayCur.Load()),
		"skewEmaMs":    skewEmaUs.Load() / 1000,
		"audioQueued":  audioQueued.Load(),
		"audioDropped": audioDropped.Load(),
		"videoTsMs":    vUs / 1000,
		"audioTsMs":    aUs / 1000,
		"audioPeak":    audioPeak.Load(),
		"audioPeakAgeMs": func() int64 {
			t := audioPeakAt.Load()
			if t == 0 {
				return -1
			}
			return time.Now().UnixMilli() - t
		}(),
		"audioBlocks":  audioPcmBlocks.Load(),
		"audioPayload": audioPayloadLast.Load(),
		"audioPayloadMax": audioPayloadMax.Load(),
		"audioEncErr":  audioEncErr.Load(),
		"audioTsSnaps": audioTsSnaps.Load(),
	})
}

const pageHTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>rtc-h264 测试页</title></head>
<body style="margin:0;background:#000;color:#eee;font:14px system-ui">
<video id="v" autoplay muted playsinline style="width:100vw;height:auto;display:block;background:#111"></video>
<div id="s" style="position:fixed;left:8px;bottom:8px;background:rgba(0,0,0,.6);padding:4px 8px;border-radius:6px">connecting…</div>
<script>
(async()=>{
 const s=document.getElementById('s');
 const relay=new URLSearchParams(location.search).get('relay')==='1';
 const codec=new URLSearchParams(location.search).get('codec')||'h264';
 try{
  const o=await (await fetch('/offer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({codec})})).json();
  if(!o||!o.sdp) throw new Error('no offer');
  const ice=[{urls:'stun:stun.cloudflare.com:3478'}];
  if(o.turnOk&&o.turnPort) ice.unshift({urls:'turn:'+location.hostname+':'+o.turnPort+'?transport=udp',username:o.turnUser,credential:o.turnPass});
  const pc=new RTCPeerConnection({iceServers:ice,iceTransportPolicy:relay?'relay':'all'});
  window.__pc=pc;
  const v=document.getElementById('v');
  // 2026-11-08 P1b：现在同一条 PC 有音频+视频两条轨，必须都加进同一个 MediaStream，
  // 否则后到的 ontrack 会把 srcObject 整个换掉（视频轨被踢走，表现成"解了码但黑屏"）。
  const stream=new MediaStream();
  pc.ontrack=(e)=>{ stream.addTrack(e.track); v.srcObject=stream; };
  pc.oniceconnectionstatechange=()=>{ s.textContent='ice '+pc.iceConnectionState+(relay?' (relay-only)':''); };
  await pc.setRemoteDescription({type:'offer',sdp:o.sdp});
  const ans=await pc.createAnswer(); await pc.setLocalDescription(ans);
  await new Promise(r=>{ if(pc.iceGatheringState==='complete')return r(); pc.onicegatheringstatechange=()=>{ if(pc.iceGatheringState==='complete')r(); }; setTimeout(r,3000); });
  const body=JSON.stringify({sid:o.sid,type:pc.localDescription.type,sdp:pc.localDescription.sdp});
  const ar=await (await fetch('/answer',{method:'POST',headers:{'content-type':'application/json'},body})).json();
  if(!ar||!ar.ok) throw new Error('answer '+(ar&&ar.error||''));
  setInterval(async()=>{
   let br=0,fr=0,fd=0,path='';
   try{
    const st=await pc.getStats(); const cands={};
    st.forEach(r=>{ if(r.type==='local-candidate'||r.type==='remote-candidate') cands[r.id]=r; });
    st.forEach(r=>{
     if(r.type==='inbound-rtp'&&r.kind==='video'){br=r.bytesReceived||0;fr=r.framesReceived||0;fd=r.framesDecoded||0;}
     if(r.type==='candidate-pair'&&r.state==='succeeded'){ const l=cands[r.localCandidateId],m=cands[r.remoteCandidateId]; path=(l?l.candidateType:'?')+'>'+(m?m.candidateType:'?'); }
    });
   }catch(e){}
   s.textContent=pc.iceConnectionState+' · '+(relay?'relay-only':'all')+' · '+(v.videoWidth?v.videoWidth+'x'+v.videoHeight:'no video')+' · 帧'+fr+'/解'+fd+' · 收'+Math.round(br/1024)+'KB · '+path;
  },1000);
 }catch(e){ s.textContent='ERR '+e.message; }
})();
</script></body></html>`

// ---------------------------------------------------------------- main

func main() {
	port := flag.Int("port", 9800, "本机 HTTP/信令端口（只在 127.0.0.1 监听）")
	host := flag.String("host", "127.0.0.1", "HTTP 监听地址")
	fps := flag.Int("fps", 60, "帧率（只用于 -loop 回放节奏；视频时间戳已改真实到达时刻）")
	loop := flag.Bool("loop", false, "回放 stdin 收到的帧（测试模式）")
	tcpAddr := flag.String("tcp", "", "监听 TCP 接收帧：addr:port")
	audioAddr := flag.String("audio", "", "监听 TCP 接收音频帧：addr:port")
	opusDLL := flag.String("opus-dll", "", "opus.dll 路径")
	audioDelay := flag.Int("audio-delay", 0, "音频发送端延迟（毫秒，固定值）：把音频整轨推后，用来对齐视频链路的固有延迟；给了就关闭自动对齐")
	audioAlign := flag.Bool("audio-align", false, "自动把音频压后到与视频同拍（按实测到达差，每会话最多调两步；默认关，配置 rtc264.audioAutoAlign=true 打开）")
	turnPort := flag.Int("turn-port", 3478, "内置 TURN 的 UDP 端口，0 表示关闭")
	turnIP := flag.String("turn-ip", "", "覆盖 TURN 中继/监听地址（默认取第一个 tailnet IP）")
	logFile := flag.String("log", "", "日志文件（可选）")
	flag.Parse()

	logPath = *logFile
	sampleDur = time.Second / time.Duration(*fps)
	if *fps <= 0 {
		sampleDur = time.Second / 60
	}
	audioDelayMs = *audioDelay
	if audioDelayMs < 0 {
		audioDelayMs = 0
	}
	if audioDelayMs > 600 {
		audioDelayMs = 600
	}
	// 2026-11-08 P1c：手动给了 -audio-delay 就走固定值，否则默认自动对齐。
	audioAutoAlign = *audioAlign && audioDelayMs == 0
	if audioDelayMs > 0 {
		logf("音频发送端延迟 %dms（固定值，关闭自动对齐）", audioDelayMs)
	} else if audioAutoAlign {
		logf("音频自动对齐已开启（按 视频到达−音频内容 的慢速均值收敛，上限 400ms）")
	}

	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		logf("register codecs: %v", err)
		os.Exit(1)
	}
	se := &settingEngine
	ips := tailnetIPs()
	// 局域网/热点（离线模式）也要能直连：把本机局域网 IPv4 一起作为 host 候选广播
	lan := lanIPs()
	if len(lan) > 0 {
		ips = append(ips, lan...)
	}
	if len(ips) > 0 {
		se.SetNAT1To1IPs(ips, webrtc.ICECandidateTypeHost)
		logf("ICE 对外地址：%v", ips)
	} else {
		logf("没有发现 tailnet/局域网 IP，只会有本机候选（真机跨网会连不上）")
	}
	// 2026-11-10：注册 NACK responder。浏览器一直在发 NACK（SDP 里 nack/nack pli 都协商了），
	// 但侧车之前没注册 interceptor → 收到的 NACK 全丢掉 → 丢一个包就得等下一个定期 IDR（0.5 秒），
	// 表现就是"画面一动就花屏"。注册后 Pion 会缓存已发包、按 NACK 重传，零星丢包当场补回来。
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		logf("register interceptors: %v", err)
		os.Exit(1)
	}
	nackFactory, nerr := nack.NewResponderInterceptor(nack.ResponderSize(4096))
	if nerr != nil {
		logf("nack responder: %v", nerr)
	} else {
		ir.Add(nackFactory)
		logf("NACK responder 已启用（缓存 4096 包，丢包可重传）")
	}
	api = webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithSettingEngine(*se), webrtc.WithInterceptorRegistry(ir))

	if *turnPort > 0 {
		go startTurn(ips, *turnPort, *turnIP)
	}

	http.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		io.WriteString(w, pageHTML)
	})
	http.HandleFunc("/offer", handleOffer)
	http.HandleFunc("/answer", handleAnswer)
	http.HandleFunc("/close", handleClose)
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/shutdown", handleShutdown)
	go func() {
		addr := net.JoinHostPort(*host, strconv.Itoa(*port))
		logf("HTTP 信令监听 %s（版本 %s）", addr, sidecarVersion)
		if *audioAddr != "" {
			dll := *opusDLL
			if dll == "" {
				dll = "opus.dll"
			}
			enc, err := newOpusEncoder(dll)
			if err != nil {
				logf("opus init failed: %v", err)
			} else {
				audioEnabled = true
				startAudioFeed(*audioAddr, enc)
				logf("audio track enabled (dll=%s)", dll)
			}
		}
		if err := http.ListenAndServe(addr, nil); err != nil {
			logf("HTTP 退出：%v", err)
		}
	}()

	// 定期打印一行状态，方便远程排障
	go func() {
		for {
			time.Sleep(30 * time.Second)
			last := lastFrameUnix.Load()
			age := int64(-1)
			if last > 0 {
				age = time.Now().UnixMilli() - last
			}
			logf("状态：会话 %d，收帧 %d，丢帧 %d，最后一帧 %dms 前", liveCount(), framesIn.Load(), droppedFrames.Load(), age)
		}
	}()

	// 兜底回收：万一 Pion 的状态回调没来，也不让死会话/半截 offer 一直留着
	go func() {
		for {
			time.Sleep(30 * time.Second)
			mu.Lock()
			var ids []string
			for id, s := range sessions {
				st := s.pc.ConnectionState()
				switch {
				case st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed:
					ids = append(ids, id)
				case !s.answered.Load() && time.Since(s.created) > 4*offerTTL:
					ids = append(ids, id)
				}
			}
			mu.Unlock()
			for _, id := range ids {
				dropSession(id, "janitor")
			}
		}
	}()

	if *loop {
		var stored [][]byte
		keys := map[int]bool{}
		rd := bufio.NewReaderSize(os.Stdin, 1<<20)
		for {
			var hdr [5]byte
			if _, err := io.ReadFull(rd, hdr[:]); err != nil {
				break
			}
			n := binary.BigEndian.Uint32(hdr[:4])
			if n == 0 || n > 8<<20 {
				continue
			}
			buf := make([]byte, n)
			if _, err := io.ReadFull(rd, buf); err != nil {
				break
			}
			stored = append(stored, buf)
			keys[len(stored)-1] = hdr[4] == 1
		}
		logf("loop：缓存 %d 帧，开始循环回放", len(stored))
		go func() {
			for {
				for i, b := range stored {
					feedFrame(b, keys[i])
					time.Sleep(sampleDur)
				}
			}
		}()
	}

	if *tcpAddr != "" {
		ln, err := net.Listen("tcp", *tcpAddr)
		if err != nil {
			logf("TCP 监听失败：%v", err)
			os.Exit(1)
		}
		logf("帧输入监听 %s", *tcpAddr)
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					time.Sleep(200 * time.Millisecond)
					continue
				}
				logf("帧输入连接：%s", conn.RemoteAddr())
				go func(c net.Conn) {
					defer func() {
						logf("帧输入断开：%s", c.RemoteAddr())
						c.Close()
					}()
					_ = c.(*net.TCPConn).SetReadBuffer(1 << 20)
					rd := bufio.NewReaderSize(c, 1<<20)
					for {
						var hdr [5]byte
						if _, err := io.ReadFull(rd, hdr[:]); err != nil {
							return
						}
						n := binary.BigEndian.Uint32(hdr[:4])
						if n == 0 || n > 8<<20 {
							continue
						}
						buf := make([]byte, n)
						if _, err := io.ReadFull(rd, buf); err != nil {
							return
						}
						feedFrameGap(buf, hdr[4]&1 == 1, hdr[4]&2 != 0)
					}
				}(conn)
			}
		}()
		select {}
	}

	// 没有 -tcp 也没有 -loop：从 stdin 读帧（文件回放/管道测试）
	rd := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		var hdr [5]byte
		if _, err := io.ReadFull(rd, hdr[:]); err != nil {
			select {}
		}
		n := binary.BigEndian.Uint32(hdr[:4])
		if n == 0 || n > 8<<20 {
			continue
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(rd, buf); err != nil {
			select {}
		}
		feedFrameGap(buf, hdr[4]&1 == 1, hdr[4]&2 != 0)
	}
}