<#
.SYNOPSIS
    一键还原：把电脑恢复到"安装产品版之前"的状态

.DESCRIPTION
    用途：产品版安装失败时，把生产环境原样还原回去。

    还原内容：
      1. 停掉产品版的服务（如果起来了）
      2. 从 XML 重新注册两个计划任务（DSH Phone Access / DSH Input Injector）
      3. 还原 %LOCALAPPDATA%\DshInput（含正在用的 input.exe 和 elevated.enabled）
      4. 删掉产品版新建的防火墙规则（生产原有那 5 条不动）
      5. 用生产目录的脚本把服务重新拉起来

.NOTES
    UTF-8 with BOM。用 restore.cmd 调用（ExecutionPolicy 是 Restricted）。
#>
[CmdletBinding()]
param(
    [string]$BackupDir = '',   # 默认自动找本脚本同级的 _migration-backup-* 里最新的一个
    [switch]$SkipStart          # 只还原不启动
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$prod = 'C:\Users\ccj\Documents\deepseek-harness\default-workspace\phone-access'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step([string]$m) { Say ''; Say "== $m" 'Cyan' }

# 找备份
if (-not $BackupDir) {
    $cand = Get-ChildItem $here -Directory -Filter '_migration-backup-*' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($cand) { $BackupDir = $cand.FullName }
}
if (-not $BackupDir -or -not (Test-Path $BackupDir)) {
    Say "[x] 找不到备份目录。用 -BackupDir 指定。" 'Red'
    exit 1
}
Say "使用备份：$BackupDir" 'Yellow'

# 1) 停产品版服务
Step '1/5 停掉产品版服务'
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'screen-server\.mjs|tunnel-proxy\.mjs|supervise\.ps1' } |
    ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed++; Say "  已停 node PID=$($_.ProcessId)" } catch {}
    }
foreach ($n in @('capture','input','audio')) {
    Get-Process $n -ErrorAction SilentlyContinue | ForEach-Object {
        try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; $killed++; Say "  已停 $n PID=$($_.Id)" } catch {}
    }
}
Say "  共停 $killed 个进程"

# 2) 还原计划任务
Step '2/5 还原计划任务'
foreach ($x in (Get-ChildItem (Join-Path $BackupDir 'tasks') -Filter *.xml -ErrorAction SilentlyContinue)) {
    try {
        $xml = Get-Content $x.FullName -Raw
        $name = if ($xml -match '<URI>\\([^<]+)</URI>') { $Matches[1] } else { $x.BaseName -replace '_',' ' }
        Register-ScheduledTask -TaskName $name -Xml $xml -Force -ErrorAction Stop | Out-Null
        Say "  已还原任务：$name" 'Green'
    } catch {
        Say "  还原任务失败 $($x.Name)：$($_.Exception.Message)" 'Red'
    }
}

# 3) 还原注入器目录
Step '3/5 还原 DshInput（注入器）'
$src = Join-Path $BackupDir 'DshInput'
$dst = Join-Path $env:LOCALAPPDATA 'DshInput'
if (Test-Path $src) {
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    Copy-Item (Join-Path $src '*') $dst -Recurse -Force -ErrorAction SilentlyContinue
    Say "  已还原 $((Get-ChildItem $src -Recurse -File).Count) 个文件到 $dst" 'Green'
} else { Say '  备份里没有 DshInput，跳过' 'Yellow' }

# 4) 删掉产品版新建的防火墙规则（按名字前缀识别，生产原有规则不动）
Step '4/5 清理产品版防火墙规则'
$removed = 0
Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match '^PhoneAccess' } |
    ForEach-Object {
        try { Remove-NetFirewallRule -Name $_.Name -ErrorAction Stop; $removed++; Say "  已删规则：$($_.DisplayName)" } catch {}
    }
Say "  共删 $removed 条（生产原有 5 条未动）"

# 5) 重新拉起生产
Step '5/5 拉起生产环境'
if ($SkipStart) {
    Say '  -SkipStart：不启动。你可以自己双击生产目录的 start-phone-access.cmd' 'Yellow'
} else {
    $starter = Join-Path $prod 'start-phone-access.cmd'
    if (Test-Path $starter) {
        Say "  运行 $starter"
        & $starter 2>&1 | ForEach-Object { Say "    $_" }
        Start-Sleep -Seconds 8
        $listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
                  Where-Object { $_.LocalPort -in 8660, 8650 } | Select-Object -First 3
        if ($listen) {
            Say '  端口已恢复监听：' 'Green'
            $listen | ForEach-Object { Say "    $($_.LocalAddress):$($_.LocalPort)" }
        } else {
            Say '  端口还没起来，等 30 秒再查；或手动双击 start-phone-access.cmd' 'Yellow'
        }
    } else {
        Say "  找不到 $starter —— 请手动到生产目录启动" 'Red'
    }
}

Say ''
Say '还原流程结束。现在用手机试一下能不能连上。' 'Cyan'
