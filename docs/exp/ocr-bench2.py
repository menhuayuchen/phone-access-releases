# RapidOCR 基准 v2：加 warmup + 中位数 + 多尺寸 + det 边长限制，找 E2 可用的配置。
import sys
import time

import numpy as np
from PIL import Image

IMG = sys.argv[1] if len(sys.argv) > 1 else 'bench-shot.png'

from rapidocr_onnxruntime import RapidOCR

img = Image.open(IMG).convert('RGB')
arr = np.array(img)
H, W = arr.shape[:2]
print(f'image: {W}x{H}')


def median_ms(fn, n=3):
    ts = []
    out = None
    for _ in range(n):
        t0 = time.perf_counter()
        out = fn()
        ts.append((time.perf_counter() - t0) * 1000)
    return sorted(ts)[len(ts) // 2], out


# 默认参数
eng = RapidOCR()
median_ms(lambda: eng(arr), 1)          # warmup
full_ms, full_res = median_ms(lambda: eng(arr))
print(f'[full default] median {full_ms:.0f} ms  lines={len(full_res or [])}')

# det 边长限制（默认 736）：调小能显著加速，代价是远距离小字检测不到
for lim in (640, 480, 368):
    try:
        e2 = RapidOCR(det_limit_side_len=lim)
        median_ms(lambda: e2(arr), 1)
        ms, r = median_ms(lambda: e2(arr))
        print(f'[full det={lim}] median {ms:.0f} ms  lines={len(r or [])}')
    except Exception as ex:
        print(f'[full det={lim}] error: {ex}')

# 区域（E2 真实场景），找一块真的有文字的
# 取左上角 900x600 —— 桌面图标和文字通常在那
crop = arr[400:1000, 200:1100]
print(f'crop shape: {crop.shape[1]}x{crop.shape[0]}')
median_ms(lambda: eng(crop), 1)
c_ms, c_res = median_ms(lambda: eng(crop))
print(f'[crop 900x600] median {c_ms:.0f} ms  lines={len(c_res or [])}')
for it in (c_res or [])[:6]:
    print('   ', it[1][:38], f'{it[2]:.2f}')

# 检测耗时 vs 识别耗时拆开看（快速模式：只识别不检测，用于已知行位置的场景）
try:
    only = RapidOCR(use_det=False, use_cls=False, use_rec=True)
    # use_det=False 需要传入已裁好的行图
    print('[det-off] ready (needs per-line crops, not benchmarked here)')
except Exception as ex:
    print('[det-off] error:', ex)
