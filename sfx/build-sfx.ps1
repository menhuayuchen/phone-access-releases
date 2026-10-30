<#
.SYNOPSIS
    把 dist 里的产品目录打成"单个 exe"，客户只需下载一个文件

.DESCRIPTION
    做法：编译好的 Sfx.exe + 追加 zip 数据 + 32 字节尾部标记
      [Sfx.exe][zip 数据][magic(16) + zipOffset(8) + zipLength(8)]

    为什么不用 iexpress：它会把所有文件拍平到同一层，
    而产品里有 node_modules\runtime\bin 等目录结构，拍平就废了。

    产出后会自动验证：用 --extract-only 解压回来，比对文件数与总字节。

.NOTES
    UTF-8 with BOM，PS 5.1。
#>
[CmdletBinding()]
param(
    [string]$DistRoot = '',
    [string]$OutFile = '',
    [switch]$KeepZip
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$productRoot = Split-Path -Parent $here
if (-not $DistRoot) { $DistRoot = Join-Path $productRoot 'dist' }

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }

# ---- 1. 找源目录 ----
if (-not (Test-Path -LiteralPath $DistRoot)) { Say ("[x] 找不到 dist 目录: " + $DistRoot) 'Red'; exit 1 }
$srcDirs = @(Get-ChildItem -LiteralPath $DistRoot -Directory | Sort-Object LastWriteTime -Descending)
if ($srcDirs.Count -eq 0) { Say '[x] dist 里没有产品目录（先跑 pack.ps1）' 'Red'; exit 1 }
$src = $srcDirs[0]
Say ("源目录: " + $src.FullName) 'Cyan'

$srcFiles = @(Get-ChildItem -LiteralPath $src.FullName -Recurse -File)
$srcCount = $srcFiles.Count
$srcBytes = ($srcFiles | Measure-Object Length -Sum).Sum
Say ("  文件 " + $srcCount + " 个 / " + [math]::Round($srcBytes / 1MB, 1) + " MB")

# ---- 2. 检查启动器 ----
$sfxExe = Join-Path $here 'Sfx.exe'

# ---- 1.5 源码改了就重编启动器（2026-10-30：安装前弹"免责声明+配置要求+同意勾选"）----
# 以前 Sfx.exe 是手工编好放在仓库里的，源码改了忘重编就会发出发旧 exe 的包。
# 这里按时间戳自动重编，csc 找不到时退回"用现成的"，不阻断打包（打包机可能没装 .NET SDK）。
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$sfxSrc = Join-Path $here 'Sfx.cs'
if ((Test-Path -LiteralPath $csc) -and (Test-Path -LiteralPath $sfxSrc)) {
    $needBuild = $true
    if (Test-Path -LiteralPath $sfxExe) {
        $needBuild = ((Get-Item -LiteralPath $sfxSrc).LastWriteTime -gt (Get-Item -LiteralPath $sfxExe).LastWriteTime)
    }
    if ($needBuild) {
        Say '正在编译启动器（Sfx.cs -> Sfx.exe）…' 'Cyan'
        & $csc /nologo /target:exe /codepage:65001 /optimize /out:$sfxExe `
            /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll `
            /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll $sfxSrc
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $sfxExe)) {
            Say '[x] 启动器编译失败，先修好再打包（不要把旧 Sfx.exe 当新的发出去）' 'Red'
            exit 1
        }
        Say ('  启动器已更新: ' + [math]::Round((Get-Item -LiteralPath $sfxExe).Length / 1KB, 1) + ' KB') 'Green'
    }
}

if (-not (Test-Path -LiteralPath $sfxExe)) { Say '[x] 没找到 Sfx.exe，先编译 Sfx.cs' 'Red'; exit 1 }

# ---- 3. 打 zip ----
$tempZip = Join-Path $env:TEMP ('pa-sfx-' + [guid]::NewGuid().ToString('N') + '.zip')
Say ''
Say '正在压缩（130MB 左右，可能要一两分钟）…'
if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force }
Compress-Archive -Path $src.FullName -DestinationPath $tempZip -CompressionLevel Optimal -Force
$zipLen = (Get-Item -LiteralPath $tempZip).Length
Say ("  压缩后: " + [math]::Round($zipLen / 1MB, 1) + " MB")

# ---- 4. 拼接 ----
if (-not $OutFile) { $OutFile = Join-Path $DistRoot 'PhoneAccess-Setup.exe' }
Say ''
Say '正在生成单文件安装包…'
$sfxBytes = [System.IO.File]::ReadAllBytes($sfxExe)
$magic = [System.Text.Encoding]::ASCII.GetBytes('PAZIPPAYLOAD0001')   # 必须与 Sfx.cs 里的 Magic 一致
$offset = [int64]$sfxBytes.Length

$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$fs = [System.IO.File]::Create($OutFile)
try {
    $fs.Write($sfxBytes, 0, $sfxBytes.Length)
    # 流式追加 zip，避免把 130MB 读进内存
    $zfs = [System.IO.File]::OpenRead($tempZip)
    try {
        $buf = New-Object byte[] (1024 * 256)
        while (($n = $zfs.Read($buf, 0, $buf.Length)) -gt 0) { $fs.Write($buf, 0, $n) }
    } finally { $zfs.Dispose() }
    # 尾部标记
    $fs.Write($magic, 0, 16)
    $fs.Write([BitConverter]::GetBytes($offset), 0, 8)
    $fs.Write([BitConverter]::GetBytes([int64]$zipLen), 0, 8)
} finally { $fs.Dispose() }

if (-not $KeepZip) { Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue }

$outLen = (Get-Item -LiteralPath $OutFile).Length
Say ("  已生成: " + $OutFile) 'Green'
Say ("  大小: " + [math]::Round($outLen / 1MB, 1) + " MB  (启动器 " + $sfxBytes.Length + " B + 数据 " + $zipLen + " B + 尾部 32 B)")

# ---- 5. 自验证：解压回来比对 ----
Say ''
Say '正在自验证（解压回临时目录比对）…'
$verifyDir = Join-Path $env:TEMP ('pa-sfx-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $verifyDir -Force | Out-Null
try {
    # 用直接调用代替 Start-Process：本机环境里同时存在 NO_PROXY 和 no_proxy 两个键，
    # Start-Process 继承环境时会抛 "Key has already been added"，让自验证假失败（2026-10-30 实测）。
    & $OutFile --extract-only $verifyDir | Out-Null
    Say ("  解压进程退出码: " + $LASTEXITCODE)

    # 包内可能多一层目录
    $root = $verifyDir
    $subs = @(Get-ChildItem -LiteralPath $verifyDir -Directory)
    if ($subs.Count -eq 1 -and (Test-Path (Join-Path $subs[0].FullName 'install.cmd'))) { $root = $subs[0].FullName }

    $vFiles = @(Get-ChildItem -LiteralPath $root -Recurse -File)
    $vCount = $vFiles.Count
    $vBytes = ($vFiles | Measure-Object Length -Sum).Sum

    Say ("  解出 " + $vCount + " 个文件 / " + [math]::Round($vBytes / 1MB, 1) + " MB")
    $okCount = ($vCount -eq $srcCount)
    $okBytes = ([math]::Abs($vBytes - $srcBytes) -lt 1024)
    $okInstall = (Test-Path (Join-Path $root 'install.cmd'))
    $okNode = (Test-Path (Join-Path $root 'runtime\node.exe'))
    $okSharp = (Test-Path (Join-Path $root 'node_modules\sharp\dist\index.js')) -or (Test-Path (Join-Path $root 'node_modules\sharp\dist\index.mjs'))

    Say ("  文件数一致: " + $okCount)
    Say ("  总字节一致: " + $okBytes)
    Say ("  有 install.cmd: " + $okInstall)
    Say ("  有 runtime\node.exe: " + $okNode)
    Say ("  有 sharp\dist: " + $okSharp)

    if ($okCount -and $okInstall -and $okNode -and $okSharp) {
        Say ''
        Say '自验证通过：单文件安装包可以正常解出完整产品。' 'Green'
    } else {
        Say ''
        Say '[!] 自验证有问题，不要发布这个包。' 'Red'
    }
} finally {
    Remove-Item -LiteralPath $verifyDir -Recurse -Force -ErrorAction SilentlyContinue
}
