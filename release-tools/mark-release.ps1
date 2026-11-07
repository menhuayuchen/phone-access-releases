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

# 回读验证
$obj = (Get-Content -LiteralPath $cfg -Raw -Encoding UTF8) | ConvertFrom-Json
if ($obj.profile -ne 'release') { throw ('标记失败：profile = ' + $obj.profile) }
if (-not $obj.experiments) { Write-Host '  [w] config 里没有 experiments 块（不影响：发布版本来就不用它）' }
if ($obj.features -and $obj.features.realCursor -eq $false) {
  Write-Host '  [w] features.realCursor=false：发布版的真实光标会被关掉，确认是不是有意的'
}
Write-Host ('  [OK] profile=release  version=' + $obj.version)
