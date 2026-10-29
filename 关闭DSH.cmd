@echo off
rem Stop the DSH web console and give the CPU back to screen capture.
setlocal
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-url.ps1" -Stop %*
exit /b %errorlevel%