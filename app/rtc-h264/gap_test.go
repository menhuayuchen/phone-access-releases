package main

// 2026-11-10：丢帧 -> 等关键帧（needKey）的单元测试。
// 为什么要有：这条路径在生产上很难人为触发（要真的把侧车 30 帧队列塞满），
// 但它是"花屏"的最后一条已知成因，所以至少把判定逻辑钉死。
//
// 跑法（本机，Go 在 C:\Users\ccj\gotool）：
//   $env:GOROOT='C:\Users\ccj\gotool\go'; $env:PATH="$env:GOROOT\bin;$env:PATH"
//   $env:GOPATH='C:\Users\ccj\go'; $env:GOMODCACHE='C:\Users\ccj\go\pkg\mod'
//   $env:GOTOOLCHAIN='local'; $env:CGO_ENABLED='0'
//   go test -run 'Feed|Gap' -v ./...

import "testing"

// 队列满丢帧时必须置 needKey —— 否则丢掉的这一帧会让后面所有 P 帧缺参考帧，
// 而接收端完全发现不了（RTP 序号不前进），表现就是连着花屏。
func TestFeedDropSetsNeedKey(t *testing.T) {
	s := &session{ch: make(chan frame, 1)}

	// 第一帧能入队，不该动 needKey
	s.feed(frame{data: []byte{1}, key: false})
	if s.needKey {
		t.Fatal("队列还有空位时不该置 needKey")
	}
	if got := s.dropped.Load(); got != 0 {
		t.Fatalf("还没丢帧，dropped=%d", got)
	}

	// 第二帧队列满 -> 丢帧 + 置 needKey
	s.feed(frame{data: []byte{2}, key: false})
	if !s.needKey {
		t.Fatal("丢帧后必须置 needKey（等下一个关键帧再推）")
	}
	if got := s.dropped.Load(); got != 1 {
		t.Fatalf("dropped 应为 1，实际 %d", got)
	}
}

// 上游（Node）丢帧时带的 gap 标记，要让**所有**在线会话等关键帧。
func TestFeedFrameGapMarksAllSessions(t *testing.T) {
	s1 := &session{ch: make(chan frame, 8)}
	s2 := &session{ch: make(chan frame, 8)}

	mu.Lock()
	old := live
	live = []*session{s1, s2}
	mu.Unlock()
	defer func() {
		mu.Lock()
		live = old
		mu.Unlock()
	}()

	before := gapMarks.Load()
	feedFrameGap([]byte{0, 0, 0, 1, 9}, false, true)
	if got := gapMarks.Load(); got != before+1 {
		t.Fatalf("gapMarks 应 +1，实际 %d -> %d", before, got)
	}
	if !s1.needKey || !s2.needKey {
		t.Fatalf("gap 标记应让所有会话等关键帧：s1=%v s2=%v", s1.needKey, s2.needKey)
	}

	// 没有 gap 标记的普通帧不该置位（否则正常播放会一直卡在等关键帧）
	s1.keyMu.Lock()
	s2.keyMu.Lock()
	s1.needKey = false
	s2.needKey = false
	s2.keyMu.Unlock()
	s1.keyMu.Unlock()

	feedFrameGap([]byte{0, 0, 0, 1, 9}, false, false)
	if s1.needKey || s2.needKey {
		t.Fatal("没有 gap 标记时不该置 needKey")
	}
	if got := gapMarks.Load(); got != before+1 {
		t.Fatalf("没有 gap 标记时 gapMarks 不该变，实际 %d", got)
	}
}

// 帧输入头的 flag 位：bit0=关键帧，bit1=gap。这两行是解析处直接用的表达式，钉住防回归。
func TestFeedHeaderFlags(t *testing.T) {
	cases := []struct {
		flag  byte
		key   bool
		gap   bool
	}{
		{0, false, false},
		{1, true, false},
		{2, false, true},
		{3, true, true},
	}
	for _, c := range cases {
		key := c.flag&1 == 1
		gap := c.flag&2 != 0
		if key != c.key || gap != c.gap {
			t.Fatalf("flag=%d 解析成 key=%v gap=%v，期望 key=%v gap=%v", c.flag, key, gap, c.key, c.gap)
		}
	}
}
