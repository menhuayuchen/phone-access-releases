# 决定性实验：同样尺寸、不同内容的连续调用，到底多快？
# 之前独立脚本测的 412ms 可能是"同一张图第二次调用"（内存池已热）。
import sys
import time

sys.path.insert(0, r'D:\download\办共\phone-access-product\app\exp\ocr')
from ocr_server import ENGINE, grab

print('-- 5 次不同区域，同尺寸 800x500 --')
for i in range(5):
    img = grab(900 + i * 90, 100, 800, 500)   # 每次内容不同
    t0 = time.perf_counter()
    r, el = ENGINE(img)
    dt = (time.perf_counter() - t0) * 1000
    print(f'  fresh#{i+1}: {dt:.0f}ms lines={len(r or [])} elapse={[round(x,3) for x in (el or [])]}')

print('-- 同一张图连续 3 次 --')
img = grab(1200, 200, 800, 500)
for i in range(3):
    t0 = time.perf_counter()
    r, el = ENGINE(img)
    dt = (time.perf_counter() - t0) * 1000
    print(f'  same#{i+1}: {dt:.0f}ms lines={len(r or [])}')
