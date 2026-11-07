# 找最优 intra_op_num_threads（32 逻辑核）。
import sys
import time

sys.path.insert(0, r'D:\download\办共\phone-access-product\app\exp\ocr')
from ocr_server import grab

from rapidocr_onnxruntime import RapidOCR

img_small = grab(1400, 100, 800, 500)
img_big = grab(1400, 100, 1200, 800)

for th in (8, 16, 24, 32):
    try:
        t0 = time.perf_counter()
        e = RapidOCR(intra_op_num_threads=th)
        load = (time.perf_counter() - t0) * 1000
        e(img_small)
        for name, img in (('800x500', img_small), ('1200x800', img_big)):
            ts = []
            for _ in range(3):
                t0 = time.perf_counter()
                r, _el = e(img)
                ts.append((time.perf_counter() - t0) * 1000)
            ts.sort()
            print(f'threads={th:2d} {name}: median {ts[1]:.0f} ms  lines={len(r or [])}  (load {load:.0f}ms)')
    except Exception as ex:
        print(f'threads={th}: failed {ex}')
