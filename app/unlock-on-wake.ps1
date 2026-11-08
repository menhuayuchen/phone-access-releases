# unlock-on-wake.ps1 - 自用版「唤醒后不要求登录」（A 方案，2026-11-07）
#
# 作用：
#   on    关闭「唤醒时要求登录」(CONSOLELOCK=0, 交流/直流)，并去掉屏保的安全锁定；
#         唤醒/开机后直接回桌面，手机不用输 Windows 密码就能操作。
#   off   恢复 CONSOLELOCK=1（唤醒仍要密码）——发布版必须用这个。
#   status 只读，输出一行 JSON，给页面/日志用。
#   -Quiet 少打印。
#
# 为什么需要管理员：CONSOLELOCK 是隐藏的电源设置，powercfg 写电源方案需要提权；
# 提权由调用方负责（power-apply.ps1 在 /power/apply 的 UAC 流程里调用本脚本）。
#
# 安全说明：这条等于"机器醒来就是已登录状态"，物理接触者可直接使用。
# 只应在自用版开启；发布版由 mark-release.ps1 把 security.unlockOnWake 强制成 false。
#
# 文件必须 UTF-8 with BOM（PowerShell 5.1）。
param(
    [ValidateSet('on', 'off', 'status')]
    [string]$Action = 'status',
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$CONSOLELOCK = '0e796bdb-100d-47d6-a2d5-f7d2daa51f51'
$errors = New-Object System.Collections.ArrayList
$warnings = New-Object System.Collections.ArrayList
function Add-Err([string]$m) { [void]$errors.Add($m) }
function Add-Warn([string]$m) { [void]$warnings.Add($m) }
function Say([string]$m) { if (-not $Quiet) { Write-Host $m } }

$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# 读当前 CONSOLELOCK（隐藏属性，值照样能读出来；读不到就返回 $null）
function Get-ConsoleLockIndex {
    param([string]$Side)   # 'ac' | 'dc'
    $q = (& powercfg.exe /query SCHEME_CURRENT SUB_NONE CONSOLELOCK 2>&1) -join "`n"
    if ($Side -eq 'ac') {
        if ($q -match '当前交流电源设置索引:\s*0x([0-9a-fA-F]+)') { return [Convert]::ToInt32($Matches[1], 16) }
    } else {
        if ($q -match '当前直流电源设置索引:\s*0x([0-9a-fA-F]+)') { return [Convert]::ToInt32($Matches[1], 16) }
    }
    return $null
}

function Set-ConsoleLockIndex {
    param([int]$Value)
    # 先取消"隐藏属性"，否则有些系统上 /SET 会报"参数无效"
    & powercfg.exe -attributes SUB_NONE $CONSOLELOCK -ATTRIB_HIDE 2>&1 | Out-Null
    & powercfg.exe /SETACVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK $Value 2>&1 | Out-Null
    & powercfg.exe /SETDCVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK $Value 2>&1 | Out-Null
    & powercfg.exe /SETACTIVE SCHEME_CURRENT 2>&1 | Out-Null
}

# 屏保：不要"恢复时显示登录屏幕"（ScreenSaverIsSecure=0）
function Set-ScreenSaverSecure {
    param([int]$Value)
    try {
        $k = 'HKCU:\Control Panel\Desktop'
        if (-not (Test-Path $k)) { return }
        Set-ItemProperty -Path $k -Name 'ScreenSaverIsSecure' -Value ([string]$Value) -ErrorAction SilentlyContinue
    } catch { Add-Warn ('设置屏保安全锁定失败：' + $_.Exception.Message) }
}
function Get-ScreenSaverSecure {
    try { return [string](Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaverIsSecure' -ErrorAction SilentlyContinue).ScreenSaverIsSecure } catch { return '' }
}

# 机器不活动自动锁屏策略（0 = 不限制）。需要管理员；失败不致命。
function Set-InactivityLimit {
    param([int]$Seconds)
    try {
        $k = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
        if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
        Set-ItemProperty -Path $k -Name 'InactivityTimeoutSecs' -Value $Seconds -Type DWord -ErrorAction Stop
    } catch { Add-Warn ('设置不活动锁屏策略失败（可能被策略锁定）：' + $_.Exception.Message) }
}

# 2026-11-08：关掉时要"恢复原样"，所以开的时候先把原始值记下来（只记第一次，避免来回切把 0 当成原值）。
$stateFile = Join-Path (Split-Path -Parent $PSCommandPath) 'unlock-on-wake.state.json'
function Save-OriginState {
    if (Test-Path -LiteralPath $stateFile) { return }
    $ssSecure = $null
    $inact = $null
    try {
        $ssSecure = (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaverIsSecure' -ErrorAction SilentlyContinue).ScreenSaverIsSecure
    } catch { }
    try {
        $v = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name 'InactivityTimeoutSecs' -ErrorAction SilentlyContinue).InactivityTimeoutSecs
        if ($null -ne $v) { $inact = [int]$v }
    } catch { }
    $doc = [pscustomobject]@{
        screenSaverSecureHad = ($null -ne $ssSecure)
        screenSaverSecure    = [string]$ssSecure
        inactivityHad        = ($null -ne $inact)
        inactivitySecs       = $(if ($null -ne $inact) { $inact } else { -1 })
        at                   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    }
    try { [System.IO.File]::WriteAllText($stateFile, ($doc | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false))) } catch { Add-Warn '记录原始设置失败（关闭时可能无法完全恢复）' }
}
function Restore-OriginState {
    if (-not (Test-Path -LiteralPath $stateFile)) { return }
    try {
        $st = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        # 屏保安全锁定
        try {
            $k = 'HKCU:\Control Panel\Desktop'
            if ($st.screenSaverSecureHad) { Set-ItemProperty -Path $k -Name 'ScreenSaverIsSecure' -Value ([string]$st.screenSaverSecure) -ErrorAction SilentlyContinue }
            else { Remove-ItemProperty -Path $k -Name 'ScreenSaverIsSecure' -ErrorAction SilentlyContinue }
        } catch { }
        # 不活动锁屏策略
        try {
            $k2 = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
            if ($st.inactivityHad) { Set-ItemProperty -Path $k2 -Name 'InactivityTimeoutSecs' -Value ([int]$st.inactivitySecs) -Type DWord -ErrorAction SilentlyContinue }
            else { Remove-ItemProperty -Path $k2 -Name 'InactivityTimeoutSecs' -ErrorAction SilentlyContinue }
        } catch { }
        Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
        Say '已恢复原始锁屏相关设置'
    } catch { Add-Warn ('恢复原始设置失败：' + $_.Exception.Message) }
}

$ac = Get-ConsoleLockIndex 'ac'
$dc = Get-ConsoleLockIndex 'dc'
Say ("CONSOLELOCK: ac=" + $ac + " dc=" + $dc + "  admin=" + $isAdmin)

switch ($Action) {
    'on' {
        if (-not $isAdmin) {
            Add-Err '需要管理员权限才能改「唤醒时要求登录」'
        } else {
            Save-OriginState
            Set-ConsoleLockIndex 0
            Set-ScreenSaverSecure 0
            Set-InactivityLimit 0
            $ac = Get-ConsoleLockIndex 'ac'
            $dc = Get-ConsoleLockIndex 'dc'
            if ($ac -ne 0 -or $dc -ne 0) { Add-Err ('设置后读回仍不是 0（ac=' + $ac + ' dc=' + $dc + '），可能被组策略覆盖') }
            Say '已关闭：唤醒时不再要求登录（自用便利模式）'
        }
    }
    'off' {
        if (-not $isAdmin) {
            Add-Err '需要管理员权限才能改「唤醒时要求登录」'
        } else {
            Set-ConsoleLockIndex 1
            # 2026-11-08：恢复开启前的原始值（屏保安全锁定 / 不活动锁屏策略），没有记录就退回"安全默认"
            if (Test-Path -LiteralPath $stateFile) { Restore-OriginState } else { Set-ScreenSaverSecure 1 }
            $ac = Get-ConsoleLockIndex 'ac'
            $dc = Get-ConsoleLockIndex 'dc'
            if ($ac -ne 1 -or $dc -ne 1) { Add-Err ('设置后读回仍不是 1（ac=' + $ac + ' dc=' + $dc + '）') }
            Say '已恢复：唤醒时要登录'
        }
    }
    'status' { }
}

$result = [pscustomobject]@{
    ok               = ($errors.Count -eq 0)
    action           = $Action
    elevated         = $isAdmin
    consoleLock      = [pscustomobject]@{ ac = $ac; dc = $dc; unlocked = (($ac -eq 0) -and ($dc -eq 0)) }
    screenSaverSecure = Get-ScreenSaverSecure
    errors           = @($errors)
    warnings         = @($warnings)
    at               = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}
$out = $result | ConvertTo-Json -Depth 4 -Compress
$out
