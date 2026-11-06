@echo off
rem Phone entry tool: show URLs / QR codes, or rotate the access key.
rem ASCII ONLY. Do NOT forward %* to the ps1: this script takes no arguments,
rem and "--no-pause" is consumed here (the ps1 has CmdletBinding and would reject it).
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0entry.ps1"
if /i not "%~1"=="--no-pause" pause
endlocal