@echo off
rem Pre-install environment survey. Read-only.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0survey.ps1" %*