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
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/turn/v4"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const sidecarVersion = "0.3.0"

// ---------------------------------------------------------------- 会话

type frame struct {
	data []byte
	key  bool
}

type session struct {
	id       string
	pc       *webrtc.PeerConnection
	track    *webrtc.TrackLocalStaticSample
	ch       chan frame
	done     chan struct{}
	created  time.Time
	answered atomic.Bool
	ready    atomic.Bool
	stopped  atomic.Bool
	closeOne sync.Once
	keyMu    sync.Mutex
	needKey  bool
	sent     atomic.Uint64
	lastSent atomic.Int64
	dropped  atomic.Uint64
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
			if err := s.track.WriteSample(media.Sample{Data: f.data, Duration: sampleDur}); err != nil {
				logf("session %s WriteSample: %v", s.id, err)
				go dropSession(s.id, "write-error")
				return
			}
			s.sent.Add(1)
			s.lastSent.Store(time.Now().UnixMilli())
		}
	}
}

func (s *session) feed(f frame) {
	select {
	case s.ch <- f:
	default:
		s.dropped.Add(1)
		droppedFrames.Add(1)
	}
}

// ---------------------------------------------------------------- 全局状态

var (
	api       *webrtc.API
	sampleDur = time.Second / 60

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
	lastFrameUnix atomic.Int64
	startedAt     = time.Now()

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

// ---------------------------------------------------------------- 会话管理

func newSession() (*session, error) {
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	id := randHex(6)
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeH264,
		ClockRate:   90000,
		SDPFmtpLine: "profile-level-id=42c032;packetization-mode=1;level-asymmetry-allowed=1",
	}, "video", "pa-"+id)
	if err != nil {
		pc.Close()
		return nil, err
	}
	if _, err = pc.AddTrack(track); err != nil {
		pc.Close()
		return nil, err
	}
	s := &session{
		id:      id,
		pc:      pc,
		track:   track,
		ch:      make(chan frame, 3),
		done:    make(chan struct{}),
		created: time.Now(),
		needKey: true,
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

func feedFrame(data []byte, key bool) {
	framesIn.Add(1)
	lastFrameUnix.Store(time.Now().UnixMilli())
	mu.Lock()
	ls := live
	mu.Unlock()
	if len(ls) == 0 {
		droppedFrames.Add(1)
		return
	}
	for _, s := range ls {
		if s.stopped.Load() {
			continue
		}
		s.feed(frame{data: data, key: key})
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

	s, err := newSession()
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
	logf("session %s offer 就绪（sdp %d 字节，已有 %d 路会话）", s.id, len(ld.SDP), liveCount())
	writeJSON(w, 200, map[string]any{
		"ok":       true,
		"sid":      s.id,
		"type":     "offer",
		"sdp":      ld.SDP,
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
	mu.Unlock()
	turnMu.Lock()
	tok, tp := turnOK, turnPort
	turnMu.Unlock()
	writeJSON(w, 200, map[string]any{
		"ok":          true,
		"version":     sidecarVersion,
		"uptimeSec":   int64(time.Since(startedAt).Seconds()),
		"sessions":    n,
		"pending":     pending,
		"lastFrameMs": age,
		"framesIn":    framesIn.Load(),
		"dropped":     droppedFrames.Load(),
		"turnOk":      tok,
		"turnPort":    tp,
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
 try{
  const o=await (await fetch('/offer',{method:'POST'})).json();
  if(!o||!o.sdp) throw new Error('no offer');
  const ice=[{urls:'stun:stun.cloudflare.com:3478'}];
  if(o.turnOk&&o.turnPort) ice.unshift({urls:'turn:'+location.hostname+':'+o.turnPort+'?transport=udp',username:o.turnUser,credential:o.turnPass});
  const pc=new RTCPeerConnection({iceServers:ice,iceTransportPolicy:relay?'relay':'all'});
  window.__pc=pc;
  const v=document.getElementById('v');
  pc.ontrack=(e)=>{ v.srcObject=new MediaStream([e.track]); };
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
	fps := flag.Int("fps", 60, "帧率（Sample 时长的分母）")
	loop := flag.Bool("loop", false, "回放 stdin 收到的帧（测试模式）")
	tcpAddr := flag.String("tcp", "", "监听 TCP 接收帧：addr:port")
	turnPort := flag.Int("turn-port", 3478, "内置 TURN 的 UDP 端口，0 表示关闭")
	turnIP := flag.String("turn-ip", "", "覆盖 TURN 中继/监听地址（默认取第一个 tailnet IP）")
	logFile := flag.String("log", "", "日志文件（可选）")
	flag.Parse()

	logPath = *logFile
	sampleDur = time.Second / time.Duration(*fps)
	if *fps <= 0 {
		sampleDur = time.Second / 60
	}

	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		logf("register codecs: %v", err)
		os.Exit(1)
	}
	se := webrtc.SettingEngine{}
	ips := tailnetIPs()
	if len(ips) > 0 {
		se.SetNAT1To1IPs(ips, webrtc.ICECandidateTypeHost)
		logf("ICE 对外地址：%v", ips)
	} else {
		logf("没有发现 tailnet IP，只会有本机候选（真机跨网会连不上）")
	}
	api = webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithSettingEngine(se))

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
						feedFrame(buf, hdr[4] == 1)
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
		feedFrame(buf, hdr[4] == 1)
	}
}
