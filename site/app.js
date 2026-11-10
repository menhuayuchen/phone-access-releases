/* 轻器 · 站点脚本 v3
   ------------------------------------------------------------------
   ① 点阵字：扫描点亮 → 落定闪一下 → 呼吸 + 光标推开 + 偶发信号抖动
   ② 画面扫描：示意屏 + 扫描光带 + 自己会动的光标
   ③ 读数跳动 ④ 滚动进度
   规矩：无依赖、无追踪、无网络请求；全部按可见性 / 省电 / 后台启停。
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DPR = Math.min(window.devicePixelRatio || 1, 1.6);
  var CJK = '600 %s "PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei",sans-serif';

  function gate(el, start, stop) {
    /* 首屏不等 observer：直接开，避免后台标签页或观察器延迟导致一片空白 */
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight || 800;
    if (r.top < vh + 160 && r.bottom > -160) start();
    if (!('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].isIntersecting) start(); else stop();
      }
    }, { rootMargin: '160px 0px' }).observe(el);
  }

  function pad4(n) { n = Math.round(n); return ('000' + n).slice(-4); }

    var SPR_FRAMES = {
      idle: [
        '........................',
        '........................',
        '........................',
        '........................',
        '........................',
        '........kkkkkkkkk.......',
        '......kkllllllbbbkk.....',
        '.....kllllllllbbbbbk....',
        '....klllllllllbbbbbbk...',
        '...kllwwwlllllbwwwbbbk..',
        '...kllwpwlllllbwpwbbbk..',
        '...kbbwwwbbbbbbwwwbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbkbbkbbbbbbbk..',
        '....kbbbbbbkkbbbbbbbk...',
        '.....kbbbbbbbbbbbbbk....',
        '......kkdddddddddkk.....',
        '........kkkkkkkkk.......',
        '........kkk..kkk........',
        '........kdk..kdk........',
        '........kdk..kdk........',
        '........................',
        '........................'
      ],
      blink: [
        '........................',
        '........................',
        '........................',
        '........................',
        '........................',
        '........kkkkkkkkk.......',
        '......kkllllllbbbkk.....',
        '.....kllllllllbbbbbk....',
        '....klllllllllbbbbbbk...',
        '...kllllllllllbbbbbbbk..',
        '...kllkkklllllbkkkbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbkbbkbbbbbbbk..',
        '....kbbbbbbkkbbbbbbbk...',
        '.....kbbbbbbbbbbbbbk....',
        '......kkdddddddddkk.....',
        '........kkkkkkkkk.......',
        '........kkk..kkk........',
        '........kdk..kdk........',
        '........kdk..kdk........',
        '........................',
        '........................'
      ],
      happy: [
        '........................',
        '........................',
        '........................',
        '........................',
        '........................',
        '........kkkkkkkkk.......',
        '......kkllllllbbbkk.....',
        '.....kllllllllbbbbbk....',
        '....klllllllllbbbbbbk...',
        '...klllkllllllbbkbbbbk..',
        '...kllklklllllbkbkbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbkkkkkkbbbbbbk..',
        '....kbbbbbkkkkbbbbbbk...',
        '.....kbbbbbbbbbbbbbk....',
        '......kkdddddddddkk.....',
        '........kkkkkkkkk.......',
        '........kkk..kkk........',
        '........kdk..kdk........',
        '........kdk..kdk........',
        '........................',
        '........................'
      ],
      surprise: [
        '........................',
        '........................',
        '........................',
        '........................',
        '........................',
        '........kkkkkkkkk.......',
        '......kkllllllbbbkk.....',
        '.....kllllllllbbbbbk....',
        '....kwwwwlllllbwwwwbk...',
        '...klwppwlllllbwppwbbk..',
        '...klwppwlllllbwppwbbk..',
        '...kbwwwwbbbbbbwwwwbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbkkbbbbbbbbk..',
        '....kbbbbbbkkbbbbbbbk...',
        '.....kbbbbbbbbbbbbbk....',
        '......kkdddddddddkk.....',
        '........kkkkkkkkk.......',
        '........kkk..kkk........',
        '........kdk..kdk........',
        '........kdk..kdk........',
        '........................',
        '........................'
      ],
      angry: [
        '........................',
        '........................',
        '........................',
        '........................',
        '........................',
        '........kkkkkkkkk.......',
        '......kkllllllbbbkk.....',
        '.....kllllllllbbbbbk....',
        '....klllllllllbbbbbbk...',
        '...kllelllllllbebbbbbk..',
        '...kllleelllllbbeebbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbkkkbbbbbbbk..',
        '....kbbbbbbbbbbbbbbbk...',
        '.....kbbbbbbbbbbbbbk....',
        '......kkdddddddddkk.....',
        '........kkkkkkkkk.......',
        '........kkk..kkk........',
        '........kdk..kdk........',
        '........kdk..kdk........',
        '........................',
        '........................'
      ],
      love: [
        '........................',
        '........................',
        '........................',
        '........................',
        '........................',
        '........kkkkkkkkk.......',
        '......kkllllllbbbkk.....',
        '.....kllllllllbbbbbk....',
        '....klllllllllbbbbbbk...',
        '...kllelelllllbebebbbk..',
        '...klleeelllllbeeebbbk..',
        '...kbbbebbbbbbbbebbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbkbbkbbbbbbbk..',
        '....kbbbbbbkkbbbbbbbk...',
        '.....kbbbbbbbbbbbbbk....',
        '......kkdddddddddkk.....',
        '........kkkkkkkkk.......',
        '........kkk..kkk........',
        '........kdk..kdk........',
        '........kdk..kdk........',
        '........................',
        '........................'
      ],
      dizzy: [
        '........................',
        '........................',
        '........................',
        '........................',
        '........................',
        '........kkkkkkkkk.......',
        '......kkllllllbbbkk.....',
        '.....kllllllllbbbbbk....',
        '....klllllllllbbbbbbk...',
        '...kllklklllllbkbkbbbk..',
        '...kllllllllllbbbbbbbk..',
        '...kbbkbkbbbbbbkbkbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbkkkbbbbbbbk..',
        '....kbbbbbbbbbbbbbbbk...',
        '.....kbbbbbbbbbbbbbk....',
        '......kkdddddddddkk.....',
        '........kkkkkkkkk.......',
        '........kkk..kkk........',
        '........kdk..kdk........',
        '........kdk..kdk........',
        '........................',
        '........................'
      ],
      sleep: [
        '........................',
        '........................',
        '........................',
        '........................',
        '........................',
        '........kkkkkkkkk.......',
        '......kkllllllbbbkk.....',
        '.....kllllllllbbbbbk....',
        '....klllllllllbbbbbbk...',
        '...kllllllllllbbbbbbbk..',
        '...kllkkklllllbkkkbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '...kbbbbbbbbbbbbbbbbbk..',
        '....kbbbbbbbbbbbbbbbk...',
        '.....kbbbbbbbbbbbbbk....',
        '......kkdddddddddkk.....',
        '........kkkkkkkkk.......',
        '........kkk..kkk........',
        '........kdk..kdk........',
        '........kdk..kdk........',
        '........................',
        '........................'
      ],
      walkA: [
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '........kkkkkkkkk.......',
    '......kkllllllbbbkk.....',
    '.....kllllllllbbbbbk....',
    '....klllllllllbbbbbbk...',
    '...kllwwwlllllbwwwbbbk..',
    '...kllwpwlllllbwpwbbbk..',
    '...kbbwwwbbbbbbwwwbbbk..',
    '...kbbbbbbbbbbbbbbbbbk..',
    '...kbbbbbbbbbbbbbbbbbk..',
    '...kbbbbbbkbbkbbbbbbbk..',
    '....kbbbbbbkkbbbbbbbk...',
    '.....kbbbbbbbbbbbbbk....',
    '......kkdddddddddkk.....',
    '........kkkkkkkkk.......',
    '.......kkk....kkk.......',
    '.......kdk....kdk.......',
    '..............kdk.......',
    '........................',
    '........................'
  ],
  walkB: [
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '........kkkkkkkkk.......',
    '......kkllllllbbbkk.....',
    '.....kllllllllbbbbbk....',
    '....klllllllllbbbbbbk...',
    '...kllwwwlllllbwwwbbbk..',
    '...kllwpwlllllbwpwbbbk..',
    '...kbbwwwbbbbbbwwwbbbk..',
    '...kbbbbbbbbbbbbbbbbbk..',
    '...kbbbbbbbbbbbbbbbbbk..',
    '...kbbbbbbkbbkbbbbbbbk..',
    '....kbbbbbbkkbbbbbbbk...',
    '.....kbbbbbbbbbbbbbk....',
    '......kkdddddddddkk.....',
    '........kkkkkkkkk.......',
    '........kkk..kkk........',
    '........kdk..kdk........',
    '........kdk.............',
    '........................',
    '........................'
  ],
};
    
        var SPRPAL = { k:'15,15,14', b:'11,216,182', l:'123,240,220', d:'10,140,124', w:'246,244,239', p:'15,15,14', e:'224,164,88' };

  /* ================================================================ */
  /* ① 点阵字                                                          */
  /* ================================================================ */
  function dotMatrix(cv) {
    var ctx = cv.getContext('2d');
    var host = cv.closest('[data-glyph-host]') || cv.parentNode;
    var osd = host.querySelector('[data-osd]');
    var WORD_A = cv.getAttribute('data-text') || '轻器';
    var WORD_B = cv.getAttribute('data-text-b') || '轻屏';

    var W = 0, H = 0, setA = null, setB = null, on = false, raf = 0, last = 0;
    var t0 = -1, reveal = 0, revealing = true, pulse = 0, osdBase = '';
    var cx = 0, cy = 0, rmax = 1, osdAt = 0;
    var ptr = { x: -9e3, y: -9e3, on: false };
    var gl = { until: 0, y0: 0, h: 0, dx: 0, next: 0 };
    var M = { phase: 'idle', dir: 1, x: 0, t0: 0, showB: false, next: 0 };
    var curMask = 1;
    var sayEl = host.querySelector('[data-say]');
    var PET = { x: 0.26, dir: 1, last: 0, jumpAt: 0, jumpT: 0, jump: 0, scared: 0, sayAt: 0, sayUntil: 0, sayLine: 0 };
    var PET_LINES = ['(・ω・) 60fps', '(￣▽￣) 本地直连', '(・_・) 不用装 App', '(￣ー￣) 免注册', '(°ロ°) 屏在，人在', '(・∀・) LED 3883'];
    /* 器灵：15×13 像素，'#'=青（机身/天线/脚），'o'=纸白（眼睛），'.'=不亮 */


    /* 把字采样成点阵；每条记录存 alpha 与方块大小 */
    function sample(text) {
      var off = document.createElement('canvas');
      off.width = W; off.height = H;
      var o = off.getContext('2d');
      o.font = CJK.replace('%s', '100px');
      var per = Math.max(0.1, o.measureText(text).width / 100);
      var fs = Math.min(H * 0.99, (W - 4) / per);
      o.font = CJK.replace('%s', fs + 'px');
      o.textAlign = 'left';
      o.textBaseline = 'middle';
      o.fillStyle = '#fff';
      o.fillText(text, 2, H * 0.52);

      var data = o.getImageData(0, 0, W, H).data;
      var step = Math.max(4, Math.sqrt((W * H) / 7200));
      var out = [];
      for (var y = step * 0.5; y < H; y += step) {
        for (var x = step * 0.5; x < W; x += step) {
          var a = data[(((y | 0) * W) + (x | 0)) * 4 + 3] / 255;
          if (a < 0.05) continue;
          out.push({ x: x, y: y, a: a, s: step * (0.42 + 0.34 * a) });
        }
      }
      return { dots: out, step: step };
    }

    function wordNow() { return M.showB ? WORD_B : WORD_A; }
    function countNow() { var s = M.showB ? setB : setA; return s ? s.dots.length : 0; }
    function osdReset() {
      osdBase = 'LED ' + countNow() + ' · ' + wordNow();
      if (osd) osd.textContent = osdBase;
    }

    function layout(boot) {
      var r = cv.getBoundingClientRect();
      W = Math.max(180, Math.round(r.width));
      H = Math.max(70, Math.round(r.height));
      cv.width = Math.round(W * DPR);
      cv.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

      setA = sample(WORD_A);
      setB = sample(WORD_B);
      cx = W * 0.5; cy = H * 0.52;
      rmax = Math.abs(0 - cx) + Math.abs(0 - cy);
      rmax = Math.max(rmax,
        Math.abs(W - cx) + Math.abs(0 - cy),
        Math.abs(0 - cx) + Math.abs(H - cy),
        Math.abs(W - cx) + Math.abs(H - cy));

      M.showB = false; M.phase = 'idle'; M.next = 0;
      t0 = boot ? -1 : performance.now() - 4000;
      reveal = boot ? 0 : 1;
      revealing = boot ? !RM : false;
      pulse = 0;
      osdReset();
      draw(performance.now());
      if (!RM && on && !raf) loop(performance.now());
    }

    function plot(d, ts, breath, boost, glitchOn) {
      var x = d.x, y = d.y, near = 0;
      if (ptr.on) {
        var dx = x - ptr.x, dy = y - ptr.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        if (dist < 150) {
          near = 1 - dist / 150;
          var push = near * near * 13;
          x += (dx / dist) * push;
          y += (dy / dist) * push;
        }
      }
      if (glitchOn && d.y > gl.y0 && d.y < gl.y0 + gl.h) x += gl.dx;

      var b = d.a * breath * boost * curMask;
      if (near > 0.02) b = b * (1 + near * 0.6);
      if (b > 1) b = 1;
      var s = d.s * (1 + near * 0.5);
      var r = 238, g = 238, bl = 236;
      if (near > 0.02) {
        r = Math.round(238 - 227 * near);
        g = Math.round(238 - 22 * near);
        bl = Math.round(236 - 54 * near);
      }
      ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + bl + ',' + b.toFixed(3) + ')';
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }

    /* 住在点阵屏上的小生物：走、眨眼、跳、被鼠标吓跑、偶尔说话 */
    function drawPet(ts) {
      var cell = (setA ? setA.step : 5) * 0.82;
      if (!PET.last) PET.last = ts;
      var dt = Math.min(64, ts - PET.last);
      PET.last = ts;

      var groundY = H * 0.95;
      var speed = (W / 820) * 0.08;
      if (PET.scared > 0) speed *= 2.4;

      var px0 = PET.x * W;
      if (ptr.on) {
        var dx = px0 - ptr.x, dy = groundY - ptr.y;
        if (Math.sqrt(dx * dx + dy * dy) < 150) {
          PET.scared = 1;
          PET.dir = dx >= 0 ? 1 : -1;
        }
      }
      if (PET.scared > 0) PET.scared = Math.max(0, PET.scared - dt / 850);

      PET.x += PET.dir * speed * dt / W;
      if (PET.x > 0.95) { PET.x = 0.95; PET.dir = -1; }
      if (PET.x < 0.03) { PET.x = 0.03; PET.dir = 1; }

      if (!PET.jumpAt) PET.jumpAt = ts + 2600 + Math.random() * 4200;
      if (ts > PET.jumpAt && !PET.jumpT) { PET.jumpT = ts; PET.jumpAt = 0; }
      if (PET.jumpT) {
        var k = (ts - PET.jumpT) / 560;
        if (k >= 1) { PET.jumpT = 0; PET.jump = 0; }
        else PET.jump = Math.sin(k * Math.PI) * 1.5;
      }

      var px = PET.x * W - 12 * cell;

      /* ---- 情绪状态机 ---- */
      if (!PET.mood) PET.mood = 'idle';
      if (!PET.moodUntil) PET.moodUntil = 0;
      if (!PET.idleSince) PET.idleSince = ts;
      if (PET.scared > 0.4) { PET.mood = 'angry'; PET.moodUntil = ts + 900; PET.idleSince = ts; }
      else if (PET.sayUntil) { PET.idleSince = ts; }
      if (ts > PET.moodUntil && PET.mood !== 'idle' && PET.mood !== 'sleep') PET.mood = 'idle';

      /* 长时间不动就想睡 */
      if (PET.mood === 'idle' && ts - PET.idleSince > 16000) { PET.mood = 'sleep'; }
      if (PET.mood === 'sleep' && (ptr.on || PET.scared > 0)) { PET.mood = 'surprise'; PET.moodUntil = ts + 700; PET.idleSince = ts; }

      /* 帧选择：情绪优先，其次眨眼，最后走路两帧交替 */
      var grid;
      if (PET.mood === 'sleep') grid = SPR_FRAMES.sleep;
      else if (PET.mood === 'angry') grid = SPR_FRAMES.angry;
      else if (PET.mood === 'surprise') grid = SPR_FRAMES.surprise;
      else if (PET.mood === 'happy') grid = SPR_FRAMES.happy;
      else if ((ts % 4200) < 110) grid = SPR_FRAMES.blink;
      else grid = (Math.floor(ts / 190) % 2) ? SPR_FRAMES.walkB : SPR_FRAMES.walkA;

      /* 挤压拉伸：起跳前压扁，空中拉长 */
      var sq = 1, st = 1;
      if (PET.jumpT) {
        var jk = (ts - PET.jumpT) / 560;
        if (jk < 0.18) { sq = 1.12; st = 0.88; }
        else if (jk > 0.82) { sq = 1.10; st = 0.90; }
        else { sq = 0.94; st = 1.07; }
      }
      var bobY = PET.scared > 0 ? Math.sin(ts * 0.021) * 0.2 : Math.sin(ts * 0.008) * 0.16;
      var py = groundY - 17 * cell * st - (PET.jump + bobY) * cell;
      var pal = SPRPAL;
      var stepX = cell * sq, stepY = cell * st;
      var rows = grid.length, cols = grid[0].length;
      var px0 = px + (12 * cell - 12 * stepX);

      /* 先铺一层极淡暗底：让它在字上也读得出来 */
      ctx.fillStyle = 'rgba(15,15,14,.55)';
      ctx.fillRect(px0 + stepX * 0.5, py + stepY * 0.5, cols * stepX - stepX, rows * stepY - stepY);

      /* 瞳孔跟随指针 */
      var lookX = 0, lookY = 0;
      if (ptr.on) {
        var ldx = ptr.x - (px0 + 12 * stepX), ldy = ptr.y - (py + 12 * stepY);
        var len = Math.sqrt(ldx * ldx + ldy * ldy) || 1;
        if (len > 24) { lookX = ldx / len > 0.35 ? 1 : (ldx / len < -0.35 ? -1 : 0); lookY = ldy / len > 0.35 ? 1 : (ldy / len < -0.35 ? -1 : 0); }
      }

      for (var r = 0; r < rows; r++) {
        var line = grid[r];
        for (var c = 0; c < cols; c++) {
          var v = line.charAt(c);
          if (v === '.') continue;
          var rgb = pal[v];
          if (!rgb) continue;
          var x = px0 + c * stepX, y = py + r * stepY;
          if (v === 'p') { x += lookX * stepX; y += lookY * stepY; }
          ctx.fillStyle = 'rgba(' + rgb + ',.95)';
          ctx.fillRect(x, y, stepX * 1.02, stepY * 1.02);
        }
      }

      /* 对话框 */
      if (sayEl) {
        if (!PET.sayAt) PET.sayAt = ts + 3200 + Math.random() * 4000;
        if (!PET.sayUntil && ts > PET.sayAt) {
          PET.sayLine = (PET.sayLine + 1) % PET_LINES.length;
          sayEl.textContent = PET.scared > 0 ? '(；´д｀) 别碰我屏幕' : (PET.mood === 'happy' ? '(・∀・) 嘿嘿' : PET_LINES[PET.sayLine]);
          sayEl.style.opacity = '1';
          PET.sayUntil = ts + 2600;
          PET.sayAt = 0;
        } else if (PET.sayUntil && ts > PET.sayUntil) {
          sayEl.style.opacity = '0';
          PET.sayUntil = 0;
          PET.sayAt = ts + 4200 + Math.random() * 5600;
        }
        if (PET.sayUntil) {
          sayEl.style.left = Math.round(px + 12 * cell) + 'px';
          sayEl.style.top = Math.round(py) + 'px';
        }
      }
    }

    function draw(ts) {
      if (t0 < 0) t0 = ts;
      var t = ts - t0;

      if (revealing) {
        reveal = Math.min(1, t / 1150);
        if (reveal >= 1) { revealing = false; pulse = 1; }
      }
      if (pulse > 0) pulse = Math.max(0, pulse - 0.022);

      ctx.clearRect(0, 0, W, H);

      var rr = reveal * (rmax + 60);
      var breath = 0.88 + 0.12 * Math.sin(t * 0.0011);
      var boost = 1 + pulse * 0.55;
      var glitchOn = ts < gl.until;
      var wiping = M.phase === 'wipe';

      /* 换台：按列从左（或从右）改写内容 */
      if (wiping) {
        var inSet = M.dir > 0 ? setB : setA;
        var outSet = M.dir > 0 ? setA : setB;
        var i, d;
        for (i = 0; i < outSet.dots.length; i++) {
          d = outSet.dots[i];
          if (M.dir > 0 ? d.x < M.x : d.x >= M.x) continue;
          curMask = 1;
          if (revealing) {
            var m1 = (rr - (Math.abs(d.x - cx) + Math.abs(d.y - cy))) / 34;
            if (m1 <= 0) continue;
            curMask = m1 > 1 ? 1 : m1;
          }
          plot(d, ts, breath, boost, glitchOn);
        }
        for (i = 0; i < inSet.dots.length; i++) {
          d = inSet.dots[i];
          if (M.dir > 0 ? d.x >= M.x : d.x < M.x) continue;
          curMask = 1;
          if (revealing) {
            var m2 = (rr - (Math.abs(d.x - cx) + Math.abs(d.y - cy))) / 34;
            if (m2 <= 0) continue;
            curMask = m2 > 1 ? 1 : m2;
          }
          plot(d, ts, breath, boost, glitchOn);
        }
        /* 改写线 */
        ctx.fillStyle = 'rgba(11,216,182,.55)';
        ctx.fillRect(M.x, 0, 1, H);
      } else {
        var cur = M.showB ? setB : setA;
        for (var k = 0; k < cur.dots.length; k++) {
          var dd = cur.dots[k];
          curMask = 1;
          if (revealing) {
            var mm = (rr - (Math.abs(dd.x - cx) + Math.abs(dd.y - cy))) / 34;
            if (mm <= 0) continue;
            curMask = mm > 1 ? 1 : mm;
          }
          plot(dd, ts, breath, boost, glitchOn);
        }
      }


      /* 涟漪环 */
      if (revealing && rr < rmax + 40) {
        ctx.beginPath();
        ctx.moveTo(cx, cy - rr);
        ctx.lineTo(cx + rr, cy);
        ctx.lineTo(cx, cy + rr);
        ctx.lineTo(cx - rr, cy);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(11,216,182,.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      /* 偶发信号抖动 */
      if (!revealing && !RM && ts > gl.next && ts > gl.until) {
        gl.y0 = Math.random() * H * 0.82;
        gl.h = 10 + Math.random() * 18;
        gl.dx = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 5);
        gl.until = ts + 90 + Math.random() * 90;
        gl.next = ts + 5200 + Math.random() * 6400;
      }

      /* 换台调度：开机 9 秒后第一次，之后每 8~14 秒一次 */
      if (!revealing && !RM) {
        if (M.phase === 'idle') {
          if (!M.next) M.next = ts + 9000;
          else if (ts > M.next) { M.phase = 'wipe'; M.dir = M.showB ? -1 : 1; M.t0 = ts; }
        } else if (M.phase === 'wipe') {
          var p = Math.min(1, (ts - M.t0) / 460);
          M.x = M.dir > 0 ? (-24 + p * (W + 48)) : (W + 24 - p * (W + 48));
          if (p >= 1) {
            M.showB = M.dir > 0;
            M.phase = 'hold';
            M.t0 = ts;
            M.x = M.dir > 0 ? W + 24 : -24;
            osdReset();
          }
        } else if (M.phase === 'hold') {
          if (ts - M.t0 > 2600) { M.phase = 'idle'; M.next = ts + 8000 + Math.random() * 6000; }
        }
      }
    }

    function loop(ts) {
      if (!on) { raf = 0; return; }
      raf = requestAnimationFrame(loop);
      if (ts - last < 33) return;
      last = ts;
      draw(ts);
    }

    function start() {
      on = true;
      host.classList.add('is-live');
      if (!RM && !raf) loop(performance.now());
    }
    function stop() { on = false; if (sayEl) sayEl.style.opacity = '0'; if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    host.addEventListener('pointermove', function (e) {
      var r = cv.getBoundingClientRect();
      ptr.x = e.clientX - r.left;
      ptr.y = e.clientY - r.top;
      ptr.on = ptr.x > -140 && ptr.y > -140 && ptr.x < W + 140 && ptr.y < H + 140;
      if (osd && ptr.on) {
        var now = performance.now();
        if (now - osdAt > 80) {
          osdAt = now;
          osd.textContent = 'X ' + pad4(ptr.x) + ' · Y ' + pad4(ptr.y);
        }
      }
    }, { passive: true });
    host.addEventListener('pointerleave', function () {
      ptr.on = false;
      if (osd) osd.textContent = osdBase;
    });

    /* 点一下重播开机涟漪 */
    host.addEventListener('pointerdown', function (e) {
      if (RM) return;
      /* 点在它身上：笑一下并冒话；点在别处：重播开机涟漪 */
      var r = cv.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var petX = PET.x * W, petY = H * 0.95 - 12 * (setA ? setA.step : 5) * 0.82;
      if (Math.abs(mx - petX) < 70 && Math.abs(my - petY) < 80) {
        PET.mood = 'happy'; PET.moodUntil = performance.now() + 900;
        PET.sayAt = performance.now() + 60;
        PET.idleSince = performance.now();
        if (!raf && on) loop(performance.now());
        return;
      }
      t0 = -1; reveal = 0; revealing = true; pulse = 0; M.next = 0;
      if (!raf && on) loop(performance.now());
    });

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { stop(); layout(false); if (on) start(); }, 200);
    });

    layout(true);
    gate(host, start, stop);
  }
  /* ================================================================ */
  /* ② 画面扫描                                                        */
  /* ================================================================ */
  function scan(cv) {
    var ctx = cv.getContext('2d');
    var W = 0, H = 0, on = false, raf = 0, last = 0, y0 = 0;
    var cur = { x: .52, y: .48, tx: .52, ty: .48 }, nextAt = 0;

    function layout() {
      var r = cv.getBoundingClientRect();
      W = Math.max(120, Math.round(r.width));
      H = Math.max(80, Math.round(r.height));
      cv.width = Math.round(W * DPR);
      cv.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }

    function paint(t) {
      ctx.clearRect(0, 0, W, H);
      var pad = Math.round(W * 0.055);
      var bar = Math.round(H * 0.08);
      var line = 'rgba(255,255,255,.20)';
      var dim = 'rgba(255,255,255,.11)';

      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.strokeRect(pad + 0.5, pad + 0.5, W - pad * 2 - 1, H - pad * 2 - 1);
      ctx.beginPath();
      ctx.moveTo(pad, pad + bar);
      ctx.lineTo(W - pad, pad + bar);
      ctx.stroke();
      ctx.fillStyle = 'rgba(11,216,182,.85)';
      ctx.fillRect(pad + 10, pad + bar / 2 - 2, 4, 4);
      ctx.fillStyle = dim;
      for (var i = 0; i < 2; i++) ctx.fillRect(pad + 20 + i * 8, pad + bar / 2 - 2, 4, 4);

      var sb = Math.round((W - pad * 2) * 0.20);
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(pad, pad + bar, sb, H - pad * 2 - bar);
      ctx.fillStyle = dim;
      for (var j = 0; j < 3; j++) ctx.fillRect(pad + 8, pad + bar + 12 + j * 10, sb - 16, 3);

      var cx = pad + sb + 10, cw = W - pad * 2 - sb - 20;
      var ch = Math.round((H - pad * 2 - bar - 22) / 2);
      ctx.fillStyle = 'rgba(255,255,255,.075)';
      ctx.fillRect(cx, pad + bar + 10, cw, ch);
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(cx, pad + bar + 10 + ch + 8, cw, ch);
      ctx.fillStyle = dim;
      for (var k = 0; k < 3; k++) ctx.fillRect(cx + 8, pad + bar + 20 + k * 7, cw * 0.55, 3);

      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fillRect(pad, H - pad - 8, W - pad * 2, 8);

      var px = cur.x * W, py = cur.y * H;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py + 13);
      ctx.lineTo(px + 3.6, py + 9.6);
      ctx.lineTo(px + 8.8, py + 9.2);
      ctx.closePath();
      ctx.fillStyle = 'rgba(238,238,236,.95)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(15,15,14,.9)';
      ctx.stroke();

      if (!RM) {
        var top = pad + bar + 4, bot = H - pad - 12;
        var y = Math.max(top, Math.min(bot, y0));
        var hgt = Math.min(34, y - top);
        if (hgt > 2) {
          var g = ctx.createLinearGradient(0, y - hgt, 0, y);
          g.addColorStop(0, 'rgba(11,216,182,0)');
          g.addColorStop(0.78, 'rgba(11,216,182,.14)');
          g.addColorStop(1, 'rgba(11,216,182,.42)');
          ctx.fillStyle = g;
          ctx.fillRect(pad, y - hgt, W - pad * 2, hgt);
        }
        ctx.fillStyle = 'rgba(11,216,182,.45)';
        ctx.fillRect(pad, y, W - pad * 2, 1);
      }
    }

    function loop(ts) {
      if (!on || RM) { raf = 0; return; }
      raf = requestAnimationFrame(loop);
      if (ts - last < 40) return;
      last = ts;
      y0 += 3.4;
      if (y0 > H - 6) y0 = 6;
      if (ts > nextAt) {
        nextAt = ts + 1100 + Math.random() * 1900;
        cur.tx = 0.30 + Math.random() * 0.48;
        cur.ty = 0.28 + Math.random() * 0.44;
      }
      cur.x += (cur.tx - cur.x) * 0.055;
      cur.y += (cur.ty - cur.y) * 0.055;
      paint(ts);
    }

    function start() {
      on = true;
      if (RM) { paint(0); return; }
      if (!raf) raf = requestAnimationFrame(loop);
    }
    function stop() { on = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { layout(); paint(0); }, 200);
    });

    layout();
    paint(0);
    gate(cv, start, stop);
  }

  /* ================================================================ */
  /* ③ 读数跳动                                                        */
  /* ================================================================ */
  function ticker() {
    var nodes = [].slice.call(document.querySelectorAll('[data-tick]'));
    if (!nodes.length || RM) return;

    var items = nodes.map(function (el) {
      var p = (el.getAttribute('data-tick') || '60|55|65|1').split('|');
      return { el: el, mid: +p[0], lo: +p[1], hi: +p[2], dec: +p[3], cur: +p[0] };
    });

    var on = false, raf = 0, last = 0;
    function step(ts) {
      if (!on) { raf = 0; return; }
      raf = requestAnimationFrame(step);
      if (ts - last < 260) return;
      last = ts;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        it.cur += (it.mid - it.cur) * 0.42 + (Math.random() - 0.5) * (it.hi - it.lo) * 0.30;
        if (it.cur < it.lo) it.cur = it.lo;
        if (it.cur > it.hi) it.cur = it.hi;
        it.el.textContent = it.cur.toFixed(it.dec);
      }
    }
    function start() { if (!on) { on = true; raf = requestAnimationFrame(step); } }
    function stop() { on = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    gate(nodes[0].closest('section') || nodes[0], start, stop);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else if (!on) start();
    });
  }

  /* ================================================================ */
  /* ④ 滚动进度                                                        */
  /* ================================================================ */
  function progress() {
    var bar = document.querySelector('[data-progress]');
    if (!bar) return;
    var queued = false;
    function upd() {
      queued = false;
      var h = document.documentElement.scrollHeight - window.innerHeight;
      var p = h > 0 ? (window.scrollY / h) : 0;
      p = Math.max(0, Math.min(1, p));
      /* 一排刻度从左往右填，而不是一根进度条 */
      bar.style.clipPath = 'inset(0 ' + ((1 - p) * 100).toFixed(2) + '% 0 0)';
    }
    window.addEventListener('scroll', function () {
      if (!queued) { queued = true; requestAnimationFrame(upd); }
    }, { passive: true });
    upd();
  }

  /* ================================================================ */
  /* ⑥ 磁吸按钮：靠近时被指针轻轻拉过去                              */
  /* ================================================================ */
  function magnets() {
    if (RM || !(window.matchMedia && matchMedia('(hover: hover)').matches)) return;
    [].forEach.call(document.querySelectorAll('[data-magnet]'), function (el) {
      var tx = 0, ty = 0, cx = 0, cy = 0, raf = 0, live = false;

      function step() {
        raf = 0;
        cx += (tx - cx) * 0.22;
        cy += (ty - cy) * 0.22;
        el.style.transform = 'translate3d(' + cx.toFixed(2) + 'px,' + cy.toFixed(2) + 'px,0)';
        if (Math.abs(cx - tx) > 0.08 || Math.abs(cy - ty) > 0.08) raf = requestAnimationFrame(step);
        else if (!live) el.style.transform = '';
      }

      function kick() { if (!raf) raf = requestAnimationFrame(step); }

      el.addEventListener('pointerenter', function () { live = true; });
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        tx = (e.clientX - (r.left + r.width / 2)) * 0.16;
        ty = (e.clientY - (r.top + r.height / 2)) * 0.26;
        kick();
      }, { passive: true });
      el.addEventListener('pointerleave', function () { live = false; tx = 0; ty = 0; kick(); });
    });
  }

  /* ================================================================ */
  /* ⑤ 点阵字随滚动轻微位移（很轻，只改 transform）                      */
  /* ================================================================ */
  function parallax() {
    var el = document.querySelector('[data-glyph]');
    if (!el || RM) return;
    var queued = false;
    function upd() {
      queued = false;
      var p = Math.max(-1, Math.min(1, window.scrollY / 620));
      el.style.transform = 'translate3d(' + (p * -10).toFixed(2) + 'px,0,0)';
    }
    window.addEventListener('scroll', function () {
      if (!queued) { queued = true; requestAnimationFrame(upd); }
    }, { passive: true });
    upd();
  }

  /* ================================================================ */
  /* ================================================================ */
  /* ⑦ 器灵：整页游走 + 像素闪现                                        */
  /* ================================================================ */
  function pagePet() {
    if (RM) return;                       /* 减弱动效：不出现 */
    var cv = document.createElement('canvas');
    cv.className = 'pet-layer';
    cv.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cv);
    var ctx = cv.getContext('2d');
    var sayEl = document.createElement('span');
    sayEl.className = 'pet-say mono';
    sayEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sayEl);

    var VW = 0, VH = 0, cell = 3.2;
    var P = {
      x: 0, y: 0, dir: 1, floor: 0, target: 0,
      state: 'walk', tState: 0, nextTp: 0,
      mood: 'idle', moodUntil: 0, idleSince: 0, scared: 0,
      sayAt: 0, sayUntil: 0, sayLine: 0, squash: 1, stretch: 1, lookX: 0, lookY: 0,
      jump: 0, jumpT: 0, nextJump: 0, tx: 0, ty: 0,
      tpCount: 0, restUntil: 0
    };
    var ptr = { x: -9e3, y: -9e3, on: false };
    var LINES = [
      '(・ω・) 60fps', '(￣▽￣) 本地直连', '(・_・) 不用装 App', '(￣ー￣) 免注册',
      '(°ロ°) 屏在，人在', '(・∀・) LED 3883', '(◕‿◕) 你好呀', '(・・)و 手机也能看',
      '(¬_¬) 不走厂商服务器', '(￣ω￣) 大文件也能传', '(・▽・) 声音也有', '(°▽°) 局域网真快'
    ];
    var LINE_REST = ['(－_－) Zzz', '(´-ω-) 歇一会儿', '(￣o￣) zzz'];
    var LINE_HAPPY = ['(・∀・) 嘿嘿', '(＾▽＾) 诶嘿', '(づ｡◕‿‿◕｡)づ'];
    var LINE_SCARE = ['(；´д｀) 别碰我', '(>_<) 走开啦'];
    var PAL = { k: '15,15,14', b: '11,216,182', l: '123,240,220', d: '10,140,124', w: '246,244,239', p: '15,15,14', e: '224,164,88' };
    var floors = [];

    function scanFloors() {
      floors = [];
      var els = document.querySelectorAll('main > section, main > div, section, .strip, footer');
      var sy = window.scrollY;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var r = el.getBoundingClientRect();
        if (r.height < 90) continue;
        var top = r.top + sy, bottom = r.bottom + sy;
        floors.push({ y: bottom - 4, x0: Math.max(20, r.left + 30), x1: Math.min(document.documentElement.clientWidth - 30, r.right - 30) });
      }
      if (!floors.length) floors.push({ y: window.innerHeight - 20, x0: 40, x1: window.innerWidth - 40 });
      if (P.y === 0) { P.floor = 0; P.y = floors[0].y; P.x = (floors[0].x0 + floors[0].x1) / 2; }
    }

    function save() {
      try {
        var f = floorOf(P.floor);
        var r = (P.x - f.x0) / Math.max(1, f.x1 - f.x0);
        localStorage.setItem('qiling.v1', JSON.stringify({ f: P.floor, r: Math.max(0, Math.min(1, r)), t: Date.now() }));
      } catch (e) {}
    }
    function restore() {
      try {
        var raw = localStorage.getItem('qiling.v1');
        if (!raw) return false;
        var s = JSON.parse(raw);
        if (!s || Date.now() - s.t > 6e5) return false;
        P.floor = Math.min(s.f, floors.length - 1);
        var f = floorOf(P.floor);
        P.x = f.x0 + (s.r || 0.5) * (f.x1 - f.x0);
        P.y = f.y;
        P.state = 'in'; P.tState = performance.now() - 120;
        P.tx = P.x; P.ty = P.y;
        return true;
      } catch (e) { return false; }
    }
    function resize() {
      VW = window.innerWidth; VH = window.innerHeight;
      cv.width = Math.round(VW * DPR); cv.height = Math.round(VH * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      cell = VW < 700 ? 2.6 : 3.2;
    }

    function floorOf(i) { return floors[Math.min(i, floors.length - 1)] || { y: VH - 20, x0: 40, x1: VW - 40 }; }

    function pickTeleport() {
      var i = P.floor;
      for (var g = 0; g < 8 && i === P.floor; g++) i = Math.floor(Math.random() * floors.length);
      var f = floorOf(i);
      P.target = i;
      P.tx = f.x0 + Math.random() * Math.max(40, f.x1 - f.x0);
      P.ty = f.y;
      P.state = 'out'; P.tState = performance.now();
    }

    function step(ts, dt) {
      /* 情绪 */
      if (P.scared > 0.35) { P.mood = 'angry'; P.moodUntil = ts + 800; P.idleSince = ts; }
      if (ts > P.moodUntil && P.mood !== 'idle' && P.mood !== 'sleep') P.mood = 'idle';
      if (P.mood === 'idle' && ts - P.idleSince > 20000) P.mood = 'sleep';
      if (P.mood === 'sleep' && (ptr.on || P.scared > 0)) { P.mood = 'surprise'; P.moodUntil = ts + 800; P.idleSince = ts; }

      var f = floorOf(P.floor);

      if (P.state === 'rest') {
        if (ts > P.restUntil) { P.state = 'walk'; P.mood = 'surprise'; P.moodUntil = ts + 600; P.idleSince = ts; }
        return;
      }
      if (P.state === 'walk') {
        /* 慢：约 34px/s */
        var sp = 34 * (P.scared > 0.2 ? 2.2 : 1) * (VW < 700 ? 0.75 : 1);
        P.x += P.dir * sp * dt / 1000;
        if (P.x > f.x1) { P.x = f.x1; P.dir = -1; }
        if (P.x < f.x0) { P.x = f.x0; P.dir = 1; }
        if (Math.random() < 0.0012) P.dir *= -1;
        if (ptr.on) {
          var dx = P.x - ptr.x, dy = (P.y - window.scrollY) - ptr.y;
          if (Math.sqrt(dx * dx + dy * dy) < 150) { P.scared = 1; P.dir = dx >= 0 ? 1 : -1; }
        }
        if (!P.nextTp) P.nextTp = ts + 18000 + Math.random() * 12000;
        if (ts > P.nextTp) { P.nextTp = 0; pickTeleport(); }
      } else if (P.state === 'out') {
        if (ts - P.tState > 260) { P.state = 'gap'; P.tState = ts; }
      } else if (P.state === 'gap') {
        if (ts - P.tState > 170) {
          P.state = 'in'; P.tState = ts;
          P.floor = P.target; P.x = P.tx; P.y = P.ty;
          P.nextTp = ts + 18000 + Math.random() * 12000;
          P.tpCount++; save();
          if (P.tpCount % 3 === 0) { P.state = 'rest'; P.restUntil = ts + 14000 + Math.random() * 10000; P.mood = 'sleep'; return; }
        }
      } else if (P.state === 'in') {
        if (ts - P.tState > 300) { P.state = 'walk'; }
      }

      if (P.scared > 0) P.scared = Math.max(0, P.scared - dt / 900);

      if (!P.nextJump) P.nextJump = ts + 4000 + Math.random() * 7000;
      if (ts > P.nextJump && !P.jumpT && P.state === 'walk') {
        P.jumpT = ts; P.nextJump = 0;
        P.mood = Math.random() < 0.5 ? 'happy' : 'surprise'; P.moodUntil = ts + 700;
      }
      if (P.jumpT) {
        var k = (ts - P.jumpT) / 700;
        if (k >= 1) { P.jumpT = 0; P.jump = 0; P.squash = 1; P.stretch = 1; }
        else {
          P.jump = Math.sin(k * Math.PI) * 2.0;
          if (k < 0.16) { P.squash = 1.14; P.stretch = 0.88; }
          else if (k > 0.85) { P.squash = 1.12; P.stretch = 0.90; }
          else { P.squash = 0.95; P.stretch = 1.06; }
        }
      } else { P.squash = 1; P.stretch = 1; }

      P.lookX = 0; P.lookY = 0;
      if (ptr.on) {
        var ex = P.x - ptr.x, ey = (P.y - window.scrollY - 12 * cell) - ptr.y;
        var len = Math.sqrt(ex * ex + ey * ey) || 1;
        P.lookX = -ex / len > 0.35 ? 1 : (-ex / len < -0.35 ? -1 : 0);
        P.lookY = -ey / len > 0.35 ? 1 : (-ey / len < -0.35 ? -1 : 0);
      }
    }

    function pickFrame(ts) {
      if (P.mood === 'sleep') return SPR_FRAMES.sleep;
      if (P.mood === 'angry') return SPR_FRAMES.angry;
      if (P.mood === 'surprise') return SPR_FRAMES.surprise;
      if (P.mood === 'happy') return SPR_FRAMES.happy;
      if ((ts % 4400) < 110) return SPR_FRAMES.blink;
      return (Math.floor(ts / 210) % 2) ? SPR_FRAMES.walkB : SPR_FRAMES.walkA;
    }

    /* 画一帧精灵；fade=0 完整，1 完全散开 */
    function drawSprite(ts, grid, x, y, fade) {
      var sx = cell * P.squash, sy2 = cell * P.stretch;
      var rows = grid.length, cols = grid[0].length;
      var px = x - (cols / 2) * sx;
      var py = y - rows * sy2 - P.jump * sy2;
      var sweep = fade > 0 ? y - (rows + 6) * sy2 * (1 - fade) : 1e9;
      for (var r = 0; r < rows; r++) {
        var line = grid[r];
        for (var c = 0; c < cols; c++) {
          var v = line.charAt(c);
          if (v === '.') continue;
          var rgb = PAL[v];
          if (!rgb) continue;
          var X = px + c * sx, Y = py + r * sy2;
          var a = 0.96;
          if (fade > 0) {
            var h1 = ((c * 37 + r * 61) % 100) / 100;
            if (h1 < fade * 1.35) { continue; }
            a = 0.96 * (1 - fade * 0.55);
            X += Math.sin(r * 2.1 + ts * 0.02) * fade * 7;
            Y -= fade * (6 + h1 * 16);
          }
          if (v === 'p') { X += P.lookX * sx; Y += P.lookY * sy2; }
          ctx.fillStyle = 'rgba(' + rgb + ',' + a.toFixed(3) + ')';
          ctx.fillRect(X, Y, sx * 1.02, sy2 * 1.02);
        }
      }
      /* 扫描线 */
      if (fade > 0 && fade < 1) {
        var ly = py + rows * sy2 * (1 - fade);
        ctx.fillStyle = 'rgba(11,216,182,' + (0.5 * (1 - fade)).toFixed(3) + ')';
        ctx.fillRect(px - 6, ly, cols * sx + 12, 2);
      }
    }

    function render(ts) {
      ctx.clearRect(0, 0, VW, VH);
      var vy = P.y - window.scrollY;
      var grid = pickFrame(ts);
      if (P.state === 'walk' || P.state === 'out') {
        if (vy > -120 && vy < VH + 120) {
          var fade = P.state === 'out' ? Math.min(1, (ts - P.tState) / 240) : 0;
          drawSprite(ts, grid, P.x, vy, fade);
        }
      } else if (P.state === 'in') {
        var vy2 = P.ty - window.scrollY;
        if (vy2 > -120 && vy2 < VH + 120) {
          var fade2 = 1 - Math.min(1, (ts - P.tState) / 280);
          drawSprite(ts, grid, P.tx, vy2, fade2);
        }
      }
      /* 气泡只在看得见时冒 */
      if (sayEl) {
        var onScreen = (vy > -60 && vy < VH + 60 && (P.state === 'walk' || P.state === 'rest' || P.state === 'in'));
        if (!onScreen) {
          sayEl.style.opacity = '0';
          P.sayUntil = 0;
          P.sayAt = ts + 2500 + Math.random() * 3000;
        } else {
          if (!P.sayAt) P.sayAt = ts + 3200 + Math.random() * 2600;
          if (!P.sayUntil && ts > P.sayAt) {
            var txt;
            if (P.scared > 0.3) txt = LINE_SCARE[Math.floor(Math.random() * LINE_SCARE.length)];
            else if (P.state === 'rest') txt = LINE_REST[Math.floor(Math.random() * LINE_REST.length)];
            else if (P.mood === 'happy') txt = LINE_HAPPY[Math.floor(Math.random() * LINE_HAPPY.length)];
            else {
              /* 优先说不重复的 */
              P.sayLine = (P.sayLine + 1 + Math.floor(Math.random() * (LINES.length - 1))) % LINES.length;
              txt = LINES[P.sayLine];
            }
            sayEl.textContent = txt;
            sayEl.style.opacity = '1';
            P.sayUntil = ts + 2800 + Math.random() * 900; P.sayAt = 0;
          } else if (P.sayUntil && ts > P.sayUntil) {
            sayEl.style.opacity = '0'; P.sayUntil = 0;
            P.sayAt = ts + 5000 + Math.random() * 5000;
          }
          if (P.sayUntil) {
            sayEl.style.left = Math.round(P.x) + 'px';
            sayEl.style.top = Math.round(vy - cell * 21) + 'px';
          }
        }
      }
    }

    var raf = 0, last = 0;
    function loop(ts) {
      raf = requestAnimationFrame(loop);
      if (!last) last = ts;
      var dt = Math.min(80, ts - last);
      last = ts;
      step(ts, dt);
      render(ts);
    }

    window.addEventListener('pointermove', function (e) {
      ptr.x = e.clientX; ptr.y = e.clientY; ptr.on = true;
    }, { passive: true });
    document.addEventListener('pointerleave', function () { ptr.on = false; });
    document.addEventListener('pointerdown', function (e) {
      if (P.state !== 'walk') return;
      var vy3 = P.y - window.scrollY;
      if (Math.abs(e.clientX - P.x) < 80 && Math.abs(e.clientY - (vy3 - 40)) < 90) {
        P.mood = 'happy'; P.moodUntil = performance.now() + 900;
        P.sayAt = performance.now() + 60;
      }
    });

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { resize(); scanFloors(); }, 220);
    });

    resize();
    scanFloors();
    if (!restore()) { P.state = 'walk'; }
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });
    raf = requestAnimationFrame(loop);
  }
  function boot() {
    var g = document.querySelector('[data-glyph]');
    if (g) dotMatrix(g);
    pagePet();
    [].forEach.call(document.querySelectorAll('[data-scan]'), scan);
    ticker();
    progress();
    parallax();
    magnets();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
