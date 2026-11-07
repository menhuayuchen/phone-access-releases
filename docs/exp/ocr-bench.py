# RapidOCR 基准：E2 之前先量清楚"一张屏幕截图要多久、认得多准"。
# 用法: py -3.12 ocr-bench.py <图片路径>
import sys
import time

import numpy as np
from PIL import Image

IMG = sys.argv[1] if len(sys.argv) > 1 else 'bench-shot.png'

t0 = time.perf_counter()
from rapidocr_onnxruntime import RapidOCR
engine = RapidOCR()
t_load = time.perf_counter() - t0

img = Image.open(IMG).convert('RGB')
arr = np.array(img)
H, W = arr.shape[:2]
print(f'image: {W}x{H}')

# 全屏
t0 = time.perf_counter()
res, _ = engine(arr)
t_full = time.perf_counter() - t0
lines = res or []
print(f'[full] {t_full*1000:.0f} ms   lines={len(lines)}')

# 打印前 8 行，看识别质量
for it in lines[:8]:
    box, text, score = it
    x0 = min(p[0] for p in box); x1 = max(p[0] for p in box)
    y0 = min(p[1] for p in box); y1 = max(p[1] for p in box)
    print(f'   ({x0:4.0f},{y0:4.0f})-({x1:4.0f},{y1:4.0f}) score={score:.2f}  {text[:40]}')

# 区域（E2 的真实场景：双指放大时只认一个区域）
for frac in (0.25, 0.5):
    side = int(min(W, H) * frac)
    cx, cy = W // 2, H // 2
    crop = arr[max(0, cy - side // 2):cy + side // 2, max(0, cx - side // 2):cx + side // 2]
    t0 = time.perf_counter()
    r2, _ = engine(crop)
    dt = time.perf_counter() - t0
    print(f'[crop {side}x{side}] {dt*1000:.0f} ms   lines={len(r2 or [])}')

# 统计：全屏文字的置信度分布
if lines:
    scores = [it[2] for it in lines]
    print(f'scores: min={min(scores):.2f} avg={sum(scores)/len(scores):.2f} >=0.9: {sum(1 for s in scores if s>=0.9)}/{len(scores)}')
print(f'[model load] {t_load*1000:.0f} ms')
