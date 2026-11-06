@echo off
cd /d "
D:\download\??\phone-access-product\app\rtc-h264
"
rtc-h264.exe -port 9800 < frames.bin > sidecar.out 2>&1