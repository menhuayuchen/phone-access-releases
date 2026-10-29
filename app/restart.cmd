@echo off
rem Restart the PhoneAccess services (screen server + supervisor + doors).
setlocal
set "SELF=%~dp0restart.ps1"
if not exist "%SELF%" goto missing

net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SELF%" %*
exit /b %errorlevel%

:missing
echo.
echo Cannot find restart.ps1 next to this file.
echo Please run this from the PhoneAccess install folder.
echo.
pause
exit /b 3
