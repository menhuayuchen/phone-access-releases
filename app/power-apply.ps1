# 轻屏 · 定时开关机引擎（由 screen-server 调用，不直接给客户用）
# 输入：-JsonPath 指向 power-schedule.json：{ "enabled":true, "rules":[ {"id","mode","repeat","date","offTime","wakeTime"} ] }
# 输出：一行 JSON（给服务端/页面用）：{ok, applied:[], removed:[], wakeTimer:"on"|"off", tasks:[{name,state,next,wake}]}
# 说明：
#   · 休眠 + 唤醒定时器 = 能定时"开机"；完全关机（S5）后软件叫不醒，只能 BIOS RTC / WOL。
#   · 任务以**当前用户**身份注册（无需管理员），唤醒任务勾 WakeToRun。
# UTF-8 with BOM，PS 5.1
param(
    [Parameter(Mandatory = $true)][string]$JsonPath,
    [switch]$StatusOnly
)

$ErrorActionPreference = 'Continue'
$PREFIX = '轻屏-电源-'

function Read-Rules {
    if (-not (Test-Path -LiteralPath $JsonPath)) { return [pscustomobject]@{ enabled = $false; rules = @() } }
    try { return Get-Content -LiteralPath $JsonPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { return [pscustomobject]@{ enabled = $false; rules = @() } }
}

function Parse-HHmm([string]$t) {
    $d = [datetime]::MinValue
    foreach ($fmt in @('HH:mm', 'H:mm')) {
        if ([datetime]::TryParseExact($t, $fmt, [Globalization.CultureInfo]::InvariantCulture, 'None', [ref]$d)) { return $d }
    }
    throw ('时间格式应为 HH:mm：' + $t)
}

function Make-Trigger($rule) {
    $off = Parse-HHmm $rule.offTime
    $at = Get-Date -Hour $off.Hour -Minute $off.Minute -Second 0
    if ($at -le (Get-Date)) { $at = $at.AddDays(1) }
    switch ($rule.repeat) {
        'weekdays' { return New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $at }
        'once' {
            $when = $at
            if ($rule.date) {
                $d = [datetime]::MinValue
                if ([datetime]::TryParseExact([string]$rule.date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, 'None', [ref]$d)) {
                    $when = $d.Date.AddHours($off.Hour).AddMinutes($off.Minute)
                    if ($when -le (Get-Date)) { $when = $when.AddDays(1) }
                }
            }
            return New-ScheduledTaskTrigger -Once -At $when
        }
        default { return New-ScheduledTaskTrigger -Daily -At $at }
    }
}

function Get-TaskInfo($name) {
    try {
        $t = Get-ScheduledTask -TaskName $name -ErrorAction Stop
        $i = Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop
        return [pscustomobject]@{ name = $name; state = [string]$t.State; next = ([string]$i.NextRunTime); wake = [bool]$t.Settings.WakeToRun }
    } catch { return $null }
}

$cfg = Read-Rules
$result = [pscustomobject]@{ ok = $true; applied = @(); removed = @(); wakeTimer = 'unknown'; tasks = @(); error = '' }

# 唤醒定时器（普通任务默认叫不醒电脑）
try {
    & powercfg.exe /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 2>$null | Out-Null
    $p = (& powercfg /query SCHEME_CURRENT SUB_SLEEP RTCWAKE 2>&1) -join ' '
    $result.wakeTimer = if ($p -match '当前交流电源设置索引:\s*0x0*1\b') { 'on' } else { 'off' }
} catch { }

$want = @()
if ($cfg.enabled -and $cfg.rules -and @($cfg.rules).Count -gt 0) {
    foreach ($r in @($cfg.rules)) {
        try {
            $id = [string]$r.id
            if (-not $id) { continue }
            $offName = $PREFIX + $id
            $wakeName = $PREFIX + $id + '-唤醒'
            $arg = if ($r.mode -eq 'shutdown') { '/s /t 60 /c "轻屏·定时关机：60 秒后关机，取消请运行 shutdown /a"' } else { '/h' }
            $actOff = New-ScheduledTaskAction -Execute 'shutdown.exe' -Argument $arg
            $setOff = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
            Register-ScheduledTask -TaskName $offName -Action $actOff -Trigger (Make-Trigger $r) -Settings $setOff -Force -ErrorAction Stop | Out-Null
            $want += $offName
            $result.applied += $offName

            if ($r.wakeTime) {
                $w = Parse-HHmm $r.wakeTime
                $atW = Get-Date -Hour $w.Hour -Minute $w.Minute -Second 0
                if ($atW -le (Get-Date)) { $atW = $atW.AddDays(1) }
                $trgW = switch ($r.repeat) {
                    'weekdays' { New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $atW }
                    'once' { New-ScheduledTaskTrigger -Once -At $atW }
                    default { New-ScheduledTaskTrigger -Daily -At $atW }
                }
                $actW = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit'
                $setW = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
                Register-ScheduledTask -TaskName $wakeName -Action $actW -Trigger $trgW -Settings $setW -Force -ErrorAction Stop | Out-Null
                $want += $wakeName
                $result.applied += $wakeName
            }
        } catch { $result.ok = $false; $result.error = [string]$_.Exception.Message }
    }
}

# 删除不再需要的任务
try {
    foreach ($t in @(Get-ScheduledTask -TaskName ($PREFIX + '*') -ErrorAction SilentlyContinue)) {
        if (-not $t) { continue }
        if ($want -notcontains $t.TaskName) {
            Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction SilentlyContinue
            $result.removed += $t.TaskName
        }
    }
} catch { }

foreach ($n in @(Get-ScheduledTask -TaskName ($PREFIX + '*') -ErrorAction SilentlyContinue)) {
    $info = Get-TaskInfo $n.TaskName
    if ($info) { $result.tasks += $info }
}

$result | ConvertTo-Json -Depth 5 -Compress
