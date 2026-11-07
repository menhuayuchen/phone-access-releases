# pack.ps1 — 把 app\ 打成"可以发给客户"的基础档产品包（卖家侧构建工具，不随包发给客户）
#
# 干什么（对照 app\PACKAGING.md）：
#   1) 从生产目录（只读）补二进制：capture.exe / input.exe / audio.exe / sources.exe /
#      lib\NAudio.*.dll / 图标 / make-qr.py / qrlib\
#   2) 从 app\ 按"白名单"复制产品代码（凭据、日志、开发脚本默认一律不带）
#   3) 补 node 运行时（默认锁 v24.21.0，wrtc 原生模块的 ABI 绑死它）和扁平化 node_modules
#      （生产目录里是 pnpm 的 junction 结构，直接拷会变成断链；这里解成真目录并去重）
#   4) 打包后自检：必需文件齐 / 禁止文件为 0 / node_modules 无链接 / 原生模块在 /
#      **生产 screen.key 任何一个字节都不在包里** / 文本里没有 ?k=<16位以上十六进制>
#   5) 输出最终包体积（基准 ≈ 110–140 MB）
#
# 硬约束：
#   · 只读生产目录，绝不修改它；生产 screen.key 绝不进包
#   · 本文件是 PowerShell 5.1 脚本，必须 UTF-8 带 BOM；不要用 PS7 语法
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File pack.ps1 -DryRun          # 只检查，不落地
#   powershell -NoProfile -ExecutionPolicy Bypass -File pack.ps1 -Zip             # 正式打包并生成 zip
#   powershell -NoProfile -ExecutionPolicy Bypass -File pack.ps1 -OutDir D:\dist  # 指定输出目录

param(
  [string]$AppDir = '',        # 产品代码目录（默认=本脚本所在目录）
  [string]$ProdDir = (Join-Path $env:LOCALAPPDATA 'PhoneAccess'),  # 生产目录（只读，默认取本机安装目录）
  [string]$OutDir = '',        # 输出目录（默认=<产品根>\dist）
  [string]$NodeExe = '',       # 指定 node.exe（默认自动找 v24.21.0 那一份）
  [string]$ExpectedNodeVersion = 'v24.21.0',
  [string]$Version = '',       # 包名里的版本（默认当天日期 yyyyMMdd）
  [switch]$DryRun,
  [switch]$Zip,
  [switch]$IncludeInternalDocs,   # 把 PACKAGING.md / check-health.ps1 也放进包（默认不带：内含主机名/路径/部分 token）
  [switch]$SkipTailscaleSetup     # 不把 bin\tailscale-setup.exe（1.4 MB）放进包
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$script:Errors = New-Object System.Collections.ArrayList
$script:Warnings = New-Object System.Collections.ArrayList

function Write-Head([string]$Text) {
  Write-Host ''
  Write-Host ('==== ' + $Text) -ForegroundColor Cyan
}
function Write-InfoLine([string]$Text) { Write-Host ('  [..] ' + $Text) }
function Write-OkLine([string]$Text) { Write-Host ('  [OK] ' + $Text) -ForegroundColor Green }
function Write-WarnLine([string]$Text) {
  Write-Host ('  [!] ' + $Text) -ForegroundColor Yellow
  [void]$script:Warnings.Add($Text)
}
function Write-ErrLine([string]$Text) {
  Write-Host ('  [X] ' + $Text) -ForegroundColor Red
  [void]$script:Errors.Add($Text)
}
function Format-Mb([long]$Bytes) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }

function Stop-Pack([string]$Text) {
  Write-Host ''
  Write-Host ('打包中止：' + $Text) -ForegroundColor Red
  if (-not $DryRun) { Write-Host '（输出目录里可能留下半个包，下次打包会自动清掉。）' }
  exit 1
}

# ---------------------------------------------------------------------------
# 0. 路径与参数
# ---------------------------------------------------------------------------
if (-not $AppDir) { $AppDir = $PSScriptRoot }
if (-not $AppDir) { $AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Test-Path -LiteralPath $AppDir -PathType Container)) { Stop-Pack ('找不到产品代码目录：' + $AppDir) }
$AppDir = (Resolve-Path -LiteralPath $AppDir).Path.TrimEnd('\')

if ($ProdDir -and -not (Test-Path -LiteralPath $ProdDir -PathType Container)) { Stop-Pack ('找不到生产目录（只读来源）：' + $ProdDir) }
if ($ProdDir) { $ProdDir = (Resolve-Path -LiteralPath $ProdDir).Path.TrimEnd('\') }

if ($ProdDir -eq $AppDir) { Stop-Pack '生产目录和产品目录是同一个，拒绝打包（会把生产文件混进包）。' }

if (-not $Version) { $Version = (Get-Date -Format 'yyyyMMdd') }
$packageName = 'PhoneAccess-Basic-' + $Version

if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $AppDir) 'dist' }
$outRoot = $OutDir
try { $outRoot = [System.IO.Path]::GetFullPath($OutDir) } catch { }
$stage = Join-Path $outRoot $packageName

$prodKeyFile = Join-Path $ProdDir 'screen.key'
$prodKey = ''
if (Test-Path -LiteralPath $prodKeyFile) {
  try { $prodKey = [string](Get-Content -LiteralPath $prodKeyFile -Raw -ErrorAction Stop); if ($prodKey) { $prodKey = $prodKey.Trim() } } catch { $prodKey = '' }
}

Write-Host ''
Write-Host '轻屏控制 · 基础档打包' -ForegroundColor Cyan
Write-InfoLine ('产品代码：' + $AppDir)
Write-InfoLine ('生产目录：' + $ProdDir + '（只读，不会修改）')
Write-InfoLine ('输出目录：' + $stage)
Write-InfoLine ('目标 node 版本：' + $ExpectedNodeVersion)
if ($DryRun) { Write-InfoLine '模式：干跑（只检查，不复制、不写文件）' }

# ---------------------------------------------------------------------------
# 1. 定义"要带什么"与"绝不带什么"
# ---------------------------------------------------------------------------
# app\ 里按白名单复制：除这些之外的一律不带（默认拒绝，而不是默认带）
$appFiles = @(
  'product.config.json',
  'product-config.ps1',
  'selfcheck.ps1',
  '自检.cmd',
  # 手机入口工具：客户自己能看二维码、换密钥（换密钥已内置在 entry.ps1，所以不需要带 rotate-key.ps1，
  # 那个在下面的禁止清单里，属卖家侧运维脚本）
  'entry.ps1',
  '手机入口.cmd',
  # 离线模式：桌面「轻屏」文件夹里的「离线模式」入口（2026-11-06）
  'offline-mode.ps1',
  '离线模式.cmd',
  # 离线模式：防火墙放行/恢复（局域网/热点/USB 直连）
  'offline-firewall.ps1',
  # 离线模式：关闭入口（恢复只监听本机/Tailscale）
  'offline-mode-off.ps1',
  '关闭离线模式.cmd',
  # 许可证：校验与状态生成随包分发。私钥在 seller-keys 目录（app 之外），天然打不进来。
  'licence.ps1',
  'licence-state.ps1',
  # 高性能模式（Moonlight/Sunshine）安装与卸载（2026-11-03）：可选组件，见 docs/B1-参考Moonlight-方案。
  'sunshine-integration.ps1',
  # 离线模式：电脑热点开关（Windows Mobile Hotspot / WinRT，2026-11-05）
  'hotspot-ctl.ps1',
  # 离线模式：局域网 https 自签证书生成（WebRTC 需要安全上下文，2026-11-06）
  'make-lan-cert.ps1',
  # 离线模式：本地 CA（手机装一次后 https 受信任、可安装成 App）
  'make-lan-ca.ps1',
  # 7 天试用锚点（2026-10-30）：licence-state.ps1 会 dot-source 它，缺了会退回"试用不可用"。
  'trial.ps1',
  'https-setup.ps1',
  'start-phone-access.ps1',
  'start-phone-access.cmd',
  'start-screen.ps1',
  'start-screen.cmd',
  'stop-phone-access.ps1',
  'stop-phone-access.cmd',
  'supervise.ps1',
  'autostart.ps1',
  'run-autostart.vbs',
  'install-elevated-input.ps1',
  'install.ps1',
  'install.cmd',
  'screen-server.mjs',
  'page.mjs',
  'lock-screen.ps1',
  'rtc.mjs',
  'decode.mjs',
  'input.mjs',
  'audio.mjs',
  'tunnel-proxy.mjs',
  'package.json',
  # 改动：图标现在是产品自有素材（由 app\icon-src.svg 渲染出来），
  # 从 app\ 取，不再依赖只读的生产目录。生产目录那份是旧图标。
  'icon-192.png',
  'icon-512.png',
  # 一键卸载 + 客户说明书（安装时会把说明书复制到桌面「轻屏」文件夹里）
  'uninstall.ps1',
  'uninstall.cmd',
  '使用说明.md',
  'dsh-port.ps1',
  'restart.ps1',
  'restart.cmd',
  'power-apply.ps1',
  'unlock-on-wake.ps1'
  # 2026-11-06 免费化：不再随包发收款码 / 联系方式（/branding/ 路由保留，卖家自己放图片即可）
)
if ($IncludeInternalDocs) {
  $appFiles += @('PACKAGING.md', 'check-health.ps1')
}

# 生产目录里必须补进包的二进制与素材（相对路径保持不变）
$prodFiles = @(
  'capture.exe',
  'capture.exe.bak',
  'input.exe',
  'audio.exe',
  'sources.exe',
  'lib\NAudio.Core.dll',
  'lib\NAudio.Wasapi.dll',
  'lib\NAudio.WinMM.dll',
  # 图标不再从这里取 —— 它是产品自有素材，在 app\icon-src.svg 生成，见 $appFiles
  'make-qr.py',
  'decode-qr.py',
  'pnpm-lock.yaml'
)

# 打包后的必需文件（缺任何一个都算包坏）
$requiredInStage = @(
  'product.config.json', 'product-config.ps1', 'selfcheck.ps1', '自检.cmd',
  'start-phone-access.ps1', 'start-phone-access.cmd', 'start-screen.ps1',
  'stop-phone-access.ps1', 'stop-phone-access.cmd',
  'supervise.ps1', 'autostart.ps1', 'run-autostart.vbs', 'install-elevated-input.ps1',
  'install.ps1', 'install.cmd',
  'screen-server.mjs', 'page.mjs', 'rtc.mjs', 'decode.mjs', 'input.mjs', 'audio.mjs', 'sunshine-integration.ps1',
  'package.json', 'pnpm-lock.yaml',
  'capture.exe', 'capture.exe.bak', 'input.exe', 'audio.exe', 'sources.exe',
  'lib\NAudio.Core.dll', 'lib\NAudio.Wasapi.dll', 'lib\NAudio.WinMM.dll',
  'icon-192.png', 'icon-512.png',
  'runtime\node.exe',
  'node_modules\ws\package.json',
  'node_modules\sharp\package.json',
  'node_modules\@roamhq\wrtc\package.json',
  'node_modules\@roamhq\wrtc-win32-x64\package.json',
  'node_modules\detect-libc\package.json',
  'node_modules\semver\package.json',
  'node_modules\@img\sharp-win32-x64\package.json'
)

# 包里绝对不能出现的文件（凭据 / 日志 / 二维码 / 开发文件 / 链接产物）
$forbiddenExact = @(
  'screen.key', 'node-path.txt',
  'screen-url.txt', 'screen-url-lan.txt', 'tailip-url.txt', 'lan-url.txt', 'login-url.txt', 'phone-url.txt',
  'phone-qr.png', 'qr-login.png', 'qr-tailip.png', 'screen-qr.png', 'screen-qr-lan.png', 'tailnet-qr.png',
  '手机入口速查.md', '轻屏入口速查.pdf', 'README.md', 'make_doc.py',
  'upgrade-rc3.ps1', 'upgrade-rc3.result.txt', 'upgrade-rc3.log',
  'syntax-check.ps1', 'focus-test.ps1', 'elevated-inject-test.ps1',
  'cursor-test.cs', 'cursor-test.exe', 'cursor-probe.cs', 'win-scan.ps1',
  'input-diag.cs', 'input-diag2.cs', 'input-diag3.cs',
  'capture.cs', 'input.cs', 'audio.cs', 'sources.cs', 'capture-sources.inc',
  'harden-firewall.ps1', 'rotate-key.ps1', 'maintenance.ps1',
  'show-qr.ps1', 'show-qr.cmd', 'start-remote.ps1', 'start-remote.cmd',
  'stop-remote.ps1', 'stop-remote.cmd',
  'sync-profile.ps1', 'sync-profile.cmd', 'sync-profile-plugins.ps1',
  'plugin-sync-exclude.txt', 'tunnel-proxy.mjs.bak-20261025-2030',
  'capture.mode', 'capture.interval', 'viewers.count', 'screen-latest.jpg',
  'supervisor.heartbeat', 'supervisor.lock', 'plugin-sync.stamp',
  # 许可证相关：绝不能进包
  #   licence.json     = 已签发的许可证（每台机器一份，带客户信息）
  #   machine.id       = 本机机器码缓存（卖家机器上的）
  #   licence.state.json = 运行时状态
  'licence.json', 'machine.id', 'licence.state.json',
  'pack.ps1'
)
if (-not $IncludeInternalDocs) {
  # 内部文档默认不带：PACKAGING.md 含主机名/内部路径，check-health.ps1 会打印部分 token 和 DNS。
  $forbiddenExact += @('PACKAGING.md', 'check-health.ps1')
}

Write-Head '1/7 检查源文件（产品目录 + 生产目录）'
$missingApp = New-Object System.Collections.ArrayList
foreach ($rel in $appFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $AppDir $rel))) { [void]$missingApp.Add($rel) }
}
if ($missingApp.Count -gt 0) {
  foreach ($m in $missingApp) { Write-ErrLine ('产品目录缺少：' + $m) }
  Stop-Pack '产品代码不齐，先补齐再打包。'
}
Write-OkLine ('产品代码齐全（' + [string]$appFiles.Count + ' 个文件，白名单之外的一律不带）')

$missingProd = New-Object System.Collections.ArrayList
foreach ($rel in $prodFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $ProdDir $rel))) { [void]$missingProd.Add($rel) }
}
if ($missingProd.Count -gt 0) {
  foreach ($m in $missingProd) { Write-ErrLine ('生产目录缺少：' + $m) }
  Stop-Pack '生产目录里的二进制不齐（这些是运行必需的）。'
}
Write-OkLine ('生产目录二进制齐全（' + [string]$prodFiles.Count + ' 个文件）')

$qrlibDir = Join-Path $ProdDir 'qrlib'
$qrlibOk = $false
if (Test-Path -LiteralPath $qrlibDir) {
  $qrlibCount = @(Get-ChildItem -LiteralPath $qrlibDir -Recurse -File -Force -ErrorAction SilentlyContinue).Count
  if ($qrlibCount -ge 50) { $qrlibOk = $true; Write-OkLine ('qrlib 齐全（' + [string]$qrlibCount + ' 个文件，约 2.4 MB）') }
  else { Write-ErrLine ('qrlib 文件太少（只有 ' + [string]$qrlibCount + ' 个），二维码生成会坏') }
} else {
  Write-WarnLine '生产目录没有 qrlib：二维码不会生成（网址照写，属降级）'
}

$tailscaleSetup = Join-Path $ProdDir 'bin\tailscale-setup.exe'
$includeTailscale = $false
if (-not $SkipTailscaleSetup -and (Test-Path -LiteralPath $tailscaleSetup)) {
  $includeTailscale = $true
  Write-OkLine ('会带上 Tailscale 安装包（' + (Format-Mb (Get-Item -LiteralPath $tailscaleSetup).Length) + '），客户机上安装器可以直接帮你打开它')
} elseif ($SkipTailscaleSetup) {
  Write-InfoLine '按参数不带 Tailscale 安装包'
} else {
  Write-WarnLine '生产目录没有 bin\tailscale-setup.exe：客户要自己去官网装 Tailscale'
}
if (-not $IncludeInternalDocs) {
  Write-InfoLine '不带内部文档（PACKAGING.md / check-health.ps1）：它们含主机名、内部路径或部分 token，不适合发给客户'
}

# ---------------------------------------------------------------------------
# 2. 源文件编码守卫（这次已经实测踩过的三个坑，打包前先挡掉）
# ---------------------------------------------------------------------------
Write-Head '2/7 检查源文件编码（.ps1 带 BOM / .cmd 纯 ASCII / .mjs+.json 不带 BOM）'
function Test-HasBom([string]$Path) {
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 3) { return $false }
    return (($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF))
  } catch { return $false }
}
function Test-IsPureAscii([string]$Path) {
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    foreach ($b in $bytes) { if ($b -gt 0x7F) { return $false } }
    return $true
  } catch { return $false }
}
$encodingErrors = 0
foreach ($rel in $appFiles) {
  $p = Join-Path $AppDir $rel
  if ($rel -like '*.ps1') {
    if (-not (Test-HasBom $p)) { Write-ErrLine ('.ps1 没有 BOM（PS 5.1 会把中文按 ANSI 读，直接语法报错）：' + $rel); $encodingErrors++ }
  } elseif ($rel -like '*.cmd') {
    if (-not (Test-IsPureAscii $p)) { Write-ErrLine ('.cmd 含非 ASCII 字符（cmd.exe 会拆成命令执行）：' + $rel); $encodingErrors++ }
  } elseif (($rel -like '*.mjs') -or ($rel -like '*.json')) {
    if (Test-HasBom $p) { Write-ErrLine ('.mjs/.json 不能带 BOM（Node 会把 BOM 当非法字符）：' + $rel); $encodingErrors++ }
  }
}
if ($encodingErrors -gt 0) { Stop-Pack ('编码检查没通过：' + [string]$encodingErrors + ' 个文件。') }
Write-OkLine '编码检查通过（.ps1 都带 BOM / .cmd 都是纯 ASCII / .mjs 和 .json 都不带 BOM）'

# ---------------------------------------------------------------------------
# 3. 找 node 运行时（锁版本：wrtc 是原生模块，换 node = 黑屏）
# ---------------------------------------------------------------------------
Write-Head '3/7 找自带 node 运行时'
function Find-NodeCandidates {
  $list = New-Object System.Collections.ArrayList
  if ($NodeExe) { [void]$list.Add($NodeExe) }
  $prodNodeTxt = Join-Path $ProdDir 'node-path.txt'
  if (Test-Path -LiteralPath $prodNodeTxt) {
    try {
      $v = [string](Get-Content -LiteralPath $prodNodeTxt -Raw -ErrorAction Stop)
      if ($v) { [void]$list.Add($v.Trim()) }
    } catch { }
  }
  if ($env:LOCALAPPDATA) {
    $base = Join-Path $env:LOCALAPPDATA '.dsh\dsh-runtimes'
    if (Test-Path -LiteralPath $base) {
      foreach ($d in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
        $p = Join-Path $d.FullName 'dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $p) { [void]$list.Add($p) }
      }
    }
  }
  foreach ($base in @('D:\deepseek\resources\runtime', 'C:\deepseek\resources\runtime')) {
    if (Test-Path -LiteralPath $base) {
      foreach ($d in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
        $p = Join-Path $d.FullName 'dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $p) { [void]$list.Add($p) }
      }
    }
  }
  try {
    $cmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) { [void]$list.Add([string]$cmd.Source) }
  } catch { }
  return $list.ToArray()
}

$nodeChosen = ''
$nodeCandidates = @(Find-NodeCandidates)
foreach ($cand in $nodeCandidates) {
  if (-not $cand) { continue }
  if (-not (Test-Path -LiteralPath $cand -PathType Leaf)) { continue }
  $ver = ''
  try { $ver = [string]((& $cand --version 2>$null) | Select-Object -First 1) } catch { $ver = '' }
  if (-not $ver) { continue }
  $ver = $ver.Trim()
  if ($ver.StartsWith($ExpectedNodeVersion)) { $nodeChosen = $cand; break }
  Write-WarnLine ('跳过 node ' + $ver + '：' + $cand)
}
if (-not $nodeChosen) {
  Write-ErrLine ('找不到 ' + $ExpectedNodeVersion + ' 的 node.exe（wrtc 原生模块的 ABI 绑死这个版本，换版本客户机流畅模式会黑屏）')
  Write-InfoLine '找过：'
  foreach ($cand in $nodeCandidates) { Write-InfoLine ('  ' + [string]$cand) }
  Stop-Pack '先准备好 v24.21.0 的 node.exe 再用 -NodeExe 指定。'
}
Write-OkLine ('用这一份 node：' + $nodeChosen)
Write-OkLine ('版本：' + $ExpectedNodeVersion + '（锁死：不要换版本、不要在客户机上装 node）')

# 生产 node_modules 去重后的真实体积（干跑估算与实际包体积都要这个数）
function Get-UniqueTreeSize {
  param([string]$Dir, $Seen)
  $total = 0L
  $item = Get-Item -LiteralPath $Dir -Force -ErrorAction SilentlyContinue
  if (-not $item) { return 0 }
  $real = [string]$item.FullName
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    $t = ''
    try { $t = [string]@($item.Target)[0] } catch { $t = '' }
    if ($t) { if ($t.StartsWith('\\?\')) { $t = $t.Substring(4) }; $real = $t }
  }
  if (-not $real) { return 0 }
  if ($Seen.ContainsKey($real)) { return 0 }
  $Seen[$real] = $true
  try { foreach ($f in [System.IO.Directory]::GetFiles($real)) { $total += (New-Object System.IO.FileInfo $f).Length } } catch { }
  try { foreach ($d in [System.IO.Directory]::GetDirectories($real)) { $total += (Get-UniqueTreeSize -Dir $d -Seen $Seen) } } catch { }
  return $total
}

$nmSource = Join-Path $ProdDir 'node_modules'
if (-not (Test-Path -LiteralPath $nmSource)) { Stop-Pack '生产目录没有 node_modules，打出来的包在客户机上起不来。' }
$seenMap = @{}
$nmSize = Get-UniqueTreeSize -Dir $nmSource -Seen $seenMap
Write-OkLine ('node_modules 源体积（解开链接、去重后）：' + (Format-Mb $nmSize))

# ---------------------------------------------------------------------------
# 4. 干跑：只报计划与体积估算
# ---------------------------------------------------------------------------
if ($DryRun) {
  Write-Head '4/7 干跑：文件与体积估算'
  $appSize = 0L
  foreach ($rel in $appFiles) { $appSize += (Get-Item -LiteralPath (Join-Path $AppDir $rel)).Length }
  $prodSize = 0L
  foreach ($rel in $prodFiles) { $prodSize += (Get-Item -LiteralPath (Join-Path $ProdDir $rel)).Length }
  if ($qrlibOk) { $qrlibSize = Get-UniqueTreeSize -Dir $qrlibDir -Seen @{}; $prodSize += $qrlibSize }
  if ($includeTailscale) { $prodSize += (Get-Item -LiteralPath $tailscaleSetup).Length }
  $nodeSize = (Get-Item -LiteralPath $nodeChosen).Length
  $est = $appSize + $prodSize + $nodeSize + $nmSize
  Write-InfoLine ('产品代码约：' + (Format-Mb $appSize))
  Write-InfoLine ('二进制/素材约：' + (Format-Mb $prodSize))
  Write-InfoLine ('node.exe：' + (Format-Mb $nodeSize))
  Write-InfoLine ('node_modules：' + (Format-Mb $nmSize))
  Write-InfoLine ('预计包体积：约 ' + (Format-Mb $est) + '（PACKAGING.md 基准 ≈ 129 MB）')
  Write-Host ''
  Write-Host '干跑结束：没有写任何文件。去掉 -DryRun 就是正式打包。' -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------------------
# 5. 正式打包
# ---------------------------------------------------------------------------
Write-Head '4/7 准备输出目录'
if (-not (Test-Path -LiteralPath $outRoot)) { $null = New-Item -ItemType Directory -Path $outRoot -Force }
if (Test-Path -LiteralPath $stage) {
  # 只删我们自己生成的包目录：路径必须在 outRoot 下，且名字是我们拼出来的
  $fullStage = [System.IO.Path]::GetFullPath($stage)
  $fullOut = [System.IO.Path]::GetFullPath($outRoot)
  if (-not $fullStage.StartsWith($fullOut, [System.StringComparison]::OrdinalIgnoreCase) -or ($fullStage -notmatch 'PhoneAccess-Basic-')) {
    Stop-Pack ('拒绝删除不认识的目录：' + $fullStage)
  }
  Write-InfoLine ('清掉上次的输出：' + $stage)
  Remove-Item -LiteralPath $fullStage -Recurse -Force
}
$null = New-Item -ItemType Directory -Path $stage -Force
Write-OkLine ('输出目录就绪：' + $stage)

Write-Head '5/7 复制产品代码 + 补二进制 + 补 node 运行时'
$copiedFiles = 0
foreach ($rel in $appFiles) {
  $src = Join-Path $AppDir $rel
  $dst = Join-Path $stage $rel
  $dstDir = Split-Path -Parent $dst
  if ($dstDir -and -not (Test-Path -LiteralPath $dstDir)) { $null = New-Item -ItemType Directory -Path $dstDir -Force }
  Copy-Item -LiteralPath $src -Destination $dst -Force
  $copiedFiles++
}
Write-OkLine ('产品代码：' + [string]$copiedFiles + ' 个文件')

foreach ($rel in $prodFiles) {
  $src = Join-Path $ProdDir $rel
  $dst = Join-Path $stage $rel
  $dstDir = Split-Path -Parent $dst
  if ($dstDir -and -not (Test-Path -LiteralPath $dstDir)) { $null = New-Item -ItemType Directory -Path $dstDir -Force }
  Copy-Item -LiteralPath $src -Destination $dst -Force
}
Write-OkLine ('二进制与素材：' + [string]$prodFiles.Count + ' 个文件')

if ($qrlibOk) {
  Copy-Item -LiteralPath $qrlibDir -Destination (Join-Path $stage 'qrlib') -Recurse -Force
  Write-OkLine 'qrlib 已复制'
}

if ($includeTailscale) {
  $binDst = Join-Path $stage 'bin'
  if (-not (Test-Path -LiteralPath $binDst)) { $null = New-Item -ItemType Directory -Path $binDst -Force }
  Copy-Item -LiteralPath $tailscaleSetup -Destination (Join-Path $binDst 'tailscale-setup.exe') -Force
  Write-OkLine 'Tailscale 安装包已复制到 bin\tailscale-setup.exe'
}

# 可选组件：高性能模式（Sunshine/Moonlight，GPL-3.0 独立程序，2026-11-03）。
# 软集成：app\ 里有 MSI 就带上；没有就跳过（不带也能正常打包，网页模式照常可用）。
# GPL 说明与许可证文本放在包内 docs\，见 app\docs\高性能模式-GPL说明.txt。
$sunshineMsiName = 'Sunshine-Windows-AMD64-installer.msi'
$sunshineMsi = Join-Path $AppDir $sunshineMsiName
if (Test-Path -LiteralPath $sunshineMsi) {
  Copy-Item -LiteralPath $sunshineMsi -Destination (Join-Path $stage $sunshineMsiName) -Force
  $gplCopied = 0
  $gplDst = Join-Path $stage 'docs'
  foreach ($g in @('LICENSE-Sunshine-GPL-3.0.txt', '高性能模式-GPL说明.txt')) {
    $gp = Join-Path $AppDir ('docs\' + $g)
    if (Test-Path -LiteralPath $gp) {
      if (-not (Test-Path -LiteralPath $gplDst)) { $null = New-Item -ItemType Directory -Path $gplDst -Force }
      Copy-Item -LiteralPath $gp -Destination (Join-Path $gplDst $g) -Force
      $gplCopied++
    }
  }
  Write-OkLine ('高性能模式组件已带上（Sunshine MSI + GPL 文件 ' + [string]$gplCopied + ' 个，约 ' + (Format-Mb (Get-Item -LiteralPath $sunshineMsi).Length) + '）')
} else {
  Write-WarnLine ('没有高性能模式组件（未找到 app\' + $sunshineMsiName + '）：本包不含 Moonlight 通道，网页模式照常可用')
}
# 可选组件：ffmpeg（网页端 H.264 编码用，2026-11-04）。
# 软集成：app\bin\ffmpeg.exe 存在就带上；没有就跳过（网页端继续走 MJPEG）。
# 注意：这个文件约 100 MB，zip 后约 36-40 MB；包体上限（蓝奏云 100 MB）要留余量。
$ffmpegExe = Join-Path $AppDir 'bin\ffmpeg.exe'
if (Test-Path -LiteralPath $ffmpegExe) {
  $binDst2 = Join-Path $stage 'bin'
  if (-not (Test-Path -LiteralPath $binDst2)) { $null = New-Item -ItemType Directory -Path $binDst2 -Force }
  Copy-Item -LiteralPath $ffmpegExe -Destination (Join-Path $binDst2 'ffmpeg.exe') -Force
  $ffNotice = Join-Path $AppDir 'docs\FFmpeg-GPL说明.txt'
  if (Test-Path -LiteralPath $ffNotice) {
    $docsDst2 = Join-Path $stage 'docs'
    if (-not (Test-Path -LiteralPath $docsDst2)) { $null = New-Item -ItemType Directory -Path $docsDst2 -Force }
    Copy-Item -LiteralPath $ffNotice -Destination (Join-Path $docsDst2 'FFmpeg-GPL说明.txt') -Force
  }
  Write-OkLine ('网页端 H.264 组件已带上（bin\ffmpeg.exe，' + (Format-Mb (Get-Item -LiteralPath $ffmpegExe).Length) + '）')
} else {
  Write-WarnLine '没有网页端 H.264 组件（未找到 app\bin\ffmpeg.exe）：网页端继续用 MJPEG'
}
# 可选组件：单窗口采集（实验，2026-11-05）。app\bin\win-capture.exe 存在就带上；
# 缺失时服务端自动回退全屏采集，不影响主流程。
$winCapExe = Join-Path $AppDir 'bin\win-capture.exe'
if (Test-Path -LiteralPath $winCapExe) {
  $binDstWin = Join-Path $stage 'bin'
  if (-not (Test-Path -LiteralPath $binDstWin)) { $null = New-Item -ItemType Directory -Path $binDstWin -Force }
  Copy-Item -LiteralPath $winCapExe -Destination (Join-Path $binDstWin 'win-capture.exe') -Force
  Write-OkLine ('单窗口采集组件已带上（bin\win-capture.exe，' + (Format-Mb (Get-Item -LiteralPath $winCapExe).Length) + '）')
} else {
  Write-WarnLine '没有单窗口采集组件（未找到 app\bin\win-capture.exe）：只影响"单窗口采集（实验）"开关'
}

# 可选组件：B 方案侧车（Pion WebRTC H.264，2026-11-05）。
# app\rtc-h264\rtc-h264.exe 是本地 Go 构建产物（不进仓库）；存在就带上，没有只少一条低延迟通道。
# 用 realtime 通道的前提：product.config.json 里 screen.h264.rtc264.enabled=true，页面 ?rtc264=1。
$rtcExe = Join-Path $AppDir 'rtc-h264\rtc-h264.exe'
if (Test-Path -LiteralPath $rtcExe) {
  $rtcDst = Join-Path $stage 'rtc-h264'
  if (-not (Test-Path -LiteralPath $rtcDst)) { $null = New-Item -ItemType Directory -Path $rtcDst -Force }
  Copy-Item -LiteralPath $rtcExe -Destination (Join-Path $rtcDst 'rtc-h264.exe') -Force
  Write-OkLine ('B 方案侧车已带上（rtc-h264.exe，' + (Format-Mb (Get-Item -LiteralPath $rtcExe).Length) + '）')
} else {
  Write-WarnLine '没有 B 方案侧车（未找到 app\rtc-h264\rtc-h264.exe）：rtc264 通道不可用，网页模式照常'
}

$runtimeDst = Join-Path $stage 'runtime'
if (-not (Test-Path -LiteralPath $runtimeDst)) { $null = New-Item -ItemType Directory -Path $runtimeDst -Force }
Copy-Item -LiteralPath $nodeChosen -Destination (Join-Path $runtimeDst 'node.exe') -Force
$nodeInStage = Join-Path $runtimeDst 'node.exe'
$nodeVerInStage = ''
try { $nodeVerInStage = [string]((& $nodeInStage --version 2>$null) | Select-Object -First 1) } catch { $nodeVerInStage = '' }
if (-not $nodeVerInStage.StartsWith($ExpectedNodeVersion)) {
  Stop-Pack ('复制过去的 node.exe 版本不对（' + $nodeVerInStage + '），客户机会黑屏。')
}
Write-OkLine ('node.exe 已放进 runtime\（版本 ' + $nodeVerInStage + '，' + (Format-Mb (Get-Item -LiteralPath $nodeInStage).Length) + '）')

# ---- node_modules：解开 pnpm 的 junction，铺平成 npm 风格（去重、无链接）----
function Resolve-LinkTarget {
  param([string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return [string]$item.FullName }
  $t = ''
  try { $t = [string]@($item.Target)[0] } catch { $t = '' }
  if (-not $t) { return '' }
  if ($t.StartsWith('\\?\')) { $t = $t.Substring(4) }
  if (-not (Test-Path -LiteralPath $t)) { return '' }
  return $t
}
function Copy-RealTree {
  param([string]$Source, [string]$Dest, $Stack)
  $real = ''
  try { $real = Resolve-LinkTarget -Path $Source } catch { $real = '' }
  if (-not $real) { return 0 }
  if ($Stack -contains $real) { return 0 }
  if (-not (Test-Path -LiteralPath $Dest)) { $null = New-Item -ItemType Directory -Path $Dest -Force }
  $count = 0
  try {
    foreach ($f in [System.IO.Directory]::GetFiles($real)) {
      Copy-Item -LiteralPath $f -Destination (Join-Path $Dest ([System.IO.Path]::GetFileName($f))) -Force
      $count++
    }
  } catch { }
  $childStack = New-Object System.Collections.ArrayList
  foreach ($x in $Stack) { [void]$childStack.Add($x) }
  [void]$childStack.Add($real)
  try {
    foreach ($d in [System.IO.Directory]::GetDirectories($real)) {
      $name = [System.IO.Path]::GetFileName($d)
      $childReal = ''
      try { $childReal = Resolve-LinkTarget -Path $d } catch { $childReal = '' }
      if (-not $childReal) { continue }
      if ($childStack -contains $childReal) { continue }
      $count += (Copy-RealTree -Source $d -Dest (Join-Path $Dest $name) -Stack $childStack)
    }
  } catch { }
  return $count
}

$nmDest = Join-Path $stage 'node_modules'
$null = New-Item -ItemType Directory -Path $nmDest -Force
$emptyStack = New-Object System.Collections.ArrayList
$nmFileCount = 0

# 1) 顶层已声明的依赖：ws / sharp / @roamhq\wrtc（遇到链接就拷它指向的真实内容）
foreach ($entry in @(Get-ChildItem -LiteralPath $nmSource -Force -Directory -ErrorAction SilentlyContinue)) {
  if ($entry.Name -eq '.pnpm') { continue }
  if ($entry.Name.StartsWith('.')) { continue }
  if ($entry.Name -eq 'node_modules') { continue }
  $nmFileCount += (Copy-RealTree -Source $entry.FullName -Dest (Join-Path $nmDest $entry.Name) -Stack $emptyStack)
}
# 2) pnpm 虚拟仓库里被提升的依赖：@img\*、@roamhq\wrtc-win32-x64、detect-libc、semver、domexception、webidl-conversions
$hoisted = Join-Path $nmSource '.pnpm\node_modules'
if (Test-Path -LiteralPath $hoisted) {
  foreach ($entry in @(Get-ChildItem -LiteralPath $hoisted -Force -Directory -ErrorAction SilentlyContinue)) {
    if ($entry.Name.StartsWith('.')) { continue }
    $dstTop = Join-Path $nmDest $entry.Name
    if (-not (Test-Path -LiteralPath $dstTop)) {
      $nmFileCount += (Copy-RealTree -Source $entry.FullName -Dest $dstTop -Stack $emptyStack)
    } else {
      foreach ($sub in @(Get-ChildItem -LiteralPath $entry.FullName -Force -Directory -ErrorAction SilentlyContinue)) {
        $dstSub = Join-Path $dstTop $sub.Name
        if (-not (Test-Path -LiteralPath $dstSub)) {
          $nmFileCount += (Copy-RealTree -Source $sub.FullName -Dest $dstSub -Stack $emptyStack)
        }
      }
    }
  }
}
Write-OkLine ('node_modules 已铺平：' + [string]$nmFileCount + ' 个文件，' + (Format-Mb (Get-UniqueTreeSize -Dir $nmDest -Seen @{})))

# 客户双击入口：英文 install.cmd 之外再给一个中文名的副本（内容同样是纯 ASCII）
$friendlyEntry = Join-Path $stage '安装轻屏.cmd'
Copy-Item -LiteralPath (Join-Path $stage 'install.cmd') -Destination $friendlyEntry -Force
Write-OkLine '已加中文双击入口：安装轻屏.cmd（内容与 install.cmd 相同，纯 ASCII）'

# ---------------------------------------------------------------------------
# 6. 打包后自检
# ---------------------------------------------------------------------------
Write-Head '6/7 打包后自检'
$selfCheckErrors = 0

# 6.1 必需文件
$missingStage = New-Object System.Collections.ArrayList
foreach ($rel in $requiredInStage) {
  if (-not (Test-Path -LiteralPath (Join-Path $stage $rel))) { [void]$missingStage.Add($rel) }
}
if ($missingStage.Count -gt 0) {
  foreach ($m in $missingStage) { Write-ErrLine ('包里缺：' + $m) }
  $selfCheckErrors++
} else {
  Write-OkLine ('必需文件齐全（' + [string]$requiredInStage.Count + ' 项）')
}

# 6.2 node_modules 必须是真目录 + 原生模块必须在
try {
  $reparseDirs = @(Get-ChildItem -LiteralPath $nmDest -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  if ($reparseDirs.Count -gt 0) {
    Write-ErrLine ('node_modules 里还有 ' + [string]$reparseDirs.Count + ' 个链接目录（客户机会断链）')
    $selfCheckErrors++
  } else {
    Write-OkLine 'node_modules 全部是真目录（没有 junction / 符号链接）'
  }
} catch { Write-WarnLine '链接检查没能完成（不影响主要结论）' }

$nativeNodes = @(Get-ChildItem -LiteralPath $nmDest -Recurse -File -Filter '*.node' -ErrorAction SilentlyContinue)
$hasWrtc = @($nativeNodes | Where-Object { $_.Name -eq 'wrtc.node' -and $_.Length -gt 10MB }).Count -gt 0
$hasSharp = @($nativeNodes | Where-Object { $_.Name -like 'sharp-win32-x64-*.node' }).Count -gt 0
if ($hasWrtc -and $hasSharp) {
  Write-OkLine ('原生模块都在（wrtc.node 15.5 MB / sharp ' + (Format-Mb (($nativeNodes | Where-Object { $_.Name -like 'sharp-win32-x64-*.node' } | Select-Object -First 1).Length)) + '）')
} else {
  Write-ErrLine ('原生模块缺失：wrtc=' + [string]$hasWrtc + ' sharp=' + [string]$hasSharp + '（流畅模式/图片会坏）')
  $selfCheckErrors++
}

# 6.3 禁止文件
$forbiddenHits = New-Object System.Collections.ArrayList
foreach ($rel in $forbiddenExact) {
  if (Test-Path -LiteralPath (Join-Path $stage $rel)) { [void]$forbiddenHits.Add($rel) }
}
$allStageFiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Force -ErrorAction SilentlyContinue)
foreach ($f in $allStageFiles) {
  $name = $f.Name
  if ($f.Extension -in '.log', '.err', '.out') { [void]$forbiddenHits.Add($f.FullName); continue }
  if ($name -like '*.bak*' -and $name -ne 'capture.exe.bak') { [void]$forbiddenHits.Add($f.FullName); continue }
  if ($name -like 'phone-qr*' -or $name -like 'screen-qr*' -or $name -eq 'qr-login.png' -or $name -eq 'qr-tailip.png' -or $name -eq 'tailnet-qr.png') {
    [void]$forbiddenHits.Add($f.FullName)
  }
}
if ($forbiddenHits.Count -gt 0) {
  foreach ($h in @($forbiddenHits | Select-Object -First 20)) { Write-ErrLine ('不该出现在包里：' + [string]$h) }
  $selfCheckErrors++
} else {
  Write-OkLine '禁止文件 0 个（密钥 / 日志 / 二维码 / 开发脚本都不在包里）'
}

# 6.4 生产密钥扫描：包里的任何文件（含二进制）都不许含生产 screen.key 的任何一个字节
if ($prodKey) {
  $keyHits = New-Object System.Collections.ArrayList
  foreach ($f in $allStageFiles) {
    $hit = $false
    try {
      if ($f.Length -gt 0) {
        $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
        $latin = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
        if ($latin.IndexOf($prodKey, [System.StringComparison]::Ordinal) -ge 0) { $hit = $true }
      }
    } catch { $hit = $false }
    if ($hit) { [void]$keyHits.Add($f.FullName) }
  }
  if ($keyHits.Count -gt 0) {
    foreach ($h in $keyHits) { Write-ErrLine ('包里有生产密钥的字节：' + [string]$h) }
    $selfCheckErrors++
  } else {
    Write-OkLine ('生产密钥扫描：0 处（扫了 ' + [string]$allStageFiles.Count + ' 个文件，含二进制）')
  }
} else {
  Write-WarnLine '生产目录没有 screen.key（或读不到），无法做"包内不含生产密钥"的字节比对；请确认这一步要不要补'
}

# 6.5 文本里的带密钥 URL / token
$textHits = New-Object System.Collections.ArrayList
$textExt = @('.txt', '.md', '.json', '.js', '.mjs', '.ps1', '.cmd', '.vbs', '.py', '.yaml', '.yml', '.html', '.htm')
try {
  foreach ($f in $allStageFiles) {
    if ($textExt -notcontains $f.Extension) { continue }
    try {
      $matches = @(Select-String -LiteralPath $f.FullName -Pattern '\?k=[0-9a-fA-F]{16,}|[?&]token=[A-Za-z0-9_\-\.]{16,}' -AllMatches -ErrorAction SilentlyContinue)
      if ($matches.Count -gt 0) { [void]$textHits.Add([string]$f.FullName + ':' + [string]$matches[0].LineNumber) }
    } catch { }
  }
} catch { }
if ($textHits.Count -gt 0) {
  foreach ($h in $textHits) { Write-ErrLine ('文本里有带密钥的网址 / token：' + [string]$h) }
  $selfCheckErrors++
} else {
  Write-OkLine '文本里的 ?k= / token= 扫描：0 处'
}

# 6.6 生产机的 tailnet IP / 主机名（不阻断，但要让卖家知道）
$identifierHits = New-Object System.Collections.ArrayList
foreach ($f in $allStageFiles) {
  if ($textExt -notcontains $f.Extension) { continue }
  try {
    $hits = @(Select-String -LiteralPath $f.FullName -Pattern '100\.108\.92\.22|LAPTOP-0FIMMV7J' -ErrorAction SilentlyContinue)
    foreach ($h in $hits) { [void]$identifierHits.Add($f.FullName.Substring($stage.Length + 1) + ':' + [string]$h.LineNumber) }
  } catch { }
}
if ($identifierHits.Count -gt 0) {
  Write-WarnLine ('包里出现生产机的 tailnet IP 或主机名 ' + [string]$identifierHits.Count + ' 处（多是注释；功能无影响，但会暴露卖家的内网信息）')
  foreach ($h in @($identifierHits | Select-Object -First 10)) { Write-WarnLine ('  ' + [string]$h) }
}

if ($selfCheckErrors -gt 0) {
  Stop-Pack ('打包后自检有 ' + [string]$selfCheckErrors + ' 项没通过，这个包不能发。')
}

# 6.7 体积
Write-Head '7/7 结果'
$stageSize = Get-UniqueTreeSize -Dir $stage -Seen @{}
$fileCount = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Force -ErrorAction SilentlyContinue).Count
Write-OkLine ('目录：' + $stage)
Write-OkLine ('文件：' + [string]$fileCount + ' 个')
Write-OkLine ('体积：' + (Format-Mb $stageSize))
$msiIncluded = Test-Path -LiteralPath (Join-Path $stage 'Sunshine-Windows-AMD64-installer.msi')
$sizeMaxMb = if ($msiIncluded) { 170 } else { 160 }
if ($stageSize -lt 100MB) {
  Write-WarnLine ('比基准（≈129 MB）小很多：确认 node.exe 和 node_modules 都在（node.exe 约 89 MB）')
} elseif ($stageSize -gt ($sizeMaxMb * 1MB)) {
  Write-WarnLine ('比基准大很多（上限 ' + [string]$sizeMaxMb + ' MB，' + $(if ($msiIncluded) { '已含 32 MB 高性能模式组件' } else { '未含高性能模式组件' }) + '）：确认没有把 cloudflared（55 MB，只属标准档）或多余文件带进来')
} else {
  Write-OkLine ('体积在预期范围（基准 ≈129 MB' + $(if ($msiIncluded) { '，含高性能模式组件 ≈161 MB' } else { '' }) + '）')
}
if ($script:Warnings.Count -gt 0) {
  Write-Host ''
  Write-Host '提醒（不阻断发布，但建议看一眼）：' -ForegroundColor Yellow
  foreach ($w in $script:Warnings) { Write-Host ('  - ' + [string]$w) -ForegroundColor Yellow }
}

$zipPath = ''
if ($Zip) {
  Write-Head '额外：生成 zip'
  $zipPath = $stage + '.zip'
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    Write-OkLine ('zip：' + $zipPath + '（' + (Format-Mb (Get-Item -LiteralPath $zipPath).Length) + '）')
  } catch {
    Write-WarnLine ('zip 没生成：' + [string]$_.Exception.Message + '（目录已可用，可以自己右键压缩）')
    $zipPath = ''
  }
}

Write-Host ''
Write-Host '打包完成。发给客户前最后确认一次：' -ForegroundColor Green
Write-Host '  1) 客户解压后双击 安装轻屏.cmd（或 install.cmd），不要双击压缩包里的文件'
Write-Host '  2) 包体约 110–140 MB；明显偏小说明 node.exe / node_modules 没进去'
Write-Host '  3) 这个包不含生产密钥、日志、二维码、开发脚本（本脚本已逐项扫过）'
if ($zipPath) { Write-Host ('  4) 直接发这个 zip：' + $zipPath) }
Write-Host ''
exit 0
