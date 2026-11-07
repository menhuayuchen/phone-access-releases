# DirectML 后端测试：DML 首次有 kernel 编译开销，必须 warmup 后再计时。
import sys
import time

sys.path.insert(0, r'D:\download\办共\phone-access-product\app\exp\ocr')
from ocr_server import grab

from rapidocr_onnxruntime import RapidOCR

img_small = grab(1400, 100, 800, 500)
img_big = grab(1400, 100, 1200, 800)
img_huge = grab(0, 0, 2000, 1200)

for label, kw in (('dml', dict(use_dml=True, intra_op_num_threads=1)), ('cpu8', dict(intra_op_num_threads=8))):
    try:
        t0 = time.perf_counter()
        e = RapidOCR(**kw)
        load = (time.perf_counter() - t0) * 1000
        # DML 第一次要编译 kernel，单独计时不参与统计
        t0 = time.perf_counter()
        e(img_small)
        warm = (time.perf_counter() - t0) * 1000
        print(f'\n[{label}] load={load:.0f}ms first-run={warm:.0f}ms')
        for name, img in (('800x500', img_small), ('1200x800', img_big), ('2000x1200', img_huge)):
            ts = []
            for _ in range(3):
                t0 = time.perf_counter()
                r, _ = e(img)
                ts.append((time.perf_counter() - t0) * 1000)
            ts.sort()
            print(f'  {name}: median {ts[1]:.0f} ms  lines={len(r or [])}')
    except Exception as ex:
        print(f'[{label}] FAILED: {type(ex).__name__}: {ex}')
