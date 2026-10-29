$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ts = 'C:\Program Files\Tailscale\tailscale.exe'

& $ts serve --http=80 off 2>&1 | Out-Null

$killed = 0
# stop the watchdog first, otherwise it restarts everything within seconds
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'powershell' -and $_.CommandLine -match '-File\s+\S+supervise\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $killed++ }

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'tunnel-proxy\.mjs' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $killed++ }

# screen viewer (capture helper + MJPEG server)
Get-Process capture | ForEach-Object { Stop-Process -Id $_.Id -Force; $killed++ }
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'node' -and $_.CommandLine -match 'screen-server\.mjs' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $killed++ }

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match '--profile web' -and $_.CommandLine -match '8642' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $killed++ }

Write-Host "Stopped $killed process(es) and closed the tailnet entry."
Write-Host 'Tailscale itself stays connected. Re-run start-phone-access.cmd to bring it all back.'
Read-Host 'Press Enter to exit'
