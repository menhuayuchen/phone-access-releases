$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $here 'web-lan.log'
$port = 8642
$py   = 'C:\Users\ccj\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'

$listening = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if (-not $listening) {
  Write-Host '[x] DSH web for phone is not running.'
  Write-Host '    Run start-phone-access.cmd first.'
  Read-Host 'Press Enter to exit'
  exit 1
}

$line = Get-Content $log -ErrorAction SilentlyContinue |
  Where-Object { $_ -match 'dsh web:\s*https?://\S+' } |
  Select-Object -Last 1

if (-not $line) {
  Write-Host '[x] No login URL found in web-lan.log. Try start-phone-access.cmd again.'
  Read-Host 'Press Enter to exit'
  exit 1
}

$url = [regex]::Match($line, 'https?://\S+').Value
$url = $url.Trim()

# Warn when the URL authority no longer matches the live listener (LAN IP changed).
$authority = [regex]::Match($url, 'https?://([^/]+)').Groups[1].Value
$live = "$($listening[0].LocalAddress):$port"
if ($authority -ne $live -and $authority -ne "$($listening[0].LocalAddress)") {
  Write-Host "[!] URL points at $authority but the listener is on $live."
  Write-Host '    The LAN IP probably changed. Stop it and run start-phone-access.cmd again.'
}

Set-Content -Path (Join-Path $here 'phone-url.txt') -Value $url -Encoding UTF8
Write-Host ''
Write-Host 'Phone login URL (one-time token, 30-day cookie):'
Write-Host $url
Write-Host ''

$qrLine = & $py (Join-Path $here 'make-qr.py') $url (Join-Path $here 'phone-qr.png') | Select-Object -Last 1
$qrPath = [regex]::Match([string]$qrLine, 'qr written: (.+) \(').Groups[1].Value
if (-not $qrPath) { $qrPath = Join-Path $here 'phone-qr.png' }
Start-Process -FilePath $qrPath
Read-Host 'Press Enter to exit'
