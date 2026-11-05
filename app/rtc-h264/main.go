package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

var (
	mu    sync.Mutex
	offerS string
)

const pageHTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;background:#000;color:#eee;font:14px system-ui">
<video id="v" autoplay muted playsinline style="width:100vw;height:auto;display:block;background:#111"></video>
<div id="s" style="position:fixed;left:8px;bottom:8px;background:rgba(0,0,0,.6);padding:4px 8px;border-radius:6px">connecting…</div>
<script>
(async()=>{
 const s=document.getElementById('s');
 try{
  const offer=await (await fetch('/offer')).json();
  const pc=new RTCPeerConnection({iceServers:[]});
  pc.ontrack=(e)=>{ document.getElementById('v').srcObject=new MediaStream([e.track]); };
  pc.oniceconnectionstatechange=()=>{ s.textContent='ice '+pc.iceConnectionState; };
  await pc.setRemoteDescription(offer);
  const ans=await pc.createAnswer(); await pc.setLocalDescription(ans);
  await new Promise(r=>{ if(pc.iceGatheringState==='complete')return r(); pc.onicegatheringstatechange=()=>{ if(pc.iceGatheringState==='complete')r(); }; setTimeout(r,2000); });
  await fetch('/answer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(pc.localDescription)});
  const v=document.getElementById('v');
  setInterval(()=>{ s.textContent=(v.videoWidth?v.videoWidth+'x'+v.videoHeight:'no video')+' '+pc.iceConnectionState; },1000);
 }catch(e){ s.textContent='ERR '+e.message; }
})();
</script></body>`

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
func main() {
	port := flag.Int("port", 9800, "local HTTP/signaling port")
	fps := flag.Int("fps", 60, "frame rate for sample duration")
	loop := flag.Bool("loop", false, "replay frames forever (test mode)")
	tcpAddr := flag.String("tcp", "", "listen TCP and accept framed samples (live mode)")
	flag.Parse()

	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		panic(err)
	}
	se := webrtc.SettingEngine{}
	if ips := tailnetIPs(); len(ips) > 0 {
		se.SetNAT1To1IPs(ips, webrtc.ICECandidateTypeHost)
		fmt.Println("ICE advertise: " + fmt.Sprint(ips))
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithSettingEngine(se))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		panic(err)
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "profile-level-id=42c032;packetization-mode=1;level-asymmetry-allowed=1"},
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
	mu.Lock()
	offerS = pc.LocalDescription().SDP
	mu.Unlock()
	fmt.Println("OFFER ready, sdp len=" + fmt.Sprint(len(offerS)))

	http.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		io.WriteString(w, pageHTML)
	})
	http.HandleFunc("/offer", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		sdp := offerS
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"type": "offer", "sdp": sdp})
	})
	http.HandleFunc("/answer", func(w http.ResponseWriter, r *http.Request) {
		var a struct {
			Type string `json:"type"`
			SDP  string `json:"sdp"`
		}
		if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: a.SDP}); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		fmt.Fprintln(w, "ok")
	})
	go func() {
		_ = http.ListenAndServe(fmt.Sprintf("0.0.0.0:%d", *port), nil)
	}()

	dur := time.Second / time.Duration(*fps)
	if *loop {
		var frames [][]byte
		rdl := bufio.NewReaderSize(os.Stdin, 1<<20)
		for {
			var hdr [5]byte
			if _, err := io.ReadFull(rdl, hdr[:]); err != nil {
				break
			}
			n := binary.BigEndian.Uint32(hdr[:4])
			if n == 0 || n > 8<<20 {
				continue
			}
			buf := make([]byte, n)
			if _, err := io.ReadFull(rdl, buf); err != nil {
				break
			}
			frames = append(frames, buf)
		}
		fmt.Println("loop frames=" + fmt.Sprint(len(frames)))
		for {
			for _, b := range frames {
				_ = track.WriteSample(media.Sample{Data: b, Duration: dur})
				time.Sleep(dur)
			}
		}
	}
	if *tcpAddr != "" {
		ln, err := net.Listen("tcp", *tcpAddr)
		if err != nil {
			panic(err)
		}
		fmt.Println("TCP listening " + *tcpAddr)
		durLive := time.Second / time.Duration(*fps)
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					continue
				}
				go func(c net.Conn) {
					defer c.Close()
					r := bufio.NewReaderSize(c, 1<<20)
					for {
						var hdr [5]byte
						if _, err := io.ReadFull(r, hdr[:]); err != nil {
							return
						}
						n := binary.BigEndian.Uint32(hdr[:4])
						if n == 0 || n > 8<<20 {
							continue
						}
						buf := make([]byte, n)
						if _, err := io.ReadFull(r, buf); err != nil {
							return
						}
						_ = track.WriteSample(media.Sample{Data: buf, Duration: durLive})
					}
				}(conn)
			}
		}()
		select {}
	}
	rd := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		var hdr [5]byte
		if _, err := io.ReadFull(rd, hdr[:]); err != nil {
			// stdin 结束（文件回放测试）时保持进程存活，方便浏览器连接观察画面
			for {
				time.Sleep(time.Second)
			}
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
