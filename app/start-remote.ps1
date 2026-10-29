param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8642
$proxyPort = 8650
$cf = Join-Path $here 'bin\cloudflared.exe'
$node = 'C:\Users\ccj\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$py = 'C:\Users\ccj\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$webLog = Join-Path $here 'web-lan.log'
$cfLog = Join-Path $here 'cf-tunnel.log'
$cfOut = Join-Path $here 'cf-tunnel.out'
$proxyLog = Join-Path $here 'proxy.log'

if (-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
  Write-Host '[x] DSH web is not running on port 8642.'
  Write-Host '    Run start-phone-access.cmd first (LAN access), then this script.'
  if (-not $Quiet) { Read-Host 'Press Enter to exit' }; exit 1
}

if (-not (Test-Path $cf)) {
  Write-Host "[x] Missing $cf"
  if (-not $Quiet) { Read-Host 'Press Enter to exit' }; exit 1
}

# 1) reverse proxy 127.0.0.1:8650 -> 10.120.222.63:8642 (rewrites Host/Origin for the DSH fence)
if (-not (Get-NetTCPConnection -State Listen -LocalPort $proxyPort -ErrorAction SilentlyContinue)) {
  Write-Host "[i] Starting reverse proxy on 127.0.0.1:$proxyPort"
  Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $here 'tunnel-proxy.mjs')`"" -WindowStyle Hidden `
    -RedirectStandardOutput $proxyLog -RedirectStandardError "$proxyLog.err"
  Start-Sleep -Seconds 2
}

# 2) cloudflared quick tunnel
Write-Host '[i] Starting Cloudflare quick tunnel...'
if (Test-Path $cfLog) { Remove-Item $cfLog -Force }
if (Test-Path $cfOut) { Remove-Item $cfOut -Force }
Start-Process -FilePath $cf -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$proxyPort", '--no-autoupdate') `
  -WindowStyle Hidden -RedirectStandardError $cfLog -RedirectStandardOutput $cfOut

$public = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  if (-not (Test-Path $cfLog)) { continue }
  $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue |
       Select-Object -First 1
  if ($m) { $public = [regex]::Match($m.Line, 'https://[a-z0-9-]+\.trycloudflare\.com').Value; break }
}
if (-not $public) {
  Write-Host '[x] No tunnel URL after 80s. Last cloudflared log lines:'
  Get-Content $cfLog -ErrorAction SilentlyContinue | Select-Object -Last 10
  if (-not $Quiet) { Read-Host 'Press Enter to exit' }; exit 1
}

# 3) turn the printed login URL into the public one (same one-time token)
$line = Get-Content $webLog -ErrorAction SilentlyContinue |
  Where-Object { $_ -match 'dsh web:\s*https?://\S+' } | Select-Object -Last 1
if (-not $line) {
  Write-Host '[x] No login URL in web-lan.log. Restart with start-phone-access.cmd.'
  if (-not $Quiet) { Read-Host 'Press Enter to exit' }; exit 1
}
$loginUrl = [regex]::Match($line, 'https?://\S+').Value.Trim()
$token = [regex]::Match($loginUrl, '[?&]token=([^&\s]+)').Groups[1].Value
$publicUrl = "$public/?token=$token"

Set-Content -Path (Join-Path $here 'phone-url.txt') -Value $publicUrl -Encoding UTF8
$qrLine = & $py (Join-Path $here 'make-qr.py') $publicUrl (Join-Path $here 'phone-qr.png') | Select-Object -Last 1
$qrPath = [regex]::Match([string]$qrLine, 'qr written: (.+) \(').Groups[1].Value
if (-not $qrPath) { $qrPath = Join-Path $here 'phone-qr.png' }
if (-not $Quiet) { Start-Process -FilePath $qrPath }

Write-Host ''
Write-Host 'Public (works on cellular / any Wi-Fi):'
Write-Host $publicUrl
Write-Host ''
Write-Host 'Tunnel URL changes every restart; the 30-day cookie then only covers this domain.'
if (-not $Quiet) { Read-Host 'Press Enter to exit' }
