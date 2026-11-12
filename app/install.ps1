# install.ps1 — 轻屏控制（基础档）· 客户版安装器
#
# 目标环境：Windows 10 2004+ / Windows 11，64 位，Windows PowerShell 5.1
# 入口：install.cmd（客户双击）→ 本脚本
#
# 设计原则（每一条都对应需求里的一句硬要求）：
#   1) 可重入：每一步先检查"是否已经做好"，装一半失败再跑一次能接着装，不会因为"已经装过"报错退出。
#   2) 人话进度：客户看到的是"正在检查这台电脑…"，不是命令与错误码。
#   3) 失败可自查：任何一步失败，立刻说清"哪一步没成、为什么、你现在该做什么"，
#      并在桌面生成一份可以直接发给卖家的 txt 报告（报告里不含密钥/网址）。
#   4) 提权只弹一次：安装器自己申请管理员权限（一次 UAC），之后的防火墙、计划任务都在同一个提权进程里做。
#      客户点了"否"要能看懂、要知道重新双击就行，且要明确告诉客户"什么都没改"。
#   5) 不写死：路径/端口读 product.config.json（复用 product-config.ps1），
#      客户机首次安装现场生成 32 位十六进制新密钥，绝不沿用卖家的 screen.key。
#   6) 可干跑：-DryRun 只检查、不落地、不提权、不启动服务（生产机正在跑的系统不能被安装器影响）。
#
# 重要：本文件必须保存为 UTF-8 带 BOM（PS 5.1 读无 BOM 的中文 .ps1 会按 ANSI 解析，直接语法报错）。

param(
  [switch]$DryRun,          # 干跑：只检查、不落地、不提权、不启动任何服务
  [switch]$NoPause,         # 结束时不等待"按回车"（给自动化用；客户双击入口不会传这个参数）
  # 2026-11-09：给 GUI 外壳用的非交互模式。只影响"等用户按键"，不改任何安装判定逻辑。
  #   · "按回车键关闭窗口" 类结束等待 → 直接跳过，不留窗口
  #   · Tailscale 未安装等待 → 不再无限等（重试一次就判定，装不上照样报错）
  #   · Tailscale 登录等待 → 不再等（本来就可以"先继续装，装完再登录"）
  [switch]$NonInteractive,
  [switch]$SkipSelfCheck,   # 跳过最后的客户自检（排查安装器自身时用）
  [switch]$SkipDefender,    # 不添加 Windows Defender 排除项
  [switch]$SkipHighPerformance, # 跳过「高性能模式」（Sunshine/Moonlight，可选组件）
[switch]$HighPerformance,       # 显式选择安装高性能组件（Sunshine/Moonlight，可选；无网络自动跳过）
  [string]$SourceDir = '',  # 安装包所在目录（默认=本脚本所在目录；测试/打包校验时可指定）
  [string]$InstallTo = '',  # 安装到哪个目录（默认读 product.config.json 的 installDir）
  # 改动（独立审查 L5）：记录"发起安装的那个账号"，提权后拿来比对。
  # 客户如果在 UAC 里输入了**另一个管理员账号**的密码，提权后的进程就是那个账号，
  # %LOCALAPPDATA%、桌面、计划任务全部落在别人名下——客户装完什么都看不到，
  # 而原来的 Test-CurrentUserInAdminGroup 在查不到时会放行，等于静默走错。
  [string]$OriginalUser = ''
)

$ErrorActionPreference = 'Stop'
# 控制台按 UTF-8 输出：本文件是 UTF-8 带 BOM，中文提示才能正常显示
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# ---------------------------------------------------------------------------
# 0. 全局状态
# ---------------------------------------------------------------------------
$script:AppTitle      = '轻屏控制'
$script:InstallerVer  = '1.0'
$script:DryRunMode    = [bool]$DryRun
$script:NoPauseMode   = [bool]$NoPause
$script:NonInteractive = [bool]$NonInteractive
$script:LogLines      = New-Object System.Collections.ArrayList
$script:Warnings      = New-Object System.Collections.ArrayList
$script:CurrentStepNo = 0
$script:CurrentStep   = '(启动)'
$script:SelfReportPath = ''
$script:SelfVerdict   = ''
# 高性能模式（Moonlight/Sunshine，可选组件）的结果，写进安装完成报告
$script:HpState       = ''

$script:ScriptPath = $PSCommandPath
if (-not $script:ScriptPath) { $script:ScriptPath = $MyInvocation.MyCommand.Path }
$script:ScriptDir = $PSScriptRoot
if (-not $script:ScriptDir) { $script:ScriptDir = Split-Path -Parent $script:ScriptPath }

# ---------------------------------------------------------------------------
# 1. 输出与日志（客户看到的一切都从这里出）
# ---------------------------------------------------------------------------
function Add-Log {
  param([string]$Text)
  if ($null -ne $Text) { [void]$script:LogLines.Add([string]$Text) }
}

function Write-Banner {
  Write-Host ''
  Write-Host '============================================================' -ForegroundColor Cyan
  Write-Host ('   轻屏控制 · 安装程序  v' + $script:InstallerVer) -ForegroundColor Cyan
  Write-Host '   给不懂技术的你：全程跟着屏幕提示走就行。' -ForegroundColor Cyan
  Write-Host '   大约 5 分钟（装 Tailscale 那一步要看你的网速）。' -ForegroundColor Cyan
  Write-Host '============================================================' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '如果这个窗口一闪就没了，说明双击的不是安装文件。' -ForegroundColor Yellow
  Write-Host '请回到安装文件夹，双击 install.cmd（或“安装轻屏.cmd”）重新来一次。' -ForegroundColor Yellow
}

function Write-Section {
  param([string]$Text)
  Write-Host ''
  Write-Host ('-------- ' + $Text) -ForegroundColor Cyan
  Add-Log ('[步骤] ' + $Text)
  # 2026-11-08：每一步立即写进度文件。以前"卡在第 10 步然后关窗口"什么都不留，客户也找不到安装报告。
  try {
    $progDir = if ($script:InstallRoot) { $script:InstallRoot } else { $env:TEMP }
    if (-not (Test-Path -LiteralPath $progDir)) { New-Item -ItemType Directory -Path $progDir -Force | Out-Null }
    ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text) |
      Out-File -LiteralPath (Join-Path $progDir 'install-progress.log') -Append -Encoding utf8
  } catch { }
}

function Write-Ok {
  param([string]$Text)
  Write-Host ('  [OK] ' + $Text) -ForegroundColor Green
  Add-Log ('  [OK] ' + $Text)
}

function Write-Note {
  param([string]$Text)
  Write-Host ('  [..] ' + $Text)
  Add-Log ('  [..] ' + $Text)
}

function Write-WarnLine {
  param([string]$Text)
  Write-Host ('  [!] ' + $Text) -ForegroundColor Yellow
  Add-Log ('  [!] ' + $Text)
  [void]$script:Warnings.Add([string]$Text)
}

function Write-BadLine {
  param([string]$Text)
  Write-Host ('  [X] ' + $Text) -ForegroundColor Red
  Add-Log ('  [X] ' + $Text)
}

# ---------------------------------------------------------------------------
# 2. 路径/身份小工具
# ---------------------------------------------------------------------------
function Test-IsAdmin {
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# 客户当前账号在不在本机管理员组里。
# 不在的话 UAC 会要求输入"另一个管理员账号的密码"，那样装出来的东西会落在别人账号下，
# 所以必须先拦住，而不是等客户在 UAC 里乱输。
function Test-CurrentUserInAdminGroup {
  try {
    $sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    $members = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop)
    foreach ($m in $members) {
      if ($m -and $m.SID -and ([string]$m.SID.Value) -eq $sid) { return $true }
    }
    return $false
  } catch {
    # 改动（独立审查 L5）：原来这里直接 return $true 放行（怕系统差异挡住正常客户）。
    # 放行本身可以接受，但**不能静默**：把"查不到"明确说出来，客户在 UAC 里
    # 输入别人账号密码时才有机会被点醒。真正的账号不一致由 -OriginalUser 比对兜底。
    Write-Host '    [..] 无法确认当前账号是否在本机管理员组（系统差异），继续安装。' -ForegroundColor Yellow
    Write-Host '         如果接下来 UAC 要求你输入**别人**的账号密码，请点取消——那样装完你自己看不到图标。' -ForegroundColor Yellow
    return $true
  }
}

function Get-PowerShellExe {
  $p = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path -LiteralPath $p) { return $p }
  return 'powershell.exe'
}

function Get-CurrentUserName {
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity -and $identity.Name) { return [string]$identity.Name }
  } catch { }
  if ($env:USERNAME) { return [string]$env:USERNAME }
  return '（读不到）'
}

# 桌面路径（部分客户的桌面被重定向到 D 盘，所以不能用 %USERPROFILE%\Desktop 猜）
function Get-DesktopDir {
  try {
    $d = [Environment]::GetFolderPath('Desktop')
    if ($d -and (Test-Path -LiteralPath $d)) { return $d }
  } catch { }
  if ($env:USERPROFILE) {
    $d2 = Join-Path $env:USERPROFILE 'Desktop'
    if (Test-Path -LiteralPath $d2) { return $d2 }
  }
  return ''
}

# 这个目录能不能真的写文件（建目录 + 写探针 + 删探针）
function Test-DirWritable {
  param([string]$Dir)
  if (-not $Dir) { return $false }
  try {
    if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Path $Dir -Force -ErrorAction Stop | Out-Null }
    $probe = Join-Path $Dir ('.pa-write-test-' + [guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllText($probe, 'x')
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $true
  } catch { return $false }
}

# 改动（虚拟机实测暴露的问题）：原来只用用户桌面，一旦它取不到/写不进，
# 快捷方式全部静默失败，客户装完桌面上什么都没有，等于安装失败。
# 现在按 用户桌面 → 公共桌面 → 安装目录 三级兜底，并记录最终用了哪个。
# 公共桌面（C:\Users\Public\Desktop）对任何登录用户都可见，是很好的第二选择。
function Get-AccessFolder {
  if ($script:AccessFolderCache) { return $script:AccessFolderCache }
  $cands = New-Object System.Collections.ArrayList
  $ud = Get-DesktopDir
  if ($ud) { [void]$cands.Add((Join-Path $ud '轻屏')) }
  try {
    $pub = [Environment]::GetFolderPath('CommonDesktopDirectory')
    if ($pub -and (Test-Path -LiteralPath $pub)) { [void]$cands.Add((Join-Path $pub '轻屏')) }
  } catch { }
  # 最后兜底：安装目录下（客户至少能在「轻屏」文件夹里找到）
  # 注意 InstallRoot 在安装早期可能还没赋值（那时就要写失败报告），必须判空，否则 Join-Path 会抛错
  if ($script:InstallRoot) {
    [void]$cands.Add((Join-Path $script:InstallRoot '桌面快捷方式'))
  }
  if ($cands.Count -eq 0) {
    # 连临时目录兜底也进不去（极端情况）：退回临时目录，别让上层拿到空值
    [void]$cands.Add((Join-Path $env:TEMP '轻屏'))
  }

  foreach ($c in $cands) {
    if (Test-DirWritable $c) {
      $script:AccessFolderCache = $c
      $script:AccessFolderReason = if ($c -eq (Join-Path $ud '轻屏')) { '用户桌面' } else { '备用位置:' + $c }
      return $c
    }
  }
  # 全失败也别返回空：至少给个路径，让上层能记录原因
  $script:AccessFolderCache = $cands[0]
  $script:AccessFolderReason = '全部不可写'
  return $cands[0]
}

function Get-AccessReportDir {
  $d = Join-Path (Get-AccessFolder) '报告'
  try {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  } catch { }
  return $d
}

# 找一个确实能写文件的目录（产品文件夹优先 → 桌面根 → 临时目录兜底），报告要放在客户找得到的地方
function Get-WritableReportDir {
  $candidates = New-Object System.Collections.ArrayList
  [void]$candidates.Add((Get-AccessReportDir))
  [void]$candidates.Add((Get-DesktopDir))
  if ($env:USERPROFILE) { [void]$candidates.Add((Join-Path $env:USERPROFILE 'Desktop')) }
  [void]$candidates.Add($env:TEMP)
  foreach ($d in $candidates) {
    if (-not $d) { continue }
    try {
      if (-not (Test-Path -LiteralPath $d)) { continue }
      $probe = Join-Path $d ('pa-write-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
      [System.IO.File]::WriteAllText($probe, 'x')
      Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
      return $d
    } catch { }
  }
  return $env:TEMP
}

# ---------------------------------------------------------------------------
# 3. 报告（失败时要能直接发给卖家；报告里绝不能出现密钥、token、完整网址）
# ---------------------------------------------------------------------------
function Get-EnvironmentSnapshot {
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add('时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  [void]$lines.Add('电脑名：' + [string]$env:COMPUTERNAME)
  [void]$lines.Add('当前用户：' + (Get-CurrentUserName))
  if (Test-IsAdmin) { [void]$lines.Add('当前权限：管理员（已提权）') } else { [void]$lines.Add('当前权限：普通用户（未提权）') }
  [void]$lines.Add('PowerShell：' + $PSVersionTable.PSVersion.ToString())
  try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    [void]$lines.Add('Windows：' + [string]$os.Caption + ' / build ' + [string]$os.BuildNumber + ' / ' + [string]$os.OSArchitecture)
  } catch { [void]$lines.Add('Windows：读不到') }
  [void]$lines.Add('安装来源：' + $script:SourceDirFull)
  [void]$lines.Add('安装目录：' + $script:InstallRoot)
  [void]$lines.Add('安装目录是否已存在：' + [string](Test-Path -LiteralPath $script:InstallRoot))
  try {
    $rootDrive = [System.IO.Path]::GetPathRoot($script:InstallRoot)
    $driveName = $rootDrive.TrimEnd('\').TrimEnd(':')
    $drv = Get-PSDrive -Name $driveName -ErrorAction Stop
    $drvFreeText = [string][math]::Round($drv.Free / 1GB, 1)
    [void]$lines.Add('安装盘剩余：' + $drvFreeText + ' GB（' + $driveName + ':）')
  } catch { }
  try {
    $nodeRel = Join-Path $script:InstallRoot 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $nodeRel)) { $nodeRel = Join-Path $script:SourceDirFull 'runtime\node.exe' }
    if (Test-Path -LiteralPath $nodeRel) {
      $ver = ''
      try { $ver = (& $nodeRel --version 2>$null | Select-Object -First 1) } catch { $ver = '' }
      [void]$lines.Add('自带 node 运行时：' + [string]$ver)
    } else {
      [void]$lines.Add('自带 node 运行时：不存在')
    }
  } catch { }
  try {
    $cfgForSnap = $null
    if (Test-Path -LiteralPath (Join-Path $script:InstallRoot 'product-config.ps1')) {
      $cfgForSnap = Get-ProductConfig -AppDir $script:InstallRoot
    } elseif ($script:ConfigSource) {
      $cfgForSnap = $script:ConfigSource
    }
    if ($cfgForSnap) {
      $tsRes = Resolve-ProductRuntime -AppDir $script:InstallRoot -Name 'tailscale' -Config $cfgForSnap -WellKnownDirs (Get-TailscaleWellKnownDirs)
      $tsInfo = Get-TailscaleInfo -TailscaleExe $tsRes.Path
      [void]$lines.Add('Tailscale：' + $(if ($tsRes.Path) { '已安装' } else { '未安装' }) + ' / 已连接=' + [string]$tsInfo.Running + ' / 私有地址=' + (Get-SafeText ($tsInfo.Ip)))
      $portsToSnap = @([int]$cfgForSnap.ports.screen)
      if ($cfgForSnap.enableDsh) { $portsToSnap += [int]$cfgForSnap.ports.door }
      foreach ($p in $portsToSnap) {
        $c = Test-ProductPortConflict -Port $p -OwnPattern 'screen-server\.mjs|tunnel-proxy\.mjs'
        if ($c) { [void]$lines.Add('端口 ' + $p + '：被占用（' + (Get-SafeText $c.Name) + ' pid=' + [string]$c.Pid + '）') }
        else { [void]$lines.Add('端口 ' + $p + '：空闲（或已由本产品自己占用）') }
      }
    }
  } catch { }
  try {
    $task = Get-ScheduledTask -TaskName 'DSH Phone Access' -ErrorAction SilentlyContinue
    [void]$lines.Add('计划任务「DSH Phone Access」：' + $(if ($task) { [string]$task.State } else { '不存在' }))
    $task2 = Get-ScheduledTask -TaskName 'DSH Input Injector' -ErrorAction SilentlyContinue
    [void]$lines.Add('计划任务「DSH Input Injector」：' + $(if ($task2) { [string]$task2.State } else { '不存在' }))
  } catch { }
  return $lines.ToArray()
}

# 把可能带密钥的字符串（比如完整网址）裁掉，只留安全的片段
function Get-SafeText {
  param([string]$Text)
  if (-not $Text) { return '（空）' }
  $s = [string]$Text
  if ($s -match 'https?://') { return '（网址已隐藏）' }
  # 改动（第二轮 P4-3）：这份报告默认是"客户直接发给卖家"的，内网 / tailnet 的裸 IP
  # 没必要出现在里面（它本身不是密钥，但也不需要外传）。回环 127.0.0.1 保留——诊断要用，
  # 而且它不指向任何真实地址。原来只挡了 http(s):// 的网址，裸 IP 会原样打印。
  try {
    $s = [regex]::Replace($s, '\b\d{1,3}(?:\.\d{1,3}){3}\b', {
        param($m)
        $ip = $m.Value
        if ($ip.StartsWith('127.')) { return $ip }
        return '<IP已隐藏>'
      })
  } catch { }
  if ($s.Length -gt 80) { $s = $s.Substring(0, 80) + '…' }
  return $s
}

function Save-InstallReport {
  param(
    [string]$Kind = '失败',                 # 失败 / 完成
    [string]$Reason = '',
    [string]$Advice = '',
    [string]$Tech = ''
  )
  try {
    $dir = Get-WritableReportDir
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $fileName = '安装完成报告-' + $stamp + '.txt'
    if ($Kind -eq '失败') { $fileName = '安装失败报告-' + $stamp + '.txt' }
    $path = Join-Path $dir $fileName

    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add('轻屏控制 · ' + $(if ($Kind -eq '失败') { '安装失败报告' } else { '安装完成报告' }))
    [void]$lines.Add(('=' * 60))
    [void]$lines.Add('这份文件可以直接发给卖家（微信里“发送文件”），里面不含登录密钥、网址和密码。')
    if ($Kind -eq '失败') {
      [void]$lines.Add('')
      [void]$lines.Add('哪一步没成：第 ' + [string]$script:CurrentStepNo + ' 步 · ' + $script:CurrentStep)
      [void]$lines.Add('原因：' + $(if ($Reason) { $Reason } else { '（没有记录到具体原因）' }))
      if ($Tech) { [void]$lines.Add('技术细节：' + $Tech) }
      [void]$lines.Add('')
      [void]$lines.Add('你现在该做什么：')
      if ($Advice) {
        foreach ($line in ($Advice -split "`n")) { [void]$lines.Add('  ' + $line.Trim()) }
      } else {
        [void]$lines.Add('  把这份文件发给卖家，并告诉卖家你是在第几步看到这句话的。')
      }
    } else {
      [void]$lines.Add('')
      [void]$lines.Add('安装结果：完成')
      [void]$lines.Add('自检结论：' + $(if ($script:SelfVerdict) { $script:SelfVerdict } else { '（没有运行）' }))
      if ($script:HpState) { [void]$lines.Add('高性能模式（Moonlight）：' + [string]$script:HpState) }
      if ($script:SelfReportPath) { [void]$lines.Add('自检报告：' + $script:SelfReportPath) }
      if ($script:Warnings.Count -gt 0) {
        [void]$lines.Add('')
        [void]$lines.Add('安装过程中的提醒（不影响使用，建议顺手看了一眼）：')
        foreach ($w in $script:Warnings) { [void]$lines.Add('  · ' + [string]$w) }
      }
      [void]$lines.Add('')
      [void]$lines.Add('接下来你要做 3 件事：')
      [void]$lines.Add('  1) 手机上装 Tailscale 并登录（卖家会一步步教你）')
      [void]$lines.Add('  2) 关掉电脑自动睡眠：设置 → 系统 → 电源 → 屏幕和睡眠 → 两个都选“从不”')
      [void]$lines.Add('  3) 用手机扫一下二维码（或输入网址），确认能看到画面、点得动、能打字')
      [void]$lines.Add('  然后重启一次电脑，再连一次；重启后还能连，才算真的装好。')
    }
    [void]$lines.Add('')
    [void]$lines.Add(('-' * 60))
    [void]$lines.Add('环境快照（卖家排查用）')
    foreach ($l in (Get-EnvironmentSnapshot)) { [void]$lines.Add('  ' + [string]$l) }
    [void]$lines.Add('')
    [void]$lines.Add(('-' * 60))
    [void]$lines.Add('安装过程记录（最后 80 行）')
    $logArr = @($script:LogLines)
    $from = [math]::Max(0, $logArr.Count - 80)
    for ($i = $from; $i -lt $logArr.Count; $i++) { [void]$lines.Add('  ' + [string]$logArr[$i]) }
    [void]$lines.Add('')
    [void]$lines.Add('（报告结束）')

    $text = (($lines | ForEach-Object { [string]$_ }) -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($true)))
    return $path
  } catch {
    return ''
  }
}

# ---------------------------------------------------------------------------
# 4. 失败：说清"哪一步没成、为什么、你现在该做什么"，并生成报告
# ---------------------------------------------------------------------------
function Fail-Install {
  param(
    [string]$Reason,
    [string]$Advice = '',
    [string]$Tech = ''
  )
  if ($script:DryRunMode) {
    Write-Host ''
    Write-BadLine ('干跑：正式安装会在这里停下来 —— ' + $Reason)
    if ($Tech) { Write-Host ('       技术细节：' + $Tech) }
    if ($Advice) {
      Write-Host '       正式安装时会给客户的提示：'
      foreach ($line in ($Advice -split "`n")) { Write-Host ('         ' + $line.Trim()) }
    }
    Write-Host ''
    Write-Host '（干跑模式没有改动任何东西：没复制文件、没改防火墙、没注册任务、没启动服务）'
    Write-Host '干跑结论：发现问题。正式安装会在这一步失败。'
    exit 2
  }

  Write-Host ''
  Write-Host '============================================================' -ForegroundColor Red
  Write-Host '  安装没有完成' -ForegroundColor Red
  Write-Host '============================================================' -ForegroundColor Red
  Write-Host ''
  Write-Host ('  哪一步没成：第 ' + [string]$script:CurrentStepNo + ' 步 · ' + $script:CurrentStep) -ForegroundColor Yellow
  Write-Host ('  原因：' + $Reason)
  if ($Tech) { Write-Host ('  技术细节：' + $Tech) }
  Write-Host ''
  if ($Advice) {
    Write-Host '  你现在该做什么：' -ForegroundColor Yellow
    foreach ($line in ($Advice -split "`n")) { Write-Host ('    ' + $line.Trim()) }
    Write-Host ''
  }

  $reportPath = Save-InstallReport -Kind '失败' -Reason $Reason -Advice $Advice -Tech $Tech
  if ($reportPath) {
    Write-Host '  如果照做还是不行：' -ForegroundColor Yellow
    Write-Host '    把「轻屏\报告」里这个文件直接发给卖家（微信里选“发送文件”）：' -ForegroundColor Yellow
    Write-Host ('      ' + $reportPath) -ForegroundColor White
    Write-Host '    不用截图，也不用自己解释；这个文件里有卖家需要的信息。' -ForegroundColor Yellow
  } else {
    Write-Host '  报告文件没能生成。请把屏幕上最后 3 行内容截图发给卖家。' -ForegroundColor Yellow
  }
  Write-Host ''
  Write-Host '  已经装好的部分不会白装：修好这个问题后重新双击安装文件，会接着装，不会从头再来。'

  # 第 4 步复制前会暂停旧的自动启动任务（防止它在复制时把旧进程拉起来）。
  # 如果这次安装失败在半路，要尽量把它恢复回去，别把客户原来能用的东西弄停。
  try {
    $taskAfterFail = Get-ScheduledTask -TaskName 'DSH Phone Access' -ErrorAction SilentlyContinue
    if ($taskAfterFail -and [string]$taskAfterFail.State -eq 'Disabled') {
      Enable-ScheduledTask -TaskName 'DSH Phone Access' -ErrorAction SilentlyContinue | Out-Null
      Write-Host '  （已把原来的自动启动任务恢复回去，避免你原来能用的东西停掉。）'
    }
  } catch { }

  Write-Host ''
  if (-not $script:NoPauseMode -and -not $script:NonInteractive) { $null = Read-Host '按回车键关闭窗口' }
  exit 3
}

# ---------------------------------------------------------------------------
# 5. UAC 提权（整个安装只弹一次）
# ---------------------------------------------------------------------------
function Request-Elevation {
  Write-Host ''
  Write-Host '安装需要管理员权限（要改防火墙、注册开机自启、放行程序）。' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '马上会弹出一个系统窗口，问你：' -ForegroundColor Yellow
  Write-Host '    “你要允许此应用对你的设备进行更改吗？”' -ForegroundColor White
  Write-Host ''
  Write-Host '请点【是】。整个安装过程只会弹这一次。' -ForegroundColor Yellow
  Write-Host '如果点了【否】：电脑上什么都不会改（没装东西、没改设置），重新双击安装文件就行。' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '（这个窗口会在新窗口打开后自动关掉，不是安装失败。）'
  Write-Host ''
  Start-Sleep -Seconds 3

  $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $script:ScriptPath + '"'
  # 把发起安装的账号传进提权后的实例，用来检测"用别人账号过了 UAC"（独立审查 L5）
  $argLine += ' -OriginalUser "' + $env:USERDOMAIN + '\' + $env:USERNAME + '"'
  if ($script:SourceDirFull -ne [System.IO.Path]::GetFullPath($script:ScriptDir).TrimEnd('\')) {
    $argLine += ' -SourceDir "' + $script:SourceDirFull + '"'
  }
  if ($InstallTo) { $argLine += ' -InstallTo "' + $InstallTo + '"' }
  if ($SkipSelfCheck) { $argLine += ' -SkipSelfCheck' }
  if ($SkipDefender) { $argLine += ' -SkipDefender' }
  if ($script:NoPauseMode) { $argLine += ' -NoPause' }

  $launched = $false
  try {
    $psExe = Get-PowerShellExe
    $null = Start-Process -FilePath $psExe -ArgumentList $argLine -Verb RunAs -PassThru -ErrorAction Stop
    $launched = $true
  } catch {
    $launched = $false
  }

  if (-not $launched) {
    Write-Host ''
    Write-Host '你没有点【是】，安装就停在这里了。' -ForegroundColor Yellow
    Write-Host '电脑上什么都没有改：没有装任何东西、没有改任何设置。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '想装的话：重新双击安装文件，弹窗出现时点【是】。' -ForegroundColor Yellow
    Add-Log '[UAC] 客户取消了提权'
    if (-not $script:NoPauseMode -and -not $script:NonInteractive) { $null = Read-Host '按回车键关闭窗口' }
    exit 4
  }
  exit 0
}

# ---------------------------------------------------------------------------
# 6. 通用检查/执行小工具
# ---------------------------------------------------------------------------
function Test-TcpPort {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMs = 5000
  )
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($HostName, $Port, $null, $null)
    $finished = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
    if (-not $finished) { return $false }
    try { $client.EndConnect($iar); return $true } catch { return $false }
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch { }
  }
}

function Test-ProductHealth {
  param([string]$HostIp, [int]$Port)
  if (-not $HostIp) { return $false }
  $url = 'http://' + $HostIp + ':' + $Port + '/health'
  try {
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $curl) {
      $text = (& $curl -s --max-time 3 $url 2>$null) -join ''
      if ($text -and ($text -match '^(ok|no-frame)')) { return $true }
    }
  } catch { }
  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($resp -and $resp.StatusCode -eq 200) { return $true }
  } catch { }
  return $false
}

# /health 要用"这台机器绑定的那个地址"问；优先 tailnet 地址，其次从 screen-url.txt 里取主机名（不读密钥）
function Resolve-HealthHost {
  param([string]$AppDir, $Config)
  try {
    if ($Config) {
      $tsRes = Resolve-ProductRuntime -AppDir $AppDir -Name 'tailscale' -Config $Config -WellKnownDirs (Get-TailscaleWellKnownDirs)
      $tsInfo = Get-TailscaleInfo -TailscaleExe $tsRes.Path
      if ($tsInfo -and $tsInfo.Ip) { return [string]$tsInfo.Ip }
    }
  } catch { }
  try {
    $urlFile = Join-Path $AppDir 'screen-url.txt'
    if (Test-Path -LiteralPath $urlFile) {
      $u = [string](Get-Content -LiteralPath $urlFile -Raw -ErrorAction Stop)
      $m = [regex]::Match($u, '^https?://([^:/?]+)')
      if ($m.Success) { return $m.Groups[1].Value }
    }
  } catch { }
  return '127.0.0.1'
}

function Invoke-RobocopyCopy {
  param([string]$From, [string]$To)
  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  if (-not (Test-Path -LiteralPath $robocopy)) { $robocopy = 'robocopy.exe' }
  # 明确排除：凭据、日志、运行状态、开发残留（即使安装包里混进来了，也不能落到客户机上）
  $excludeFiles = @(
    'screen.key', 'node-path.txt', '*.log', '*.log.err', '*.out',
    '*-url.txt', '*url*.txt', 'phone-qr*.png', 'qr-login.png', 'qr-tailip.png',
    'screen-qr*.png', 'tailnet-qr.png', 'capture.mode', 'capture.interval',
    'viewers.count', 'supervisor.heartbeat', 'supervisor.lock', 'plugin-sync.stamp',
    'maintenance.flag', 'screen-latest.jpg', '*.bak-*',
      # 改动（自审发现）：下面这些都是**客户资产**，重装绝不能被出厂值覆盖。
      #   product.config.json 客户可能改过端口或开关（例如把 enableDsh 打开走方案乙）；
      #   licence.json 是已签发的许可证；licence.state.json / machine.id 是运行时状态。
      # 原来只排除了 screen.key，所以客户改过的配置重装一次就回到出厂值了。
      # 新装机上这个文件本来就缺，所以复制完再补一份默认值（见下面的补默认配置代码）。
      'product.config.json', 'licence.json', 'licence.state.json', 'machine.id',
      'elevated-step.log', 'elevated-step.err.log'
  )
  # 改动（真实安装测试暴露的严重 bug）：原来这里写的是目录**名字**，靠 robocopy /XD 匹配。
  # 但 /XD 给的若是裸名字，会匹配树上**任意层级**的同名目录 —— 于是
  # node_modules\sharp\dist 被一起排掉，sharp 缺了 dist 就跑不起来，
  # screen-server 一 import 就崩，8660 永远不监听、supervisor 无限重启。
  # 静态检查、干跑、打包自检都发现不了，因为它们不走 robocopy 的排除逻辑。
  # 现在把排除项锚成**绝对路径**，只精确匹配源目录顶层的这几个子目录。
  $excludeDirNames = @('diagnostics', 'plugin-sync-backup', '.dsh-memory', 'pylib', 'build-doc', 'dist')
  $excludeDirs = @()
  foreach ($d in $excludeDirNames) {
    $full = Join-Path $From $d
    if (Test-Path -LiteralPath $full) { $excludeDirs += $full }
  }
  # /IS = 连"看起来一样"的文件也重新复制。
  # 为什么必须有它（虚拟机实测的真实事故）：
  #   robocopy 默认跳过"大小和时间戳都相同"的文件。如果上一次安装中途出过问题
  #   （崩溃、断电、磁盘写入失败），目标目录里会留下**大小正确但内容全 0** 的空壳，
  #   时间戳又是从源文件带过来的——于是重装时 robocopy 认为"都一样"全部跳过，
  #   复制耗时 0 秒，所有 .ps1 都是空壳，整个安装必然失败。
  #   加 /IS 后重装会真正重写一遍，坏文件能被覆盖。
  $argList = @($From, $To, '/E', '/IS', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', '/XF')
  $argList += $excludeFiles
  if ($excludeDirs.Count -gt 0) {
    $argList += '/XD'
    $argList += $excludeDirs
  }
  $null = & $robocopy @argList 2>&1
  $code = $LASTEXITCODE
  Add-Log ('[robocopy] 退出码 ' + [string]$code)
  return $code
}

# 停掉"上一版装在同一个目录里"的进程，否则文件被占用、复制会失败。
# 只认命令行里带安装目录的进程：绝不碰这台机器上别的程序（更不会碰卖家自己的生产系统）。
function Stop-InstalledInstance {
  param([string]$AppDir)
  $taskName = 'DSH Phone Access'
  try {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
      Add-Log '[i] 已暂停旧的自动启动任务，避免它在复制文件时把旧进程拉起来'
    }
  } catch { }

  $selfId = $PID
  $parentId = 0
  try { $parentId = [int](Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [string]$selfId) -ErrorAction SilentlyContinue).ParentProcessId } catch { $parentId = 0 }
  $stopped = 0
  try {
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $selfId -and $_.ProcessId -ne $parentId -and
      $_.CommandLine -and $AppDir -and
      (([string]$_.CommandLine).ToLowerInvariant().Contains($AppDir.ToLowerInvariant())) -and
      $_.Name -match '^(capture|input|audio|sources|node|powershell)\.exe$'
    })
    foreach ($p in $procs) {
      try { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop; $stopped++ } catch { }
    }
  } catch { }
  if ($stopped -gt 0) {
    Add-Log ('[i] 已停止旧版本进程 ' + [string]$stopped + ' 个')
    Start-Sleep -Milliseconds 800
  }
}

function New-DesktopShortcut {
  <#
    创建桌面快捷方式。失败时**记录下来**，并尝试降级方案。

    为什么要有降级（虚拟机实测暴露）：原来三个失败分支都只 `return ''`，
    静默吞掉原因。客户装完桌面上什么都没有，报告里也看不出为什么。
    更狠的是 WScript.Shell 这个 COM 在某些环境里建不出来（权限/CLR/安全策略），
    一挂就是四个图标全挂，客户完全没有可点的入口。

    降级顺序：
      1) .lnk（正常，有图标、有说明）
      2) .cmd 小外壳（不依赖 COM，双击照样能启动）
    两者任一成功都算赢，并把用了哪种记进 $script:ShortcutIssues。
  #>
  param(
    [string]$Dir,
    [string]$Name,
    [string]$TargetPath,
    [string]$WorkDir,
    [string]$Description,
    [string]$FallbackScript
  )
  if (-not $script:ShortcutIssues) { $script:ShortcutIssues = New-Object System.Collections.ArrayList }

  if (-not $Dir) { [void]$script:ShortcutIssues.Add($Name + ': 没有桌面目录'); return '' }
  if (-not (Test-Path -LiteralPath $Dir)) { [void]$script:ShortcutIssues.Add($Name + ': 目录不存在 ' + $Dir); return '' }
  if (-not $TargetPath) { [void]$script:ShortcutIssues.Add($Name + ': 没给目标路径'); return '' }
  if (-not (Test-Path -LiteralPath $TargetPath)) { [void]$script:ShortcutIssues.Add($Name + ': 目标文件不存在 ' + $TargetPath); return '' }

  # 1) 首选 .lnk
  $linkPath = Join-Path $Dir ($Name + '.lnk')
  try {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($linkPath)
    $sc.TargetPath = $TargetPath
    if ($WorkDir) { $sc.WorkingDirectory = $WorkDir }
    if ($Description) { $sc.Description = $Description }
    $sc.WindowStyle = 1
    $sc.Save()
    if (Test-Path -LiteralPath $linkPath) { return $linkPath }
    [void]$script:ShortcutIssues.Add($Name + ': .lnk 保存后不存在')
  } catch {
    [void]$script:ShortcutIssues.Add($Name + ': .lnk 创建失败 - ' + $_.Exception.Message)
  }

  # 2) 降级：写一个 .cmd 外壳（不依赖 COM，双击一样能跑）
  #    ⚠️ 内容必须只含 ASCII：客户用户名可能是中文（%LOCALAPPDATA% 会变成 C:\Users\张三\…），
  #    而 .cmd 按 ASCII 写盘会把中文写坏。所以只用 %LOCALAPPDATA% 变量 + ASCII 的 .ps1 文件名。
  #    绝对路径一律不写——宁可让外壳在自定义安装目录下失效，也不要写进中文把 .cmd 写坏
  #    （.cmd 被写坏的排查成本极高，前面已经踩过一次）。
  try {
    $cmdPath = Join-Path $Dir ($Name + '.cmd')
    $scriptName = if ($FallbackScript) { $FallbackScript } else { 'start-phone-access.ps1' }
    # ⚠️ 含 + 拼接的元素必须各自加一层括号！
    # PowerShell 坑：数组字面量里写 @('a' + $x + 'b', 'c')，逗号会被 + 表达式吃进去，
    # 实测把这段 .cmd 拆成 15 行、命令断成两截，双击直接失效。
    # 写成 @((...), 'c') 才是 11 个正确元素。
    $lines = @(
      '@echo off',
      'rem PhoneAccess shortcut (generated by installer)',
      'set "PA_DIR=%LOCALAPPDATA%\PhoneAccess"',
      ('if not exist "%PA_DIR%\' + $scriptName + '" ('),
      '  echo Cannot find the program. Please run the installer again.',
      '  pause',
      '  exit /b 1',
      ')',
      'cd /d "%PA_DIR%"',
      ('powershell -NoProfile -ExecutionPolicy Bypass -File "' + $scriptName + '"'),
      'if errorlevel 1 pause'
    )
    [System.IO.File]::WriteAllText($cmdPath, ($lines -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)
    if (Test-Path -LiteralPath $cmdPath) {
      [void]$script:ShortcutIssues.Add($Name + ': 已用 .cmd 外壳代替 .lnk')
      return $cmdPath
    }
  } catch {
    [void]$script:ShortcutIssues.Add($Name + ': .cmd 外壳也失败 - ' + $_.Exception.Message)
  }
  return ''
}

# 防火墙：只允许 Tailscale 私有网段进来，拒绝所有局域网私有网段。
# 端口来自 product.config.json（不写死），规则名带统一前缀，重复安装是"先删后建"，不会叠加。
function Set-ProductFirewall {
  param([int[]]$Ports)
  $tag = 'PhoneAccess 轻屏'
  $tailnet = '100.64.0.0/10'
  $lanRanges = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
  # 清理旧版本留下的规则（旧命名 "DSH phone access" / "DSH Web (phone access)"）：
  # 实测 "DSH phone access : block lan 8660" 会让离线模式下的手机一直连不上（8660 超时），必须删掉。
  try {
    Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^DSH (phone access|Web \(phone access\))' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  } catch { }
  foreach ($p in $Ports) {
    $allowName = $tag + ' : 只允许 Tailscale ' + [string]$p
    $blockName = $tag + ' : 拒绝局域网 ' + [string]$p
    Get-NetFirewallRule -DisplayName $allowName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    $null = New-NetFirewallRule -DisplayName $allowName -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort $p -RemoteAddress $tailnet -Profile Any -ErrorAction Stop `
      -Description '轻屏：只允许 Tailscale 私有网段访问'
    Get-NetFirewallRule -DisplayName $blockName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    $null = New-NetFirewallRule -DisplayName $blockName -Direction Inbound -Action Block -Protocol TCP `
      -LocalPort $p -RemoteAddress $lanRanges -Profile Any -ErrorAction Stop `
      -Description '轻屏：拒绝局域网私有网段（防止同网段设备直接连）'
  }
}

# ---------------------------------------------------------------------------
# 7. 启动前定位安装包 / 安装目录
# ---------------------------------------------------------------------------
$script:SourceDirFull = ''
try {
  if (-not $SourceDir) { $SourceDir = $script:ScriptDir }
  $script:SourceDirFull = [System.IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
} catch {
  $script:SourceDirFull = $SourceDir
}

# 读配置（配置文件坏了不崩：Get-ProductConfig 会退回默认值并给 Warnings）
$script:ConfigSource = $null
try {
  $configScript = Join-Path $script:SourceDirFull 'product-config.ps1'
  if (Test-Path -LiteralPath $configScript) {
    . $configScript
    $script:ConfigSource = Get-ProductConfig -AppDir $script:SourceDirFull
  }
} catch {
  $script:ConfigSource = $null
}

$script:InstallRoot = ''
if ($InstallTo) {
  $script:InstallRoot = $InstallTo
} elseif ($script:ConfigSource -and $script:ConfigSource.installDir) {
  $script:InstallRoot = [string]$script:ConfigSource.installDir
} else {
  $script:InstallRoot = Join-Path $env:LOCALAPPDATA 'PhoneAccess'
}
try {
  $script:InstallRoot = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($script:InstallRoot)).TrimEnd('\')
} catch {
  $script:InstallRoot = [Environment]::ExpandEnvironmentVariables($script:InstallRoot)
}

# ---------------------------------------------------------------------------
# 8. 主流程
# ---------------------------------------------------------------------------
try {
  Write-Banner
  Add-Log ('安装器 v' + $script:InstallerVer + ' / 来源 ' + $script:SourceDirFull + ' / 目标 ' + $script:InstallRoot)

  # ---- 提权（只弹一次；点了"否"要能看懂）----
  if ($script:DryRunMode) {
    if (-not (Test-IsAdmin)) {
      Write-Note '干跑：当前不是管理员。正式安装会先申请一次管理员权限（弹一次 UAC，点【是】）。'
    }
  } else {
    # 改动（独立审查 L5）：如果提权后的身份和发起安装的账号不一致，
    # 说明客户在 UAC 里输入了**别的管理员账号**。那样装出来的东西（安装目录、桌面图标、
    # 计划任务）全在别人名下，客户自己登录后什么都看不到，属于最难排查的一类"装失败"。
    # 以前这种情况会被静默放过（查不到就当通过），现在直接拦下来并说清楚该怎么办。
    if ($OriginalUser) {
      $nowUser = $env:USERDOMAIN + '\' + $env:USERNAME
      if ($nowUser -ne $OriginalUser) {
        $script:CurrentStepNo = 0
        $script:CurrentStep = '管理员权限'
        Fail-Install '你用的是另一个管理员账号（不是你自己的账号）' `
          (@(
            '刚才那个"用户账户控制"窗口里，你输入的是另一个管理员账号的密码。',
            '这样装出来的程序会算在那个账号名下，**你自己登录后看不到**桌面图标，也连不上。',
            '',
            '正确的做法（二选一）：',
            '  1) 重新双击安装文件，在 UAC 窗口里点【是】（不要输入别人的账号密码）；',
            '  2) 如果必须用管理员账号，就先用那个账号登录 Windows，装好再从你的账号里用。',
            '',
            ('发起安装的账号：' + $OriginalUser),
            ('当前运行身份：' + $nowUser)
          ) -join "`n")
      }
    }
    if (-not (Test-IsAdmin)) {
      if (-not (Test-CurrentUserInAdminGroup)) {
        $script:CurrentStepNo = 0
        $script:CurrentStep = '管理员权限'
        Fail-Install '你现在登录的账号不是这台电脑的管理员' `
          (@(
            '这个产品需要管理员权限才能装（要改防火墙、注册开机自启）。',
            '解决办法（选一个）：',
            '  1) 用这台电脑上的管理员账号登录 Windows，再双击安装文件；',
            '  2) 让卖家打电话教你用管理员账号登录。',
            '这不是安装包的问题，你的账号确实没有权限。'
          ) -join "`n")
      }
      Request-Elevation
    }
    Write-Ok '已获得管理员权限（整个安装只会弹这一次）'
  }

  # 防重复双击：两个安装同时跑会互相抢文件（客户很容易因为"没反应"连点两下）
  if (-not $script:DryRunMode) {
    try {
      $script:SingleInstanceMutex = New-Object System.Threading.Mutex($false, 'Local\PhoneAccessInstall_v1')
      if (-not $script:SingleInstanceMutex.WaitOne(0)) {
        Write-Host ''
        Write-Host '安装已经在另一个窗口里进行中，请不要重复双击。' -ForegroundColor Yellow
        Write-Host '如果找不到那个窗口：等 2 分钟后再双击一次，或者重启电脑后再装。' -ForegroundColor Yellow
        Write-Host ''
        if (-not $script:NoPauseMode -and -not $script:NonInteractive) { $null = Read-Host '按回车键关闭窗口' }
        exit 0
      }
    } catch { }
  }

  # 之前装过？提前说一句，让客户知道重跑是安全的
  if (Test-Path -LiteralPath $script:InstallRoot) {
    Write-Ok '检测到之前装过（或正在装）。这次会接着装：已经好的步骤自动跳过，不会重复安装。'
  }

  # =========================================================================
  # 第 1 步：检查安装包
  # =========================================================================
  $script:CurrentStepNo = 1
  $script:CurrentStep = '检查安装包'
  Write-Section '第 1 步 · 检查安装包'

  if ($script:SourceDirFull -match '^\\\\') {
    Fail-Install '安装文件放在网络共享盘上（路径以 \\ 开头）' `
      (@(
        '请先把压缩包解压到这台电脑自己的硬盘上（比如桌面），再从解压出来的文件夹里双击安装文件。',
        '网络共享盘 / U 盘上直接运行会出现权限问题。'
      ) -join "`n")
  }
  if (-not (Test-Path -LiteralPath $script:SourceDirFull -PathType Container)) {
    Fail-Install '找不到安装文件所在的文件夹' `
      '请重新解压卖家发给你的压缩包，然后进解压出来的文件夹双击安装文件。'
  }

  $requiredFiles = @(
    'product.config.json', 'product-config.ps1', 'selfcheck.ps1', '自检.cmd',
    'start-phone-access.ps1', 'start-phone-access.cmd', 'start-screen.ps1',
    'stop-phone-access.ps1', 'stop-phone-access.cmd',
    'supervise.ps1', 'autostart.ps1', 'run-autostart.vbs', 'install-elevated-input.ps1',
    # 许可证 + 手机入口 + HTTPS 支持：缺任何一个都会导致功能静默缺失，所以列入必需清单
    # 2026-11-08 删除 7 天试用：trial.ps1 已删除，不再往安装目录复制，也不再做任何试用初始化
    'licence.ps1', 'licence-state.ps1', 'https-setup.ps1',
    'entry.ps1', '手机入口.cmd',
    # 离线模式（局域网/电脑热点）：入口脚本 + 桌面快捷方式目标
    'offline-mode.ps1', '离线模式.cmd', 'make-lan-cert.ps1', 'make-lan-ca.ps1', 'hotspot-ctl.ps1', 'offline-firewall.ps1',
    'offline-mode-off.ps1', '关闭离线模式.cmd',
    'uninstall.ps1', 'uninstall.cmd', '使用说明.md',
    'dsh-port.ps1', 'restart.ps1', 'restart.cmd',
    'screen-server.mjs', 'page.mjs', 'rtc.mjs', 'decode.mjs', 'input.mjs', 'audio.mjs',
    'package.json', 'pnpm-lock.yaml',
    'capture.exe', 'input.exe', 'audio.exe', 'sources.exe',
    'lib\NAudio.Core.dll', 'lib\NAudio.Wasapi.dll', 'lib\NAudio.WinMM.dll',
    'icon-192.png', 'icon-512.png',
    'runtime\node.exe',
    'node_modules\ws\package.json', 'node_modules\sharp\package.json', 'node_modules\@roamhq\wrtc\package.json',
    # sharp 的 dist 目录必须单独检查：曾经因为 robocopy 的裸目录名排除把它整个漏掉，
    # 导致画面服务一 import 就崩、8660 永远不监听（线上真实事故）。
    # 注意 sharp 的入口是 index.cjs / index.mjs，没有 index.js（别照 javascript 惯例猜）。
    'node_modules\sharp\dist\index.mjs',
    'node_modules\sharp\dist\index.cjs'
  )
  $missing = New-Object System.Collections.ArrayList
  foreach ($rel in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:SourceDirFull $rel))) { [void]$missing.Add($rel) }
  }

  # 自带的 node.exe 必须是真的（89 MB 左右）；太小说明包坏了
  $nodeInSource = Join-Path $script:SourceDirFull 'runtime\node.exe'
  if (Test-Path -LiteralPath $nodeInSource) {
    try {
      $nodeLen = (Get-Item -LiteralPath $nodeInSource -Force).Length
      if ($nodeLen -lt 20MB) { [void]$missing.Add('runtime\node.exe（文件不完整，只有 ' + [string][math]::Round($nodeLen / 1MB, 1) + ' MB）') }
    } catch { }
  }

  # pnpm 的 junction 陷阱：目录若是"快捷方式"式链接，到客户机就是断链
  try {
    $wrtcDir = Join-Path $script:SourceDirFull 'node_modules\@roamhq\wrtc'
    if (Test-Path -LiteralPath $wrtcDir) {
      $wrtcItem = Get-Item -LiteralPath $wrtcDir -Force
      if ($wrtcItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        [void]$missing.Add('node_modules\@roamhq\wrtc（是链接目录，不是真文件）')
      }
    }
  } catch { }

  if ($missing.Count -gt 0) {
    $showMissing = @($missing | Select-Object -First 6)
    Fail-Install ('安装包不完整：缺少 ' + [string]$missing.Count + ' 个必要文件（' + ($showMissing -join '、') + '）') `
      (@(
        '这不是你操作的问题，是文件没解压完整。请按顺序做：',
        '  1) 找到卖家发给你的压缩包（.zip 文件），右键选“全部解压”；',
        '  2) 解压到桌面，会得到一个文件夹；',
        '  3) 进那个文件夹，双击 install.cmd（不要直接双击压缩包里的文件）；',
        '还是这样：把这份报告发给卖家，让他们重新发一次安装包。'
      ) -join "`n")
  }

  # 安装包里混进卖家的密钥 / 日志：不复制、不使用，并明确告诉客户
  if (Test-Path -LiteralPath (Join-Path $script:SourceDirFull 'screen.key')) {
    Write-WarnLine '安装包里带了卖家电脑上的密钥文件。已忽略：安装会给你生成一把全新的密钥。'
  }
  $strayLogs = @(Get-ChildItem -LiteralPath $script:SourceDirFull -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.log', '.err', '.out' })
  if ($strayLogs.Count -gt 0) {
    Write-Note ('安装包里带了 ' + [string]$strayLogs.Count + ' 个运行日志文件；安装时会跳过，不会复制到你电脑上。')
  }
  if ($script:ConfigSource -and $script:ConfigSource.Warnings -and @($script:ConfigSource.Warnings).Count -gt 0) {
    foreach ($w in @($script:ConfigSource.Warnings)) { Write-WarnLine ('配置文件提示：' + [string]$w) }
  }
  Write-Ok '安装包完整'

  # =========================================================================
  # 第 2 步：检查这台电脑能不能装
  # =========================================================================
  $script:CurrentStepNo = 2
  $script:CurrentStep = '检查这台电脑能不能装'
  Write-Section '第 2 步 · 检查这台电脑能不能装'

  $envChecks = New-Object System.Collections.ArrayList
  function Add-EnvCheck {
    param(
      [string]$Name,
      [bool]$Ok,
      [string]$Detail,
      [bool]$Hard = $true,
      [string]$Advice = ''
    )
    [void]$envChecks.Add([pscustomobject]@{
      Name = $Name; Ok = $Ok; Detail = $Detail; Hard = $Hard; Advice = $Advice
    })
    if ($Ok) { Write-Ok ($Name + '：' + $Detail) }
    else {
      if ($Hard) { Write-BadLine ($Name + '：' + $Detail) }
      else { Write-WarnLine ($Name + '：' + $Detail) }
    }
  }

  # 2.1 系统版本与位数（硬门槛 H1）
  try {
    $osInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $osCaption = [string]$osInfo.Caption
    $osBuild = 0
    try { $osBuild = [int]$osInfo.BuildNumber } catch { $osBuild = 0 }
    $osArch = [string]$osInfo.OSArchitecture
    $osOk = ($osCaption -notmatch 'Server') -and ($osArch -match '64') -and ($osBuild -ge 19041)
    Add-EnvCheck 'Windows 版本' $osOk ($osCaption + ' / build ' + [string]$osBuild + ' / ' + $osArch) $true `
      (@(
        '这台电脑的系统版本不够（需要 Windows 10 2004 以上或 Windows 11，64 位）。',
        '请不要自己升级系统。拍一张“设置 → 系统 → 关于”的截图发给卖家，让卖家判断能不能装。'
      ) -join "`n")
  } catch {
    Add-EnvCheck 'Windows 版本' $false '读不到系统信息' $true '重启电脑后再双击一次；还不行就把报告发给卖家。'
  }

  # 2.2 是否加域 / 是否被公司 MDM 管（硬门槛 H3）
  # 注意：root/cimv2/mdm/dmmap 的 MDM_DevDetail_Ext01 在未纳管的 Win10/11 上同样有本地
  # 占位实例，按实例个数(>0)判定会 100% 误报（2026-10-28 在干净机器上实测）。
  # 这里只看真实纳管证据：加域 / AzureAD / 企业域 / MDMUrl / Intune(MDM) 设备注册。
  $managedReasons = New-Object System.Collections.ArrayList
  try {
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    if ([bool]$cs.PartOfDomain) { [void]$managedReasons.Add('加入了公司域(' + [string]$cs.Domain + ')') }
  } catch { }
  try {
    $dsreg = (& dsregcmd.exe /status 2>$null | Out-String)
    if ($dsreg -match '(?i)AzureAdJoined\s*:\s*YES') { [void]$managedReasons.Add('已加入 Azure AD') }
    if ($dsreg -match '(?i)EnterpriseJoined\s*:\s*YES') { [void]$managedReasons.Add('已加入企业域') }
    if ($dsreg -match '(?i)MDMUrl\s*:\s*https?://\S+') { [void]$managedReasons.Add('设备已注册 MDM') }
  } catch { }
  try {
    $mdmEnrolled = @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -ErrorAction Stop | ForEach-Object {
        $e = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        if ($e.ProviderID -and ([string]$e.ProviderID) -match 'MS DM Server') { $e }
      })
    if ($mdmEnrolled.Count -gt 0) { [void]$managedReasons.Add('Intune/MDM 已注册本机') }
  } catch { }
  if ($managedReasons.Count -gt 0) {
    Add-EnvCheck '不是公司统一管理的电脑' $false ($managedReasons -join '、') $true `
      (@(
        '这台电脑是公司/学校统一管理的。我们的方案要改防火墙和开机自启，会被公司的策略覆盖掉，装了也不稳定。',
        '建议换到你自己的个人电脑装；如果必须用这台，需要请公司 IT 出书面许可。',
        '把这份报告发给卖家，卖家会告诉你能不能做。'
      ) -join "`n")
  } else {
    Add-EnvCheck '不是公司统一管理的电脑' $true '没有加域、没有被 MDM 管控'
  }

  # 2.3 管理员权限（正式安装时已经提权；干跑时说明会弹一次 UAC）
  if ($script:DryRunMode -and -not (Test-IsAdmin)) {
    Add-EnvCheck '管理员权限' $true '干跑：正式安装会请求一次管理员权限（弹一次 UAC，点【是】）'
  } else {
    Add-EnvCheck '管理员权限' (Test-IsAdmin) $(if (Test-IsAdmin) { '已获得管理员权限' } else { '当前没有管理员权限' }) $true `
      '重新双击安装文件，在弹窗里点【是】。'
  }

  # 2.4 磁盘空间（硬门槛 H6 + 安装盘余量）
  try {
    $sysDriveName = 'C'
    if ($env:SystemDrive) { $sysDriveName = $env:SystemDrive.TrimEnd('\').TrimEnd(':') }
    if (-not $sysDriveName) { $sysDriveName = 'C' }
    $sysFree = (Get-PSDrive -Name $sysDriveName -ErrorAction Stop).Free
    $sysFreeGB = [math]::Round($sysFree / 1GB, 1)
    Add-EnvCheck 'C 盘剩余空间' ($sysFree -ge 10GB) ([string]$sysFreeGB + ' GB（至少需要 10 GB）') $true `
      (@(
        'C 盘空间不够。请先清理一下：清空回收站、删掉下载文件夹里不用的大文件。',
        '清理完重新双击安装文件。不会清理的话把报告发给卖家，卖家电话里教你。'
      ) -join "`n")
  } catch {
    Add-EnvCheck 'C 盘剩余空间' $false '读不到磁盘剩余空间' $false '不影响安装，卖家会远程帮你确认。'
  }
  try {
    $installDrive = [System.IO.Path]::GetPathRoot($script:InstallRoot)
    $installDriveName = $installDrive.TrimEnd('\').TrimEnd(':')
    if ($installDriveName) {
      $instFree = (Get-PSDrive -Name $installDriveName -ErrorAction Stop).Free
      Add-EnvCheck '安装盘剩余空间' ($instFree -ge 1GB) ([string][math]::Round($instFree / 1GB, 1) + ' GB（' + $installDriveName + ':）') $true `
        '安装盘空间不足 1 GB，请先清理磁盘。'
    }
  } catch {
    Add-EnvCheck '安装盘剩余空间' $false '读不到安装盘剩余空间' $false '不影响安装，卖家会远程帮你确认。'
  }

  # 2.5 能不能出网到 Tailscale（2026-11-08 改为软门槛）
  # 旧逻辑只测 login.tailscale.com:443 且失败就中止安装 —— 在"只有 IPv4 / 被墙 / 虚拟机没有 IPv6"的机器上会误杀。
  # 实测：这台能用 Tailscale 的机器其实是走 IPv6 连 2606:b740:1:20::102；VMware NAT 的虚拟机没有 IPv6，IPv4 又被挡，必然失败。
  # 新逻辑：① Tailscale 已安装且已登录（BackendState=Running）→ 直接通过，不再探测；
  #         ② 否则 controlplane / login 两个域名 × IPv4/IPv6 任意一条能通即通过；
  #         ③ 仍失败只警告、不阻断安装（装完在手机设置里能看到 Tailscale 状态）。
  $networkOk = $false
  $networkDetail = ''
  $tsAlreadyRunning = $false
  try {
    $tsCandidates = @()
    if ($env:ProgramFiles) { $tsCandidates += (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe') }
    if (${env:ProgramFiles(x86)}) { $tsCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe') }
    foreach ($tsExe in $tsCandidates) {
      if (-not (Test-Path -LiteralPath $tsExe)) { continue }
      try {
        $stRaw = (& $tsExe status --json 2>$null | Out-String)
        if ($stRaw -and $stRaw.Trim()) {
          $stObj = $stRaw | ConvertFrom-Json
          if ($stObj.BackendState -eq 'Running') { $tsAlreadyRunning = $true; break }
        }
      } catch { }
    }
  } catch { }
  if ($tsAlreadyRunning) {
    $networkOk = $true
    $networkDetail = 'Tailscale 已安装并已登录（跳过网络探测）'
  } else {
    # 总探测预算 15 秒，避免网络极差时安装器卡 1 分多钟（每个地址 3 秒、每个地址族最多试 2 个）
    $probeDeadline = (Get-Date).AddSeconds(15)
    foreach ($h in @('controlplane.tailscale.com', 'login.tailscale.com')) {
      if ($networkOk -or (Get-Date) -gt $probeDeadline) { break }
      foreach ($fam in @('InterNetwork', 'InterNetworkV6')) {
        if ($networkOk -or (Get-Date) -gt $probeDeadline) { break }
        try {
          $addrs = @([System.Net.Dns]::GetHostAddresses($h) | Where-Object { $_.AddressFamily.ToString() -eq $fam } | Select-Object -First 2)
          foreach ($a in $addrs) {
            if ((Get-Date) -gt $probeDeadline) { break }
            $ipTxt = $a.IPAddressToString
            if (Test-TcpPort -HostName $ipTxt -Port 443 -TimeoutMs 3000) {
              $networkOk = $true
              if ($fam -eq 'InterNetwork') { $networkDetail = '能连上（' + $h + ' / IPv4）' }
              else { $networkDetail = '能连上（' + $h + ' / IPv6）' }
              break
            }
          }
        } catch { }
      }
    }
    if (-not $networkOk) { $networkDetail = '连不上 Tailscale（controlplane/login，IPv4+IPv6 都试过）' }
  }
  Add-EnvCheck '能不能连上 Tailscale' $networkOk $networkDetail $false `
    (@(
      '网络连不上 Tailscale 的服务器（controlplane/login 两个都试过 IPv4+IPv6）。',
      '不影响继续安装，但装好后手机可能连不上电脑。按顺序试：',
      '  1) 先确认这台电脑能正常打开网页；',
      '  2) 公司/学校网络常限制 Tailscale，换手机热点试一次；',
      '  3) 如果这台电脑已经装过 Tailscale 并登录过，通常可以直接用；仍不行把报告发给卖家。'
    ) -join "`n")

  # 2.6 .NET 运行环境（软门槛：抓屏/声音程序是 .NET 编译的）
  try {
    $netRelease = 0
    try { $netRelease = [int](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release -ErrorAction Stop).Release } catch { $netRelease = 0 }
    if ($netRelease -ge 528040) {
      Add-EnvCheck '.NET 运行环境' $true '4.8 或更高'
    } else {
      Add-EnvCheck '.NET 运行环境' $false ('版本偏低（Release=' + [string]$netRelease + '）') $false `
        '一般够用。如果装完画面起不来，先跑一次 Windows 更新再重新安装。'
    }
  } catch {
    Add-EnvCheck '.NET 运行环境' $false '读不到 .NET 版本' $false '不影响安装，卖家会远程帮你确认。'
  }

  # 2.7 有没有人登录着桌面（软门槛：注销/重启停在登录界面时服务不会运行）
  $consoleActive = $false
  try {
    $qs = (& query.exe session 2>$null | Out-String)
    if ($qs -match '(?im)^\s*>?\s*console\s') { $consoleActive = $true }
    if ($qs -match '(?i)(Disc|断开)') {
      if ($qs -match '(?im)^\s*>?\s*console\s+.*(Disc|断开)') { $consoleActive = $false }
    }
  } catch { }
  if ($consoleActive) {
    Add-EnvCheck '有人登录着这台电脑' $true '检测到正在使用的桌面会话'
  } else {
    Add-EnvCheck '有人登录着这台电脑' $false '没看到正在使用的桌面登录会话' $false `
      '重启电脑后要有人登录 Windows（锁屏可以，注销不行），手机才连得上。'
  }

  # 2.8 端口占用（软门槛 S10：客户机上可能被别的软件占了）
  $portsToCheck = New-Object System.Collections.ArrayList
  $cfgForPorts = $script:ConfigSource
  try {
    if (Test-Path -LiteralPath (Join-Path $script:InstallRoot 'product.config.json')) {
      $cfgForPorts = Get-ProductConfig -AppDir $script:InstallRoot
    }
  } catch { }
  if ($cfgForPorts) {
    [void]$portsToCheck.Add([int]$cfgForPorts.ports.screen)
    if ($cfgForPorts.enableDsh) { [void]$portsToCheck.Add([int]$cfgForPorts.ports.door) }
    foreach ($p in $portsToCheck) {
      $conflict = Test-ProductPortConflict -Port $p -OwnPattern 'screen-server\.mjs|tunnel-proxy\.mjs'
      if ($conflict) {
        $cfgKey = 'ports.screen'
        if ($cfgForPorts -and ([int]$p -eq [int]$cfgForPorts.ports.door)) { $cfgKey = 'ports.door' }
        # 技术细节只进报告：客户看到"谁占了、点哪里"，不看到命令行与配置文件名
        Add-Log ('端口冲突详情：' + (Format-PortConflictMessage -Conflict $conflict -ConfigKey $cfgKey))
        $whoText = ''
        if ($conflict.Name) { $whoText = '（' + [string]$conflict.Name + '）' }
        Add-EnvCheck ('端口 ' + [string]$p) $false ('被另一个程序占用了' + $whoText) $true `
          (@(
            '先把占用的那个程序关掉，再双击安装文件；不确定是哪个程序就直接重启电脑。',
            '重启后还是这样：把这份报告发给卖家，卖家会帮你把端口换一个（不用你自己动手改）。'
          ) -join "`n")
      } else {
        Add-EnvCheck ('端口 ' + [string]$p) $true '没有被别的程序占用'
      }
    }
  }

  $hardProblems = @($envChecks | Where-Object { -not $_.Ok -and $_.Hard })
  if ($hardProblems.Count -gt 0) {
    $reason = (($hardProblems | ForEach-Object { $_.Name + '：' + $_.Detail }) -join '；')
    $adviceList = @()
    foreach ($p in $hardProblems) { if ($p.Advice) { $adviceList += $p.Advice } }
    Fail-Install ('这台电脑有 ' + [string]$hardProblems.Count + ' 项不满足安装要求（' + $reason + '）') (($adviceList | Select-Object -Unique) -join "`n")
  }
  Write-Ok '这台电脑满足安装要求'

  # =========================================================================
  # 第 3 步：私有网络 Tailscale（客户用自己的账号登录；卖家不碰账号）
  # =========================================================================
  $script:CurrentStepNo = 3
  $script:CurrentStep = '检查私有网络（Tailscale）'
  Write-Section '第 3 步 · 检查私有网络（Tailscale）'

  $tsPath = ''
  $tsResolved = $null
  if ($script:ConfigSource) {
    $tsResolved = Resolve-ProductRuntime -AppDir $script:SourceDirFull -Name 'tailscale' -Config $script:ConfigSource -WellKnownDirs (Get-TailscaleWellKnownDirs)
    $tsPath = $tsResolved.Path
  }

  if (-not $tsPath) {
    Write-WarnLine '这台电脑还没装 Tailscale。手机能连进来的那条“私有网络”就是它。'
    Write-Host '  你需要先装好它（大约 3 分钟）：'
    Write-Host '    1) 回到安装文件夹，进 bin 文件夹，双击 tailscale-setup.exe'
    Write-Host '    2) 一路点“下一步 / 安装”'
    Write-Host '    3) 装好后打开它，点 “Log in”，用卖家给你的账号登录'
    $bundledSetup = Join-Path $script:SourceDirFull 'bin\tailscale-setup.exe'
    if (Test-Path -LiteralPath $bundledSetup) {
      if ($script:DryRunMode) {
        Write-Note '（干跑）会帮你打开 Tailscale 安装包'
      } else {
        Write-Note '正在帮你打开 Tailscale 安装包，请按它的提示装完…'
        try { $null = Start-Process -FilePath $bundledSetup -Wait } catch { Write-WarnLine '没能自动打开安装包，请手动双击 bin\tailscale-setup.exe' }
      }
    }
    $attempt = 0
    while (-not $tsPath -and $attempt -lt 6) {
      if ($script:DryRunMode) { break }
      $attempt++
      Write-Host ''
      if ($script:NonInteractive) {
        # 非交互：GUI 外壳里没人按回车。给 2 秒缓冲后重试一次；还找不到就按原逻辑报错。
        Start-Sleep -Seconds 2
      } else {
        $null = Read-Host '装好并登录后，按回车继续（要退出请直接关掉这个窗口）'
      }
      if ($script:ConfigSource) {
        $tsResolved = Resolve-ProductRuntime -AppDir $script:SourceDirFull -Name 'tailscale' -Config $script:ConfigSource -WellKnownDirs (Get-TailscaleWellKnownDirs)
        $tsPath = $tsResolved.Path
      }
      if (-not $tsPath) { Write-WarnLine '还是没找到 Tailscale。确认刚才那一步装完了吗？' }
    }
    if (-not $tsPath) {
      Fail-Install 'Tailscale 还没装好' `
        (@(
          '手机要通过 Tailscale 才能连到这台电脑，所以它必须先装好。',
          '装好 Tailscale 并登录后，重新双击安装文件即可继续：已经做过的步骤不会重复。',
          '装不上（安装包打不开 / 提示失败）：把这份报告发给卖家。'
        ) -join "`n")
    }
    Write-Ok 'Tailscale 已装上'
  }

  $tsInfo = Get-TailscaleInfo -TailscaleExe $tsPath
  if ($tsInfo -and $tsInfo.Running) {
    Write-Ok ('Tailscale 已登录并连上（私有地址 ' + [string]$tsInfo.Ip + '）')
  } else {
    Write-WarnLine 'Tailscale 装了，但现在还没登录 / 没连上。'
    Write-Host '  在屏幕右下角的托盘里找到 Tailscale 图标（可能要先点 ^ 展开），'
    Write-Host '  右键 → Log in，按提示登录（用卖家给你的账号，或你自己的账号）。'
    $loginAttempt = 0
    while ((-not $tsInfo.Running) -and $loginAttempt -lt 3 -and -not $script:DryRunMode) {
      $loginAttempt++
      Write-Host ''
      if ($script:NonInteractive) {
        # 非交互：不等登录。原逻辑本来就说"可以先继续装，装完再登录"，直接跳出重试循环。
        Write-WarnLine '（非交互模式）不等 Tailscale 登录，继续安装；装完请手动登录。'
        break
      } else {
        $null = Read-Host '登录好再按回车重新检查（也可以直接按回车先继续装，装完再登录）'
      }
      $tsInfo = Get-TailscaleInfo -TailscaleExe $tsPath
      if (-not $tsInfo.Running) { Write-WarnLine '还是没连上。可以继续装，但装完要记得登录 Tailscale，否则手机连不上。' }
    }
    if ($tsInfo -and $tsInfo.Running) {
      Write-Ok 'Tailscale 已登录并连上'
    } else {
      Write-WarnLine '先继续安装。装完一定要回来登录 Tailscale（右下角图标 → Log in），否则手机连不上。'
    }
  }

  # =========================================================================
  # 第 4 步：复制程序文件
  # =========================================================================
  $script:CurrentStepNo = 4
  $script:CurrentStep = '复制程序文件'
  Write-Section '第 4 步 · 复制程序文件'

  $sameFolder = ($script:SourceDirFull.TrimEnd('\') -eq $script:InstallRoot.TrimEnd('\'))
  if ($sameFolder) {
    Write-Ok '安装文件夹和程序文件夹是同一个，不需要复制'
  } elseif ($script:DryRunMode) {
    Write-Note ('（干跑）会把程序从 ' + $script:SourceDirFull + ' 复制到 ' + $script:InstallRoot)
    Write-Note '（干跑）不会复制文件，也不会停止任何正在运行的程序'
  } else {
    Stop-InstalledInstance -AppDir $script:InstallRoot
    if (-not (Test-Path -LiteralPath $script:InstallRoot)) {
      $null = New-Item -ItemType Directory -Path $script:InstallRoot -Force
    }
    Write-Note '正在复制（约 130 MB，1-3 分钟）。请不要关窗口、不要关机…'
    $copyWatch = [System.Diagnostics.Stopwatch]::StartNew()
    $copyCode = Invoke-RobocopyCopy -From $script:SourceDirFull -To $script:InstallRoot
    $copyWatch.Stop()
    if ($copyCode -ge 8) {
      Fail-Install ('复制程序文件失败（robocopy 退出码 ' + [string]$copyCode + '）') `
        (@(
          '按顺序试：',
          '  1) 确认安装文件夹没有被移动或删除；',
          '  2) 如果杀毒软件弹了拦截提示，先点“允许”，再重新双击安装文件；',
          '  3) 还是不行：把这份报告发给卖家。'
        ) -join "`n")
    }
    Write-Ok ('程序文件已复制到：' + $script:InstallRoot + '（用时 ' + [string][math]::Round($copyWatch.Elapsed.TotalSeconds) + ' 秒）')

    # product.config.json 被上面刻意排除在复制之外（保护客户改过的配置）。
    # 新装机上它一定不存在，所以这里补一份默认值；老机上有就一个字都不动。
    $cfgDst = Join-Path $script:InstallRoot 'product.config.json'
    if (-not (Test-Path -LiteralPath $cfgDst)) {
      $cfgSrc = Join-Path $script:SourceDirFull 'product.config.json'
      if (Test-Path -LiteralPath $cfgSrc) {
        try {
          Copy-Item -LiteralPath $cfgSrc -Destination $cfgDst -Force
          Write-Note '已写入默认配置 product.config.json（这台电脑之前没有）'
        } catch {
          Write-WarnLine ('默认配置写不进去：' + $_.Exception.Message)
        }
      }
    } else {
      Write-Note '检测到已有的 product.config.json，保留你原来的设置不动'
      # 但新版本可能加了新字段（例如 version / update），老配置里没有。
      # 这里做**只增不改**的迁移：只把默认配置里有、客户配置里没有的「顶层键」补上，
      # 客户已经设过的值一个都不动。不这么做，升级上来的机器在「设置」里看不到版本号、
      # 「检查更新」也会因为读不到 update 字段而失效。
      try {
        $cfgSrc2 = Join-Path $script:SourceDirFull 'product.config.json'
        if (Test-Path -LiteralPath $cfgSrc2) {
          $oldCfg = Get-Content -LiteralPath $cfgDst -Raw -Encoding UTF8 | ConvertFrom-Json
          $defCfg = Get-Content -LiteralPath $cfgSrc2 -Raw -Encoding UTF8 | ConvertFrom-Json
          $changed = New-Object System.Collections.ArrayList
          $oldNames = @($oldCfg.PSObject.Properties.Name)
          # 第一步：包里有、老配置完全没有的顶层键 → 补上（客户已经设过的值不动）。
          foreach ($prop in $defCfg.PSObject.Properties) {
            if (-not ($oldNames -contains $prop.Name)) {
              $oldCfg | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value -Force
              [void]$changed.Add($prop.Name)
            }
          }
          # 第二步（2026-10-30 修复）：version / update / plans / freemium / share 是**产品自带的信息**，
          # 不是客户设置。它们老配置里也有旧值，只“补缺”的话升级后永远停在旧版本：
          #   设置里显示旧版本号（客户以为没升级成功）、
          #   检查更新读到的是旧 update（没有后来才加的 update.github）→ 永远说“还没配置更新源”。
          # 这几类改成每次升级都用包里的值覆盖；端口/开关/屏幕分辨率/许可证等客户设置仍然一个字不动。
          foreach ($k in @('version', 'update', 'plans', 'freemium', 'share')) {
            $defProp = $defCfg.PSObject.Properties[$k]
            if ($null -eq $defProp) { continue }
            $oldCfg | Add-Member -NotePropertyName $k -NotePropertyValue $defProp.Value -Force
            [void]$changed.Add('同步:' + $k)
          }
          if ($changed.Count -gt 0) {
            [System.IO.File]::WriteAllText($cfgDst, ($oldCfg | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
            Write-Ok ('已更新 product.config.json：' + ($changed -join '、') + '（版本号/更新源/套餐来自新版本；端口和开关等客户设置未动）')
          }
        }
      } catch {
        Write-WarnLine ('旧配置迁移时出错（不影响安装）：' + $_.Exception.Message)
      }
    }
  }

  if (-not $script:DryRunMode) {
    $missingTarget = New-Object System.Collections.ArrayList
    foreach ($rel in $requiredFiles) {
      if (-not (Test-Path -LiteralPath (Join-Path $script:InstallRoot $rel))) { [void]$missingTarget.Add($rel) }
    }
    if ($missingTarget.Count -gt 0) {
      Fail-Install ('安装目录里还缺 ' + [string]$missingTarget.Count + ' 个文件（' + ((@($missingTarget | Select-Object -First 5)) -join '、') + '）') `
        (@(
          '这通常是杀毒软件把程序文件删掉了。',
          '请先重新解压一次安装包，再双击安装包里的 install.cmd；',
          '找不到安装包的话：把这份报告发给卖家，让卖家重新发一份。'
        ) -join "`n")
    }
    Write-Ok '程序文件齐全'

    # ---- 内容校验（不是只查"在不在"）--------------------------------------
    # 真实事故（虚拟机实测）：复制出来的 .ps1 大小正确、内容全是 0x00，
    # 之后所有脚本在第 1 行就报 "The term ':' is not recognized"，
    # 而当时"文件齐全"这个检查是绿的 —— 因为它只用了 Test-Path。
    # 所以这里必须比对内容：
    #   · 全部必需文件：比大小 + 比开头 16 字节（零填充立刻暴露，几乎不耗时）
    #   · 脚本/配置类：整文件哈希（防止内容被替换成别的）
    $zeroed = New-Object System.Collections.ArrayList
    $mismatch = New-Object System.Collections.ArrayList
    $hashExts = @('.ps1', '.mjs', '.json', '.cmd', '.vbs')
    # 下面这些文件**允许**和安装包里不一样：它们是客户资产，复制时刻意被排除掉了。
    # 踩过的坑（虚拟机实测）：product.config.json 已经按"保留客户设置"跳过了复制，
    # 紧接着内容校验又拿它跟出厂值比对 → 必然不一致 → 整个安装在这里失败。
    # 自己的规则要前后一致：既然刻意不覆盖，就不能要求它等于出厂值。
    $contentSkip = @('product.config.json')
    foreach ($rel in $requiredFiles) {
      if ($contentSkip -contains $rel) { continue }
      $srcF = Join-Path $script:SourceDirFull $rel
      $dstF = Join-Path $script:InstallRoot $rel
      if (-not (Test-Path -LiteralPath $srcF) -or -not (Test-Path -LiteralPath $dstF)) { continue }
      try {
        $li = Get-Item -LiteralPath $dstF
        if ($li.Length -eq 0) { [void]$zeroed.Add($rel); continue }
        # 开头 16 字节全零 = 内容被清零的典型特征
        $fsD = [System.IO.File]::OpenRead($dstF)
        try {
          $buf = New-Object byte[] 16
          $n = $fsD.Read($buf, 0, 16)
          $allZero = $true
          for ($bi = 0; $bi -lt $n; $bi++) { if ($buf[$bi] -ne 0) { $allZero = $false; break } }
          if ($allZero) { [void]$zeroed.Add($rel); continue }
        } finally { $fsD.Dispose() }
        if (-not $li.Length -eq (Get-Item -LiteralPath $srcF).Length) { [void]$mismatch.Add($rel); continue }
        if ($hashExts -contains [System.IO.Path]::GetExtension($rel).ToLowerInvariant()) {
          if ((Get-FileHash -LiteralPath $srcF).Hash -ne (Get-FileHash -LiteralPath $dstF).Hash) { [void]$mismatch.Add($rel) }
        }
      } catch { }
    }
    if ($zeroed.Count -gt 0 -or $mismatch.Count -gt 0) {
      $detail = New-Object System.Collections.ArrayList
      if ($zeroed.Count -gt 0) { [void]$detail.Add('内容被清零：' + ((@($zeroed | Select-Object -First 6)) -join '、') + $(if ($zeroed.Count -gt 6) { ' 等 ' + $zeroed.Count + ' 个' } else { '' })) }
      if ($mismatch.Count -gt 0) { [void]$detail.Add('内容与安装包不一致：' + ((@($mismatch | Select-Object -First 6)) -join '、')) }
      Fail-Install ('程序文件复制后内容不对（' + $zeroed.Count + ' 个被清零，' + $mismatch.Count + ' 个不一致）') `
        (@(
          '这不是你操作的问题。按顺序试：',
          '  1) 关掉杀毒软件的拦截，重新双击安装包；',
          '  2) 重启这台电脑后再装一次（磁盘写入异常会导致文件变成空的）；',
          '  3) 还是这样：把这份报告发给卖家。',
          '',
          '细节：'
        ) + ($detail -join "`n") -join "`n")
    }
    Write-Ok '程序文件内容校验通过（哈希一致，没有被清零或替换）'

    # pnpm 链接必须在打包时解开；客户机上出现链接目录 = 包做坏了
    try {
      $nmDir = Join-Path $script:InstallRoot 'node_modules'
      $linkDirs = @(Get-ChildItem -LiteralPath $nmDir -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
      if ($linkDirs.Count -gt 0) {
        Fail-Install ('程序文件里有 ' + [string]$linkDirs.Count + ' 个“快捷方式”式目录（链接没有展开）') `
          '这个安装包在别的电脑上用不了。请把报告发给卖家，让卖家重新打包一份。'
      }
    } catch { }
  }

  # 重新读一次安装目录里的配置（后面的端口、开关都以安装目录里的为准）
  $cfg = $script:ConfigSource
  try {
    if (Test-Path -LiteralPath (Join-Path $script:InstallRoot 'product-config.ps1')) {
      $cfg = Get-ProductConfig -AppDir $script:InstallRoot
    }
  } catch { }

  # 自带 node 运行时：必须是打包时验证过的那一份（wrtc 原生模块 ABI 绑死 node 版本）
  $nodeToCheck = Join-Path $script:InstallRoot 'runtime\node.exe'
  if ($script:DryRunMode -and -not (Test-Path -LiteralPath $nodeToCheck)) { $nodeToCheck = $nodeInSource }
  $nodeVersion = ''
  if (Test-Path -LiteralPath $nodeToCheck) {
    try { $nodeVersion = [string]((& $nodeToCheck --version 2>$null) | Select-Object -First 1) } catch { $nodeVersion = '' }
  }
  if (-not $nodeVersion) {
    Fail-Install '自带的 node 运行时跑不起来' `
      (@(
        '安装包里的程序文件可能被杀毒软件删掉了。',
        '请把这份报告发给卖家；卖家会重新发一份，并教你怎么把安装目录加进杀毒软件的白名单。'
      ) -join "`n")
  }
  if ($nodeVersion -match '^v24\.21\.0') {
    Write-Ok ('自带 node 运行时正常（' + $nodeVersion + '）')
  } elseif ($nodeVersion -match '^v24\.') {
    Write-WarnLine ('自带 node 是 ' + $nodeVersion + '（验证过的是 v24.21.0）。同属 v24，一般可用；如果画面“流畅模式”黑屏，把报告发给卖家。')
  } else {
    # node 主版本不对 = wrtc 原生模块 ABI 不对，流畅模式一定黑屏。这是包做坏了，不能装。
    Fail-Install ('自带的 node 运行时版本不对（' + $nodeVersion + '，需要 v24.x）') `
      (@(
        '这不是你操作的问题：安装包里的程序版本不配套。',
        '请把这份报告发给卖家，让卖家重新发一份正确的安装包。',
        '（现在先不要往下装：装上去手机的“流畅模式”会黑屏。）'
      ) -join "`n")
  }

  # =========================================================================
  # 第 5 步：生成新密钥（客户机现场生成；绝不沿用卖家的）
  # =========================================================================
  $script:CurrentStepNo = 5
  $script:CurrentStep = '生成新的登录密钥'
  Write-Section '第 5 步 · 生成新的登录密钥'

  $keyFile = Join-Path $script:InstallRoot 'screen.key'
  if ($script:DryRunMode) {
    Write-Note '（干跑）会检查 / 生成一把 32 位十六进制的新密钥（不显示内容、不上传、不沿用卖家的旧密钥）'
  } else {
    $hasValidKey = $false
    if (Test-Path -LiteralPath $keyFile) {
      try {
        $existingKey = [string](Get-Content -LiteralPath $keyFile -Raw -ErrorAction Stop)
        if ($existingKey) {
          $existingKey = $existingKey.Trim()
          if ($existingKey -match '^[0-9a-fA-F]{32}$') { $hasValidKey = $true }
        }
      } catch { }
    }
    if ($hasValidKey) {
      Write-Ok '这台电脑已经有一把 32 位新密钥，继续沿用（手机上已经存过的网址不会失效）'
    } else {
      $keyBytes = New-Object byte[] 16
      $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
      $rng.GetBytes($keyBytes)
      $rng.Dispose()
      $newKey = ''
      foreach ($b in $keyBytes) { $newKey += $b.ToString('x2') }
      [System.IO.File]::WriteAllText($keyFile, $newKey, [System.Text.Encoding]::ASCII)
      Write-Ok '已生成一把全新的登录密钥（32 位十六进制，只存在这台电脑上）'
      Write-Note '这把密钥不显示、不上传，也不会沿用卖家电脑上的旧密钥。'
    }
  }

  # =========================================================================
  # 第 6 步：安全设置（防火墙只放 Tailscale + 防病毒放行）
  # =========================================================================
  $script:CurrentStepNo = 6
  $script:CurrentStep = '安全设置（防火墙 + 防病毒放行）'
  Write-Section '第 6 步 · 安全设置（防火墙 + 防病毒放行）'

  $natPorts = New-Object System.Collections.ArrayList
  if ($cfg) {
    [void]$natPorts.Add([int]$cfg.ports.screen)
    if ($cfg.enableDsh) { [void]$natPorts.Add([int]$cfg.ports.door) }
  } else {
    [void]$natPorts.Add(8660)
  }
  if ($script:DryRunMode) {
    Write-Note ('（干跑）会为端口 ' + (@($natPorts) -join '、') + ' 建防火墙规则：只允许 Tailscale 网段，拒绝局域网')
    if ($SkipDefender) { Write-Note '（干跑）按参数跳过防病毒放行' }
    else { Write-Note '（干跑）会把安装目录加入 Windows Defender 排除项' }
  } else {
    $firewallOk = $true
    try {
      Set-ProductFirewall -Ports @($natPorts)
    } catch {
      $firewallOk = $false
      Write-WarnLine ('防火墙规则没加上：' + [string]$_.Exception.Message)
    }
    if ($firewallOk) {
      Write-Ok ('已加防火墙规则：手机只能从 Tailscale 私有网络进来，同一个局域网里的其它设备进不来（端口 ' + (@($natPorts) -join '、') + '）')
    } else {
      Write-WarnLine '防火墙规则没加上：局域网里的其它设备也可能连上。手机照常能用，但请把报告发给卖家补这一步。'
    }

    if ($SkipDefender) {
      Write-Note '按参数跳过防病毒放行'
    } else {
      try {
        # 改动（第二轮 P0-2 附带）：排除项从"整个目录"改成"具体可执行文件"。
        # 排除整个目录 = 给"往这个目录里丢任何程序"发白名单；而安装根和 DshInput 都是
        # 普通用户可写目录，提权任务又从这里起进程，两者叠在一起就是提权链的一环。
        $inputDeployDir = Join-Path $env:LOCALAPPDATA 'DshInput'
        $pfRootInst = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
        $inputElevDir = Join-Path $pfRootInst 'PhoneAccessInput'
        # Add-MpPreference 只加不减：以前装过的"整目录"排除项必须显式删掉，否则改成文件级等于没改
        foreach ($oldExcl in @($script:InstallRoot, $inputDeployDir)) {
          if ($oldExcl) { try { Remove-MpPreference -ExclusionPath $oldExcl -ErrorAction SilentlyContinue } catch { } }
        }
        $exclFiles = @('capture.exe', 'input.exe', 'audio.exe', 'sources.exe', 'runtime\node.exe') |
          ForEach-Object { Join-Path $script:InstallRoot $_ }
        $exclFiles += (Join-Path $inputElevDir 'input.exe')
        foreach ($ef in $exclFiles) {
          try { $null = Add-MpPreference -ExclusionPath $ef -ErrorAction SilentlyContinue } catch { }
        }
        Write-Ok '已让 Windows Defender 放行本程序的几个可执行文件（它有时会把抓屏程序误判成病毒）'
      } catch {
        Write-WarnLine '没能自动加防病毒排除项（一般不影响使用，卖家会教你怎么手动加）'
      }
    }
  }

  # =========================================================================
  # 第 7 步：开机自动启动 + 每 2 分钟自动恢复
  # =========================================================================
  $script:CurrentStepNo = 7
  $script:CurrentStep = '注册开机自动启动'
  Write-Section '第 7 步 · 注册开机自动启动（重启后手机还能连）'

  $taskName = 'DSH Phone Access'
  if ($script:DryRunMode) {
    Write-Note '（干跑）会注册计划任务「DSH Phone Access」：登录 Windows 时自动启动 + 每 2 分钟自动检查恢复'
  } else {
    $vbsPath = Join-Path $script:InstallRoot 'run-autostart.vbs'
    if (-not (Test-Path -LiteralPath $vbsPath)) {
      Fail-Install '安装目录里缺少 run-autostart.vbs，无法设置开机自启' `
        '请把这份报告发给卖家；这通常是杀毒软件删除了程序文件。'
    }
    try {
      $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
      $userIdForTask = Get-CurrentUserName
      $action = New-ScheduledTaskAction -Execute $wscript -Argument ('//nologo "' + $vbsPath + '"') -WorkingDirectory $script:InstallRoot
      $principal = New-ScheduledTaskPrincipal -UserId $userIdForTask -LogonType Interactive -RunLevel Limited
      $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $userIdForTask
      $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration ([TimeSpan]::FromDays(3650))
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
      $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      if ($existingTask) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop }
      $null = Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal `
        -Trigger @($triggerLogon, $triggerRepeat) -Settings $settings -ErrorAction Stop `
        -Description '轻屏控制：登录时自动启动，并每 2 分钟自检恢复'
      Write-Ok '开机自启和自动恢复已经注册（重启后不用你手动点任何东西）'
# 2026-11-08：清理重复自启任务（历史版本装过 PhoneAccess Autostart 等别名，和 DSH Phone Access
# 都指向 run-autostart.vbs；两个任务各每 2 分钟跑一次 → 每分钟左右重复启动一次）。
try {
  $dupes = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.TaskName -ne $taskName -and ($_.Actions | Where-Object { $_.Arguments -match 'run-autostart\.vbs' })
  })
  foreach ($d in $dupes) {
    try {
      Unregister-ScheduledTask -TaskName $d.TaskName -TaskPath $d.TaskPath -Confirm:$false -ErrorAction Stop
      Write-Note ('已移除重复自启任务：' + $d.TaskName)
    } catch { }
  }
} catch { }

      # 已知限制（PACKAGING.md §6.2）：autostart.ps1 只等 WLAN|Wi-Fi 网卡别名拿地址。
      # 纯有线上网的机器重启后可能不会被拉起来。先告诉客户，别让他以为是安装坏了。
      try {
        $wlanIp = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
          Where-Object { $_.InterfaceAlias -match 'WLAN|Wi-Fi' -and $_.IPAddress -notlike '169.254.*' } |
          Select-Object -First 1)
        if (-not $wlanIp) {
          Write-WarnLine '这台电脑现在是有线上网（没检测到 Wi-Fi）。重启后“自动启动”这项在个别机器上可能不生效（已知限制）；装完把报告发给卖家，卖家会给你补一个设置。'
        }
      } catch { }
    } catch {
      Fail-Install ('注册开机自动启动失败：' + [string]$_.Exception.Message) `
        (@(
          '这通常是安全软件阻止了“计划任务”。',
          '请把这份报告发给卖家；卖家会教你（或远程帮你）把计划任务恢复。',
          '现在手机可能还能用，但重启后会自动断开，所以这一步不能跳过。'
        ) -join "`n")
    }
  }

  # =========================================================================
  # 第 8 步：高权限操作（管理员窗口也能点得动）
  # =========================================================================
  $script:CurrentStepNo = 8
  $script:CurrentStep = '开启高权限操作'
  Write-Section '第 8 步 · 开启高权限操作（以管理员运行的窗口也能点得动）'

  $elevScript = Join-Path $script:InstallRoot 'install-elevated-input.ps1'
  if ($script:DryRunMode) {
    Write-Note '（干跑）会注册计划任务「DSH Input Injector」，让远程点击在管理员权限的窗口上也有效'
  } elseif (Test-Path -LiteralPath $elevScript) {
    Write-Note '正在设置（约 10 秒）…'
    $psExeForElev = Get-PowerShellExe
    # 把子进程的原始输出留档：这一步要复制 exe、提升权限、注册计划任务，
    # 在陌生环境（刚装的系统、开了杀毒、特殊语言包）里失败形态很多，
    # 只看控制台上滚过去的红字很难定位。留一份文件，客户一发就能查。
    #
    # 为什么用 Start-Process 而不是 `& ... | Tee-Object`：
    # 一是能把 stdout / stderr 分别落到文件，诊断时拿到的是原始文本；
    # 二是管道会把 $LASTEXITCODE 变成整条管道的值，读不到子进程真实退出码。
    # 注意：powershell -File 只有在脚本里显式 exit N 时才传回退出码（运行时报错仍是 0），
    # 所以**成功判定以 elevated.enabled 标记文件为准**，退出码只作参考。
    $elevOutLog = Join-Path $script:InstallRoot 'elevated-step.log'
    $elevErrLog = Join-Path $script:InstallRoot 'elevated-step.err.log'
    foreach ($lf in @($elevOutLog, $elevErrLog)) {
      try { Remove-Item -LiteralPath $lf -Force -ErrorAction SilentlyContinue } catch { }
    }
    $elevRc = 1
    try {
      $spArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $elevScript + '"'))
      $ep = Start-Process -FilePath $psExeForElev -ArgumentList $spArgs -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput $elevOutLog -RedirectStandardError $elevErrLog
      if ($ep) { $elevRc = $ep.ExitCode }
    } catch {
      Write-WarnLine ('高权限设置这一步报错：' + $_.Exception.Message)
    }
    # 不管成败都把子进程做了什么回显出来（否则客户面对这一步是一片空白）
    foreach ($lf in @($elevOutLog, $elevErrLog)) {
      if (Test-Path -LiteralPath $lf) {
        Get-Content -LiteralPath $lf -Encoding UTF8 -ErrorAction SilentlyContinue |
          Where-Object { $_ -and $_.Trim() } | ForEach-Object { Write-Host ('    ' + $_) }
      }
    }
    # 改动（第二轮 P0-2 / I1）：成功判定不再只看"标记文件在不在"——标记文件以前在用户可写目录，
    # 谁都能造一个。现在要求**计划任务真的指向 %ProgramFiles%\PhoneAccessInput 里那份 exe** 才算成功。
    $pfRootElev = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
    $elevDir = Join-Path $pfRootElev 'PhoneAccessInput'
    $elevMarker = Join-Path $elevDir 'elevated.enabled'
    $elevTaskOk = $false
    try {
      $tElev = Get-ScheduledTask -TaskName 'DSH Input Injector' -ErrorAction SilentlyContinue
      if ($tElev) { $elevTaskOk = ([string](@($tElev.Actions)[0].Execute) -eq (Join-Path $elevDir 'input.exe')) }
    } catch { }
    if ($elevRc -eq 0 -and (Test-Path -LiteralPath $elevMarker) -and $elevTaskOk) {
      Write-Ok '高权限操作已开启（管理员窗口也能点得动）'
    } else {
      Write-WarnLine '高权限操作没开启成功。普通窗口照常能用，只有“以管理员身份运行”的窗口会点不动。'
      Write-WarnLine ('这一步的详细输出已存到：' + $elevOutLog + '（发给卖家即可）')
      # 解析类失败（编码/BOM/被杀毒改写）全靠这几个事实判断，一并记进来
      try {
        $eb = [System.IO.File]::ReadAllBytes($elevScript)
        $head = ($eb[0..([Math]::Min(7, $eb.Length - 1))] | ForEach-Object { $_.ToString('X2') }) -join ' '
        Add-Content -LiteralPath $elevOutLog -Value ('[诊断] 脚本首 8 字节: ' + $head + ' / 总字节: ' + $eb.Length) -Encoding UTF8
        $isAdminNow = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        Add-Content -LiteralPath $elevOutLog -Value ('[诊断] 安装器当前是否管理员: ' + $isAdminNow) -Encoding UTF8
        Add-Content -LiteralPath $elevOutLog -Value ('[诊断] powershell 路径: ' + $psExeForElev) -Encoding UTF8
        Add-Content -LiteralPath $elevOutLog -Value ('[诊断] 注入器 install.log 是否存在: ' + (Test-Path (Join-Path $elevDir 'install.log')) + ' / 旧位置 DshInput\install.log: ' + (Test-Path (Join-Path $env:LOCALAPPDATA 'DshInput\install.log'))) -Encoding UTF8
      } catch { }
    }
  } else {
    Write-WarnLine '安装目录里缺少 install-elevated-input.ps1，跳过这一步'
  }

  # =========================================================================
  # 第 9 步：启动服务
  # =========================================================================
  $script:CurrentStepNo = 9
  $script:CurrentStep = '启动程序'
  Write-Section '第 9 步 · 启动程序（约 30 秒）'

  $cfgFinal = $cfg
  if (-not $cfgFinal) { $cfgFinal = $script:ConfigSource }
  $screenPort = 8660
  if ($cfgFinal) { try { $screenPort = [int]$cfgFinal.ports.screen } catch { $screenPort = 8660 } }

  if ($script:DryRunMode) {
    Write-Note '（干跑）会启动画面服务、声音转发、远程注入和自动守护，然后等它连上'
  } else {
    $startScript = Join-Path $script:InstallRoot 'start-phone-access.ps1'
    if (-not (Test-Path -LiteralPath $startScript)) {
      Fail-Install '安装目录里缺少 start-phone-access.ps1，无法启动程序' `
        '请把这份报告发给卖家；这通常是杀毒软件删除了程序文件。'
    }
    Write-Note '正在启动画面服务…'
    # 启动脚本会把带密钥的手机网址打印出来。基础档下卖家不应拿到密钥，
    # 所以把它的输出重定向到临时文件后立刻删掉，屏幕上不留、报告里也不留。
    # （删不掉时先清空内容：宁可留个空文件，也不能把密钥留在硬盘上）
    $startLog = Join-Path $env:TEMP ('pa-install-start-' + (Get-Date -Format 'HHmmss') + '.log')
    $startErr = $startLog + '.err'
    $startRc = 1
    try {
      $startArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $startScript + '" -Quiet'
      $startProc = Start-Process -FilePath (Get-PowerShellExe) -ArgumentList $startArgs -WindowStyle Hidden `
        -RedirectStandardOutput $startLog -RedirectStandardError $startErr -PassThru -Wait -ErrorAction Stop
      if ($startProc) { $startRc = [int]$startProc.ExitCode }
    } catch {
      $startRc = 1
    }
    # 改动（第二轮 P4-1）：先**脱敏**再删。原来只是删，删不掉才清空——万一安装被杀在
    # "写完日志、还没删" 之间，磁盘上会留一份带完整 ?k= 的日志。现在改成：一拿到日志就
    # 把 k=<十六进制> 换成占位符，再走"删除（删不掉就留空文件）"的老路。
    foreach ($tmpLog in @($startLog, $startErr)) {
      if (Test-Path -LiteralPath $tmpLog) {
        try {
          $rawLog = [System.IO.File]::ReadAllText($tmpLog)
          $cleanLog = [regex]::Replace($rawLog, 'k=[0-9a-fA-F]{8,}', 'k=<已脱敏>')
          if ($cleanLog -ne $rawLog) {
            [System.IO.File]::WriteAllText($tmpLog, $cleanLog, (New-Object System.Text.UTF8Encoding($false)))
          }
        } catch { }
      }
    }
    foreach ($tmpLog in @($startLog, $startErr)) {
      for ($k = 0; $k -lt 5; $k++) {
        Remove-Item -LiteralPath $tmpLog -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $tmpLog)) { break }
        Start-Sleep -Milliseconds 300
      }
      if (Test-Path -LiteralPath $tmpLog) {
        try { [System.IO.File]::WriteAllText($tmpLog, '') } catch { }
      }
    }
    Add-Log ('[启动] start-phone-access.ps1 返回码 ' + [string]$startRc)

    $healthHost = Resolve-HealthHost -AppDir $script:InstallRoot -Config $cfgFinal
    $healthy = $false
    for ($i = 0; $i -lt 25; $i++) {
      if (Test-ProductHealth -HostIp $healthHost -Port $screenPort) { $healthy = $true; break }
      Start-Sleep -Seconds 2
    }
    if ($healthy) {
      Write-Ok '画面服务已经连上（手机可以看到了）'
    } else {
      Write-WarnLine '画面服务还没响应。可能还要再等一会儿，也可能是某一步没成。下面的自检会告诉我们具体是哪一项。'
    }
  }

  # =========================================================================
  # 第 10 步：客户自检（验收）
  # =========================================================================
  $script:CurrentStepNo = 10
  $script:CurrentStep = '客户自检（验收）'
  Write-Section '第 10 步 · 客户自检（验收）'

  $selfcheckPath = Join-Path $script:InstallRoot 'selfcheck.ps1'
  if ($script:DryRunMode) {
    Write-Note '（干跑）会运行 selfcheck.ps1 做验收，并把结论显示出来（报告存到「轻屏\报告」）'
  } elseif ($SkipSelfCheck) {
    Write-Note '按参数跳过验收'
  } elseif (-not (Test-Path -LiteralPath $selfcheckPath)) {
    Write-WarnLine '安装目录里缺少 selfcheck.ps1，跳过验收（不影响使用）'
  } else {
    $reportDir = Get-WritableReportDir
    $script:SelfReportPath = Join-Path $reportDir ('自检报告-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
    Write-Note '正在逐项检查（约 30 秒）。检查结果会写一份报告到「轻屏\报告」…'
    $psExeForCheck = Get-PowerShellExe
    # 2026-11-08 修：原来同步等 selfcheck 且无超时。自检里 tailscale status --json / query session
    # 在个别机器上会阻塞（实测 40+ 秒），安装器看起来就卡在第 10 步。现在：独立进程 + 最长 120 秒 + 进度提示。
    $checkProc = $null
    try {
      $checkProc = Start-Process -FilePath $psExeForCheck -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $selfcheckPath, '-Quiet', '-ReportPath', $script:SelfReportPath) -WindowStyle Hidden -PassThru
      $waited = 0
      $checkTimeout = 120
      while ($checkProc -and -not $checkProc.HasExited -and $waited -lt $checkTimeout) {
        Start-Sleep -Seconds 2
        $waited += 2
        if (($waited % 10) -eq 0) { Write-Host ('    自检进行中… ' + [string]$waited + 's（最多 ' + [string]$checkTimeout + 's）') -ForegroundColor Gray }
      }
      if ($checkProc -and -not $checkProc.HasExited) {
        Write-WarnLine '自检超过 120 秒还没结束，已跳过（不影响安装；装好后可双击桌面「自查」再跑）。'
        try { $checkProc.Kill() } catch { }
        try { & taskkill.exe /PID ([string]$checkProc.Id) /T /F 2>$null | Out-Null } catch { }
      }
    } catch {
      Write-WarnLine ('自检脚本没能运行完成：' + [string]$_.Exception.Message)
    }

    if (Test-Path -LiteralPath $script:SelfReportPath) {
      $reportLines = @()
      try { $reportLines = @(Get-Content -LiteralPath $script:SelfReportPath -Encoding UTF8 -ErrorAction Stop) } catch { $reportLines = @() }
      for ($i = 0; $i -lt $reportLines.Count; $i++) {
        if (([string]$reportLines[$i]) -match '一句话结论') {
          for ($j = $i + 1; $j -lt $reportLines.Count; $j++) {
            $candidate = ([string]$reportLines[$j]).Trim()
            if ($candidate) { $script:SelfVerdict = $candidate; break }
          }
          break
        }
      }
    }

    if ($script:SelfVerdict -match '有问题') {
      Write-BadLine ('自检结论：' + $script:SelfVerdict)
      Write-Host ''
      Write-Host '  自检发现了问题。请打开「轻屏\报告」里的自检报告，按里面“你该做什么”那条做。' -ForegroundColor Yellow
      Write-Host '  看不懂就把这份自检报告发给卖家，卖家会告诉你点哪里。' -ForegroundColor Yellow
    } elseif ($script:SelfVerdict -match '注意') {
      Write-WarnLine ('自检结论：' + $script:SelfVerdict)
      Write-Host '  这些不影响现在用，但建议按报告里的建议顺手处理一下。' -ForegroundColor Yellow
    } elseif ($script:SelfVerdict -match '正常') {
      Write-Ok ('自检结论：' + $script:SelfVerdict)
    } else {
      Write-WarnLine '自检没给出结论（可能没跑完）。请双击桌面「轻屏」文件夹里的「自查」再跑一次。'
    }
    if (Test-Path -LiteralPath $script:SelfReportPath) {
      Write-Note ('自检报告：' + $script:SelfReportPath)
    }
  }

  # =========================================================================
  # 第 11 步：高性能模式（Moonlight/Sunshine，可选组件，2026-11-03）
  # =========================================================================
  $script:CurrentStepNo = 11
  $script:CurrentStep = '高性能模式（Moonlight，可选）'
  Write-Section '第 11 步 · 高性能模式（Moonlight，可选）'

  $hpMsi = Join-Path $script:InstallRoot 'Sunshine-Windows-AMD64-installer.msi'
  $hpMsiSrc = Join-Path $script:SourceDirFull 'Sunshine-Windows-AMD64-installer.msi'
  $hpScript = Join-Path $script:InstallRoot 'sunshine-integration.ps1'
  if (-not (Test-Path -LiteralPath $hpScript)) { $hpScript = Join-Path $script:SourceDirFull 'sunshine-integration.ps1' }
  # 2026-11-12（用户反馈）：安装器先自己判断系统里是不是已经有 Sunshine。
  # 以前不管装没装都会问"现在安装吗"，装过的人每次升级都要再答一遍（选 Y 还会跑一次集成）。
  # 现在：已安装 → 不再询问、不再重装；之前已由本产品集成过（marker 存在）→ 整步跳过；
  #       只是用户自己装过 Sunshine、没有本产品配置 → 静默补一次配置
  #       （sunshine-integration.ps1 自己也会检测已安装并跳过 MSI，不会重装）。
  $hpMarker = Join-Path $script:InstallRoot 'sunshine-integration.json'
  $hpDetected = $false
  $hpDetectWhy = ''
  try {
    foreach ($p in @(
      (Join-Path $env:ProgramFiles 'Sunshine\sunshine.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Sunshine\sunshine.exe'),
      (Join-Path $env:LOCALAPPDATA 'Sunshine\sunshine.exe'),
      (Join-Path $env:ProgramData 'Sunshine\sunshine.exe')
    )) {
      if ($p -and (Test-Path -LiteralPath $p)) { $hpDetected = $true; $hpDetectWhy = $p; break }
    }
    if (-not $hpDetected) {
      $svcHp = Get-Service -Name 'SunshineService' -ErrorAction SilentlyContinue
      if ($svcHp) { $hpDetected = $true; $hpDetectWhy = 'SunshineService 服务' }
    }
    if (-not $hpDetected) {
      $procHp = Get-Process -Name 'sunshine' -ErrorAction SilentlyContinue
      if ($procHp) { $hpDetected = $true; $hpDetectWhy = 'Sunshine 进程' }
    }
    if (-not $hpDetected) {
      $keysHp = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
      $appHp = Get-ItemProperty $keysHp -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Sunshine' } | Select-Object -First 1
      if ($appHp) { $hpDetected = $true; $hpDetectWhy = [string]$appHp.DisplayName }
    }
  } catch { }
  $hpIntegrated = $hpDetected -and (Test-Path -LiteralPath $hpMarker)
  $hpSkipExisting = $hpIntegrated -and (-not $HighPerformance)
  if ($hpDetected) {
    Write-Note ('检测到系统已安装 Sunshine（' + $hpDetectWhy + '），不再询问、不重装')
    if ($hpSkipExisting) { Write-Note '本产品的高性能模式配置已存在（sunshine-integration.json），本步直接跳过' }
    else { Write-Note '还没应用过本产品的高性能配置：自动补一次配置（不重装 MSI）' }
  }
  $hpWant = [bool]$HighPerformance
  if (-not $hpDetected -and -not $hpWant -and -not $SkipHighPerformance -and -not $script:DryRunMode -and -not $script:NoPauseMode) {
    Write-Host ''
    Write-Host '可选组件：高性能模式（Moonlight / Sunshine）' -ForegroundColor Cyan
    Write-Host '  约 33 MB，需要网络；不装的话网页模式完全可用，以后也能在手机设置页补装。'
    $choiceExe = Join-Path $env:SystemRoot 'System32\choice.exe'
    $hpChoice = 2
    try {
      & $choiceExe /C YN /N /T 15 /D N /M '  现在安装吗？[Y=装 / N=跳过，15 秒后自动跳过] '
      $hpChoice = [int]$LASTEXITCODE
    } catch { $hpChoice = 2 }
    $hpWant = ($hpChoice -eq 1)
  }
  # 已安装但还没有本产品配置：不装 MSI，只自动应用一次配置（不改装、不联网下载）
  if ($hpDetected -and -not $hpWant -and -not $hpSkipExisting -and -not $SkipHighPerformance -and -not $script:DryRunMode -and -not $script:NoPauseMode) {
    $hpWant = $true
  }
  $hpNetOk = $true
  try { $hpNetOk = [System.Net.NetworkInformation.NetworkInterface]::GetIsNetworkAvailable() } catch { $hpNetOk = $false }
  if ($SkipHighPerformance) {
    Write-Note '按参数跳过高性能模式（网页模式照常可用）'
    $script:HpState = '按参数跳过'
  } elseif ($hpSkipExisting) {
    Write-Note 'Sunshine 已安装且已由本产品配置过，跳过（不重装、不重复改配置）'
    $script:HpState = '已安装（跳过）'
  } elseif ($script:DryRunMode) {
    Write-Note '（干跑）会安装并预配置 Sunshine（只绑 tailnet、自动随机凭据、防火墙收紧、只广播 H.264）'
    $script:HpState = '（干跑未执行）'
  } elseif (-not $hpWant) {
  Write-Note '未选择高性能组件，跳过（网页模式完全可用；以后可在手机设置页补装）'
  $script:HpState = '未选择（跳过）'
} elseif (-not $hpNetOk) {
  Write-WarnLine '当前没有网络：跳过高性能组件（网页模式照常可用）'
  $script:HpState = '无网络（跳过）'
} elseif ((-not (Test-Path -LiteralPath $hpMsi)) -and (-not (Test-Path -LiteralPath $hpMsiSrc))) {
  Write-Note '这个安装包没带高性能模式组件（没有 Sunshine 安装包），跳过；网页模式照常可用'
  $script:HpState = '未包含（跳过）'
} elseif (-not (Test-Path -LiteralPath $hpScript)) {
  Write-WarnLine '缺少 sunshine-integration.ps1，跳过高性能模式'
  $script:HpState = '缺少脚本（跳过）'
} else {
  $hpMsiUse = $hpMsi
  if (-not (Test-Path -LiteralPath $hpMsiUse)) { $hpMsiUse = $hpMsiSrc }
  Write-Note '正在安装/预配置 Sunshine（约 1–2 分钟）。它是独立程序（GPL-3.0），只用来给 Moonlight 提供低延迟通道…'
  $hpOk = $false
  $hpMsiBefore = @(Get-Process msiexec -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  try {
    $psExeHp = Get-PowerShellExe
    # 2026-11-06：机器上已装过 Sunshine 时这一步可能卡住；再套一层 5 分钟总超时。
    # 2026-11-08：超时后连同它拉起的 msiexec 一起结束，避免安装器一直挂着。
    $hpArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $hpScript, '-Action', 'install',
      '-AppDir', $script:InstallRoot, '-MsiPath', $hpMsiUse, '-Quiet')
    $hpProc = Start-Process -FilePath $psExeHp -ArgumentList $hpArgs -PassThru -WindowStyle Hidden
    $hpTimedOut = $false
    # 2026-11-08（用户要求）：Sunshine 安装/下载阶段给进度条，不再干等 5 分钟。
    $hpStart = Get-Date
    $hpMaxSec = 300
    while ($hpProc -and -not $hpProc.HasExited) {
      $hpElapsed = [int]((Get-Date) - $hpStart).TotalSeconds
      if ($hpElapsed -ge $hpMaxSec) { $hpTimedOut = $true; break }
      $hpPct = [int][Math]::Min(95, [Math]::Round($hpElapsed * 100.0 / $hpMaxSec))
      $barLen = 22
      $filled = [int][Math]::Round($hpPct * $barLen / 100.0)
      $bar = '[' + ('#' * $filled) + ('-' * ($barLen - $filled)) + ']'
      try { Write-Host ("`r    安装进度 " + $bar + ' ' + [string]$hpPct + '%  已用 ' + [string]$hpElapsed + 's / 最多 ' + [string]$hpMaxSec + 's ') -NoNewline -ForegroundColor Cyan } catch { }
      Start-Sleep -Seconds 2
    }
    try { Write-Host '' } catch { }
    if ($hpTimedOut) {
      try { Stop-Process -Id $hpProc.Id -Force -ErrorAction SilentlyContinue } catch { }
      try {
        $hpMsiAfter = @(Get-Process msiexec -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
        foreach ($mp in ($hpMsiAfter | Where-Object { $hpMsiBefore -notcontains $_ })) {
          try { Stop-Process -Id $mp -Force -ErrorAction SilentlyContinue } catch { }
        }
      } catch { }
      Write-WarnLine '高性能模式 5 分钟没结束，已强制结束这一步，继续安装其他部分（不影响网页模式）'
    } else {
      $hpOk = ($hpProc.ExitCode -eq 0)
    }
  } catch {
    Write-WarnLine ('高性能模式安装没能完成：' + [string]$_.Exception.Message)
  }
  if ($hpOk) {
    Write-Ok '高性能模式已就绪：手机装 Moonlight → 手机页「设置 → 高性能模式」输 PIN 配对'
    $script:HpState = '已就绪（手机装 Moonlight 后配对）'
  } else {
    Write-WarnLine '高性能模式没装成（不影响网页模式）；可重跑安装包或手动运行 sunshine-integration.ps1'
    $script:HpState = '未完成（不影响网页模式）'
  }
}
# =========================================================================
  # 第 12 步：收尾（桌面图标 + 手机入口 + 讲清楚接下来做什么）
  # =========================================================================
  $script:CurrentStepNo = 12
  $script:CurrentStep = '收尾（桌面文件夹 + 手机入口）'
  Write-Section '第 12 步 · 收尾（桌面文件夹 + 手机入口）'

  if ($script:DryRunMode) {
    Write-Note '（干跑）会在桌面创建「轻屏」文件夹，里面放 启动 / 自查 / 停止 三个图标'
    Write-Note '（干跑）会打开手机扫码入口'
    Write-Host ''
    Write-Host '干跑完成：没有改动任何东西（没复制文件、没改防火墙、没注册任务、没启动服务、没生成密钥）。' -ForegroundColor Green
    Write-Host '正式安装会按上面 12 步执行完毕，并在最后运行客户自检。' -ForegroundColor Green
    if (-not $script:NoPauseMode -and -not $script:NonInteractive) { $null = Read-Host '按回车键关闭窗口' }
    exit 0
  }

  # 改动（桌面整洁）：快捷方式不再放桌面根目录，统一放进「轻屏」文件夹
  $script:ShortcutIssues = New-Object System.Collections.ArrayList
  $desktopDir = Get-AccessFolder
  try {
    if (-not (Test-Path -LiteralPath $desktopDir)) { New-Item -ItemType Directory -Path $desktopDir -Force | Out-Null }
  } catch { }
  $shortcutStart = New-DesktopShortcut -Dir $desktopDir -Name '启动' `
    -TargetPath (Join-Path $script:InstallRoot 'start-phone-access.cmd') -WorkDir $script:InstallRoot `
    -FallbackScript 'start-phone-access.ps1' `
    -Description '启动轻屏控制（一般不需要手动点，开机会自动启动）'
  $shortcutCheck = New-DesktopShortcut -Dir $desktopDir -Name '自查' `
    -TargetPath (Join-Path $script:InstallRoot '自检.cmd') -WorkDir $script:InstallRoot `
    -FallbackScript 'selfcheck.ps1' `
    -Description '出问题时双击这个，按提示操作，把报告发给卖家'
  $shortcutStop = New-DesktopShortcut -Dir $desktopDir -Name '停止' `
    -TargetPath (Join-Path $script:InstallRoot 'stop-phone-access.cmd') -WorkDir $script:InstallRoot `
    -FallbackScript 'stop-phone-access.ps1' `
    -Description '临时停止轻屏控制'
  # 改动（用户要求）：桌面文件夹里加一个「重启」，画面卡住/改了配置时双击即可
  # 改动（第二轮 P1-3 / I2）：必须传 -FallbackScript，否则 COM 建 .lnk 失败降级成 .cmd 时
  # 会退回默认的 start-phone-access.ps1 —— 双击「重启」变成「启动」，双击「卸载」也变成「启动」。
  $shortcutRestart = New-DesktopShortcut -Dir $desktopDir -Name '重启' `
    -TargetPath (Join-Path $script:InstallRoot 'restart.cmd') -WorkDir $script:InstallRoot `
    -FallbackScript 'restart.ps1' `
    -Description '重启画面服务和入口（卡住时用）'
  $shortcutEntry = New-DesktopShortcut -Dir $desktopDir -Name '手机入口' `
    -TargetPath (Join-Path $script:InstallRoot '手机入口.cmd') -WorkDir $script:InstallRoot `
    -FallbackScript 'entry.ps1' `
    -Description '查看手机入口二维码，或换一把新密钥'
  # 离线模式（2026-11-06）：没有互联网/没有 Tailscale 时用局域网/电脑热点直连。
  # 双击后自动打开 screen.offline 开关、重启画面服务，并用默认浏览器打开手机直连地址（https）。
  $shortcutOffline = New-DesktopShortcut -Dir $desktopDir -Name '离线模式' `
    -TargetPath (Join-Path $script:InstallRoot '离线模式.cmd') -WorkDir $script:InstallRoot `
    -FallbackScript 'offline-mode.ps1' `
    -Description '没有互联网/Tailscale 时用：开局域网（https + WebRTC）并打开手机直连地址'
  # 关闭离线模式（2026-11-06）：恢复只监听本机/Tailscale，并撤销局域网的防火墙放行
  $shortcutOfflineOff = New-DesktopShortcut -Dir $desktopDir -Name '关闭离线模式' `
    -TargetPath (Join-Path $script:InstallRoot '关闭离线模式.cmd') -WorkDir $script:InstallRoot `
    -FallbackScript 'offline-mode-off.ps1' `
    -Description '关闭局域网访问：恢复只监听本机/Tailscale，并撤销防火墙放行'
  # 改动（用户要求：桌面文件夹里要有便利的控制程序和文档）：
  # 加一个「卸载」入口，并把客户说明书复制进去，客户不用回安装目录翻文件。
  # 改动（第二轮 P1-3 / I2）：同上，降级外壳必须真的去跑卸载，不能退回「启动」。
  $shortcutUninstall = New-DesktopShortcut -Dir $desktopDir -Name '卸载' `
    -TargetPath (Join-Path $script:InstallRoot 'uninstall.cmd') -WorkDir $script:InstallRoot `
    -FallbackScript 'uninstall.ps1' `
    -Description '把轻屏控制从这台电脑上卸掉（会二次确认）'
  $docSrc = Join-Path $script:InstallRoot '使用说明.md'
  if (Test-Path -LiteralPath $docSrc) {
    try {
      Copy-Item -LiteralPath $docSrc -Destination (Join-Path $desktopDir '使用说明.md') -Force
      Write-Ok '使用说明已放到桌面「轻屏」文件夹里'
    } catch {
      Write-WarnLine '使用说明没能复制到桌面（不影响使用）'
    }
  } else {
    Write-WarnLine '安装包里缺少 使用说明.md，桌面文档没放（不影响使用）'
  }
  $shortcutCount = 0
  foreach ($sc in @($shortcutStart, $shortcutCheck, $shortcutStop, $shortcutRestart, $shortcutEntry, $shortcutOffline, $shortcutOfflineOff, $shortcutUninstall)) { if ($sc) { $shortcutCount++ } }

  $folderReason = [string]$script:AccessFolderReason
  if ($shortcutCount -ge 2) {
    # 改动（第二轮 P3-3 / I3）：文案说 6 个、列表只写了 4 个，客户数一遍会以为少建了。
    Write-Ok ('已生成「轻屏」文件夹（' + [string]$shortcutCount + ' 个图标：启动 / 自查 / 停止 / 重启 / 手机入口 / 离线模式 / 关闭离线模式 / 卸载）')
    Write-Host ('    位置：' + $desktopDir) -ForegroundColor Gray
    if ($folderReason -and $folderReason -ne '用户桌面') {
      Write-WarnLine ('注意：你的桌面路径写不进去，图标放在了这里 → ' + $desktopDir)
    }
  } else {
    Write-WarnLine '桌面图标没能创建（不影响使用）。可以进安装文件夹双击 start-phone-access.cmd。'
  }
  # 不管成败都把细节摊开：客户/卖家发报告一看就知道卡在哪，不用猜
  if ($script:ShortcutIssues -and $script:ShortcutIssues.Count -gt 0) {
    Write-Host ('    快捷方式细节：') -ForegroundColor Gray
    foreach ($s in $script:ShortcutIssues) { Write-Host ('      · ' + $s) -ForegroundColor Gray }
  }
  Write-Host ('    桌面路径判定：' + $(if ($folderReason) { $folderReason } else { '用户桌面' })) -ForegroundColor Gray
  # 2026-11-08：把"建了什么/哪里失败"写进文件夹，客户和卖家都不用猜
  try {
    $infoLines = @()
    $infoLines += '轻屏 · 桌面文件夹信息'
    $infoLines += ('时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    $infoLines += ('文件夹位置：' + $desktopDir)
    $infoLines += ('桌面路径判定：' + $(if ($folderReason) { $folderReason } else { '用户桌面' }))
    $infoLines += ('快捷方式成功：' + [string]$shortcutCount + ' / 8')
    if ($script:ShortcutIssues -and $script:ShortcutIssues.Count -gt 0) {
      $infoLines += '创建细节：'
      foreach ($s in $script:ShortcutIssues) { $infoLines += ('  - ' + [string]$s) }
      $infoLines += '如果缺图标：多半是杀毒软件拦截了创建快捷方式；重跑一次安装包，或把安装目录里的同名 .cmd 发送到桌面即可。'
    } else {
      $infoLines += '创建细节：全部成功'
    }
    Set-Content -LiteralPath (Join-Path $desktopDir '桌面快捷方式信息.txt') -Value ($infoLines -join "`r`n") -Encoding utf8 -ErrorAction SilentlyContinue
  } catch { }

  # 手机入口：2026-11-09 改成「一个页面」。
  # 原来这里会依情况弹 图片查看器 / 记事本 / 资源管理器，客户装完一次看到好几个窗口，乱。
  # 现在统一生成「手机入口.html」（二维码 + 网址 + 机器码 + 接下来三步），用默认浏览器打开一次。
  # 生成失败才回退到原来的打开方式，保证任何情况下客户都能拿到入口信息。
  $qrPath = Join-Path $script:InstallRoot 'screen-qr.png'
  $urlFilePath = Join-Path $script:InstallRoot 'screen-url.txt'
  $urlWait = 0
  while ($urlWait -lt 30 -and -not (Test-Path -LiteralPath $qrPath) -and -not (Test-Path -LiteralPath $urlFilePath)) {
    Start-Sleep -Seconds 1
    $urlWait++
  }
  $entryOpened = $false
  $entryHtml = Join-Path $script:InstallRoot '手机入口.html'
  $entryScript = Join-Path $script:InstallRoot 'make-entry-html.ps1'
  if (Test-Path -LiteralPath $entryScript) {
    try {
      Write-Note '正在打开手机入口页面（二维码、网址、接下来要做的事都在这一页里）。'
      & (Get-PowerShellExe) -NoProfile -ExecutionPolicy Bypass -File $entryScript -InstallRoot $script:InstallRoot -Open | Out-Null
      if (Test-Path -LiteralPath $entryHtml) { $entryOpened = $true }
    } catch {
      $entryOpened = $false
      Add-Log ('[入口页] 生成失败，回退到逐个打开：' + $_.Exception.Message)
    }
  }
  if (-not $entryOpened) {
    # ---- 回退路径：保持原来的行为（只可能打开其中一个）----
    if (Test-Path -LiteralPath $qrPath) {
      Write-Note '正在打开手机扫码入口：用手机扫这个二维码（手机要先连上 Tailscale）。'
      try { $null = Start-Process -FilePath $qrPath } catch { Write-WarnLine '二维码没能自动打开，文件在：' + $qrPath }
    } elseif (Test-Path -LiteralPath $urlFilePath) {
      Write-Note '正在打开手机入口文件（里面是带密钥的网址，别截图发给别人）。'
      try { $null = Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $urlFilePath + '"') } catch { Write-WarnLine ('网址文件在：' + $urlFilePath) }
    } else {
      Write-WarnLine '手机入口文件 30 秒内还没生成（画面服务可能起得慢或没起来）。'
      Write-Host ('  手动入口：双击 ' + (Join-Path $script:InstallRoot '手机入口.cmd') + ' 生成二维码；或重新运行一次安装包。') -ForegroundColor Yellow
    }
  }

  # ---- 许可证 ---------------------------------------------------------------
  # 三种情况：
  #   a) 安装包里附带了 licence.json（卖家提前为客户签好的）→ 自动装好，客户零操作
  #   b) 安装目录里已有许可证（重装/升级）→ 保留不动，不覆盖
  #   c) 都没有 → 把机器码显示出来，让客户发给卖家（这是未授权时客户唯一要做的动作）
  $licSrc = Join-Path $script:SourceDirFull 'licence.json'
  $licDst = Join-Path $script:InstallRoot 'licence.json'
  if ((Test-Path -LiteralPath $licSrc) -and -not (Test-Path -LiteralPath $licDst)) {
    try { Copy-Item -LiteralPath $licSrc -Destination $licDst -Force; Write-Ok '安装包里附带了许可证，已装好。' } catch { }
  }

  $licState = $null
  try {
    $licStateScript = Join-Path $script:InstallRoot 'licence-state.ps1'
    if (Test-Path -LiteralPath $licStateScript) {
      & $licStateScript -AppDir $script:InstallRoot -Quiet | Out-Null
      $stateFile = Join-Path $script:InstallRoot 'licence.state.json'
      if (Test-Path -LiteralPath $stateFile) {
        $licState = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
      }
    }
  } catch { }

  $summaryPath = Save-InstallReport -Kind '完成'

  Write-Host ''
  Write-Host '============================================================' -ForegroundColor Green
  Write-Host '  安装完成' -ForegroundColor Green
  Write-Host '============================================================' -ForegroundColor Green
  Write-Host ''

  # 许可证状态放在最显眼的位置：未授权时这是客户唯一要做的动作
  if ($licState -and $licState.usable) {
    $expText = '永久'
    if ($licState.expires -and $licState.expires -ne 'never') { $expText = [string]$licState.expires }
    Write-Host ('  许可证：已授权（' + [string]$licState.name + ' / ' + $expText + '）') -ForegroundColor Green
    Write-Host ''
  } else {
    Write-Host '  ------------------------------------------------------------' -ForegroundColor Yellow
    Write-Host '  最后一步：把下面这串机器码发给卖家，换一份许可证' -ForegroundColor Yellow
    Write-Host '  ------------------------------------------------------------' -ForegroundColor Yellow
    Write-Host ''
    if ($licState -and $licState.machineCode) {
      Write-Host ('      ' + [string]$licState.machineCode) -ForegroundColor White
    } else {
      Write-Host '      （机器码没算出来，双击桌面「轻屏」文件夹里的「自查」可以看到）' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '  拿到许可证文件（licence.json）后，放进这个目录：'
    Write-Host ('      ' + $script:InstallRoot)
    Write-Host '  几秒内自动生效，不用重启。'
    Write-Host ''
    Write-Host '  在放好许可证之前，手机能打开网页，但画面和操作是暂停的。' -ForegroundColor Yellow
    Write-Host ''
  }

  Write-Host '  手机现在应该已经能看到这台电脑了。你还要做 3 件事：'
  Write-Host '    1) 手机上装 Tailscale，登录同一个账号（卖家会一步步教你）'
  Write-Host '    2) 关掉电脑自动睡眠：设置 → 系统 → 电源 → 屏幕和睡眠 → 两个都选“从不”'
  Write-Host '    3) 用手机扫刚才的二维码（或输入网址），确认能看到画面、点得动、能打字'
  Write-Host ''
  Write-Host '  然后重启一次电脑，再连一次 —— 重启后还能连，才算真的装好。' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  出问题：双击桌面「轻屏」文件夹里的「自查」，把里面的报告发给卖家。'
  Write-Host '  桌面入口：打开「轻屏」文件夹 → 启动 / 自查 / 停止 / 手机入口 / 离线模式'
  if ($summaryPath) {
    Write-Host ''
    Write-Host '  这次安装的报告（可以发给卖家留档）：'
    Write-Host ('    ' + $summaryPath)
  }
  Write-Host ''
  if (-not $script:NoPauseMode -and -not $script:NonInteractive) { $null = Read-Host '按回车键关闭窗口' }
  exit 0
}
catch {
  $stepNo = $script:CurrentStepNo
  $stepName = $script:CurrentStep
  try {
    Fail-Install ('第 ' + [string]$stepNo + ' 步「' + $stepName + '」出现意外错误') `
      '请把这份报告发给卖家，并告诉卖家你是在第几步看到这句话的。' ([string]$_.Exception.Message)
  } catch {
    Write-Host ''
    Write-BadLine ('安装中断：' + $script:CurrentStep + ' / ' + [string]$_.Exception.Message)
    if (-not $script:NoPauseMode -and -not $script:NonInteractive) { $null = Read-Host '按回车键关闭窗口' }
    exit 3
  }
}
