@echo off
rem PhoneAccess uninstaller launcher.
rem Must be elevated: deleting scheduled tasks + firewall rules needs admin.
setlocal
set "SELF=%~dp0uninstall.ps1"
if not exist "%SELF%" goto missing

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo Requesting administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SELF%" %*
exit /b %errorlevel%

:missing
echo.
echo Cannot find uninstall.ps1 next to this file.
echo Please run this from the PhoneAccess install folder.
echo.
pause
exit /b 3
