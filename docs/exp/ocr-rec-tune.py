# 找 rec 阶段的加速空间：降输入尺寸 / 并行识别多行。
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

sys.path.insert(0, r'D:\download\办共\phone-access-product\app\exp\ocr')
from ocr_server import grab

from rapidocr_onnxruntime import RapidOCR

img = grab(1060, 100, 800, 500)     # 这块文字密（~20 行）
print('crop', img.shape)

base = RapidOCR(intra_op_num_threads=8)
base(img)
t0 = time.perf_counter()
res, el = base(img)
print(f'[default rec_img_shape] {(time.perf_counter()-t0)*1000:.0f}ms lines={len(res or [])} elapse={el}')

for shape in ([3, 32, 320], [3, 24, 320]):
    try:
        e = RapidOCR(intra_op_num_threads=8, rec_img_shape=shape)
        e(img)
        t0 = time.perf_counter()
        r, el = e(img)
        print(f'[rec_img_shape={shape}] {(time.perf_counter()-t0)*1000:.0f}ms lines={len(r or [])} elapse={el}')
    except Exception as ex:
        print(f'[rec_img_shape={shape}] failed: {ex}')

# 看看 RapidOCR 内部对象，能不能拿到 det/rec 分开调
print('\n-- engine attrs --')
for a in ('text_det', 'text_rec', 'text_cls', 'use_det', 'use_rec', 'use_cls'):
    print(' ', a, hasattr(base, a))
if hasattr(base, 'text_rec'):
    tr = base.text_rec
    print('  text_rec attrs:', [x for x in dir(tr) if not x.startswith('_')][:20])
