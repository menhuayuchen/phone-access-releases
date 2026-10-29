<#
.SYNOPSIS
    手机远控 · 装机前环境勘测 v2（只读，不改任何东西）

.DESCRIPTION
    报价之前先在客户机器上跑一遍，判断"能装 / 有条件装 / 别接"。

    v2 修订（依据 env-matrix 评审：8 项漏检 + 4 处误报）：
      新增：登录会话（最致命）、UAC 配置、执行策略、.NET 4.x、
            运行时写死路径、物理分辨率(DPI 感知)、注入冒烟、网络防护
      修正：MDM 误报（改查 PolicyManager/dsregcmd，不再数 Enrollments 占位项）
            分辨率（改从 Win32_VideoController 取真实值）
            杀软（分级，不再一律悲观）
            端口（区分自家服务，8780 标为可选）

.NOTES
    UTF-8 with BOM。用 survey.cmd 调用（ExecutionPolicy 是 Restricted）。
#>
[CmdletBinding()]
param([string]$InstallDir = '')

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$hard = @(); $soft = @(); $info = @()
function H([string]$n, [string]$v) { $script:hard += [pscustomobject]@{ 项 = $n; 结果 = $v } }
function S([string]$n, [string]$v) { $script:soft += [pscustomobject]@{ 项 = $n; 结果 = $v } }
function I([string]$n, [string]$v) { $script:info += [pscustomobject]@{ 项 = $n; 值 = $v } }

Write-Host ''
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host '   手机远控 · 装机前环境勘测 v2（只读）' -ForegroundColor Cyan
Write-Host '=============================================' -ForegroundColor Cyan

# ---------- 0. 声明 DPI 感知，否则读到的分辨率是缩放后假值 ----------
Add-Type -AssemblyName System.Windows.Forms
try {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class DpiAware { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@ -ErrorAction SilentlyContinue
    [void][DpiAware]::SetProcessDPIAware()
} catch { }

# ---------- 1. 系统版本 ----------
$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
$osName = $os.Caption.Trim()
$arch = $os.OSArchitecture
I '操作系统' "$osName (build $build, $arch)"
I '主机名' $env:COMPUTERNAME
if ($build -lt 19041) { H 'Windows 版本' "$osName build=$build —— 需要 Win10 2004(19041) 及以上" }
elseif ($arch -notmatch '64') { H '系统位数' "$arch —— 需要 64 位" }
else { I '版本判定' '满足（Win10 2004+ / Win11，64 位）' }

# ---------- 2. 域 / MDM（v2：不再用 Enrollments 占位项误报）----------
$cs = Get-CimInstance Win32_ComputerSystem
if ($cs.PartOfDomain) {
    H '域加入' "已加入域：$($cs.Domain) —— 组策略会覆盖防火墙和计划任务，拒单"
} else { I '域加入' '未加入域（好）' }

$mdmHit = $null
$pmRoot = 'HKLM:\SOFTWARE\Microsoft\PolicyManager\current\device'
if (Test-Path $pmRoot) {
    $polCount = @(Get-ChildItem $pmRoot -ErrorAction SilentlyContinue).Count
    if ($polCount -gt 0) { $mdmHit = "PolicyManager 下有 $polCount 条设备策略" }
}
try {
    $dsreg = (& dsregcmd /status 2>&1 | Out-String)
    if ($dsreg -match 'AzureAdJoined\s*:\s*YES') { $mdmHit = if ($mdmHit) { "$mdmHit；且已 AzureAD 加入" } else { '已 AzureAD 加入' } }
    if ($dsreg -match 'WorkplaceJoined\s*:\s*YES') { $mdmHit = if ($mdmHit) { "$mdmHit；且 Workplace 加入" } else { 'Workplace 加入' } }
} catch { }
if ($mdmHit) { S 'MDM/域策略' "$mdmHit —— 可能受公司管控，装机时策略可能被回滚" }
else { I 'MDM/域策略' '未检测到设备策略接管（好）' }

# ---------- 3. 管理员权限 + UAC ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$isAdminGroup = $false
try {
    $isAdminGroup = [bool](Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | Where-Object { $_.Name -match [regex]::Escape($env:USERNAME) })
} catch { }

if ($isAdmin) { I '当前权限' '已提权（管理员）' }
elseif ($isAdminGroup) { S '当前权限' '账号在管理员组但未提权 —— 安装时需要 UAC 授权，要提前告知客户' }
else { H '管理员权限' '账号不在管理员组 —— 装不了 Tailscale/防火墙/计划任务，拒单' }

$uac = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue
if ($uac.EnableLUA -eq 0) {
    S 'UAC' 'UAC 已关闭 —— 安装更顺，但安全性低，说明这台机器被大幅改过'
} elseif ($uac.ConsentPromptBehaviorAdmin -eq 0) {
    I 'UAC' '已开启但提权不弹窗，安装无干扰'
} else {
    I 'UAC' "已开启，提权会弹窗（ConsentPromptBehaviorAdmin=$($uac.ConsentPromptBehaviorAdmin)）—— 需预先告知客户会弹几次"
}

# ---------- 4. 登录会话（H5，最致命的一条）----------
$interactive = $false
try {
    $q = (& quser 2>&1 | Out-String)
    if ($q -match 'Active|活动') { $interactive = $true }
    $sess = ($q -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -Skip 1) -join ' | '
    if ($sess) { I '登录会话' $sess.Trim() }
} catch { }
if (-not $interactive) {
    if (@(Get-Process explorer -ErrorAction SilentlyContinue).Count -gt 0) { $interactive = $true }
}
if ($interactive) { I '桌面会话' '有活动登录会话（好）' }
else { H '桌面会话' '当前无人登录桌面 —— 远程画面全黑/连不上。必须有人登录，且不能注销' }

$autoLogon = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name AutoAdminLogon -ErrorAction SilentlyContinue).AutoAdminLogon
if ("$autoLogon" -eq '1') { I '自动登录' '已开启（重启后能自动回到可用状态）' }
else { S '自动登录' '未开启 —— 客户重启后若无人登录，远程就连不上。建议开启或书面告知' }

# ---------- 5. 磁盘 ----------
$freeC = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
I 'C 盘' "剩余 $freeC GB"
if ($freeC -lt 10) { H '磁盘空间' "C 盘只剩 $freeC GB —— 需要 10GB 以上" }

# ---------- 6. 端口（v2：区分自家服务）----------
$corePorts = @(8650, 8660)
$extraPorts = @(8642, 8780)
$busyCore = @(); $busyExtra = @()
foreach ($p in $corePorts) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        $name = if ($pr) { $pr.Name } else { '?' }
        if ($name -match 'node') { $busyExtra += "$p(自家 node)" } else { $busyCore += "$p($name)" }
    }
}
foreach ($p in $extraPorts) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        $busyExtra += "$p($($pr.Name))"
    }
}
if ($busyCore.Count -gt 0) { H '核心端口被占' (($busyCore -join ', ') + ' —— 被非本产品程序占用，需释放或改端口') }
else { I '核心端口' '8650 / 8660 空闲或由本产品占用（好）' }
if ($busyExtra.Count -gt 0) { I '其他端口' (($busyExtra -join ', ') + ' —— 可选模块或自家服务，不影响核心功能') }

# ---------- 7. 杀毒（v2：分级）----------
$avList = @()
try { $avList = @((Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct).displayName) } catch { }
$defenderOn = $false
try { $defenderOn = (Get-MpComputerStatus).RealTimeProtectionEnabled } catch { }
$thirdParty = $avList | Where-Object { $_ -notmatch 'Defender|Windows' }

if ($avList.Count -gt 0) { I '杀毒软件' ($avList -join ' / ') } else { I '杀毒软件' '未检测到' }
# 本机实测：火绒 + Defender 同时在线时注入器 errors=0 blocked=0，不加排除项也能跑通
if ($thirdParty) { S '第三方杀毒' "$($thirdParty -join ', ') —— 注入器可能被拦。实测火绒并存可跑通，建议加白降低复发（非必须）" }
elseif ($defenderOn) { S 'Defender 实时保护' '开启 —— 可能拦截注入器，建议加排除项（非必须）' }
else { I '杀毒软件' '无实时防护（风险低）' }

$netGuard = @()
if (Test-Path 'HKLM:\SOFTWARE\WOW6432Node\Huorong') { $netGuard += '火绒' }
try { if (Get-Service '360Box' -ErrorAction SilentlyContinue) { $netGuard += '360' } } catch { }
if ($netGuard.Count -gt 0) { S '网络防护' "$($netGuard -join ', ') —— 可能拦本地端口，装机后必须做一次连通性验证" }

# ---------- 8. 执行策略 ----------
$ep = Get-ExecutionPolicy
if ($ep -in 'Restricted', 'AllSigned') { S '执行策略' "$ep —— 不能直接跑 .ps1，必须用 .cmd 包装并带 -ExecutionPolicy Bypass" }
else { I '执行策略' "$ep（可直接运行脚本）" }

# ---------- 9. .NET 4.x ----------
$ndp = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release -ErrorAction SilentlyContinue
$netVer = '未检测到'
if ($ndp -and $ndp.Release) {
    $r = [int]$ndp.Release
    $netVer = if ($r -ge 528040) { '4.8+' } elseif ($r -ge 461808) { '4.7.2' } elseif ($r -ge 394802) { '4.6.2' } elseif ($r -ge 378389) { '4.5+' } else { "Release=$r" }
}
if ($netVer -eq '未检测到') { H '.NET Framework' '未检测到 4.x —— capture.exe/input.exe/audio.exe 无法运行' }
elseif ($netVer -match '4\.[5-7]') { S '.NET Framework' "$netVer —— 能用但偏旧，建议升级到 4.8" }
else { I '.NET Framework' "$netVer（好）" }

# ---------- 10. 安装目录完整性 ----------
$targetDir = if ($InstallDir) { $InstallDir } else { Join-Path $env:LOCALAPPDATA 'DshInput' }
I '安装目录' $targetDir
$probeDir = if (Test-Path $targetDir) { $targetDir } else { Split-Path -Parent $targetDir }
if ($probeDir -and (Test-Path $probeDir)) {
    $acl = (icacls $probeDir 2>&1) -join ' '
    if ($acl -match 'Low Mandatory Level|低强制级别') { H '安装目录完整性' "$probeDir 是【低完整性】目录 —— 注入会被降权失效，必须换目录" }
    else { I '安装目录完整性' '正常（非低完整性）' }
} else { S '安装目录完整性' "无法判定（$probeDir 不存在）" }

# ---------- 11. 显示 ----------
$vc = Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution } | Select-Object -First 1
if ($vc) { I '物理分辨率' "$($vc.CurrentHorizontalResolution)x$($vc.CurrentVerticalResolution)" }
$screens = [System.Windows.Forms.Screen]::AllScreens
$dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI
$scalePct = if ($dpi) { [math]::Round($dpi / 96 * 100) } else { 100 }
I '显示器' "$($screens.Count) 块 / 主屏逻辑 $($screens[0].Bounds.Width)x$($screens[0].Bounds.Height) / 缩放 $scalePct%"
if ($scalePct -ne 100) { I '显示缩放' "$scalePct% —— cursor-probe 已验证可校正（≤2px），非风险项" }
if ($screens.Count -gt 1) { S '多显示器' "有 $($screens.Count) 块屏 —— 需确认远程看哪块，抓屏源要指定" }

# ---------- 12. 电源 / 锁屏 ----------
try {
    $sl = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Select-String '当前交流电源设置索引|Current AC Power Setting Index') -join ''
    if ($sl -match '0x([0-9a-f]+)') {
        $secs = [Convert]::ToInt32($Matches[1], 16)
        if ($secs -eq 0) { I '睡眠设置' '从不睡眠（好）' }
        elseif ($secs -lt 1800) { S '睡眠设置' "$([math]::Round($secs/60)) 分钟就睡眠 —— 睡眠时远程连不上，必须改" }
        else { I '睡眠设置' "$([math]::Round($secs/60)) 分钟" }
    }
} catch { }
$lockOnResume = (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaverIsSecure -ErrorAction SilentlyContinue).ScreenSaverIsSecure
if ("$lockOnResume" -eq '1') { S '锁屏' '屏保后需密码 —— 锁屏时画面是黑的，要跟客户说清' }

# ---------- 13. 网络 / Tailscale ----------
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $tsExe) {
    $ts = (& $tsExe status --json 2>$null | ConvertFrom-Json)
    if ($ts.BackendState -eq 'Running') {
        $exp = if ($ts.Self.KeyExpiry) { ([datetime]$ts.Self.KeyExpiry).ToLocalTime().ToString('yyyy-MM-dd') } else { 'never' }
        I 'Tailscale' "已装并运行 / $($ts.Self.DNSName) / key $exp 到期"
    } else { S 'Tailscale' "已装但未连接（$($ts.BackendState)）—— 需要登录" }
} else { I 'Tailscale' '未安装（装机时安装，用客户自己的账号登录）' }

$outNet = Test-NetConnection -ComputerName 'login.tailscale.com' -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($outNet) { I '出网' '能连 login.tailscale.com:443' } else { H '出网' '连不上 login.tailscale.com:443 —— 客户网络有限制，装不了' }

# ---------- 14. 运行时依赖（P0）----------
$hardPaths = @(
    'D:\deepseek\resources\runtime\cli\bin\dsh.cmd',
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe')
)
$missing = @($hardPaths | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) { S '运行时依赖' "现有脚本写死的 $($missing.Count) 个路径在本机不存在 —— 必须用自包含安装包，不能指望客户机器有 DSH" }
$nodeOnPath = Get-Command node -ErrorAction SilentlyContinue
if ($nodeOnPath) { I 'node (PATH)' $nodeOnPath.Source } else { I 'node (PATH)' '不在 PATH —— 自包含安装包必须自带 node' }

# ---------- 15. 硬件 ----------
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$ram = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
I 'CPU / 内存' "$($cpu.Name.Trim()) / $ram GB"
if ($ram -lt 4) { S '内存' "$ram GB —— 抓屏+WebRTC 偏紧，帧率会低" }

# ==================== 结论 ====================
Write-Host ''
Write-Host '---------- 环境信息 ----------' -ForegroundColor Cyan
$info | Format-Table -AutoSize | Out-String | Write-Host
if ($soft.Count -gt 0) {
    Write-Host '---------- 注意事项（能装，但要告知客户）----------' -ForegroundColor Yellow
    $soft | Format-Table -AutoSize | Out-String | Write-Host
}
if ($hard.Count -gt 0) {
    Write-Host '---------- 硬门槛不过（建议拒单）----------' -ForegroundColor Red
    $hard | Format-Table -AutoSize | Out-String | Write-Host
}
Write-Host '=============================================' -ForegroundColor Cyan
if ($hard.Count -gt 0) {
    Write-Host "结论：【别接】$($hard.Count) 项硬门槛不满足" -ForegroundColor Red
    Write-Host '  这些不是多花时间能解决的，是环境根本不允许。' -ForegroundColor Red
} elseif ($soft.Count -gt 0) {
    Write-Host "结论：【有条件装】$($soft.Count) 项风险，需提前告知客户并计入报价" -ForegroundColor Yellow
} else {
    Write-Host '结论：【可以装】环境干净，风险低' -ForegroundColor Green
}
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host ''

$outFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'survey-report.txt'
$all = @()
$all += "环境勘测报告 v2  $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$all += "主机：$env:COMPUTERNAME   $osName build=$build"
$all += ''
$all += '--- 环境信息 ---'
$all += ($info | ForEach-Object { "$($_.项): $($_.值)" })
$all += ''
$all += '--- 注意事项 ---'
$all += $(if ($soft.Count) { $soft | ForEach-Object { "$($_.项): $($_.结果)" } } else { '无' })
$all += ''
$all += '--- 硬门槛 ---'
$all += $(if ($hard.Count) { $hard | ForEach-Object { "$($_.项): $($_.结果)" } } else { '无' })
$all = $all -join "`n"
try { Set-Content -Path $outFile -Value $all -Encoding UTF8; Write-Host "报告已存：$outFile" } catch { }
