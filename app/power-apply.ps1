# 轻屏 · 定时开关机引擎（由 screen-server 调用，不直接给客户用）
# 2026-11-07 重写：修掉 -StatusOnly 失效、once 忽略日期、过去日期被偷偷+1天、只设交流唤醒、不检查休眠支持、结果无处可看
# 输入：-JsonPath power-schedule.json   { "enabled":true, "rules":[ {"id","mode","repeat","date","offTime","wakeTime"} ] }
# 参数：-StatusOnly 只读（不建任务、不改电源设置）；-OutPath 把结果写到文件（服务端读它展示失败原因）
# 输出：一行 JSON：{ok, statusOnly, enabled, rules, applied, removed, skipped, warnings, errors, wakeTimer:{ac,dc}, hibernate, tasks:[{name,state,next,wake}], error, at}
# 说明：
#   · 休眠(S4)+唤醒定时器 = 能定时"开机"；完全关机(S5)后软件叫不醒，只能 BIOS RTC / 唤醒局域网。
#   · 任务以**当前用户**身份注册，无需管理员；唤醒任务勾 WakeToRun。
#   · 文件必须 UTF-8 with BOM（PowerShell 5.1）。
param(
    [Parameter(Mandatory = $true)][string]$JsonPath,
    [switch]$StatusOnly,
    [string]$OutPath = ''
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$PREFIX = '轻屏-电源-'
$errors = New-Object System.Collections.ArrayList
$warnings = New-Object System.Collections.ArrayList

function Add-Err([string]$m) { [void]$errors.Add($m) }
function Add-Warn([string]$m) { [void]$warnings.Add($m) }

function Read-Doc {
    if (-not (Test-Path -LiteralPath $JsonPath)) { return [pscustomobject]@{ enabled = $false; rules = @() } }
    try { return Get-Content -LiteralPath $JsonPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Add-Err '配置文件读不出来（JSON 坏了）'; return [pscustomobject]@{ enabled = $false; rules = @() } }
}

function Parse-HHmm {
    param([string]$t)
    if (-not $t) { return $null }
    $d = [datetime]::MinValue
    foreach ($fmt in @('HH:mm', 'H:mm')) {
        if ([datetime]::TryParseExact(([string]$t).Trim(), $fmt, [Globalization.CultureInfo]::InvariantCulture, 'None', [ref]$d)) { return $d }
    }
    return $null
}

function Parse-DateStr([string]$s) {
    $d = [datetime]::MinValue
    if ([datetime]::TryParseExact(([string]$s).Trim(), 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, 'None', [ref]$d)) { return $d.Date }
    return $null
}

function Test-Hibernate {
    try {
        $a = ((& powercfg.exe /a 2>&1) -join "`n")
        $idx = $a.IndexOf('Hibernate')
        if ($idx -lt 0) { $idx = $a.IndexOf('休眠') }
        if ($idx -lt 0) { return $false }
        # 取"支持"段落（第一个 Hibernate/休眠 出现之前的部分里如果提到不支持，就不算）
        $head = $a.Substring(0, [Math]::Max(0, $idx))
        if ($head -match '(?i)not available|not supported|不支持') { return $false }
        return $true
    } catch { }
    return $false
}

function Get-WakeTimerState {
    $ac = 'unknown'; $dc = 'unknown'
    try {
        $q = ((& powercfg.exe /query SCHEME_CURRENT SUB_SLEEP RTCWAKE 2>&1) -join "`n")
        $hexes = [regex]::Matches($q, '0x([0-9a-fA-F]+)')
        if ($hexes.Count -ge 1) { $ac = if ([Convert]::ToInt32($hexes[0].Groups[1].Value, 16) -eq 1) { 'on' } else { 'off' } }
        if ($hexes.Count -ge 2) { $dc = if ([Convert]::ToInt32($hexes[1].Groups[1].Value, 16) -eq 1) { 'on' } else { 'off' } }
    } catch { }
    return [pscustomobject]@{ ac = $ac; dc = $dc }
}

function Normalize-Rules($raw) {
    $out = @()
    $seen = @{}
    $i = 0
    foreach ($r in @($raw)) {
        $i++
        if (-not $r) { continue }
        $id = [string]$r.id
        if (-not $id) { $id = 'r' + $i }
        $id = ($id -replace '[^A-Za-z0-9_-]', '')
        if (-not $id) { $id = 'r' + $i }
        if ($seen.ContainsKey($id)) { Add-Err ('第 ' + $i + ' 条规则 id 重复（' + $id + '），已跳过'); continue }
        $seen[$id] = 1

        $mode = [string]$r.mode
        if ($mode -ne 'shutdown' -and $mode -ne 'hibernate') { Add-Err ('第 ' + $i + ' 条：方式只能是「休眠」或「关机」'); continue }
        $repeat = [string]$r.repeat
        if ($repeat -ne 'daily' -and $repeat -ne 'weekdays' -and $repeat -ne 'once') { $repeat = 'daily' }

        $off = Parse-HHmm ([string]$r.offTime)
        if (-not $off) { Add-Err ('第 ' + $i + ' 条：关机/休眠时间格式不对（应为 HH:mm）'); continue }
        $wake = $null
        if ([string]$r.wakeTime) {
            $wake = Parse-HHmm ([string]$r.wakeTime)
            if (-not $wake) { Add-Err ('第 ' + $i + ' 条：唤醒时间格式不对（应为 HH:mm）'); continue }
        }

        $date = $null
        if ($repeat -eq 'once') {
            $date = Parse-DateStr ([string]$r.date)
            if (-not $date) { Add-Err ('第 ' + $i + ' 条：选「仅一次」时必须选日期'); continue }
            $offAt = $date.AddHours($off.Hour).AddMinutes($off.Minute)
            if ($offAt -le (Get-Date)) { Add-Err ('第 ' + $i + ' 条：日期时间已经过去了（' + $offAt.ToString('yyyy-MM-dd HH:mm') + '），请重新选'); continue }
        } else {
            if ($wake -and $wake.Hour -eq $off.Hour -and $wake.Minute -eq $off.Minute) {
                Add-Err ('第 ' + $i + ' 条：唤醒时间和关机时间一样，没有意义'); continue
            }
        }

        $out += [pscustomobject]@{
            id = $id; mode = $mode; repeat = $repeat
            date = if ($date) { $date.ToString('yyyy-MM-dd') } else { '' }
            offTime = $off.ToString('HH:mm'); wakeTime = if ($wake) { $wake.ToString('HH:mm') } else { '' }
        }
    }
    return , $out
}

function New-OffTrigger($rule) {
    $off = Parse-HHmm $rule.offTime
    if ($rule.repeat -eq 'once') {
        $d = Parse-DateStr $rule.date
        return New-ScheduledTaskTrigger -Once -At $d.AddHours($off.Hour).AddMinutes($off.Minute)
    }
    $at = Get-Date -Hour $off.Hour -Minute $off.Minute -Second 0
    if ($at -le (Get-Date)) { $at = $at.AddDays(1) }
    if ($rule.repeat -eq 'weekdays') { return New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $at }
    return New-ScheduledTaskTrigger -Daily -At $at
}

function New-WakeTrigger($rule) {
    $w = Parse-HHmm $rule.wakeTime
    if (-not $w) { return $null }
    # 2026-11-07 实测教训：唤醒定时器会被"意外唤醒"提前消耗掉 ——
    #   20:05:02 休眠，20:06:04 就被网卡/键鼠叫醒（这些设备都开着"允许唤醒"），
    #   到 20:07 真正该唤醒时反而没有定时器了，机器一直睡着，得手动按键才回来。
    # 对策：同一个唤醒任务给 3 个触发点（目标时间、+3 分钟、+6 分钟）。
    # 只要有一次没被兑现，睡回去之后下一个触发点会重新注册唤醒定时器，多一层兜底。
    $offsets = @(0, 3, 6)
    $list = @()
    if ($rule.repeat -eq 'once') {
        # 关键修复：仅一次时，唤醒必须落在规则日期上（以前忽略 date，可能排到今天）
        $d = Parse-DateStr $rule.date
        $baseDt = $d.AddHours($w.Hour).AddMinutes($w.Minute)
        foreach ($off in $offsets) {
            $list += New-ScheduledTaskTrigger -Once -At $baseDt.AddMinutes($off)
        }
        return $list
    }
    $at = Get-Date -Hour $w.Hour -Minute $w.Minute -Second 0
    if ($at -le (Get-Date)) { $at = $at.AddDays(1) }
    foreach ($off in $offsets) {
        $t = $at.AddMinutes($off)
        if ($rule.repeat -eq 'weekdays') {
            $list += New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $t
        } else {
            $list += New-ScheduledTaskTrigger -Daily -At $t
        }
    }
    return $list
}

# ---------------- 主流程 ----------------
$doc = Read-Doc
$rules = Normalize-Rules $doc.rules
$hibernateOk = Test-Hibernate
$wakeState = Get-WakeTimerState
$applied = @(); $removed = @(); $skipped = @()

if (-not $StatusOnly) {
    # 唤醒定时器：交流 + 直流都要开（以前只开交流，拔掉电源就叫不醒）
    try {
        & powercfg.exe /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 2>$null | Out-Null
        & powercfg.exe /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 2>$null | Out-Null
        $wakeState = Get-WakeTimerState
        if ($wakeState.ac -ne 'on') { Add-Warn '交流电源的「唤醒定时器」没能开启（可能被组策略限制），定时唤醒可能不生效' }
        if ($wakeState.dc -ne 'on') { Add-Warn '电池模式下「唤醒定时器」没开，拔掉电源后可能叫不醒' }
    } catch { Add-Warn '设置唤醒定时器失败（可能需要管理员权限）' }
}

$want = @()
if (-not $StatusOnly) {
  # 启用且有规则才建任务；**删除多余任务必须始终执行**（否则暂停后到点照样休眠）
  if ($doc.enabled -and $rules.Count -gt 0) {
    foreach ($r in $rules) {
        if ($r.mode -eq 'hibernate' -and -not $hibernateOk) {
            Add-Err ('规则 ' + $r.id + '：这台电脑不支持休眠（或休眠被关掉了），请把方式改成「关机」或先开启休眠')
            [void]$skipped.Add($r.id)
            continue
        }
        if ($StatusOnly) {
            $want += ($PREFIX + $r.id)
            if ($r.wakeTime) { $want += ($PREFIX + $r.id + '-唤醒') }
            continue
        }
        try {
            $offName = $PREFIX + $r.id
            $arg = if ($r.mode -eq 'shutdown') { '/s /t 60 /c "轻屏定时关机：60 秒后关机，取消请运行 shutdown /a"' } else { '/h' }
            $setOff = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
            Register-ScheduledTask -TaskName $offName -Action (New-ScheduledTaskAction -Execute 'shutdown.exe' -Argument $arg) `
                -Trigger (New-OffTrigger $r) -Settings $setOff -Force -ErrorAction Stop | Out-Null
            $want += $offName; $applied += $offName

            if ($r.wakeTime) {
                if ($r.mode -eq 'shutdown') {
                    Add-Warn ('规则 ' + $r.id + ' 是「关机」+ 唤醒时间：关机后软件叫不醒，这条唤醒不会生效')
                } else {
                    $trgW = New-WakeTrigger $r
                    if ($trgW) {
                        $setW = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
                        $wakeName = $PREFIX + $r.id + '-唤醒'
                        Register-ScheduledTask -TaskName $wakeName -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit') `
                            -Trigger $trgW -Settings $setW -Force -ErrorAction Stop | Out-Null
                        $want += $wakeName; $applied += $wakeName
                    }
                }
            }
        } catch {
            Add-Err ('规则 ' + $r.id + ' 建任务失败：' + [string]$_.Exception.Message)
            [void]$skipped.Add($r.id)
        }
    }

  }
    # 删除不再需要的任务（暂停时 $want 为空 → 全部删掉）
    try {
        foreach ($t in @(Get-ScheduledTask -TaskName ($PREFIX + '*') -ErrorAction SilentlyContinue)) {
            if (-not $t) { continue }
            if ($want -notcontains $t.TaskName) {
                Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction SilentlyContinue
                $removed += $t.TaskName
            }
        }
    } catch { }
}

$tasks = @()
try {
    foreach ($t in @(Get-ScheduledTask -TaskName ($PREFIX + '*') -ErrorAction SilentlyContinue)) {
        if (-not $t) { continue }
        try {
            $i = Get-ScheduledTaskInfo -TaskName $t.TaskName -ErrorAction Stop
            $tasks += [pscustomobject]@{ name = $t.TaskName; state = [string]$t.State; next = ([string]$i.NextRunTime); wake = [bool]$t.Settings.WakeToRun }
        } catch {
            $tasks += [pscustomobject]@{ name = $t.TaskName; state = [string]$t.State; next = ''; wake = $false }
        }
    }
} catch { }

$result = [pscustomobject]@{
    ok = ($errors.Count -eq 0)
    statusOnly = [bool]$StatusOnly
    enabled = [bool]$doc.enabled
    rules = $rules
    applied = $applied
    removed = $removed
    skipped = $skipped
    warnings = @($warnings)
    errors = @($errors)
    wakeTimer = $wakeState
    hibernate = $hibernateOk
    tasks = $tasks
    error = if ($errors.Count -gt 0) { [string]$errors[0] } else { '' }
    at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
$out = $result | ConvertTo-Json -Depth 6 -Compress
if ($OutPath) {
    try { [System.IO.File]::WriteAllText($OutPath, $out, (New-Object System.Text.UTF8Encoding($false))) } catch { }
}
$out
