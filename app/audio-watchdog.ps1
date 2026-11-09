# audio-watchdog.ps1 - 音频采集看门狗
#
# 背景（2026-11-09 实测确认）：
#   audio.exe 跑久了它的命名管道服务端会僵死——进程还在、rms 还在写、chunks 还在涨，
#   但不再接受新客户端连接，screen-server 就一直 "audio: disconnected (ETIMEDOUT)"，
#   用户表现为"莫名其妙没声音，怎么操作都不会自己好"。已经发生三次了。
#
# 判据（三条，任意一条成立才动手，尽量不误杀）：
#   1) 有观众 + 已经有音频数据 + 音频非常陈旧（audioAge > 3 秒）且连续 N 次
#      —— 说明在传但卡住了。只在 viewers>0 且 audioChunks>0 时判，避免"用户没开声音"误杀。
#   2) screen-server 日志最近 20 行里有 >= 10 条 audio disconnected
#      —— 管道连不上。
#   3) 管道 dsh-audio 存在，但 audio.exe 存在且日志 20 分钟没有任何新的 rms 行
#      —— 守护线程死了。
#
# 反误杀：
#   - viewers = 0（没人看）时完全不动手
#   - audioChunks = 0（用户没开声音）时不按判据 1 动手
#   - 每次重启后强制静默 120 秒，避免连环重启
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File audio-watchdog.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File audio-watchdog.ps1 -DryRun   # 只观察不重启
#
# 日志：<产品目录>\audio-watchdog.log

[CmdletBinding()]
param(
    [int]$IntervalSeconds = 30,        # 检查间隔
    [double]$MaxAudioAge = 3.0,        # audioAge 超过这么多秒算陈旧
    [int]$MaxStaleChecks = 2,          # 连续几次陈旧才重启（2 次 = 约 60 秒）
    [int]$CooldownSeconds = 120,       # 重启后的静默期
    [string]$ProductDir = '',
    [switch]$DryRun                    # 只记录判断，不真的重启
)

$ErrorActionPreference = 'Continue'

if (-not $ProductDir) {
    $ProductDir = Join-Path $env:LOCALAPPDATA 'PhoneAccess'
}

$logFile = Join-Path $ProductDir 'audio-watchdog.log'
$healthUrl = 'http://127.0.0.1:8660/health'
$serverLog = Join-Path $ProductDir 'screen-server.log'
$audioLog = Join-Path $ProductDir 'audio.log'

function Write-WdLog([string]$text) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $text
    try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
    Write-Host $line
}

function Get-HealthText {
    try {
        $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
        return [string]$r.Content
    } catch {
        return $null
    }
}

function Get-HealthNumber([string]$text, [string]$name) {
    # health 是一行 key=value 拼接，形如 ... viewers=1 ... rtc={"audioChunks":1400,"audioAge":0.016,...}
    if (-not $text) { return $null }
    $m = [regex]::Match($text, '(?:^|\s)' + [regex]::Escape($name) + '=(-?[0-9.]+)')
    if ($m.Success) {
        $v = 0.0
        if ([double]::TryParse($m.Groups[1].Value, [ref]$v)) { return $v }
    }
    return $null
}

function Get-JsonNumber([string]$text, [string]$name) {
    # 从 rtc={...} 这段 JSON 里取数字
    if (-not $text) { return $null }
    $m = [regex]::Match($text, '"' + [regex]::Escape($name) + '"\s*:\s*(-?[0-9.]+)')
    if ($m.Success) {
        $v = 0.0
        if ([double]::TryParse($m.Groups[1].Value, [ref]$v)) { return $v }
    }
    return $null
}

function Test-PipeExisted {
    try {
        $names = [System.IO.Directory]::GetFiles('\\.\pipe\')
        foreach ($n in $names) {
            if ($n -match 'dsh-audio$') { return $true }
        }
    } catch { }
    return $false
}

function Get-DisconnectedCount {
    if (-not (Test-Path -LiteralPath $serverLog)) { return 0 }
    try {
        $tail = Get-Content -LiteralPath $serverLog -Tail 20 -ErrorAction Stop
        $n = 0
        foreach ($l in $tail) {
            if ($l -match 'audio.*disconnected') { $n++ }
        }
        return $n
    } catch { return 0 }
}

function Get-AudioLogAgeMinutes {
    if (-not (Test-Path -LiteralPath $audioLog)) { return 999 }
    try {
        $f = Get-Item -LiteralPath $audioLog
        return ((Get-Date) - $f.LastWriteTime).TotalMinutes
    } catch { return 999 }
}

function Restart-AudioProcess([string]$reason) {
    if ($DryRun) {
        Write-WdLog ('[DRYRUN] 应当重启 audio.exe，原因：' + $reason)
        return $false
    }
    $procs = @(Get-Process -Name 'audio' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) {
        Write-WdLog ('[WARN] 要重启 audio.exe 但进程不存在，等待 supervisor 拉起。原因：' + $reason)
        return $false
    }
    foreach ($p in $procs) {
        try {
            Write-WdLog ('[ACTION] 停止 audio.exe PID=' + $p.Id + '，原因：' + $reason)
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
        } catch {
            Write-WdLog ('[ERROR] 停止 PID=' + $p.Id + ' 失败：' + $_.Exception.Message)
        }
    }
    # supervisor 通常会自己拉起；这里等一下确认
    Start-Sleep -Seconds 6
    $after = @(Get-Process -Name 'audio' -ErrorAction SilentlyContinue)
    if ($after.Count -gt 0) {
        Write-WdLog ('[OK] audio.exe 已被拉起：PID=' + ($after | ForEach-Object { $_.Id }) -join ',')
    } else {
        Write-WdLog '[WARN] 6 秒内没被拉起，等 supervisor 下一轮'
    }
    return $true
}

Write-WdLog ('=== audio-watchdog 启动 (interval=' + $IntervalSeconds + 's, maxAge=' + $MaxAudioAge + 's, dryRun=' + $DryRun.IsPresent + ') ===')

$staleCount = 0
$lastRestart = [datetime]::MinValue

while ($true) {
    try {
        $health = Get-HealthText
        if (-not $health) {
            Write-WdLog '[SKIP] /health 不可达（screen-server 可能在重启），本轮跳过'
            Start-Sleep -Seconds $IntervalSeconds
            continue
        }

        $viewers = Get-HealthNumber $health 'viewers'
        $audioChunks = Get-JsonNumber $health 'audioChunks'
        $audioAge = Get-JsonNumber $health 'audioAge'
        $disconnected = Get-DisconnectedCount
        $audioLogAgeMin = Get-AudioLogAgeMinutes
        $pipeAlive = Test-PipeExisted

        $summary = 'viewers=' + $viewers + ' audioChunks=' + $audioChunks + ' audioAge=' + $audioAge + ' disconnectedTail=' + $disconnected + ' audioLogAgeMin=' + ([math]::Round($audioLogAgeMin, 1))
        Write-WdLog ('[CHECK] ' + $summary)

        # 冷却期内只观察不动作
        if (((Get-Date) - $lastRestart).TotalSeconds -lt $CooldownSeconds) {
            Write-WdLog '[SKIP] 冷却期内（刚重启过）'
            $staleCount = 0
            Start-Sleep -Seconds $IntervalSeconds
            continue
        }

        $shouldRestart = $false
        $reason = ''

        # 判据 1：有观众 + 有音频数据 + 音频陈旧
        if ($viewers -gt 0 -and $audioChunks -gt 0 -and $null -ne $audioAge -and $audioAge -gt $MaxAudioAge) {
            $staleCount++
            Write-WdLog ('[SUSPECT] 音频陈旧 audioAge=' + $audioAge + 's > ' + $MaxAudioAge + 's，连续 ' + $staleCount + ' 次')
            if ($staleCount -ge $MaxStaleChecks) {
                $shouldRestart = $true
                $reason = '音频数据陈旧（audioAge=' + $audioAge + 's，连续 ' + $staleCount + ' 次）'
            }
        } else {
            if ($staleCount -gt 0) { Write-WdLog '[OK] 音频恢复新鲜，重置计数' }
            $staleCount = 0
        }

        # 判据 2：screen-server 日志连续 disconnected，并且音频也确实陈旧
        # （2026-11-09 实测踩到：历史日志里会残留 disconnection 记录，光看条数会误杀——
        #   必须叠加 audioAge 异常才算数，否则一次重启前的旧日志就能把阈值顶满）
        if (-not $shouldRestart -and $disconnected -ge 10) {
            if ($null -eq $audioAge -or $audioAge -gt $MaxAudioAge) {
                $shouldRestart = $true
                $reason = 'screen-server 日志连续 ' + $disconnected + ' 条音频断连，且 audioAge=' + $audioAge + 's'
            } else {
                Write-WdLog ('[INFO] disconnectedTail=' + $disconnected + ' 但 audioAge=' + $audioAge + 's 正常，判定为历史日志残留，不动手')
            }
        }

        # 判据 3：管道在、但 audio 日志很久没更新（守护线程死了）
        if (-not $shouldRestart -and $pipeAlive -and $audioLogAgeMin -gt 20) {
            $hasProc = @(Get-Process -Name 'audio' -ErrorAction SilentlyContinue).Count -gt 0
            if ($hasProc) {
                $shouldRestart = $true
                $reason = 'audio.log 已 ' + [math]::Round($audioLogAgeMin, 1) + ' 分钟无更新'
            }
        }

        if ($shouldRestart) {
            $did = Restart-AudioProcess $reason
            if ($did) {
                $lastRestart = Get-Date
                $staleCount = 0
            }
        }
    } catch {
        Write-WdLog ('[ERROR] 检查异常：' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)
    }

    Start-Sleep -Seconds $IntervalSeconds
}
