<#
.SYNOPSIS
    部署新编译的 audio.exe 到生产目录（需要管理员）。

.DESCRIPTION
    audio.exe 是提权进程，普通权限停不掉，所以这一步必须 UAC。

    用法（普通权限执行即可，会自己弹 UAC）：
        Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<这个文件>'

    或者已经提权时直接：
        powershell -NoProfile -ExecutionPolicy Bypass -File <这个文件>

    做四件事：
      1) 停掉正在跑的 audio.exe（如果它卡住不退，强杀）
      2) 备份旧的 audio.exe 为 audio.exe.bak-<时间戳>
      3) 用 dist\audio.exe 覆盖
      4) 用正确的参数重新启动，并把结果写进 deploy-audio.result.json

.NOTES
    UTF-8 with BOM，PowerShell 5.1。不要写 JS 风格 // 注释。
#>
param(
    [string]$Src = '',
    [string]$ProdDir = (Join-Path $env:LOCALAPPDATA 'PhoneAccess')
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
if (-not $Src) { $Src = Join-Path $root 'dist\audio.exe' }
$dst = Join-Path $ProdDir 'audio.exe'
$log = Join-Path $ProdDir 'audio.log'
$resultFile = Join-Path $here 'deploy-audio.result.json'

$errors = New-Object System.Collections.ArrayList
$steps = New-Object System.Collections.ArrayList
function Say([string]$m) { Write-Host $m; [void]$steps.Add($m) }

$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

if (-not $isAdmin) {
    [void]$errors.Add('需要管理员权限（会弹 UAC 那种）')
} elseif (-not (Test-Path -LiteralPath $Src)) {
    [void]$errors.Add('找不到编译产物：' + $Src + '（先跑 release-tools\build-audio.ps1）')
}

$oldPid = 0
$newPid = 0
if ($errors.Count -eq 0) {
    # 1) 停旧进程
    $old = @(Get-Process audio -ErrorAction SilentlyContinue)
    if ($old.Count -gt 0) {
        $oldPid = $old[0].Id
        foreach ($p in $old) {
            try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Say ('已停止 audio.exe pid=' + $p.Id) }
            catch { [void]$errors.Add('停止 audio.exe 失败：' + $_.Exception.Message) }
        }
        Start-Sleep -Milliseconds 600
        $still = @(Get-Process audio -ErrorAction SilentlyContinue)
        if ($still.Count -gt 0) { [void]$errors.Add('audio.exe 仍未退出（pid=' + ($still | ForEach-Object { $_.Id }) + '）') }
    } else {
        Say '没有正在运行的 audio.exe'
    }
}

if ($errors.Count -eq 0) {
    # 2) 备份 + 3) 覆盖
    try {
        if (Test-Path -LiteralPath $dst) {
            $bak = $dst + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
            Copy-Item -LiteralPath $dst -Destination $bak -Force
            Say ('已备份旧文件：' + (Split-Path -Leaf $bak))
        }
        Copy-Item -LiteralPath $Src -Destination $dst -Force
        Say ('已覆盖：' + $dst + '（' + (Get-Item -LiteralPath $dst).Length + ' 字节）')
    } catch { [void]$errors.Add('覆盖文件失败：' + $_.Exception.Message) }
}

if ($errors.Count -eq 0) {
    # 4) 重新启动
    try {
        $p = Start-Process -FilePath $dst -ArgumentList 'dsh-audio', $log -WindowStyle Hidden -PassThru
        $newPid = $p.Id
        Say ('已启动 audio.exe pid=' + $newPid)
        Start-Sleep -Seconds 2
    } catch { [void]$errors.Add('启动失败：' + $_.Exception.Message) }
}

$result = [pscustomobject]@{
    ok      = ($errors.Count -eq 0)
    elevated = $isAdmin
    src     = $Src
    dst     = $dst
    oldPid  = $oldPid
    newPid  = $newPid
    steps   = @($steps)
    errors  = @($errors)
    at      = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
$out = $result | ConvertTo-Json -Depth 5 -Compress
try { [System.IO.File]::WriteAllText($resultFile, $out, (New-Object System.Text.UTF8Encoding($false))) } catch { }
$out
