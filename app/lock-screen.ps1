# 防窥屏（privacy mode）：在被控电脑的每块屏幕最上层盖一个全屏窗口。
#
# 关键点：SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) 让窗口**不出现在屏幕捕获里**，
# 所以本机的人只看到黑屏/自定义图，而远端控制者通过 ddagrab 捕获仍然看到真实桌面。
#
# 用法（由 screen-server 拉起，不直接给客户用）：
#   powershell -File lock-screen.ps1 -ImagePath "锁屏图.png" -StopFile "privacy.stop"
#     -ImagePath 省略 = 纯黑
#     -StopFile  出现这个文件就退出（服务端删/建文件来关）
#     -HoldSeconds 调试用：N 秒后自动退出（0 = 一直显示）
#     -TestColor  调试用：用纯色块代替锁屏图（配合截图检测"是否被捕获"）
#
# 退出：窗口关闭 / StopFile 出现 / 进程被杀。服务端会同时删除 StopFile。
# UTF-8 with BOM，PS 5.1。
param(
    [string]$ImagePath = '',
    [string]$StopFile = '',
    [string]$BeatFile = '',
    [int]$ParentPid = 0,
    [string]$TestColor = '',
    [int]$HoldSeconds = 0,
    [int]$MaxMinutes = 480,
    [switch]$DisableExclude
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('LockWinApi' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LockWinApi {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
    [DllImport("user32.dll")]
    public static extern int ShowCursor(bool bShow);
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
}

$WDA_EXCLUDEFROMCAPTURE = 0x00000011
$ES_CONTINUOUS = 0x80000000
$ES_DISPLAY_REQUIRED = 0x00000002
$ES_SYSTEM_REQUIRED = 0x00000001

# 不让系统休眠/关屏：防窥屏期间屏幕由我们控制
try { [void][LockWinApi]::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_DISPLAY_REQUIRED -bor $ES_SYSTEM_REQUIRED)) } catch { }

$lockImage = $null
if ($ImagePath -and (Test-Path -LiteralPath $ImagePath)) {
    try { $lockImage = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path) } catch { $lockImage = $null }
}

$backColor = [System.Drawing.Color]::Black
if ($TestColor) {
    try { $backColor = [System.Drawing.ColorTranslator]::FromHtml($TestColor) } catch { }
}

$forms = @()
$hiddenCursor = 0
try {
    foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
        $f = New-Object System.Windows.Forms.Form
        $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
        $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
        $f.Bounds = $screen.Bounds
        $f.TopMost = $true
        $f.ShowInTaskbar = $false
        $f.BackColor = $backColor
        $f.MinimizeBox = $false
        $f.MaximizeBox = $false
        $f.ControlBox = $false
        if ($lockImage) {
            $f.BackgroundImage = $lockImage
            $f.BackgroundImageLayout = [System.Windows.Forms.ImageLayout]::Stretch
        }
        # Alt+F4 / 点关闭 都拦掉；脚本自己要退出时把 allowClose 放开
        $global:lockScreenAllowClose = $false
        $f.Add_FormClosing({ param($s, $e) if (-not $global:lockScreenAllowClose) { $e.Cancel = $true } })
        $f.Show()
        if (-not $DisableExclude) {
            try { [void][LockWinApi]::SetWindowDisplayAffinity($f.Handle, [uint32]$WDA_EXCLUDEFROMCAPTURE) } catch { }
        }
        $forms += $f
    }
    if ($forms.Count -gt 0) {
        try { [void]$forms[0].Activate() } catch { }
        try { [void]$forms[0].Focus() } catch { }
    }
    for ($i = 0; $i -lt 8; $i++) { if ([LockWinApi]::ShowCursor($false) -lt 0) { $hiddenCursor++; break } else { $hiddenCursor++ } }

    $start = Get-Date
    while ($true) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 80
        if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
        if ($HoldSeconds -gt 0 -and ((Get-Date) - $start).TotalSeconds -ge $HoldSeconds) { break }
        if ($forms.Count -eq 0) { break }
        # 保命三件套：服务端进程没了 / 心跳文件过期 / 超过最长时长 —— 任何一条都立刻撤窗口，
        # 绝不能让电脑本机被一块关不掉的黑屏卡住（服务端崩溃/被杀时靠这些自动解锁）。
        if ($ParentPid -gt 0) {
            $pp = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
            if (-not $pp) { break }
        }
        if ($BeatFile) {
            try {
                if (-not (Test-Path -LiteralPath $BeatFile)) { break }
                if (((Get-Date) - (Get-Item -LiteralPath $BeatFile).LastWriteTime).TotalSeconds -gt 20) { break }
            } catch { break }
        }
        if ($MaxMinutes -gt 0 -and ((Get-Date) - $start).TotalMinutes -ge $MaxMinutes) { break }
    }
} finally {
    $global:lockScreenAllowClose = $true
    for ($i = 0; $i -lt $hiddenCursor; $i++) { [void][LockWinApi]::ShowCursor($true) }
    foreach ($f in $forms) { try { $f.Hide(); $f.Close(); $f.Dispose() } catch { } }
    if ($lockImage) { try { $lockImage.Dispose() } catch { } }
    try { [void][LockWinApi]::SetThreadExecutionState([uint32]$ES_CONTINUOUS) } catch { }
}
