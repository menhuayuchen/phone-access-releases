# lan-firewall.ps1 — 局域网直连（screen.lan）的防火墙放行（需要管理员）
#
# 安全原则（2026-11-07 定）：
#   · 只放行 **局域网私有网段** 来源，绝不放行公网（不写 RemoteAddress=Any）
#   · 只开局域网直连真正需要的两项：TCP 8662（HTTPS 画面入口）、UDP（WebRTC 媒体，限定 rtc-h264.exe）
#   · **不动** 8660 / 8650 的任何规则 —— tailnet 入口的姿态保持不变
#   · 关掉（-Off）时把两条规则都删掉，恢复"只允许 Tailscale"
#
# 用法（管理员）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File app\lan-firewall.ps1 -Action on
#   powershell -NoProfile -ExecutionPolicy Bypass -File app\lan-firewall.ps1 -Action off
#   powershell -NoProfile -ExecutionPolicy Bypass -File app\lan-firewall.ps1 -Action status
#
# 本文件是 PowerShell 5.1 脚本，必须 UTF-8 带 BOM；不要写 JS 风格 // 注释。

param(
  [ValidateSet('on', 'off', 'status')]
  [string]$Action = 'status',
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  # 仓库里是 app\lan-firewall.ps1（父目录才是产品根）；部署到安装目录后直接躺在根下（自己就是根）。
  $here2 = $PSScriptRoot
  if (Test-Path -LiteralPath (Join-Path $here2 'runtime\node.exe')) { $Root = $here2 }
  else { $Root = Split-Path -Parent $here2 }
}
$nodeExe = Join-Path $Root 'runtime\node.exe'
$rtcExe = Join-Path $Root 'rtc-h264\rtc-h264.exe'
$lan = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')

$log = Join-Path $Root 'lan-firewall.log'
function W([string]$m) {
  Write-Host $m
  try { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) } catch { }
}

$r1 = 'PA-LAN-SCREEN-8662'
$r2 = 'PA-LAN-RTC-UDP'

function Remove-Both {
  foreach ($n in @($r1, $r2)) {
    $rs = @(Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue)
    foreach ($x in $rs) {
      Remove-NetFirewallRule -Name $x.Name -ErrorAction Stop
      W ('[OK] 已删除规则 ' + $n)
    }
  }
}

switch ($Action) {
  'status' {
    W ('[i] 目录：' + $Root)
    W ('[i] node.exe：' + $nodeExe + '  存在=' + (Test-Path -LiteralPath $nodeExe))
    W ('[i] rtc-h264.exe：' + $rtcExe + '  存在=' + (Test-Path -LiteralPath $rtcExe))
    foreach ($n in @($r1, $r2)) {
      $x = Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $x) { W ('[ ] ' + $n + ' —— 未创建（局域网直连关闭状态）'); continue }
      $pf = $x | Get-NetFirewallPortFilter
      $af = $x | Get-NetFirewallAddressFilter
      W ('[x] ' + $n + '  ' + $x.Action + '  ' + $pf.Protocol + '/' + (@($pf.LocalPort) -join ',') + '  来源=' + (@($af.RemoteAddress) -join ',') + '  Enabled=' + $x.Enabled)
    }
  }
  'on' {
    if (-not (Test-Path -LiteralPath $nodeExe)) { throw ('找不到 ' + $nodeExe) }
    if (-not (Test-Path -LiteralPath $rtcExe)) { throw ('找不到 ' + $rtcExe) }

    # 1) 局域网 HTTPS 画面入口
    if (-not (Get-NetFirewallRule -DisplayName $r1 -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $r1 -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort 8662 -RemoteAddress $lan -Program $nodeExe -Profile Any `
        -Description '轻屏：局域网直连（HTTPS 8662），只允许私有网段' | Out-Null
      W ('[OK] 已创建 ' + $r1)
    } else { W ('[i] 已存在 ' + $r1) }

    # 2) WebRTC 媒体（UDP 任意端口，但程序必须是 rtc-h264.exe，来源必须是私有网段）
    if (-not (Get-NetFirewallRule -DisplayName $r2 -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $r2 -Direction Inbound -Action Allow -Protocol UDP `
        -LocalPort Any -RemoteAddress $lan -Program $rtcExe -Profile Any `
        -Description '轻屏：局域网直连的 WebRTC 媒体，只允许私有网段' | Out-Null
      W ('[OK] 已创建 ' + $r2)
    } else { W ('[i] 已存在 ' + $r2) }
  }
  'off' {
    Remove-Both
    W '[OK] 已恢复：局域网入口关闭，只剩 Tailscale'
  }
}
