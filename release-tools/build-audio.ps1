# build-audio.ps1 — 从 app\audio.cs 重新编译声音组件 audio.exe
#
# 为什么要这个脚本：audio.exe 不是从仓库里直接拿的——pack.ps1 是从
# 「生产目录」(%LOCALAPPDATA%\PhoneAccess) 复制二进制。也就是说源码改了以后，
# 必须先把新 exe 放到生产目录，打出来的包才含修复。这个脚本负责编译那一步，
# 部署（停旧进程 → 换文件 → 起新进程）需要管理员，见文件末尾提示。
#
# 用法（在 phone-access-product 根目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File release-tools\build-audio.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File release-tools\build-audio.ps1 -Out D:\tmp\audio.exe
#
# 默认输出 dist\audio.exe（dist 不进版本库）。脚本**不会**自动部署到生产目录：
# 那一步需要管理员，见脚本末尾打印的三条命令。
#
# 本文件是 PowerShell 5.1 脚本，必须 UTF-8 带 BOM；不要写 JS 风格 // 注释。

param(
  [string]$Out = '',
  [string]$ProdDir = (Join-Path $env:LOCALAPPDATA 'PhoneAccess')
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$src = Join-Path $root 'app\audio.cs'
$lib = Join-Path $ProdDir 'lib'

if (-not (Test-Path -LiteralPath $src)) { throw ('找不到源码：' + $src) }
if (-not (Test-Path -LiteralPath $lib)) { throw ('找不到 NAudio 依赖目录：' + $lib + '（先装一次产品，或指定 -ProdDir）') }
if (-not $Out) { $Out = Join-Path $root 'dist\audio.exe' }

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $csc)) { throw '找不到 csc.exe（需要 .NET Framework 4.x）' }

$netstandard = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\netstandard.dll'

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { $null = New-Item -ItemType Directory -Path $outDir -Force }
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

Write-Host ('编译：' + $src)
& $csc /nologo /target:winexe /out:$Out $src `
  /r:"$lib\NAudio.Core.dll" /r:"$lib\NAudio.Wasapi.dll" /r:"$lib\NAudio.WinMM.dll" `
  /r:$netstandard 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) { throw ('编译失败，csc 退出码 ' + $LASTEXITCODE) }

$fi = Get-Item -LiteralPath $Out
Write-Host ('[OK] ' + $fi.FullName + '  ' + $fi.Length + ' bytes') -ForegroundColor Green
$exe = Join-Path $ProdDir 'audio.exe'
$lg = Join-Path $ProdDir 'audio.log'
Write-Host ''
Write-Host '部署到生产目录（需要管理员，UAC 会弹）：' -ForegroundColor Yellow
Write-Host '  1) 停进程： Get-Process audio | Stop-Process -Force'
Write-Host ('  2) 换文件： Copy-Item "' + $fi.FullName + '" "' + $exe + '" -Force')
Write-Host ('  3) 起进程： Start-Process "' + $exe + '" -ArgumentList "dsh-audio","' + $lg + '" -WindowStyle Hidden')
Write-Host '  验证：audio.log 出现 "pipe: client connected"，screen-server.log 出现 "audio] connected"（不再是 EPERM）'
