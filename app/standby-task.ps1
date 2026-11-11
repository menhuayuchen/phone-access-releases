<#
.SYNOPSIS
    「未登录待机页」的安装 / 移除 / 状态（2026-11-11）。

.DESCRIPTION
    解决的是这个场景：电脑重启后**没有人登录 Windows**，产品（用户会话应用）根本不会运行，
    手机打开地址只能看到连不上 —— 分不清"电脑关机了"还是"开着但没人登录"。

    做法：注册一个 **SYSTEM 计划任务**，开机时用自带的 runtime\node.exe 跑 standby.mjs，
    由它占住画面端口只服务一张说明页：「电脑已开机，请在电脑上登录」。
    用户登录后 screen-server 启动、写 app-ready.json 标记 → 待机页看到标记立刻释放端口退出。

    同时把 Tailscale 打开 --unattended（Windows 专有）：否则没人登录时 tailnet 不联网，
    待机页压根不可达。

    需要管理员（注册计划任务 + 改 Tailscale 机器级设置）。

.NOTES
    UTF-8 with BOM，PS 5.1。输出最后一行是 JSON。
#>
param(
    [ValidateSet('install', 'remove', 'status')]
    [string]$Action = 'status',
    [int]$Port = 0,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$TASK = 'LightScreen Standby'
$errors = New-Object System.Collections.ArrayList
$warnings = New-Object System.Collections.ArrayList
function Add-Err([string]$m) { [void]$errors.Add($m) }
function Add-Warn([string]$m) { [void]$warnings.Add($m) }
function Say([string]$m) { if (-not $Quiet) { Write-Host $m } }

$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# 端口：没传就读 product.config.json 的 ports.screen
if ($Port -le 0) {
    $Port = 8660
    try {
        $cfg = Get-Content -LiteralPath (Join-Path $here 'product.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.ports -and $cfg.ports.screen) { $Port = [int]$cfg.ports.screen }
    } catch { }
}

$nodeExe = Join-Path $here 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { $nodeExe = $c.Source; Add-Warn '没找到自带 runtime\node.exe，用了 PATH 里的 node' }
    else { Add-Err '找不到 node 运行时（runtime\node.exe），无法安装待机页' }
}
$script = Join-Path $here 'standby.mjs'
if (-not (Test-Path -LiteralPath $script)) { Add-Err '找不到 standby.mjs（待机页脚本）' }
$sentinel = Join-Path $here 'app-ready.json'
$logPath = Join-Path $here 'standby.log'
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'

function Get-TaskInfo {
    $t = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
    if (-not $t) { return $null }
    $act = @($t.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments })
    return [pscustomobject]@{
        name      = $t.TaskName
        state     = [string]$t.State
        principal = [string]$t.Principal.UserId
        runLevel  = [string]$t.Principal.RunLevel
        triggers  = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName })
        actions   = $act
    }
}

function Get-TailscaleUnattended {
    try {
        if (-not (Test-Path -LiteralPath $tsExe)) { return $null }
        $p = & $tsExe debug prefs 2>$null | Out-String
        if ($p -match '"ForceDaemon"\s*:\s*(\w+)') { return ($Matches[1] -eq 'true') }
    } catch { }
    return $null
}

switch ($Action) {
    'install' {
        if (-not $isAdmin) {
            Add-Err '需要管理员权限：注册 SYSTEM 计划任务 + 改 Tailscale 机器级设置'
            break
        }
        if ($errors.Count -gt 0) { break }

        # 1) Tailscale unattended（开机无人登录也要联网，否则待机页不可达）
        $before = Get-TailscaleUnattended
        if (Test-Path -LiteralPath $tsExe) {
            try {
                & $tsExe set --unattended 2>&1 | Out-Null
                $after = Get-TailscaleUnattended
                Say ('  Tailscale unattended: ' + [string]$before + ' -> ' + [string]$after)
                if ($after -ne $true) { Add-Warn 'Tailscale unattended 没读回 true（可能版本差异），待机页在未登录时可能仍不可达' }
            } catch { Add-Warn ('设置 Tailscale unattended 失败：' + $_.Exception.Message) }
        } else {
            Add-Warn ('没找到 ' + $tsExe + '：跳过 unattended（未登录时 tailnet 不会在线）')
        }

        # 2) 注册开机任务
        try {
            $argLine = '"' + $script + '" --port ' + $Port + ' --sentinel "' + $sentinel + '"'
            if (Test-Path -LiteralPath $tsExe) { $argLine += ' --ts "' + $tsExe + '"' }
            $argLine += ' --log "' + $logPath + '"'

            $act = New-ScheduledTaskAction -Execute $nodeExe -Argument $argLine -WorkingDirectory $here
            $trg = New-ScheduledTaskTrigger -AtStartup
            $prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
            # 常驻：没有执行时限；失败重启几次；别因为电池策略不启动（笔记本合盖/用电池很常见）
            $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
                -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
            Register-ScheduledTask -TaskName $TASK -Action $act -Trigger $trg -Principal $prn -Settings $set -Force | Out-Null
            Say '  已注册计划任务 ' + $TASK + '（开机 / SYSTEM / 最高权限）'
        } catch {
            Add-Err ('注册计划任务失败：' + $_.Exception.Message)
        }
    }
    'remove' {
        if (-not $isAdmin) { Add-Err '需要管理员权限才能移除'; break }
        try {
            $t = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
            if ($t) {
                try { Stop-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue } catch { }
                Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction Stop
                Say '  已移除计划任务 ' + $TASK
            } else {
                Say '  计划任务本来就不存在'
            }
            # 顺手收掉可能还在跑的待机页进程
            try {
                Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -and $_.CommandLine -match 'standby\.mjs' } |
                    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }
            } catch { }
        } catch {
            Add-Err ('移除失败：' + $_.Exception.Message)
        }
    }
    'status' { }
}

$result = [pscustomobject]@{
    ok        = ($errors.Count -eq 0)
    action    = $Action
    elevated  = $isAdmin
    port      = $Port
    node      = $nodeExe
    script    = $script
    sentinel  = $sentinel
    log       = $logPath
    task      = (Get-TaskInfo)
    tsUnattended = (Get-TailscaleUnattended)
    errors    = @($errors)
    warnings  = @($warnings)
    at        = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
$out = $result | ConvertTo-Json -Depth 6 -Compress

# 2026-11-11：提权运行时的黑窗口一闪就关、什么都看不到 —— 所以把结果落一份文件。
# 排查"装了但没生效"时先看它（无文件 = 提权那一步没真正跑起来，比如 UAC 被取消）。
try {
    $resultFile = Join-Path $here 'standby-task.result.json'
    [System.IO.File]::WriteAllText($resultFile, $out, (New-Object System.Text.UTF8Encoding($false)))
} catch { }
$out
