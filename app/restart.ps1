<#
.SYNOPSIS
    重启「手机远程」的服务（画面服务 + 守护进程 + 入口门）。

.DESCRIPTION
    用途：改了配置、或者画面卡住/打不开时，双击一下这个就能把整条链重建一遍。
    行为：
      1) 调 stop-phone-access.ps1 停掉全部本产品进程
      2) 等 2 秒
      3) 调 start-phone-access.ps1 -Quiet 重新拉起来
      4) 打印结果（画面端口是否在监听、手机入口地址）

    不动的东西：DSH 网页（如果它在跑，只是重新指向它）、Tailscale、许可证。

.NOTES
    UTF-8 with BOM，PS 5.1。
#>
param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'product-config.ps1')

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok([string]$m) { Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Warn([string]$m) { Write-Host ('  [!] ' + $m) -ForegroundColor Yellow }

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  重启「手机远程」服务' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

$cfg = Get-ProductConfig -AppDir $here
$screenPort = [int]$cfg.ports.screen
$dshPort = [int]$cfg.ports.dsh
$enableDsh = [bool]$cfg.enableDsh

# ---- 1) 停 ----
Say '  第 1 步 · 停止现有服务…' 'Cyan'
try {
    & (Join-Path $here 'stop-phone-access.ps1') *> $null
    Ok '已发出停止指令'
} catch {
    Warn ('停止时出错（继续尝试重启）：' + $_.Exception.Message)
}
Start-Sleep -Seconds 2

# 确认画面服务真的走了
$still = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'screen-server\.mjs' })
if ($still.Count -gt 0) {
    foreach ($p in $still) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }
    Start-Sleep -Seconds 1
    Ok ('强制结束了 ' + $still.Count + ' 个残留进程')
}

# ---- 2) 起 ----
Write-Host ''
Say '  第 2 步 · 重新启动…' 'Cyan'
$startScript = Join-Path $here 'start-phone-access.ps1'
if (-not (Test-Path -LiteralPath $startScript)) {
    Warn '找不到 start-phone-access.ps1，无法继续。'
    if (-not $NoPause) { $null = Read-Host '按回车关闭窗口' }
    exit 1
}
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -Quiet
} catch {
    Warn ('启动时报错：' + $_.Exception.Message)
}

# ---- 3) 验收 ----
Write-Host ''
Say '  第 3 步 · 检查结果…' 'Cyan'
Start-Sleep -Seconds 2

$listen = @(Get-NetTCPConnection -State Listen -LocalPort $screenPort -ErrorAction SilentlyContinue)
if ($listen.Count -gt 0) {
    $addrs = ($listen | ForEach-Object { [string]$_.LocalAddress }) -join ', '
    Ok ('画面服务已在监听：' + $addrs + ':' + $screenPort)
} else {
    Warn ('画面服务没起来（端口 ' + $screenPort + ' 没有监听）')
    Say '      可以双击桌面「手机远程」里的「自查」看详细原因。' 'Yellow'
}

if ($enableDsh) {
    $door = @(Get-NetTCPConnection -State Listen -LocalPort $dshPort -ErrorAction SilentlyContinue)
    if ($door.Count -gt 0) {
        Ok ('对话控制台的门已在监听，端口 ' + $dshPort)
    } else {
        Warn ('对话控制台的门没起来（端口 ' + $dshPort + '）')
    }
}

# 把手机入口地址再打一遍，省得用户去找
$urlFile = Join-Path $here 'screen-url.txt'
if (Test-Path -LiteralPath $urlFile) {
    try {
        $u = (Get-Content -LiteralPath $urlFile -Raw -Encoding UTF8).Trim()
        if ($u) {
            Write-Host ''
            Say '  手机入口：' 'Cyan'
            Say ('      ' + $u) 'White'
        }
    } catch { }
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Say '  重启完成。手机上如果还不动，刷新一下页面。' 'Green'
Write-Host '============================================================' -ForegroundColor Green
Write-Host ''

if (-not $NoPause) { $null = Read-Host '按回车关闭窗口' }
exit 0
