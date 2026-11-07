#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""轻屏实验版 E2 的 OCR 服务（常驻，只监听 127.0.0.1）。

为什么单独一个进程：RapidOCR 模型加载一次要 ~760ms，每次请求重新拉进程太慢，
所以常驻；Node 那边只做鉴权和转发。

抓屏为什么自己用 ctypes 写：产品自带的 capture.exe 是"持续抓帧循环"，不是单帧；
ffmpeg 裁剪版没编 png/rawvideo 的 muxer。而且必须是 **DPI aware** 的进程，
否则在 150% 缩放的屏幕上 GetSystemMetrics 给的是 1707x1067 逻辑像素，
和产品的 2560x1600 物理像素对不上，裁剪区域会整体偏移。

用法:
    py -3.12 ocr_server.py [port]     默认 8777

接口:
    GET  /health                 -> {"ok":true,"screen":{"w":..,"h":..}}
    POST /ocr   {"rect":{...}}   -> {"ok":true,"ms":..,"lines":[{text,x,y,w,h,score}]}
    POST /shutdown
"""
import ctypes
import json
import sys
import threading
import time
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777

# ---- DPI aware：必须在任何窗口/设备上下文创建之前调用 ----------------------
try:
    # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    if not ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
        ctypes.windll.user32.SetProcessDPIAware()
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', ctypes.c_uint32),
        ('biWidth', ctypes.c_int32),
        ('biHeight', ctypes.c_int32),
        ('biPlanes', ctypes.c_uint16),
        ('biBitCount', ctypes.c_uint16),
        ('biCompression', ctypes.c_uint32),
        ('biSizeImage', ctypes.c_uint32),
        ('biXPelsPerMeter', ctypes.c_int32),
        ('biYPelsPerMeter', ctypes.c_int32),
        ('biClrUsed', ctypes.c_uint32),
        ('biClrImportant', ctypes.c_uint32),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', ctypes.c_uint32 * 3)]


def screen_size():
    """物理像素分辨率（DPI aware 下才是真值）。"""
    return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))


def grab(x, y, w, h):
    """抓屏一块区域，返回 (h, w, 3) 的 BGR ndarray。"""
    hdc = user32.GetDC(0)
    if not hdc:
        raise RuntimeError('GetDC failed')
    mem_dc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    old = gdi32.SelectObject(mem_dc, bmp)
    try:
        if not gdi32.BitBlt(mem_dc, 0, 0, w, h, hdc, x, y, SRCCOPY):
            raise RuntimeError('BitBlt failed')
        bi = BITMAPINFO()
        bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bi.bmiHeader.biWidth = w
        bi.bmiHeader.biHeight = -h          # 负数 = top-down，省一次翻转
        bi.bmiHeader.biPlanes = 1
        bi.bmiHeader.biBitCount = 32
        bi.bmiHeader.biCompression = 0      # BI_RGB
        buf = ctypes.create_string_buffer(w * h * 4)
        if not gdi32.GetDIBits(mem_dc, bmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS):
            raise RuntimeError('GetDIBits failed')
        arr = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4)
        return np.ascontiguousarray(arr[:, :, :3])   # BGRA -> BGR
    finally:
        try:
            gdi32.SelectObject(mem_dc, old)
        except Exception:
            pass
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(0, hdc)


print('ocr: loading model ...', flush=True)
t0 = time.perf_counter()
from rapidocr_onnxruntime import RapidOCR  # noqa: E402

# 8 线程是最优：实测 800x500 区域 8 线程 515ms，16 线程反而 623ms、32 线程 1046ms
# （CPU 是 R9 8945HX / 32 逻辑核）。DirectML 更差（1163ms）—— OCR 是逐行小图推理，
# GPU 每次 run 的调度开销吃掉了并行优势，所以老实用 CPU。
ENGINE = RapidOCR(intra_op_num_threads=8)
print(f'ocr: model ready in {(time.perf_counter() - t0) * 1000:.0f} ms', flush=True)
SW, SH = screen_size()
print(f'ocr: screen {SW}x{SH} (physical)', flush=True)

# 预热一次：第一次推理比稳定态慢好几倍，别让用户的第一下吃这个亏
try:
    # 预热用真实尺寸的图：小图预热后，第一次大图仍然有额外开销
    _warm = grab(0, 0, min(800, SW), min(500, SH))
    ENGINE(_warm)
    print('ocr: warmup done', flush=True)
except Exception as e:
    print('ocr: warmup skipped:', e, flush=True)

LOCK = threading.Lock()

# 同一个矩形 1.5 秒内复用结果：手势抖动/重复请求不会重复烧 CPU。
# 不能太长 —— 画面（视频、光标动画）一直在变，过时文字比没有更糟。
CACHE = {}
CACHE_MS = 1500

# 超过 1200x900 就不增强：说明用户没怎么放大，像素本身够清楚，而且大区域识别要 1 秒以上
MAX_AREA = 1200 * 900


def sample_colors(img, x, y, w, h):
    """给一行文字采样背景色和前景色（BGR -> #rrggbb）。

    为什么要采样：客户端要把这一行的背景盖住再画矢量字，否则原像素里的
    模糊字和清晰字叠在一起，看起来是双影。背景色用中位数（文字只占少数像素，
    中位数不会被文字颜色带跑偏）；前景色用「离背景最远的那个极端色」近似。
    """
    try:
        H, W = img.shape[:2]
        x0 = max(0, min(x, W - 1)); y0 = max(0, min(y, H - 1))
        x1 = max(x0 + 1, min(x + w, W)); y1 = max(y0 + 1, min(y + h, H))
        patch = img[y0:y1, x0:x1]
        if patch.size == 0:
            return None, None
        flat = patch.reshape(-1, 3)
        if flat.shape[0] > 40000:          # 大区域抽样，别为了一行字跑满
            step = max(1, flat.shape[0] // 40000)
            flat = flat[::step]
        bg = np.median(flat, axis=0)
        lum = float(bg[0]) * 0.114 + float(bg[1]) * 0.587 + float(bg[2]) * 0.299
        fg = (24, 24, 24) if lum > 110 else (245, 245, 245)
        to_hex = lambda c: '#%02x%02x%02x' % (int(c[2]), int(c[1]), int(c[0]))  # BGR -> RGB hex
        return to_hex(bg), to_hex(fg)
    except Exception:
        return None, None


def normalise_rect(rect):
    rx = int(rect.get('x', 0))
    ry = int(rect.get('y', 0))
    rw = int(rect.get('w', 0))
    rh = int(rect.get('h', 0))
    if rw <= 0 or rh <= 0:
        raise ValueError('bad rect')
    rx = max(0, min(rx, SW - 1))
    ry = max(0, min(ry, SH - 1))
    rw = max(1, min(rw, SW - rx))
    rh = max(1, min(rh, SH - ry))
    return rx, ry, rw, rh


def do_ocr(rect):
    rx, ry, rw, rh = normalise_rect(rect)

    # 区域太大就别认了：说明用户没怎么放大，这时候像素本来就够清楚，
    # 而且大区域的识别时间会线性涨上去（实测 2000x1200 要 1700ms）。
    if rw * rh > MAX_AREA:
        return {
            'ok': True, 'tooLarge': True,
            'rect': {'x': rx, 'y': ry, 'w': rw, 'h': rh},
            'grabMs': 0, 'ocrMs': 0, 'ms': 0, 'lines': [],
        }

    key = (rx, ry, rw, rh)
    now = time.perf_counter()
    hit = CACHE.get(key)
    if hit and (now - hit[0]) * 1000 < CACHE_MS:
        out = dict(hit[1])
        out['cached'] = True
        out['ms'] = 0
        return out

    t0 = time.perf_counter()
    img = grab(rx, ry, rw, rh)
    t_grab = (time.perf_counter() - t0) * 1000

    t1 = time.perf_counter()
    with LOCK:
        res, _ = ENGINE(img)
    t_ocr = (time.perf_counter() - t1) * 1000

    lines = []
    for it in (res or []):
        if not it or len(it) < 3:
            continue
        box, text, score = it[0], it[1], it[2]
        if not text:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        x0 = int(round(min(xs))); y0 = int(round(min(ys)))
        w0 = int(round(max(xs) - min(xs))); h0 = int(round(max(ys) - min(ys)))
        bg, fg = sample_colors(img, x0, y0, w0, h0)
        lines.append({
            'text': str(text),
            'x': x0,
            'y': y0,
            'w': w0,
            'h': h0,
            'score': round(float(score), 3),
            'bg': bg,
            'fg': fg,
        })
    out = {
        'ok': True,
        'rect': {'x': rx, 'y': ry, 'w': rw, 'h': rh},
        'grabMs': round(t_grab, 1),
        'ocrMs': round(t_ocr, 1),
        'ms': round(t_grab + t_ocr, 1),
        'lines': lines,
    }
    CACHE[key] = (time.perf_counter(), out)
    if len(CACHE) > 24:
        CACHE.clear()
    return out


class Handler(BaseHTTPRequestHandler):
    # Node 那边用 fetch（undici，默认 keep-alive），而 BaseHTTPRequestHandler 默认是
    # HTTP/1.0 —— 响应完就关连接。第二次请求会复用已经断开的连接，报「接收时发生错误」。
    # 所以这里明说 HTTP/1.1，同时在响应头里 Connection: close，让客户端每次都新建连接
    # （本服务是单线程、请求本来就是串行的，不需要复用连接）。
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        if self.path.startswith('/health'):
            w, h = screen_size()
            self._send(200, {'ok': True, 'screen': {'w': w, 'h': h}})
        else:
            self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b'{}'
        if self.path.startswith('/shutdown'):
            self._send(200, {'ok': True})
            threading.Timer(0.2, lambda: sys.exit(0)).start()
            return
        if not self.path.startswith('/ocr'):
            self._send(404, {'ok': False, 'error': 'not found'})
            return
        try:
            req = json.loads(raw.decode('utf-8') or '{}')
            self._send(200, do_ocr(req.get('rect') or {}))
        except Exception as e:
            self._send(500, {'ok': False, 'error': str(e)})


if __name__ == '__main__':
    # 单线程而不是 ThreadingHTTPServer：实测多线程版在连续请求下会越跑越慢
    # （800x500 从 1037ms 涨到 1879ms），OCR 本来就是串行的，多开线程只抢 GIL。
    srv = HTTPServer(('127.0.0.1', PORT), Handler)
    print(f'ocr: listening on http://127.0.0.1:{PORT}', flush=True)
    srv.serve_forever()
