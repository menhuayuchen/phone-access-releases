@echo off
setlocal
rem ============================================================
rem Phone Access install - customer double-click entry.
rem
rem ASCII ONLY on purpose. cmd.exe inherits the console code page
rem and re-reads this file line by line, so a non-ASCII byte here
rem can be split into commands (it breaks even a "rem" comment).
rem Never add a code-page switch here either: cmd.exe reads this file
rem line by line, so switching the page garbles everything below it.
rem Chinese text belongs in the FILE NAME, never in this file.
rem
rem Exit codes: 0 = installed, 2 = dry run finished, 3 = install
rem failed (the ps1 already paused and saved a report), 4 = the
rem user said No to the UAC prompt (nothing was changed).
rem ============================================================
title Phone Access Installer
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :done
if "%RC%"=="2" goto :done
if "%RC%"=="3" goto :done
if "%RC%"=="4" goto :done
rem The ps1 never got to show anything (missing file / blocked by policy).
echo.
echo [Installer stopped unexpectedly - exit code %RC%]
echo Please take a photo of this window and send it to the seller.
pause
:done
rem endlocal would reset ERRORLEVEL to 0, so expand RC first and exit explicitly.
endlocal & exit /b %RC%
