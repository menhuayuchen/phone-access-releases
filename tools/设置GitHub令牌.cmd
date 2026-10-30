@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-github-token.ps1"
echo.
pause
