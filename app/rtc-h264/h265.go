// HEVC（H.265）P1：sidecar 打包 + SDP 参数
//
// 2026-11-12 晚（P1 交接文档 docs/HEVC-评估-2026-11-12.md）：
//   · 原计划是"自己实现 RFC 7798 打包器"，但实测 Pion v4.2.26 依赖的 pion/rtp v1.10.6
//     **已经自带 codecs.H265Payloader**（单 NAL / AP / FU 都有，还带参数集缓存）。
//     我们只用其中"单 NAL + FU"两条路（SkipAggregation=true，不发 AP）——
//     这正是 RFC 7798 里最保守、浏览器解包器兼容性最好的组合，也省掉一份自写打包器的风险。
//   · 这个文件负责：codec 选项解析、H265 的 SDP fmtp（profile/level/tier + sprop-vps/sps/pps）、
//     以及 HEVC 专用 MediaEngine（只注册 H265 + Opus，避免把 H264 也放进 m-line 导致
//     浏览器"能答 H264 就答 H264"、而侧车实际在推 H265 的错配）。
package main

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/webrtc/v4"
)

// offerOpts 是页面/Node 在 /offer 里带过来的编码参数。
// Node 从 ffmpeg 的 fMP4 初始化段解析出 hvcC 后填进来（拿不到就留空，靠码流内参数集）。
type offerOpts struct {
	Codec string `json:"codec"` // "h264"（默认）| "hevc"
	// sprop-* 是 SDP fmtp 里用的 base64（HEVC NAL 单元，不含起始码），
	// 标准名见 RFC 7798 §7.2 / draft-ietf-avtcore-hevc-webrtc。
	SpropVPS string `json:"spropVps"`
	SpropSPS string `json:"spropSps"`
	SpropPPS string `json:"spropPps"`
	Profile  string `json:"profileId"` // general_profile_idc，Main=1
	Level    string `json:"levelId"`   // general_level_idc，例如 120 / 150 / 180
	Tier     string `json:"tierFlag"`  // 0=Main tier，1=High tier
}

func (o offerOpts) isHEVC() bool {
	c := strings.ToLower(strings.TrimSpace(o.Codec))
	return c == "hevc" || c == "h265"
}

// digits 只保留数字，防止外部传进来的值把 SDP 弄坏（注入 / 解析失败）。
func digits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// b64Token 校验 sprop 值：只允许 base64 字符，且长度合理。
// SDP fmtp 的值里出现 ';' / 空格会把整行切坏，宁可不带也不能带脏值。
func b64Token(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 8192 {
		return ""
	}
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '+', r == '/', r == '=':
		default:
			return ""
		}
	}
	return s
}

// h265Fmtp 生成 H265 的 a=fmtp 行。顺序沿用浏览器（Chrome 用 level-id 打头）的习惯。
func h265Fmtp(o offerOpts) string {
	level := digits(o.Level)
	if level == "" {
		level = "120" // level 4.0：1920x1200@120 的实际码率/帧率吃得下
	}
	profile := digits(o.Profile)
	if profile == "" {
		profile = "1" // Main
	}
	tier := digits(o.Tier)
	if tier == "" {
		tier = "0"
	}
	parts := []string{
		"level-id=" + level,
		"profile-id=" + profile,
		"tier-flag=" + tier,
		"tx-mode=SRST",
	}
	if v := b64Token(o.SpropVPS); v != "" {
		parts = append(parts, "sprop-vps="+v)
	}
	if v := b64Token(o.SpropSPS); v != "" {
		parts = append(parts, "sprop-sps="+v)
	}
	if v := b64Token(o.SpropPPS); v != "" {
		parts = append(parts, "sprop-pps="+v)
	}
	return strings.Join(parts, ";")
}

// h265Codec 返回 H265 的 RTPCodecParameters（PT 116 与 Pion 默认一致，方便对照日志）。
func h265Codec(fmtp string) webrtc.RTPCodecParameters {
	return webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:     webrtc.MimeTypeH265,
			ClockRate:    90000,
			SDPFmtpLine:  fmtp,
			RTCPFeedback: videoFeedback,
		},
		PayloadType: 116,
	}
}

// videoFeedback 与 Pion 默认视频 codec 的反馈集合一致：NACK/PLI 要协商上，
// 否则丢一个包只能等下一个关键帧（我们 0.5 秒一个，但没必要白等）。
var videoFeedback = []webrtc.RTCPFeedback{
	{Type: "goog-remb"},
	{Type: "ccm", Parameter: "fir"},
	{Type: "nack"},
	{Type: "nack", Parameter: "pli"},
	{Type: "transport-cc"},
}

// newHEVCAPI 造一份"只谈 H265（+Opus）"的 API。
//
// 为什么不复用全局 api：Pion 的 MediaEngine 没有 unregister，而 SDP 里的 a=fmtp 是
// **MediaEngine 注册项**决定的（Track 上的 fmtp 只参与答案匹配，不进 offer）。
// 每个 HEVC 会话的 sprop 可能不同（编码器重启会换参数集），所以为每次 HEVC offer
// 新建一个 MediaEngine 最干净；H.264 会话继续用全局 api，完全不受影响。
func newHEVCAPI(fmtp string, sePtr *webrtc.SettingEngine) (*webrtc.API, error) {
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(h265Codec(fmtp), webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	// 音频沿用默认参数（页面只认 opus；保留 PT 111 让 SDP 与 H.264 路径一致）
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}

	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		return nil, err
	}
	if f, err := nack.NewResponderInterceptor(nack.ResponderSize(4096)); err == nil {
		ir.Add(f)
	}
	se := *sePtr
	return webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithSettingEngine(se), webrtc.WithInterceptorRegistry(ir)), nil
}

// decodeSprop 只用于诊断日志：把 base64 sprop 解成 NAL 头信息/长度，便于一眼看出
// "SDP 里带的是不是真的 VPS/SPS/PPS"。解不开就返回长度 0。
func decodeSprop(b64 string) (nalType int, size int) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(raw) < 2 {
		return -1, 0
	}
	return int(raw[0]>>1) & 0x3f, len(raw)
}

func describeSprop(name, b64 string) string {
	t, n := decodeSprop(b64)
	if t < 0 {
		return name + "=(无效)"
	}
	return fmt.Sprintf("%s=%dB(type %d)", name, n, t)
}
