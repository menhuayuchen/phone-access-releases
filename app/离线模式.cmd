@echo off
rem Offline mode launcher: enable LAN access (https + WebRTC) and open the phone URL.
rem ASCII ONLY. This wrapper takes no arguments except the pause switch.
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0offline-mode.ps1"
if /i not "%~1"=="--no-pause" pause
endlocal
