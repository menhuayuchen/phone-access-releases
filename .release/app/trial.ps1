<#
.SYNOPSIS
    7 天全功能试用的"锚点"：记录首次安装时间，并让卸载重装拿不到新的 7 天。

.DESCRIPTION
    商业目标（2026-10-30 用户拍板）：
      新装 7 天全功能试用（超清不限时 + 个性化全开），到期自动回落到免费档。
      "由奢入俭"是最强的付费动机，但前提是**卸载重装不能刷新试用期**，
      否则等于永久免费。

    做法：把"首装时间"存在安装目录**以外**的三个地方，取其中**最早**的一个作为锚点：
      1) HKLM\SOFTWARE\PhoneAccess       （管理员写；重装系统才会没）
      2) %ProgramData%\PhoneAccess\trial.json
      3) %LOCALAPPDATA%\PhoneAccessTrial\trial.json   （刻意不用安装目录 %LOCALAPPDATA%\PhoneAccess）
      4) HKCU\SOFTWARE\PhoneAccess       （无管理员权限时的兜底）
    注意 3) 的路径：安装目录是 %LOCALAPPDATA%\PhoneAccess，卸载会整个删掉，
    所以试用标记必须放在同级的另一个目录里。

    防篡改（诚实说明：本地方案只防"手滑/顺手改"，不防刻意逆向）：
      · 每条记录带 machine（机器码）+ chk（SHA256(machine|start|salt)）；
        改 start 而不重算 chk 会失效，换机器复制文件也会失效。
      · 记录里带 lastSeen：系统时间往回调超过 1 天视为作弊，试用直接判失效。
      · 本地记录被人为删光时，无法与服务器对账（产品没有中心服务器），
        这一点在 STATUS/交付说明里已写明，不要对外宣称"绝对防破解"。

.NOTES
    UTF-8 with BOM，PS 5.1。调用方：licence-state.ps1（每次校验许可证时顺带算一次，结果写进 licence.state.json）。
#>
[CmdletBinding()]
param(
    [string]$AppDir = '',
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AppDir) { $AppDir = $here }

# licence.ps1 提供 Get-LicenceMachineCode（机器码算法与许可证共用一套，避免两套口径）
try { . (Join-Path $here 'licence.ps1') } catch { }

# 盐值：只防"顺手改文件"，不是密钥。改这里会让老机器的记录全部失效（等于重发试用），别乱改。
$script:TrialSalt = 'phoneaccess-trial-anchor-2026-10-30'

# 服务端试用台账（2026-11-03，T1）：**可选**。配置 freemium.trialLedgerUrl 指向一个
# 记录"每台机器第一次领试用时间"的小接口；本地锚点被清掉（重装系统、手动删记录）时，
# 台账能把这台机器按回原来的起点。连不上/超时就完全退回本地逻辑，绝不锁死客户。
# 隐私：只上传机械码（SHA256 哈希），不含任何客户信息。
$script:LedgerFailCacheHours = 6    # 联网失败后 6 小时内不再重试（避免守护进程每 8 秒卡 4 秒）
$script:LedgerRefreshDays = 7       # 已有台账结果时 7 天后刷新一次

function Get-TrialLedgerUrl {
    param([string]$Dir)
    try {
        $p = Join-Path $Dir 'product.config.json'
        if (-not (Test-Path -LiteralPath $p)) { return '' }
        $cfg = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg -and $cfg.freemium -and $cfg.freemium.trialLedgerUrl) {
            return ([string]$cfg.freemium.trialLedgerUrl).Trim()
        }
    } catch { }
    return ''
}

function Get-TrialLedgerToken {
    # 可选：和台账服务共用的一串口令（只算"防误扫"，不是安全边界——它在客户端配置里）。
    param([string]$Dir)
    try {
        $p = Join-Path $Dir 'product.config.json'
        if (-not (Test-Path -LiteralPath $p)) { return '' }
        $cfg = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg -and $cfg.freemium -and $cfg.freemium.trialLedgerToken) {
            return ([string]$cfg.freemium.trialLedgerToken).Trim()
        }
    } catch { }
    return ''
}

function Test-TrialLedgerUrl {
    # 只允许 https（机械码别走明文）。本机回环地址放行 http，供自测用。
    param([string]$Url)
    if ($Url -match '^https://\S+$') { return $true }
    if ($Url -match '^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(/\S*)?$') { return $true }
    return $false
}

function Read-TrialLedgerCache {
    param([string]$Path)
    $res = [pscustomobject]@{ start = ''; at = ''; failedAt = '' }
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $res }
        $j = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($j) {
            $res.start = [string]$j.start
            $res.at = [string]$j.at
            $res.failedAt = [string]$j.failedAt
        }
    } catch { }
    return $res
}

function Write-TrialLedgerCache {
    param([string]$Path, [string]$Start, [string]$At, [string]$FailedAt)
    try {
        $body = [pscustomobject]@{ start = $Start; at = $At; failedAt = $FailedAt } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($Path, $body, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Get-LedgerStart {
    <#
      查台账，返回 @{ start=''; ok; cached; error }。
      start 为空 = 台账没有可用起点（首次领、或连不上且无缓存）。
      缓存策略：
        · 有未过期的台账结果（7 天内）→ 直接用缓存，不联网；
        · 最近 6 小时失败过 → 不重试，只用缓存；
        · 否则 POST 一次，成功写缓存，失败写 failedAt。
    #>
    param([string]$Url, [string]$Machine, [string]$CachePath, [int]$TimeoutSec = 4, [string]$Token = '')
    $res = [pscustomobject]@{ start = ''; ok = $false; cached = $false; error = '' }
    if (-not $Url -or -not $Machine) { return $res }
    if (-not (Test-TrialLedgerUrl -Url $Url)) { $res.error = '台账地址必须是 https（本机回环自测除外）'; return $res }

    $now = Get-Date
    $cul = [System.Globalization.CultureInfo]::InvariantCulture
    $styles = [System.Globalization.DateTimeStyles]::None
    $cache = Read-TrialLedgerCache -Path $CachePath

    if ($cache.failedAt) {
        $f = [datetime]::MinValue
        if ([datetime]::TryParseExact($cache.failedAt, 'yyyy-MM-dd HH:mm:ss', $cul, $styles, [ref]$f)) {
            if ($now -lt $f.AddHours($script:LedgerFailCacheHours)) {
                $res.start = $cache.start; $res.cached = $true; $res.error = '最近失败过，只用缓存'
                return $res
            }
        }
    }
    if ($cache.start -and $cache.at) {
        $a = [datetime]::MinValue
        if ([datetime]::TryParseExact($cache.at, 'yyyy-MM-dd HH:mm:ss', $cul, $styles, [ref]$a)) {
            if ($now -lt $a.AddDays($script:LedgerRefreshDays)) {
                $res.start = $cache.start; $res.ok = $true; $res.cached = $true
                return $res
            }
        }
    }

    try {
        $body = (@{ machine = $Machine; v = 1 } | ConvertTo-Json -Compress)
        $hdrs = @{}
        if ($Token) { $hdrs['x-ledger-token'] = $Token }
        $r = Invoke-RestMethod -Uri $Url -Method Post -ContentType 'application/json' -Body $body -Headers $hdrs -TimeoutSec $TimeoutSec
        $s = [string]$r.start
        if ($s -match '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$') {
            $res.start = $s
            $res.ok = $true
            Write-TrialLedgerCache -Path $CachePath -Start $s -At $now.ToString('yyyy-MM-dd HH:mm:ss') -FailedAt ''
        } else {
            $res.error = '台账返回的 start 格式不对'
            Write-TrialLedgerCache -Path $CachePath -Start '' -At '' -FailedAt $now.ToString('yyyy-MM-dd HH:mm:ss')
        }
    } catch {
        $res.error = '台账连不上：' + $_.Exception.Message
        Write-TrialLedgerCache -Path $CachePath -Start $cache.start -At $cache.at -FailedAt $now.ToString('yyyy-MM-dd HH:mm:ss')
        if ($cache.start) { $res.start = $cache.start; $res.cached = $true }
    }
    return $res
}

function Merge-TrialAnchor {
    <#
      纯函数：在"本地锚点"和"台账起点"里取最早的一个。
        · 本地没有锚点（重装/清记录）→ 用台账起点；
        · 台账比本地早（说明这台机器以前领过）→ 用台账；
        · 否则保持本地。
      返回选中的字符串；两个都空返回 ''。
    #>
    param([string]$Anchor, [string]$LedgerStart)
    if (-not $Anchor) { return [string]$LedgerStart }
    if (-not $LedgerStart) { return [string]$Anchor }
    $cul = [System.Globalization.CultureInfo]::InvariantCulture
    $styles = [System.Globalization.DateTimeStyles]::None
    $a = [datetime]::MinValue
    $b = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($Anchor, 'yyyy-MM-dd HH:mm:ss', $cul, $styles, [ref]$a)) { return [string]$LedgerStart }
    if (-not [datetime]::TryParseExact($LedgerStart, 'yyyy-MM-dd HH:mm:ss', $cul, $styles, [ref]$b)) { return [string]$Anchor }
    if ($b -lt $a) { return [string]$LedgerStart }
    return [string]$Anchor
}

function Get-TrialDaysFromConfig {
    param([string]$Dir)
    $days = 7
    try {
        $p = Join-Path $Dir 'product.config.json'
        if (Test-Path -LiteralPath $p) {
            $cfg = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
            $v = 0
            if ($cfg -and $cfg.freemium -and ($null -ne $cfg.freemium.trialDays)) {
                $v = [int]$cfg.freemium.trialDays
            }
            if ($v -gt 0 -and $v -le 365) { $days = $v }
        }
    } catch { }
    return $days
}

function Get-TrialCheck {
    param([string]$Machine, [string]$Start)
    $raw = ([string]$Machine) + '|' + ([string]$Start) + '|' + $script:TrialSalt
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $h = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($raw))
    } finally { $sha.Dispose() }
    return (-join ($h | ForEach-Object { $_.ToString('x2') }))
}

function Get-TrialPaths {
    param([string]$Dir)
    $list = New-Object System.Collections.ArrayList
    $pd = $env:ProgramData
    if (-not $pd) { $pd = 'C:\ProgramData' }
    $lad = $env:LOCALAPPDATA
    if (-not $lad) { $lad = Join-Path $env:USERPROFILE 'AppData\Local' }
    # 顺序 = 可信度从高到低；读取时全部读，取最早
    [void]$list.Add((Join-Path $pd 'PhoneAccess\trial.json'))
    [void]$list.Add((Join-Path $lad 'PhoneAccessTrial\trial.json'))
    [void]$list.Add((Join-Path $Dir 'trial.json'))
    return $list.ToArray()
}

function Read-TrialRegValue {
    # 用 reg.exe 而不是 PowerShell 注册表提供程序：非管理员时 New-Item 会往错误流喷一堆红字，
    # 而"写不进去"在这里是完全正常的情况（没提权），不该吓到客户。
    param([string]$Key, [string]$Name)
    try {
        $hive = 'HKLM'
        if ($Key -like 'HKCU*') { $hive = 'HKCU' }
        $path = $hive + '\SOFTWARE\PhoneAccess'
        $out = & reg query $path /v $Name 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $out) { return '' }
        foreach ($line in @($out)) {
            if ($line -match ('^\s+' + [regex]::Escape($Name) + '\s+REG_SZ\s+(.*)$')) { return $matches[1].Trim() }
        }
        return ''
    } catch { return '' }
}

function Write-TrialRegValue {
    param([string]$Key, [string]$Name, [string]$Value)
    try {
        $hive = 'HKLM'
        if ($Key -like 'HKCU*') { $hive = 'HKCU' }
        $path = $hive + '\SOFTWARE\PhoneAccess'
        & reg add $path /v $Name /t REG_SZ /d $Value /f 1>$null 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Read-TrialCandidates {
    param([string]$Machine)
    $found = New-Object System.Collections.ArrayList
    foreach ($p in (Get-TrialPaths -Dir $AppDir)) {
        try {
            if (-not (Test-Path -LiteralPath $p)) { continue }
            $j = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not $j -or -not $j.start) { continue }
            $m = [string]$j.machine
            $s = [string]$j.start
            $c = [string]$j.chk
            if ($m -ne $Machine) { continue }
            if ($c -ne (Get-TrialCheck -Machine $m -Start $s)) { continue }
            [void]$found.Add([pscustomobject]@{ start = $s; lastSeen = [string]$j.lastSeen; source = $p })
        } catch { }
    }
    foreach ($kv in @(@{ key = 'HKLM:\SOFTWARE\PhoneAccess'; name = 'HKLM' }, @{ key = 'HKCU:\SOFTWARE\PhoneAccess'; name = 'HKCU' })) {
        try {
            $s = Read-TrialRegValue -Key $kv.key -Name 'TrialStart'
            if (-not $s) { continue }
            $c = Read-TrialRegValue -Key $kv.key -Name 'TrialChk'
            if ($c -ne (Get-TrialCheck -Machine $Machine -Start $s)) { continue }
            $ls = Read-TrialRegValue -Key $kv.key -Name 'TrialLastSeen'
            [void]$found.Add([pscustomobject]@{ start = $s; lastSeen = $ls; source = $kv.name })
        } catch { }
    }
    return $found.ToArray()
}

function Save-TrialRecord {
    param([string]$Machine, [string]$Start, [string]$LastSeen)
    $chk = Get-TrialCheck -Machine $Machine -Start $Start
    $body = [pscustomobject]@{ v = 1; machine = $Machine; start = $Start; lastSeen = $LastSeen; chk = $chk }
    $json = $body | ConvertTo-Json -Compress
    foreach ($p in (Get-TrialPaths -Dir $AppDir)) {
        try {
            $dir = Split-Path -Parent $p
            if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            [System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))
        } catch { }
    }
    [void](Write-TrialRegValue -Key 'HKLM:\SOFTWARE\PhoneAccess' -Name 'TrialStart' -Value $Start)
    [void](Write-TrialRegValue -Key 'HKLM:\SOFTWARE\PhoneAccess' -Name 'TrialChk' -Value $chk)
    [void](Write-TrialRegValue -Key 'HKLM:\SOFTWARE\PhoneAccess' -Name 'TrialLastSeen' -Value $LastSeen)
    [void](Write-TrialRegValue -Key 'HKCU:\SOFTWARE\PhoneAccess' -Name 'TrialStart' -Value $Start)
    [void](Write-TrialRegValue -Key 'HKCU:\SOFTWARE\PhoneAccess' -Name 'TrialChk' -Value $chk)
    [void](Write-TrialRegValue -Key 'HKCU:\SOFTWARE\PhoneAccess' -Name 'TrialLastSeen' -Value $LastSeen)
}

function Get-TrialState {
    <#
      返回：
        active     = 试用中（trial 期内且未过期）
        state      = 'trial' | 'expired' | 'clock-tamper' | 'no-machine'
        start/ends = 起止时间字符串（yyyy-MM-dd HH:mm:ss）
        daysLeft   = 剩余天数（向上取整，到期当天显示 1）
        days       = 试用总天数
    #>
    param([string]$Dir = '')

    if (-not $Dir) { $Dir = $AppDir }
    $days = Get-TrialDaysFromConfig -Dir $Dir
    $machine = ''
    try { $machine = Get-LicenceMachineCode } catch { }
    # 旧算法机械码（v1）：2026-11-03 之前的试用锚点是用它写的，要平滑迁移到 v2
    $legacyMachine = ''
    try {
        if (Get-Command Get-LicenceLegacyMachineCode -ErrorAction SilentlyContinue) {
            $legacyMachine = Get-LicenceLegacyMachineCode
        }
    } catch { }

    $res = [pscustomobject]@{
        active   = $false
        state    = 'ok'
        start    = ''
        ends     = ''
        daysLeft = 0
        days     = $days
        machine  = $machine
    }

    if (-not $machine) {
        $res.state = 'no-machine'
        # 读不到机器码时不发放试用，也不阻断产品（免费档照常能用）
        return $res
    }

    $cands = @(Read-TrialCandidates -Machine $machine)
    # 迁移：v2 码一个锚点都没有时，找 v1 码的旧锚点；找到就沿用（下面的 Save-TrialRecord
    # 会用 v2 码把记录重写成新格式，下次直接命中 v2）。
    if ($cands.Count -eq 0 -and $legacyMachine -and $legacyMachine -ne $machine) {
        $cands = @(Read-TrialCandidates -Machine $legacyMachine)
    }

    # 取最早的一条作为锚点：重装时旧记录还在 -> 锚点不变 -> 试用期不刷新
    $anchor = $null
    $anchorLastSeen = $null
    foreach ($c in $cands) {
        if (-not $c.start) { continue }
        if (-not $anchor) { $anchor = $c.start; $anchorLastSeen = $c.lastSeen; continue }
        $a = [datetime]::MinValue; $b = [datetime]::MinValue
        $styles = [System.Globalization.DateTimeStyles]::None
        $cul = [System.Globalization.CultureInfo]::InvariantCulture
        $okA = [datetime]::TryParseExact($anchor, 'yyyy-MM-dd HH:mm:ss', $cul, $styles, [ref]$a)
        $okB = [datetime]::TryParseExact([string]$c.start, 'yyyy-MM-dd HH:mm:ss', $cul, $styles, [ref]$b)
        if ($okB -and (-not $okA -or $b -lt $a)) { $anchor = [string]$c.start; $anchorLastSeen = $c.lastSeen }
    }

    # 服务端台账（可选，T1）：只在「本地一个锚点都没有」（疑似重装/清记录）或
    # 「已经有台账缓存」时联网；正常机器一次都不联网。台账起点更早就以台账为准。
    try {
        $ledgerUrl = Get-TrialLedgerUrl -Dir $Dir
        if ($ledgerUrl -and $machine) {
            $ledgerCache = Join-Path $Dir 'trial-ledger.json'
            if ((-not $anchor) -or (Test-Path -LiteralPath $ledgerCache)) {
                $ledgerToken = Get-TrialLedgerToken -Dir $Dir
                $led = Get-LedgerStart -Url $ledgerUrl -Machine $machine -CachePath $ledgerCache -Token $ledgerToken
                if ($led.start) {
                    $merged = Merge-TrialAnchor -Anchor ([string]$anchor) -LedgerStart ([string]$led.start)
                    if ($merged -and ($merged -ne [string]$anchor)) {
                        $anchor = $merged
                        $anchorLastSeen = $merged
                    } elseif (-not $anchor) {
                        $anchor = $merged
                        $anchorLastSeen = $merged
                    }
                }
            }
        }
    } catch { }

    $now = Get-Date
    if (-not $anchor) {
        # 第一次安装：现在就是起点，立刻写进四个位置
        $anchor = $now.ToString('yyyy-MM-dd HH:mm:ss')
        $anchorLastSeen = $anchor
        Save-TrialRecord -Machine $machine -Start $anchor -LastSeen $anchor
    }

    $startDt = [datetime]::MinValue
    $styles2 = [System.Globalization.DateTimeStyles]::None
    $cul2 = [System.Globalization.CultureInfo]::InvariantCulture
    if (-not [datetime]::TryParseExact($anchor, 'yyyy-MM-dd HH:mm:ss', $cul2, $styles2, [ref]$startDt)) {
        # 锚点时间格式坏掉：按"现在"重写一次，不让产品因为一条坏记录而永久锁死
        $anchor = $now.ToString('yyyy-MM-dd HH:mm:ss')
        $startDt = $now
        Save-TrialRecord -Machine $machine -Start $anchor -LastSeen $anchor
    }

    # 时钟回拨检测：系统时间比记录里的 lastSeen 早 1 天以上 -> 视为作弊，试用判失效
    $tamper = $false
    if ($anchorLastSeen) {
        $ls = [datetime]::MinValue
        if ([datetime]::TryParseExact([string]$anchorLastSeen, 'yyyy-MM-dd HH:mm:ss', $cul2, $styles2, [ref]$ls)) {
            if ($now -lt $ls.AddDays(-1)) { $tamper = $true }
        }
    }
    # 系统时间比试用起点还早：同样按回拨处理（不能靠调时间去"回到"试用期）
    if ($now -lt $startDt.AddDays(-1)) { $tamper = $true }

    $ends = $startDt.AddDays($days)
    $res.start = $startDt.ToString('yyyy-MM-dd HH:mm:ss')
    $res.ends = $ends.ToString('yyyy-MM-dd HH:mm:ss')

    if ($tamper) {
        $res.state = 'clock-tamper'
        $res.active = $false
        $res.daysLeft = 0
        return $res
    }

    if ($now -lt $ends) {
        $res.active = $true
        $res.state = 'trial'
        $remain = ($ends - $now).TotalDays
        $res.daysLeft = [int][math]::Ceiling($remain)
        if ($res.daysLeft -lt 1) { $res.daysLeft = 1 }
    } else {
        $res.active = $false
        $res.state = 'expired'
        $res.daysLeft = 0
    }

    # 每次跑都刷新 lastSeen（只往前推，方便回拨检测）
    $newSeen = $now.ToString('yyyy-MM-dd HH:mm:ss')
    $keepSeen = $anchorLastSeen
    if ($keepSeen) {
        $ls2 = [datetime]::MinValue
        if ([datetime]::TryParseExact([string]$keepSeen, 'yyyy-MM-dd HH:mm:ss', $cul2, $styles2, [ref]$ls2)) {
            if ($now -gt $ls2) { $keepSeen = $newSeen } else { $keepSeen = $ls2.ToString('yyyy-MM-dd HH:mm:ss') }
        } else { $keepSeen = $newSeen }
    } else { $keepSeen = $newSeen }
    Save-TrialRecord -Machine $machine -Start $res.start -LastSeen $keepSeen

    return $res
}

# 直接运行本脚本时打印结果，方便排查（产品运行时不走这条路径）
if ($MyInvocation.InvocationName -ne '.') {
    $t = Get-TrialState -Dir $AppDir
    if (-not $Quiet) {
        Write-Host ('试用：' + $t.state + '  开始=' + $t.start + '  到期=' + $t.ends + '  剩余=' + $t.daysLeft + '/' + $t.days + ' 天') -ForegroundColor Cyan
        Write-Host ('机器码：' + $t.machine)
    }
}
