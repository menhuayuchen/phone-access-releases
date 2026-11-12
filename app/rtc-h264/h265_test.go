package main

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/pion/rtp/codecs"
)

// ---- 构造最小可识别的 HEVC NALU（只保证 2 字节头 + 指定类型）----
func hevcNALU(typ uint8, payloadLen int) []byte {
	// F=0(1bit) | Type(6bit) | LayerId(6bit) | TID+1(3bit=1)
	hdr0 := byte((typ & 0x3f) << 1)
	b := make([]byte, 2+payloadLen)
	b[0] = hdr0
	b[1] = 0x01
	for i := 0; i < payloadLen; i++ {
		b[2+i] = byte(i*7 + int(typ))
	}
	return b
}

func annexB(nals ...[]byte) []byte {
	var out []byte
	for _, n := range nals {
		out = append(out, 0x00, 0x00, 0x00, 0x01)
		out = append(out, n...)
	}
	return out
}

// Test in: 侧车用 Pion 的 H265Payloader（SkipAggregation，只发单 NAL + FU），
// 再用 Pion 的 H265Depacketizer 逐包还原。这是"打包是否 RFC 7798 正确"的第一道验收：
// 还原出来的 Annex-B 必须与输入逐字节一致，否则浏览器表现就是花屏/黑屏。
func TestH265PayloaderRoundTrip(t *testing.T) {
	vps := hevcNALU(32, 20)  // VPS
	sps := hevcNALU(33, 40)  // SPS
	pps := hevcNALU(34, 8)   // PPS
	irap := hevcNALU(19, 4000) // IDR_W_RADL（IRAP 16~21 里的 19）
	trail := hevcNALU(1, 600)  // 非关键帧
	frame := annexB(vps, sps, pps, irap, trail)

	pl := &codecs.H265Payloader{SkipAggregation: true}
	payloads := pl.Payload(packetMTU, frame)
	if len(payloads) == 0 {
		t.Fatal("payloader 没有产出任何包")
	}

	// 逐包按 RFC 7798 检查 + 用 pion 解包器还原
	var rebuilt []byte
	dep := &codecs.H265Depacketizer{}
	fuStarts, fuEnds, fuMids, ap := 0, 0, 0, 0
	var firstHdr []byte
	for i, p := range payloads {
		if len(p) < 2 {
			t.Fatalf("第 %d 个包太短：%d", i, len(p))
		}
		typ := int(p[0]>>1) & 0x3f
		switch {
		case typ == 48:
			ap++
		case typ == 49:
			if len(p) < 3 {
				t.Fatalf("FU 包太短：%d", len(p))
			}
			fu := p[2]
			isS, isE := fu&0x80 != 0, fu&0x40 != 0
			if isS {
				fuStarts++
			} else if isE {
				fuEnds++
			} else {
				fuMids++
			}
			if i == 0 {
				t.Fatalf("第 0 个包不该是 FU（应当是参数集单 NAL）")
			}
		default:
			if i == 0 {
				firstHdr = p
			}
		}
		out, err := dep.Unmarshal(p)
		if err != nil {
			t.Fatalf("解包第 %d 个包失败（type=%d）：%v", i, typ, err)
		}
		rebuilt = append(rebuilt, out...)
	}

	if ap != 0 {
		t.Fatalf("SkipAggregation=true 时不应出现 AP 聚合包，实际 %d 个", ap)
	}
	if fuStarts != 1 || fuEnds != 1 || fuMids < 1 {
		t.Fatalf("FU 分片首/尾/中间计数不对：S=%d E=%d mid=%d（应 1/1/>=1）", fuStarts, fuEnds, fuMids)
	}
	if !bytes.Equal(firstHdr, vps) {
		t.Fatalf("第一个包应是完整的 VPS 单 NAL（len=%d），实际 len=%d", len(vps), len(firstHdr))
	}
	if !bytes.Equal(rebuilt, frame) {
		t.Fatalf("还原后的 Annex-B 与输入不一致：input=%d rebuilt=%d", len(frame), len(rebuilt))
	}
	t.Logf("PASS: %d 个 NAL → %d 个 RTP 包（FU S/E=%d/%d，mid=%d），还原 %d 字节逐字节一致",
		5, len(payloads), fuStarts, fuEnds, fuMids, len(rebuilt))
}

// 关键帧不能超过 0.5 秒就来一次：确认 IRAP 大帧确实被切成多个包、且每包 <= MTU。
func TestH265PacketSizeCap(t *testing.T) {
	irap := hevcNALU(19, 3000)
	pl := &codecs.H265Payloader{SkipAggregation: true}
	ps := pl.Payload(packetMTU, annexB(irap))
	if len(ps) < 2 {
		t.Fatalf("3000 字节的 IRAP 应切成多包，实际 %d 包", len(ps))
	}
	for i, p := range ps {
		if len(p) > int(packetMTU) {
			t.Fatalf("第 %d 个包 %d 字节 > MTU %d", i, len(p), packetMTU)
		}
	}
}

func TestH265FmtpAndOpts(t *testing.T) {
	vps := hevcNALU(32, 12)
	sps := hevcNALU(33, 24)
	pps := hevcNALU(34, 6)
	b64 := func(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

	f := h265Fmtp(offerOpts{
		Codec: "hevc", Profile: "1", Level: "120", Tier: "0",
		SpropVPS: b64(vps), SpropSPS: b64(sps), SpropPPS: b64(pps),
	})
	for _, want := range []string{"profile-id=1", "level-id=120", "tier-flag=0", "tx-mode=SRST",
		"sprop-vps=" + b64(vps), "sprop-sps=" + b64(sps), "sprop-pps=" + b64(pps)} {
		if !bytes.Contains([]byte(f), []byte(want)) {
			t.Fatalf("fmtp 缺 %q：%s", want, f)
		}
	}
	// 默认值（没有 hvcC 时）：也要能生成一条合法的 fmtp
	d := h265Fmtp(offerOpts{Codec: "hevc"})
	if d != "level-id=120;profile-id=1;tier-flag=0;tx-mode=SRST" {
		t.Fatalf("默认 fmtp 不对：%s", d)
	}
	// 注入防护：带 ';' / 空格的 sprop 必须被丢掉，不能把 SDP 弄坏
	bad := h265Fmtp(offerOpts{Codec: "hevc", SpropVPS: "AAAA;drop=1", SpropSPS: "AA AA"})
	if bytes.Contains([]byte(bad), []byte("drop=1")) || bytes.Contains([]byte(bad), []byte("sprop-vps")) {
		t.Fatalf("非法 sprop 未被丢弃：%s", bad)
	}
	// 类型判定
	for _, c := range []string{"hevc", "HEVC", "h265"} {
		if !(offerOpts{Codec: c}).isHEVC() {
			t.Fatalf("%q 应判为 HEVC", c)
		}
	}
	for _, c := range []string{"", "h264", "avc"} {
		if (offerOpts{Codec: c}).isHEVC() {
			t.Fatalf("%q 不应判为 HEVC", c)
		}
	}
	// sprop 诊断能认出 NAL 类型
	if typ, n := decodeSprop(b64(vps)); typ != 32 || n != len(vps) {
		t.Fatalf("decodeSprop 结果不对：type=%d len=%d（应 32/%d）", typ, n, len(vps))
	}
	t.Logf("fmtp = %s", f)
}

// 既有的 H.264 路径不应被 HEVC 改动影响：H264Payloader 仍然产出 Annex-B 可还原的包。
func TestH264PathUnchanged(t *testing.T) {
	nal := hevcNALU(5, 500) // 这里只是造一段任意 NAL；H264 打包器只看 RFC6184 头
	nal[0] = 0x65          // IDR，Main profile
	pl := &codecs.H264Payloader{}
	ps := pl.Payload(packetMTU, annexB(nal))
	if len(ps) != 1 || !bytes.Equal(ps[0], nal) {
		t.Fatalf("H264Payloader 单 NAL 行为变了：%d 包", len(ps))
	}
}
