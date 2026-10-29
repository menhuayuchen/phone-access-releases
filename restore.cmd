@echo off
rem One-click restore to pre-install state. ASCII only.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore.ps1" %*
rem --no-pause for scripted use
if /i not "%~1"=="--no-pause" pause