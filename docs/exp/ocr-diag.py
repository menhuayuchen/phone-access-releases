# 诊断：RapidOCR 的耗时到底花在 det 还是 rec 上，以及线程数/参数的影响。
import inspect
import sys
import time

import numpy as np

sys.path.insert(0, r'D:\download\办共\phone-access-product\app\exp\ocr')
from ocr_server import ENGINE, grab  # 复用已经 DPI aware 的抓屏 + 已加载的模型

print('RapidOCR.__init__ 参数:', inspect.signature(ENGINE.__init__) if hasattr(ENGINE, '__init__') else '?')

for (w, h) in ((800, 500), (1200, 800)):
    img = grab(1400, 100, w, h)
    t0 = time.perf_counter()
    res, elapse = ENGINE(img)
    dt = (time.perf_counter() - t0) * 1000
    n = len(res or [])
    print(f'\n[{w}x{h}] total={dt:.0f}ms lines={n}')
    print('  elapse(det,cls,rec) =', elapse)
    if elapse:
        det = elapse[0] if len(elapse) > 0 else 0
        cls = elapse[1] if len(elapse) > 1 else 0
        rec = elapse[2] if len(elapse) > 2 else 0
        print(f'  det={det:.0f}ms cls={cls:.0f}ms rec={rec:.0f}ms')
        if n:
            print(f'  per-line rec ≈ {rec / n:.1f} ms')

# 多线程有没有用
try:
    from rapidocr_onnxruntime import RapidOCR
    for th in (1, 4, 8):
        e = RapidOCR(intra_op_num_threads=th)
        img = grab(1400, 100, 800, 500)
        e(img)  # warm
        t0 = time.perf_counter()
        r, el = e(img)
        dt = (time.perf_counter() - t0) * 1000
        print(f'[threads={th}] {dt:.0f}ms lines={len(r or [])} elapse={el}')
except Exception as ex:
    print('threads test failed:', ex)
