# stream-firewall.ps1 — 「同一 Wi-Fi 串流」的防火墙开关（2026-11-08）
#
# 背景：Sunshine 自带的放行规则只覆盖 tailnet(100.64/10) + 回环，同一 Wi-Fi 的 Moonlight
# 连不上（手机提示"查找不到电脑"）。但把整个离线模式打开代价太大（8660/8661 明文 HTTP 都暴露）。
# 所以做成**独立开关**：只放行 Moonlight 真正需要的 Sunshine 端口，且：
#   · 来源只限私有网段（10/8、172.16/12、192.168/16），绝不放行公网
#   · 程序限定为真正的监听进程 Sunshine.exe（服务登记的 sunshinesvc.exe 只是外壳）
#   · **不放 47990**（Sunshine 的 Web 管理后台，Moonlight 用不到；后台仍走 tailnet）
# 关掉时把规则全部删除，恢复"只允许 Tailscale"。
#
# 用法（管理员）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File stream-firewall.ps1 -Action on
#   powershell -NoProfile -ExecutionPolicy Bypass -File stream-firewall.ps1 -Action off
#   powershell -NoProfile -ExecutionPolicy Bypass -File stream-firewall.ps1 -Action status
#
# 本文件是 PowerShell 5.1 脚本，必须 UTF-8 带 BOM；不要写 JS 风格 // 注释。

param(
  [ValidateSet('on', 'off', 'status')]
  [string]$Action = 'status',
  [string]$Root = ''
)

$ErrorActionPreference = 'Continue'

if (-not $Root) {
  $here0 = $PSScriptRoot
  if (Test-Path -LiteralPath (Join-Path $here0 'runtime\node.exe')) { $Root = $here0 }
  else { $Root = Split-Path -Parent $here0 }
}

$lan = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
$rTcp = 'PA-STREAM-LAN-TCP'
$rUdp = 'PA-STREAM-LAN-UDP'
$sunTcp = @(47984, 47989, 48010)                  # HTTPS 配对 / HTTP 配对+游戏列表 / RTSP
$sunUdp = @(47998, 47999, 48000, 48002, 48010)    # 视频 / 音频 / 控制

$log = Join-Path $Root 'stream-firewall.log'
function W([string]$m) {
  Write-Host $m
  try { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) } catch { }
}

function Get-SunshineExe {
  $exe = ''
  try {
    $pr = Get-Process -Name 'sunshine' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pr -and $pr.Path) { $exe = $pr.Path }
  } catch { }
  if (-not $exe) {
    foreach ($c in @((Join-Path $env:ProgramFiles 'Sunshine\sunshine.exe'),
                     (Join-Path ${env:ProgramFiles(x86)} 'Sunshine\sunshine.exe'))) {
      if ($c -and (Test-Path -LiteralPath $c)) { $exe = $c; break }
    }
  }
  if ($exe -and -not (Test-Path -LiteralPath $exe)) { $exe = '' }
  return $exe
}

function Remove-Rules {
  foreach ($n in @($rTcp, $rUdp)) {
    $rs = @(Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue)
    foreach ($x in $rs) {
      Remove-NetFirewallRule -Name $x.Name -ErrorAction SilentlyContinue
      W ('[OK] 已删除规则 ' + $n)
    }
  }
}

$sun = Get-SunshineExe

switch ($Action) {
  'status' {
    W ('[i] 目录：' + $Root)
    W ('[i] Sunshine.exe：' + $(if ($sun) { $sun } else { '(未找到)' }))
    foreach ($n in @($rTcp, $rUdp)) {
      $xs = @(Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue)
      if (-not $xs.Count) { W ('[ ] ' + $n + ' —— 未创建（同一 Wi-Fi 串流关闭）'); continue }
      foreach ($x in $xs) {
        $pf = $x | Get-NetFirewallPortFilter
        $af = $x | Get-NetFirewallAddressFilter
        $ap = $x | Get-NetFirewallApplicationFilter
        W ('[x] ' + $n + ' ' + $pf.Protocol + '/' + (@($pf.LocalPort) -join ',') + ' 程序=' + (Split-Path $ap.Program -Leaf) + ' 来源=' + (@($af.RemoteAddress) -join ',') + ' Enabled=' + $x.Enabled)
      }
    }
  }
  'on' {
    if (-not $sun) {
      W '[!] 没找到 Sunshine.exe（没装串流组件？），跳开放行'
      Remove-Rules
      return
    }
    Remove-Rules   # 先清掉旧的（端口/程序可能变了），再重建
    foreach ($p in $sunTcp) {
      New-NetFirewallRule -DisplayName $rTcp -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $p -RemoteAddress $lan -Program $sun -Profile Any `
        -Description '轻屏：同一 Wi-Fi 下允许 Moonlight 串流（仅 Sunshine，TCP）' | Out-Null
    }
    foreach ($p in $sunUdp) {
      New-NetFirewallRule -DisplayName $rUdp -Direction Inbound -Action Allow -Protocol UDP `
        -LocalPort $p -RemoteAddress $lan -Program $sun -Profile Any `
        -Description '轻屏：同一 Wi-Fi 下允许 Moonlight 串流（仅 Sunshine，UDP）' | Out-Null
    }
    W ('[OK] 已放行同一 Wi-Fi 串流（TCP ' + ($sunTcp -join ',') + ' / UDP ' + ($sunUdp -join ',') + '，不含 47990）')
  }
  'off' {
    Remove-Rules
    W '[OK] 已恢复：同一 Wi-Fi 串流关闭，只保留 Tailscale'
  }
}
