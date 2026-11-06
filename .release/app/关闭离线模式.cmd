@echo off
rem Offline mode OFF: restore default listeners (loopback + tailnet) and firewall rules.
rem ASCII ONLY. This wrapper takes no arguments except the pause switch.
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0offline-mode-off.ps1"
if /i not "%~1"=="--no-pause" pause
endlocal
