package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

type answerReq struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

func main() {
	port := flag.Int("port", 9800, "local signaling port")
	fps := flag.Int("fps", 60, "frame rate for sample duration")
	flag.Parse()

	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		panic(err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(me))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		panic(err)
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "profile-level-id=42e032;packetization-mode=1"},
		"video", "pa-h264",
	)
	if err != nil {
		panic(err)
	}
	if _, err = pc.AddTrack(track); err != nil {
		panic(err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		panic(err)
	}
	gatherDone := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		panic(err)
	}
	<-gatherDone

	// 打印 offer（JSON/base64 由 Node 侧转换使用）
	out := map[string]string{"type": "offer", "sdp": pc.LocalDescription().SDP}
	b, _ := json.Marshal(out)
	fmt.Println("OFFER " + string(b))

	// 本地 HTTP 收 answer
	http.HandleFunc("/answer", func(w http.ResponseWriter, r *http.Request) {
		var a answerReq
		if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{
			Type: webrtc.SDPTypeAnswer, SDP: a.SDP,
		}); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		fmt.Fprintln(w, "ok")
	})
	go func() {
		_ = http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", *port), nil)
	}()

	// 从 stdin 读帧：u32 长度 + u8 key + payload
	rd := bufio.NewReaderSize(os.Stdin, 1<<20)
	dur := time.Second / time.Duration(*fps)
	for {
		var hdr [5]byte
		if _, err := io.ReadFull(rd, hdr[:]); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return
			}
			fmt.Println("read err: " + err.Error())
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
		if err := track.WriteSample(media.Sample{Data: buf, Duration: dur}); err != nil {
			fmt.Println("write sample err: " + err.Error())
			return
		}
	}
}
