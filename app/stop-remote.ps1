$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$killed = 0
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'cloudflared' -and $_.CommandLine -match 'tunnel' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $killed++ }



Write-Host "Stopped $killed remote-access process(es)."
Write-Host 'The local DSH web on 10.120.222.63:8642 is still running (LAN access).'
Read-Host 'Press Enter to exit'
