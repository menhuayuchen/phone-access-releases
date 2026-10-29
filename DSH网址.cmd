@echo off
rem Open the DSH web console on the phone (seller tool, not shipped).
setlocal
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-url.ps1" %*
exit /b %errorlevel%