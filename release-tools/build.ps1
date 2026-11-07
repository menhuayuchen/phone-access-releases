# build.ps1 — 双轨一条命令入口：自用版 selfuse / 发布版 release
#
# 用法（在 phone-access-product 根目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File release-tools\build.ps1 -Track selfuse
#   powershell -NoProfile -ExecutionPolicy Bypass -File release-tools\build.ps1 -Track release
#   ... -Version 1.0.18      可选；显式指定时必须与 app\product.config.json 的 version 一致
#
# 两条轨道的差别（详见 docs\双轨-自用版与发布版.md）：
#   selfuse：app\ 原样打包（含本机 dsh 字样、开发脚本），profile=selfuse → 实验功能可用
#   release：app\ → .release\app 三段 scrub 去标识化，再 mark-release 把 profile 改成 release
#            → 服务端不挂 /exp/*，客户包里永远没有实验接口
#
# 只出包，不发布：不改版本号、不传 Gitee/GitHub、不打 tag（发版需用户明确同意）。
#
# 本文件是 PowerShell 5.1 脚本，必须 UTF-8 带 BOM；不要写 JS 风格 // 注释。

param(
  [string]$Track = '',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$app = Join-Path $root 'app'
$dist = Join-Path $root 'dist'
$ps = 'powershell.exe'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Head([string]$t) { Write-Host ''; Say ('==== ' + $t) 'Cyan' }

# ---- 0. 参数与版本 ------------------------------------------------------
if (-not $Track) { throw '必须指定 -Track selfuse 或 -Track release' }
if ($Track -ne 'selfuse' -and $Track -ne 'release') { throw ('未知轨道：' + $Track) }

$cfgPath = Join-Path $app 'product.config.json'
if (-not (Test-Path -LiteralPath $cfgPath)) { throw ('找不到 ' + $cfgPath) }
$srcCfg = (Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8) | ConvertFrom-Json
if (-not $Version) { $Version = $srcCfg.version }
if ($Version -ne $srcCfg.version) {
  throw ('-Version ' + $Version + ' 与 product.config.json 的 ' + $srcCfg.version + ' 不一致；版本号只改配置文件一处')
}
if (-not (Test-Path -LiteralPath $dist)) { $null = New-Item -ItemType Directory -Path $dist }

$outName = 'LightScreen-Setup-v' + $Version + '-' + $Track + '.exe'
$outFile = Join-Path $dist $outName
if (Test-Path -LiteralPath $outFile) {
  Remove-Item -LiteralPath $outFile -Force
  Say ('  [i] 已删掉旧产物，准备重出：' + $outName) 'Yellow'
}

Say ('轨道：' + $Track + '   版本：' + $Version) 'White'

# ---- 1. 按轨道打包 ------------------------------------------------------
if ($Track -eq 'selfuse') {
  Head '1/3 自用版：pack.ps1（app\ 原样，不 scrub）'
  $selfDist = Join-Path $root '.selfuse\dist'
  if (Test-Path -LiteralPath $selfDist) { Remove-Item -LiteralPath $selfDist -Recurse -Force }
  $null = New-Item -ItemType Directory -Path $selfDist -Force
  & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'pack.ps1') -AppDir $app -OutDir $selfDist -Zip -Version $Version | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'pack.ps1 失败' }
  $pkgDir = Join-Path $selfDist ('PhoneAccess-Basic-' + $Version)

  Head '2/3 自用版：出单文件安装包'
  & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'sfx\build-sfx.ps1') -DistRoot $selfDist -OutFile $outFile -Version $Version | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'build-sfx 失败' }
}
else {
  Head '1/3 发布版：build-release.ps1（scrub + 标记 release）'
  & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'build-release.ps1') -Version $Version -OutFile $outFile | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'build-release 失败' }
  $pkgDir = Join-Path $root ('.release\dist\PhoneAccess-Basic-' + $Version)
}

# ---- 2. 验收：包里的 profile / 版本 / 真光标都得对 ----------------------
Head '3/3 验收'
$wantProfile = if ($Track -eq 'selfuse') { 'selfuse' } else { 'release' }
$cfgOut = Join-Path $pkgDir 'product.config.json'
if (-not (Test-Path -LiteralPath $cfgOut)) { throw ('包里找不到 product.config.json：' + $cfgOut) }
$outCfg = (Get-Content -LiteralPath $cfgOut -Raw -Encoding UTF8) | ConvertFrom-Json
if ($outCfg.profile -ne $wantProfile) { throw ('profile 不对：包里是 ' + $outCfg.profile + '，预期 ' + $wantProfile) }
if ($outCfg.version -ne $Version) { throw ('版本不一致：包里是 ' + $outCfg.version + '，预期 ' + $Version) }
if ($outCfg.features -and $outCfg.features.realCursor -eq $false) { throw 'features.realCursor=false：真实光标会被关掉，确认是不是有意的' }
Write-Host ('  [OK] profile=' + $outCfg.profile + '  version=' + $outCfg.version + '  realCursor 开')

if (-not (Test-Path -LiteralPath $outFile)) { throw ('没生成安装包：' + $outFile) }
$fi = Get-Item -LiteralPath $outFile
$sha = (Get-FileHash -LiteralPath $outFile -Algorithm SHA256).Hash
Write-Host ''
Say ('产物：' + $outFile) 'Green'
Say ('  ' + [math]::Round($fi.Length / 1MB, 1) + ' MB   SHA256 ' + $sha) 'Green'
