@echo off
rem Customer self-check entry. ASCII ONLY.
rem Do NOT forward %* to the ps1 (CmdletBinding scripts reject unknown flags).
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0selfcheck.ps1"
if /i not "%~1"=="--no-pause" pause
endlocal