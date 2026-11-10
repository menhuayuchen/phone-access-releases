# mark-release.ps1 — 把 staging 里的 product.config.json 标记成「发布版」
#
# 只改一处字面量： "profile": "selfuse"  ->  "profile": "release"
# 服务端读到 release 就把 experiments 整块当成空（不挂 /exp/*），
# 所以发布版不需要重排 JSON、也不需要删实验配置。
#
# 只动 staging（.release\app），绝不碰 app\ 源目录。
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File release-tools\mark-release.ps1 -Dst .release\app

param(
  [string]$Dst = ''
)
$ErrorActionPreference = 'Stop'

if (-not $Dst) { $Dst = Join-Path (Split-Path -Parent $PSScriptRoot) '.release\app' }
$cfg = Join-Path $Dst 'product.config.json'
if (-not (Test-Path -LiteralPath $cfg)) { throw ('找不到 ' + $cfg) }

$text = [System.IO.File]::ReadAllText($cfg)

# 先确认是合法 JSON，别把坏文件带进包里
try { $null = $text | ConvertFrom-Json }
catch { throw ('product.config.json 不是合法 JSON：' + $_.Exception.Message) }

$selfPat = '"profile"\s*:\s*"selfuse"'
$relPat  = '"profile"\s*:\s*"release"'
$hits = [regex]::Matches($text, $selfPat).Count

if ($hits -eq 0) {
  if ([regex]::IsMatch($text, $relPat)) {
    Write-Host '  [i] 已经是 release，跳过'
  } else {
    throw 'product.config.json 里找不到 "profile": "selfuse"，无法标记发布版'
  }
} elseif ($hits -gt 1) {
  throw ('"profile": "selfuse" 出现 ' + $hits + ' 次（预期 1 次），停止')
} else {
  $text = [regex]::Replace($text, $selfPat, '"profile": "release"')
  # JSON 保持无 BOM（和源文件一致）
  [System.IO.File]::WriteAllText($cfg, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# 2026-11-07：发布版强制关闭「唤醒后不要求登录」（自用便利模式，安全上不该随包发布）。
# 这一段必须在回读验证之前，验证里也会断言它是 false。
$t2 = [System.IO.File]::ReadAllText($cfg)
$uwPat = '"unlockOnWake"\s*:\s*true'
if ([regex]::IsMatch($t2, $uwPat)) {
    $t2 = [regex]::Replace($t2, $uwPat, '"unlockOnWake": false')
    [System.IO.File]::WriteAllText($cfg, $t2, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '  [i] security.unlockOnWake -> false（发布版强制关闭）'
}

# 2026-11-09：发布版强制关闭实验模式（240fps/100Mbps 只属于自用实验版，客户机器扛不住也不该扛）。
# 位置在回读验证之前，验证里也会断言 false。
$t3 = [System.IO.File]::ReadAllText($cfg)
if ($t3 -match '"experiment"\s*:\s*\{[^}]*"enabled"\s*:\s*true') {
    $t3 = [regex]::Replace($t3, '("experiment"\s*:\s*\{[^}]*"enabled"\s*:\s*)true', '${1}false')
    [System.IO.File]::WriteAllText($cfg, $t3, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '  [i] screen.h264.experiment.enabled -> false（发布版强制关闭）'
}

# 2026-11-10（1.0.21）政策变更：**不再**把发布版的帧率/码率/分辨率重置回 60/14000/1920。
# 用户明确要求「发布版的画质上限跟自用版一样」，客户机器扛不住的问题改由程序内置的
# 「设备审查」（screen-server.mjs 里的 deviceAudit/deviceApplyCaps）自动封顶：
#   没有硬件编码 → 30fps/12Mbps/1600 宽；桌面复制采集不可用 → 30fps/8Mbps/1280 宽并停用清晰模式。
# 这里只保留「安全类」的强制项（唤醒免登录必须关），以及下面回读验证里的上限断言。

# 回读验证
$obj = (Get-Content -LiteralPath $cfg -Raw -Encoding UTF8) | ConvertFrom-Json
if ($obj.profile -ne 'release') { throw ('标记失败：profile = ' + $obj.profile) }
if (-not $obj.experiments) { Write-Host '  [w] config 里没有 experiments 块（不影响：发布版本来就不用它）' }
# 上限只许在自用/发布共用的天花板之内（240fps / 100Mbps），再多就是配置写错了
if ($obj.screen -and $obj.screen.h264) {
  if ($obj.screen.h264.fps -gt 240) { throw ('screen.h264.fps=' + $obj.screen.h264.fps + ' 超过 240（共用天花板）') }
  if ($obj.screen.h264.kbps -gt 100000) { throw ('screen.h264.kbps=' + $obj.screen.h264.kbps + ' 超过 100000（共用天花板）') }
  $ex = $obj.screen.h264.experiment
  if ($ex) {
    if ($ex.fps -and $ex.fps -gt 240) { throw ('experiment.fps=' + $ex.fps + ' 超过 240') }
    if ($ex.kbps -and $ex.kbps -gt 100000) { throw ('experiment.kbps=' + $ex.kbps + ' 超过 100000') }
  }
}
if ($obj.security -and $obj.security.unlockOnWake -eq $true) {
  throw '发布版不允许 security.unlockOnWake=true（唤醒后免登录只属于自用版），请检查 mark-release 的强制关闭逻辑'
}
if ($obj.features -and $obj.features.realCursor -eq $false) {
  Write-Host '  [w] features.realCursor=false：发布版的真实光标会被关掉，确认是不是有意的'
}

# 2026-11-10（1.0.21）：设备审查必须随包存在。
# 它现在是"发布版敢用自用版同等画质上限"的唯一前提 —— 少了它，弱机器会黑屏/反复秒退。
$srvPath = Join-Path $Dst 'screen-server.mjs'
if (-not (Test-Path -LiteralPath $srvPath)) { throw ('staging 里找不到 screen-server.mjs：' + $srvPath) }
$srvTxt = [System.IO.File]::ReadAllText($srvPath)
foreach ($marker in @('deviceAudit', 'deviceApplyCaps', '/device-check')) {
  if ($srvTxt.IndexOf($marker) -lt 0) { throw ('发布包里缺少设备审查标记「' + $marker + '」，不能出包（弱机器会黑屏）') }
}
Write-Host '  [OK] 设备审查存在（deviceAudit / deviceApplyCaps / /device-check）'
Write-Host ('  [OK] profile=release  version=' + $obj.version)
