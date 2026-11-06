<#
.SYNOPSIS
    一键卸载「轻屏控制」

.DESCRIPTION
    按顺序把安装时做过的事情全部撤掉：
      1) 停掉画面服务 / 守护进程 / 注入器 / 抓屏 / 音频
      2) 删除两个计划任务（开机自启、高权限注入）
      3) 删除防火墙规则
      4) 删除 Defender 排除项
      5) 删除桌面「轻屏」文件夹
      6) 删除安装目录和注入器目录

    默认**保留许可证**（licence.json）——客户以后重装同一台机器不用重新申请。
    要连许可证一起删，加 -RemoveLicence。

.NOTES
    UTF-8 with BOM，PS 5.1。
    需要管理员权限。会二次确认（要输入 YES），避免误双击。
#>
[CmdletBinding()]
param(
    [switch]$Yes,             # 跳过确认（自动化用）
    [switch]$RemoveLicence,   # 连许可证一起删
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok([string]$m) { Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Warn([string]$m) { Write-Host ('  [!] ' + $m) -ForegroundColor Yellow }

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  卸载「轻屏控制」' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

# ---- 读配置（拿安装目录和端口）----
$installRoot = Join-Path $env:LOCALAPPDATA 'PhoneAccess'
$screenPort = 8660
$enableWebConsole = $false
$cfgPath = Join-Path $here 'product.config.json'
if (Test-Path -LiteralPath $cfgPath) {
    try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.installDir) {
            $expanded = [Environment]::ExpandEnvironmentVariables([string]$cfg.installDir)
            if ($expanded) { $installRoot = $expanded }
        }
        if ($cfg.ports -and $cfg.ports.screen) { $screenPort = [int]$cfg.ports.screen }
        if ($cfg.enableWebConsole) { $enableWebConsole = [bool]$cfg.enableWebConsole }
    } catch { }
}
# 如果本脚本就在安装目录里跑，以脚本所在目录为准
if (Test-Path -LiteralPath (Join-Path $here 'screen-server.mjs')) { $installRoot = $here }

$injectorDir = Join-Path $env:LOCALAPPDATA 'PaInput'
# 改动（第二轮 P0-2 / I1）：提权注入器现在装在 %ProgramFiles%\PhoneAccessInput（用户不可写），
# 卸载要连这个目录一起清，否则任务删了、文件留在系统目录里。
$pfRootUn = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$inputElevDir = Join-Path $pfRootUn 'PhoneAccessInput'

# ---- 安全闸：禁止对着「源码/开发目录」卸载 -------------------------------------
# 踩过的坑：从产品源码目录（app\）直接跑这个脚本时，上面那行会把 $installRoot 认成 app\，
# 一确认就会把源码资料全删掉。开发目录的特征是同时有打包脚本和源码素材。
$looksLikeDev = $false
foreach ($marker in @('pack.ps1', 'icon-src.svg', 'PACKAGING.md', 'build-sfx.ps1')) {
    if (Test-Path -LiteralPath (Join-Path $installRoot $marker)) { $looksLikeDev = $true; break }
}
if ($looksLikeDev) {
    Write-Host ''
    Write-Host '  [X] 拒绝执行：这个目录看起来是「开发者源码目录」，不是客户机上的安装目录。' -ForegroundColor Red
    Write-Host ('      判定目录：' + $installRoot) -ForegroundColor Red
    Write-Host ''
    Write-Host '      要卸载的安装目录一般是：' -ForegroundColor Yellow
    Write-Host ('        ' + (Join-Path $env:LOCALAPPDATA 'PhoneAccess')) -ForegroundColor Yellow
    Write-Host '      请双击那个目录里的 uninstall.cmd，不要用源码目录里的这份。' -ForegroundColor Yellow
    Write-Host ''
    if (-not $NoPause) { $null = Read-Host '按回车关闭窗口' }
    exit 2
}

Write-Host '  将要删除的位置：'
Write-Host ('    安装目录   ' + $installRoot)
Write-Host ('    注入器目录 ' + $injectorDir)
Write-Host ('   高权限注入器目录 ' + $inputElevDir)
Write-Host ('    桌面文件夹 ' + (Join-Path ([Environment]::GetFolderPath('Desktop')) '轻屏'))
Write-Host '    计划任务   PhoneAccess Autostart / PhoneAccess Input'
Write-Host ('    防火墙规则 PhoneAccess 轻屏 *')
Write-Host ''
if ($RemoveLicence) {
    Warn '你会连许可证一起删除（以后重装需要重新申请，要重新把机器码发给卖家）。'
} else {
    Say '  许可证会保留（重装同一台电脑不用重新申请）。' 'Cyan'
}
Write-Host ''

if (-not $Yes) {
    $ans = Read-Host '  确认卸载请输入 YES（直接回车取消）'
    if ($ans -ne 'YES') {
        Say ''
        Say '  已取消，什么都没改。' 'Gray'
        if (-not $NoPause) { $null = Read-Host '按回车关闭窗口' }
        exit 0
    }
}

# ---- 是否管理员 ----
$isAdmin = $false
try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
if (-not $isAdmin) {
    Say ''
    Warn '需要管理员权限（要删计划任务和防火墙规则）。'
    Say '  请右键这个文件选「以管理员身份运行」，或从「安装器」里再点一次卸载。' 'Yellow'
    if (-not $NoPause) { $null = Read-Host '按回车关闭窗口' }
    exit 1
}

Write-Host ''
Write-Host '-------- 第 1 步 · 停止正在运行的程序' -ForegroundColor Cyan

function Stop-MatchingProcess {
    param([string]$NamePattern, [string]$CmdPattern)
    $killed = 0
    try {
        $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
                ($NamePattern -and $_.Name -match $NamePattern) -or ($CmdPattern -and $_.CommandLine -and $_.CommandLine -match $CmdPattern)
            })
        foreach ($p in $procs) {
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
        }
    } catch { }
    return $killed
}

# 先停守护进程，否则它会马上把画面服务拉回来
$n = Stop-MatchingProcess -CmdPattern 'supervise\.ps1'
if ($n -gt 0) { Ok ('已停止守护进程（' + $n + ' 个）') }

# 画面服务、门、注入器、抓屏、音频
$n = Stop-MatchingProcess -CmdPattern 'screen-server\.mjs'
if ($n -gt 0) { Ok ('已停止画面服务（' + $n + ' 个）') }
$n = Stop-MatchingProcess -CmdPattern 'tunnel-proxy\.mjs'
if ($n -gt 0) { Ok ('已停止转发进程（' + $n + ' 个）') }
# 改动（第二轮 P4-2）：改成按"可执行文件所在目录"杀，不再只按进程名。
# 原来 `-NamePattern '^input\.exe$'` 会把系统上任何同名程序一起杀掉（ai 工具、其他软件都可能叫这名）。
# 也不能照抄 install.ps1 那边"命令行里含安装目录"的做法：提权注入器的命令行是
# `pa-input "C:\Program Files\PhoneAccessInput\input.log"`，根本不含安装目录。
$productDirs = @($installRoot, $injectorDir, $inputElevDir) | Where-Object { $_ }
$killedByPath = 0
try {
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $ep = [string]$_.ExecutablePath
            $ep -and (@($productDirs | Where-Object { $ep.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0)
        })
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killedByPath++ } catch { }
    }
} catch { }
if ($killedByPath -gt 0) { Ok ('已停止本产品目录下的进程（' + $killedByPath + ' 个）') }
Start-Sleep -Seconds 2

Write-Host ''
Write-Host '-------- 第 2 步 · 删除计划任务' -ForegroundColor Cyan
foreach ($taskName in @('PhoneAccess Autostart', 'PhoneAccess Input')) {
    try {
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($t) {
            try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
            Ok ('已删除计划任务：' + $taskName)
        }
    } catch {
        Warn ('删除计划任务失败：' + $taskName + ' — ' + $_.Exception.Message)
    }
}

Write-Host ''
Write-Host '-------- 第 3 步 · 删除防火墙规则' -ForegroundColor Cyan
try {
    $rules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'PhoneAccess*' })
    foreach ($r in $rules) {
        try { Remove-NetFirewallRule -Name $r.Name -ErrorAction Stop; Ok ('已删除规则：' + $r.DisplayName) } catch { }
    }
    if ($rules.Count -eq 0) { Say '  （没有找到本产品的防火墙规则）' 'Gray' }
} catch { Warn '防火墙规则处理失败，可稍后手工删除' }

Write-Host ''
Write-Host '-------- 第 4 步 · 撤销 Defender 排除项' -ForegroundColor Cyan
try {
    $prefs = Get-MpPreference -ErrorAction Stop
    $paths = @($prefs.ExclusionPath)
    $mine = @($paths | Where-Object { $_ -and ($_ -like ($installRoot + '*') -or $_ -like ($injectorDir + '*') -or $_ -like ($inputElevDir + '*')) })
    if ($mine.Count -gt 0) {
        Remove-MpPreference -ExclusionPath $mine -ErrorAction SilentlyContinue
        Ok ('已撤销 ' + $mine.Count + ' 条 Defender 排除项')
    } else {
        Say '  （没有需要撤销的排除项）' 'Gray'
    }
} catch { Say '  （无法读取 Defender 设置，跳过）' 'Gray' }

Write-Host ''
Write-Host '-------- 第 5 步 · 删除桌面文件夹' -ForegroundColor Cyan
$desktopCandidates = @()
try {
    $d = [Environment]::GetFolderPath('Desktop')
    if ($d) { $desktopCandidates += (Join-Path $d '轻屏') }
} catch { }
try {
    $pub = [Environment]::GetFolderPath('CommonDesktopDirectory')
    if ($pub) { $desktopCandidates += (Join-Path $pub '轻屏') }
} catch { }
foreach ($folder in $desktopCandidates) {
    if (Test-Path -LiteralPath $folder) {
        try { Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction Stop; Ok ('已删除：' + $folder) }
        catch { Warn ('删不掉：' + $folder + '（可能还有文件在用）') }
    }
}

Write-Host ''
# 高性能模式（Sunshine/Moonlight，可选组件）：只卸"我们装的"（看 marker），
# 必须在删安装目录之前跑——脚本和 marker 都在安装目录里。
$hpMarker = Join-Path $installRoot 'sunshine-integration.json'
$hpScript = Join-Path $installRoot 'sunshine-integration.ps1'
if ((Test-Path -LiteralPath $hpMarker) -and (Test-Path -LiteralPath $hpScript)) {
    Write-Host '-------- 第 5.5 步 · 卸载高性能模式（Moonlight）' -ForegroundColor Cyan
    try {
        $psExeHp = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        & $psExeHp -NoProfile -ExecutionPolicy Bypass -File $hpScript -Action uninstall -AppDir $installRoot -Quiet
        Ok '高性能模式已卸载（服务 / 防火墙规则 / 配置已清理）'
    } catch {
        Warn ('高性能模式卸载没完成：' + $_.Exception.Message)
        Warn '  可以在「设置 → 应用」里手动卸载 Sunshine；不影响网页模式'
    }
    Write-Host ''
}

Write-Host '-------- 第 6 步 · 删除程序文件' -ForegroundColor Cyan
# 保留许可证：先把它挪到临时目录，删完再放回去
$keepLic = $null
$licPath = Join-Path $installRoot 'licence.json'
if ((Test-Path -LiteralPath $licPath) -and (-not $RemoveLicence)) {
    try {
        $keepLic = Get-Content -LiteralPath $licPath -Raw -Encoding UTF8
        Ok '已备份许可证（卸载后保留）'
    } catch { }
}
if (Test-Path -LiteralPath $installRoot) {
    try {
        Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction Stop
        Ok ('已删除安装目录：' + $installRoot)
    } catch {
        Warn ('有文件删不掉（多在运行中）：' + $_.Exception.Message)
        Warn '  请重启电脑后，再双击一次卸载程序。'
    }
}
if (Test-Path -LiteralPath $injectorDir) {
    try { Remove-Item -LiteralPath $injectorDir -Recurse -Force -ErrorAction Stop; Ok ('已删除注入器目录：' + $injectorDir) }
    catch { Warn ('注入器目录删不掉：' + $_.Exception.Message) }
}
# 高权限注入器目录（Program Files）：任务是第 2 步删的、进程是第 1 步杀的，这里删文件是安全的
if (Test-Path -LiteralPath $inputElevDir) {
    try { Remove-Item -LiteralPath $inputElevDir -Recurse -Force -ErrorAction Stop; Ok ('已删除高权限注入器目录：' + $inputElevDir) }
    catch { Warn ('高权限注入器目录删不掉（可能还在运行）：' + $_.Exception.Message) }
}

# 放回许可证（如果保留）
if ($keepLic -and (-not $RemoveLicence)) {
    try {
        $null = New-Item -ItemType Directory -Path $installRoot -Force
        [System.IO.File]::WriteAllText($licPath, $keepLic, (New-Object System.Text.UTF8Encoding($false)))
        Ok '许可证已保留在安装目录（重新安装后可直接用）'
        Write-Host ('     ' + $licPath) -ForegroundColor Gray
    } catch { Warn '许可证没能保留，如有需要请联系卖家补发' }
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host '  卸载完成' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host ''
Write-Host '  还有两件事它没动（你自己决定要不要处理）：' -ForegroundColor Gray
Write-Host '    · Tailscale 本身（如果你还要用，留着；不用了在「设置 → 应用」里卸载）'
if ($enableWebConsole) {
    Write-Host '    · 控制台桌面程序（本产品只是启动它，没有安装它）'
}
Write-Host ''
Write-Host '  如果桌面图标还在，按 F5 刷新一下桌面。'
Write-Host ''

if (-not $NoPause) { $null = Read-Host '按回车关闭窗口' }
exit 0
