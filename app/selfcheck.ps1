param(
  [switch]$Quiet,          # 不等待"按回车"（给计划任务 / 自动化用）
  [string]$ReportPath = '', # 报告保存到指定路径（默认：桌面）
  [switch]$NoReport        # 不生成报告文件，只在屏幕上显示
)

# ============================================================================
# 手机远程访问 · 客户版一键自检（只读）
#
# 给谁用：不懂技术的客户。正式交付时由「自检.cmd」包一层双击运行
#         （Windows 默认执行策略会拦 .ps1 双击，这是机器行为不是本脚本的问题）。
#         手动运行：powershell -NoProfile -ExecutionPolicy Bypass -File "自检.ps1"
#
# 它做什么：把「现在能不能用、不能用的话该干什么」用大白话讲清楚，
#           并导出一份可以贴给卖家的 txt 报告。
# 它不做什么：不启动服务、不改配置、不停止任何进程、
#             不读取也不打印任何密钥 / cookie / token / 完整网址。
#
# ★★ 以后加检查项只动两处，绝对不要改主流程 ★★
#   1) 写一个探针函数，最后 return (New-SelfResult -Status ... -Detail ... -Tech ...)
#      Status 只能是 ok / warn / fail / unknown
#   2) 在「检查注册表」区加一行 Register-SelfCheck（-Probe { 你的函数 }）
#   主流程（Invoke-SelfChecks、Get-SelfReportLines、Write-SelfConsoleReport）
#   只遍历注册表，不认识任何具体检查项。
#
# 级别（-Severity）决定"这项坏了有多严重"，三档结论由级别自动算出来：
#   blocker  = 坏了手机就用不了            → fail 结论 🔴 有问题
#   caution  = 坏了还能用，但某个功能受损  → fail 结论 🟡 注意
#   cosmetic = 与能不能用无关，只进「小提示」→ 不改结论
# 所以想加一项"能直接让客户知道用不了"的检查，Severity 用 blocker 即可，
# 不需要碰任何渲染 / 结论代码。
# ============================================================================

$ErrorActionPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$script:SelfVersion = '1.0'
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }

# ---------------------------------------------------------------------------
# 0. 复用 product-config.ps1（与启动脚本同源：配置读取 / 运行时发现 / 端口 / Tailscale）
# ---------------------------------------------------------------------------
$cfgScript = Join-Path $here 'product-config.ps1'
if (-not (Test-Path -LiteralPath $cfgScript)) {
  Write-Host ''
  Write-Host '🔴 有问题：这台电脑上的程序不完整（缺少 product-config.ps1）。' -ForegroundColor Red
  Write-Host '   这不是你操作的问题。请把这句话截图发给卖家，让他们重新安装。' -ForegroundColor Yellow
  if (-not $Quiet) { Read-Host '按回车键关闭窗口' }
  exit 1
}
. $cfgScript

$cfg = Get-ProductConfig -AppDir $here

# 共享缓存：同一份信息被多个检查用到时只查一次（不改任何东西，纯缓存）
$script:TsCache = $null
$script:HealthCache = $null
$script:SupCache = $null

# ---------------------------------------------------------------------------
# 1. 通用小工具
# ---------------------------------------------------------------------------
function New-SelfResult {
  param(
    [string]$Status = 'unknown',   # ok / warn / fail / unknown
    [string]$Detail = '',          # 给客户看的一句话（白话）
    [string]$Tech = '',            # 给卖家排查用的技术细节（报告里才有）
    [string]$Advice = ''           # 特殊情况才填；不填就用注册时的 -Advice
  )
  return [pscustomobject]@{ Status = $Status; Detail = $Detail; Tech = $Tech; Advice = $Advice }
}

function ConvertTo-NumberOr {
  param($Value, [double]$Default = -1)
  $n = 0.0
  if ([double]::TryParse([string]$Value, [ref]$n)) { return $n }
  return $Default
}

function Get-SelfProcessCount {
  param([string]$Name)
  try { return @(Get-Process -Name $Name -ErrorAction SilentlyContinue).Count } catch { return 0 }
}

function Format-IdleSeconds {
  param([long]$Seconds)
  if ($Seconds -le 0) { return '从不' }
  if ($Seconds -lt 120) { return ([string]$Seconds + ' 秒') }
  if ($Seconds -lt 7200) { return ([string][math]::Round($Seconds / 60) + ' 分钟') }
  return ([string][math]::Round($Seconds / 3600, 1) + ' 小时')
}

# ---------------------------------------------------------------------------
# 2. 共享信息读取（只读，带缓存）
# ---------------------------------------------------------------------------

# Tailscale：可执行文件 + 连接状态 + 原始 status JSON（授权到期时间在 JSON 里）
function Get-SelfTailscale {
  if ($null -ne $script:TsCache) { return $script:TsCache }

  $res = Resolve-ProductRuntime -AppDir $here -Name 'tailscale' -Config $cfg -WellKnownDirs (Get-TailscaleWellKnownDirs)
  $info = [pscustomobject]@{ Ip = ''; DnsName = ''; Running = $false; Note = '' }
  $json = $null
  if ($res.Path) {
    try { $info = Get-TailscaleInfo -TailscaleExe $res.Path } catch { }
    try {
      $raw = (& $res.Path status --json 2>$null | Out-String)
      if ($raw -and $raw.Trim()) { $json = $raw | ConvertFrom-Json }
    } catch { $json = $null }
  }

  $script:TsCache = [pscustomobject]@{ Path = $res.Path; Tried = $res.Tried; Info = $info; Json = $json }
  return $script:TsCache
}

# 手机网址文件里的主机地址。只取主机，绝不把整条网址（含密钥）带出来。
function Get-SelfEntryHost {
  $f = Join-Path $here 'screen-url.txt'
  try {
    if (Test-Path -LiteralPath $f) {
      $u = (Get-Content -LiteralPath $f -Raw -ErrorAction Stop).Trim()
      $m = [regex]::Match($u, '^https?://([^:/]+)')
      if ($m.Success) { return $m.Groups[1].Value }
    }
  } catch { }
  return ''
}

# 画面服务的 /health。只用于读数字，不打印网址；不需要密钥（本机自连）。
function Get-SelfHealth {
  if ($null -ne $script:HealthCache) { return $script:HealthCache }

  $port = [int]$cfg.ports.screen
  $hostIp = [string](Get-SelfTailscale).Info.Ip
  if (-not $hostIp) { $hostIp = Get-SelfEntryHost }
  if (-not $hostIp) { $hostIp = '127.0.0.1' }
  $url = 'http://' + $hostIp + ':' + $port + '/health'

  $text = ''
  for ($k = 0; $k -lt 3 -and -not $text; $k++) {
    try { $text = (& curl.exe -s --max-time 4 $url) -join '' } catch { $text = '' }
    if (-not $text) { Start-Sleep -Milliseconds 300 }
  }

  $script:HealthCache = [pscustomobject]@{
    Ok   = [bool]($text -match '^(ok|no-frame)')
    Text = [string]$text
    Port = $port
  }
  return $script:HealthCache
}

# 从 /health 文本里取普通字段：age=0.1 viewers=0
function Get-HealthToken {
  param([string]$Text, [string]$Name)
  if (-not $Text) { return '' }
  $m = [regex]::Match($Text, '(?:^|\s)' + [regex]::Escape($Name) + '=([^\s]+)')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

# 从 /health 文本里取内嵌 JSON：input={"connected":true,...}
function Get-HealthJson {
  param([string]$Text, [string]$Name)
  if (-not $Text) { return $null }
  $m = [regex]::Match($Text, [regex]::Escape($Name) + '=(\{[^}]*\})')
  if ($m.Success) {
    try { return ($m.Groups[1].Value | ConvertFrom-Json) } catch { return $null }
  }
  return $null
}

# 自动恢复程序（supervise.ps1）的进程数与心跳年龄
function Get-SelfSupervisorInfo {
  if ($null -ne $script:SupCache) { return $script:SupCache }

  $count = -1
  try {
    $count = @(Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { $_.Name -match 'powershell' -and $_.CommandLine -match 'supervise\.ps1' }).Count
  } catch { $count = -1 }

  $age = -1
  $beat = Join-Path $here 'supervisor.heartbeat'
  try {
    if (Test-Path -LiteralPath $beat) { $age = ((Get-Date) - (Get-Item -LiteralPath $beat).LastWriteTime).TotalSeconds }
  } catch { $age = -1 }

  $script:SupCache = [pscustomobject]@{ Count = $count; HeartbeatAge = $age }
  return $script:SupCache
}

# 跑一个短命 node 探针验证 @roamhq/wrtc（原生模块）能不能加载。
# 只读：进程读完就退出，超时就杀掉（杀的是自己刚起的探针，不是别人的进程）。
function Invoke-SelfWrtcProbe {
  param([string]$NodeExe)

  $tempRoot = $env:TEMP
  if (-not $tempRoot) { $tempRoot = $here }
  $outFile = Join-Path $tempRoot ('pa-wrtc-' + [guid]::NewGuid().ToString('N') + '.out')
  $errFile = $outFile + '.err'
  # 注意：这段代码里不能有空格，Start-Process 传参时才不会被拆开
  $code = "try{require('@roamhq/wrtc');console.log('WRTC_OK')}catch(e){console.log('WRTC_FAIL')}"

  $proc = $null
  try {
    $proc = Start-Process -FilePath $NodeExe -ArgumentList @('-e', $code) -WorkingDirectory $here `
      -WindowStyle Hidden -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile -ErrorAction Stop
    $finished = $false
    try { Wait-Process -Id $proc.Id -Timeout 12 -ErrorAction Stop; $finished = $true } catch { $finished = $false }
    if (-not $finished) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
      return 'timeout'
    }
    $text = ''
    try { $text = [string](Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue) } catch { $text = '' }
    return $text
  } catch {
    return ('error: ' + $_.Exception.Message)
  } finally {
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# 3. 每个检查一个探针函数（加新检查 = 在这里加一个函数 + 第 4 节加一行注册）
# ---------------------------------------------------------------------------

function Test-SelfOs {
  try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch {
    return New-SelfResult 'unknown' '读不到系统信息（权限不足）' 'CIM Win32_OperatingSystem 查询失败'
  }
  $build = 0
  try { $build = [int]$os.BuildNumber } catch { $build = 0 }
  $arch = [string]$os.OSArchitecture
  $caption = ([string]$os.Caption).Trim()
  $is64 = ($arch -match '64')
  $tech = ('Caption={0}; Build={1}; Arch={2}' -f $caption, $build, $arch)

  if ($build -ge 19041 -and $is64) {
    $shortCaption = ($caption -replace '^Microsoft\s+', '')
    return New-SelfResult 'ok' ($shortCaption + ' build ' + $build + '（64 位）') $tech
  }
  if (-not $is64) {
    return New-SelfResult 'fail' '这台电脑是 32 位系统，装不了这套功能' $tech `
      -Advice '把报告发给卖家，商量换一台 64 位、Windows 10（2004 版）以上的电脑。'
  }
  return New-SelfResult 'fail' '系统版本太老（需要 Windows 10 2004 版以上）' $tech `
    -Advice '把报告发给卖家，商量升级系统或换电脑。'
}

function Test-SelfTailscale {
  $ts = Get-SelfTailscale
  if (-not $ts.Path) {
    return New-SelfResult 'fail' '电脑上没找到 Tailscale' ('已尝试：' + ($ts.Tried -join '；')) `
      -Advice '这台电脑没装 Tailscale（手机连电脑的通道）。联系我们装，别自己装，装错了要重来。'
  }

  $running = [bool]$ts.Info.Running
  $ip = [string]$ts.Info.Ip
  $state = ''
  $expiry = $null
  if ($ts.Json) {
    try { $state = [string]$ts.Json.BackendState } catch { $state = '' }
    try { if ($state -eq 'Running') { $running = $true } } catch { }
    try { if ($ts.Json.Self.KeyExpiry) { $expiry = [datetime]$ts.Json.Self.KeyExpiry } } catch { $expiry = $null }
  }
  # Tailscale 关掉 "key expiry" 时 JSON 里给的是 0001-01-01，别把它当成"已过期"
  if ($expiry -and $expiry.Year -lt 2000) { $expiry = $null }
  $tech = ('BackendState={0}; IP={1}; KeyExpiry={2}' -f $state, $ip, $(if ($expiry) { $expiry.ToLocalTime().ToString('yyyy-MM-dd') } else { '' }))

  if (-not $running -or -not $ip) {
    return New-SelfResult 'fail' 'Tailscale 装了，但电脑这边没有连上' $tech `
      -Advice '打开电脑右下角的 Tailscale 图标，点「连接」；手机上也打开 Tailscale，然后重新跑一次自检。'
  }

  if ($expiry) {
    $days = [int][math]::Floor(($expiry.ToLocalTime() - (Get-Date)).TotalDays)
    if ($days -le 14) {
      $when = if ($days -lt 0) { '已经过期' } else { ([string]$days + ' 天后到期（' + $expiry.ToLocalTime().ToString('yyyy-MM-dd') + '）') }
      return New-SelfResult 'warn' ('现在能连，但 Tailscale 的授权 ' + $when) $tech `
        -Advice '把报告发给卖家续期。到期那天手机上所有入口会突然打不开。'
    }
  }
  return New-SelfResult 'ok' ('已连接（私有网络地址 ' + $ip + '）') $tech
}

function Test-SelfScreenService {
  $port = [int]$cfg.ports.screen
  $listeners = @()
  try { $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) } catch { $listeners = @() }

  if ($listeners.Count -eq 0) {
    return New-SelfResult 'fail' ('画面服务没在运行（端口 ' + $port + ' 没人应答）') ('无进程监听端口 ' + $port) `
      -Advice '双击电脑上的「启动」图标，等 2 分钟再跑一次自检；还不行把报告发给卖家。'
  }

  $conflict = Test-ProductPortConflict -Port $port -OwnPattern 'screen-server\.mjs'
  if ($conflict) {
    $who = '一个读不到名字的程序'
    if ($conflict.Name) { $who = ($conflict.Name + '（pid ' + $conflict.Pid + '）') }
    else { $who = ('另一个程序（pid ' + $conflict.Pid + '）') }
    return New-SelfResult 'fail' ('端口 ' + $port + ' 被别的软件占用了：' + $who) ('port=' + $port + '; pid=' + $conflict.Pid) `
      -Advice '联系我们换一个端口（改配置的活由我们做，你不用动）。'
  }

  $addresses = @($listeners | ForEach-Object { [string]$_.LocalAddress } | Sort-Object -Unique)
  $tech = ('port={0}; listen={1}' -f $port, ($addresses -join ','))
  $tsIp = [string](Get-SelfTailscale).Info.Ip
  if ($tsIp) {
    $onPrivate = @($listeners | Where-Object {
        [string]$_.LocalAddress -eq $tsIp -or [string]$_.LocalAddress -eq '0.0.0.0' -or [string]$_.LocalAddress -eq '::'
      })
    if ($onPrivate.Count -eq 0) {
      return New-SelfResult 'warn' '画面服务在运行，但没在私有网络地址上监听（手机走 Tailscale 会连不上）' $tech `
        -Advice '重启这台电脑；还不行把报告发给卖家。'
    }
  }
  return New-SelfResult 'ok' ('正在运行（端口 ' + $port + '）') $tech
}

function Test-SelfCapture {
  $count = Get-SelfProcessCount 'capture'
  if ($count -eq 1) {
    $proc = Get-Process -Name 'capture' -ErrorAction SilentlyContinue | Select-Object -First 1
    $mb = 0
    $procId = ''
    if ($proc) { $mb = [math]::Round($proc.WorkingSet64 / 1MB); $procId = [string]$proc.Id }
    return New-SelfResult 'ok' ('屏幕读取组件正常运行（pid ' + $procId + '，占用 ' + $mb + 'MB）') ('capture.exe count=1; pid=' + $procId + '; ws=' + $mb + 'MB')
  }
  if ($count -eq 0) {
    return New-SelfResult 'fail' '负责读屏幕的组件没在运行，手机看不到画面' 'capture.exe count=0' `
      -Advice '重启这台电脑（重启后请登录一次），等 2 分钟再跑自检；还不行把报告发给卖家。'
  }
  return New-SelfResult 'warn' ('有 ' + $count + ' 个重复的屏幕读取进程（正常应该只有 1 个）') ('capture.exe count=' + $count) `
    -Advice '重启这台电脑后重跑自检。'
}

function Test-SelfTailnetAccess {
  $health = Get-SelfHealth
  $port = [int]$cfg.ports.screen
  if ($health.Ok) {
    return New-SelfResult 'ok' '画面服务的连接是通的（模拟手机的访问方式测试通过）' ('GET /health -> 200/503, port=' + $port + ', body-prefix=' + $health.Text.Substring(0, [math]::Min(12, $health.Text.Length)))
  }

  $ts = Get-SelfTailscale
  if (-not $ts.Info.Running -or -not $ts.Info.Ip) {
    return New-SelfResult 'unknown' 'Tailscale 没连上，这一项没法测' 'tailscale not running; skip health probe'
  }
  return New-SelfResult 'fail' '从电脑自己这边都打不开画面服务，手机肯定也打不开' ('GET /health on tailnet ip:' + $port + ' 无响应') `
    -Advice '先在手机和电脑上都打开 Tailscale，再跑一次自检；还不行把报告发给卖家。'
}

function Test-SelfSession {
  $raw = ''
  try { $raw = (query session 2>&1 | Out-String) } catch { $raw = '' }
  if (-not $raw -or -not $raw.Trim()) {
    return New-SelfResult 'unknown' '没法读取电脑的登录状态（可能是权限不足）' 'query session 无输出'
  }
  $lines = @($raw -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
  $consoleLines = @($lines | Where-Object { $_ -match '^\s*>?\s*console\b' })
  $currentLine = @($lines | Where-Object { $_ -match '^\s*>\s*console\b' })

  if ($currentLine.Count -gt 0) {
    return New-SelfResult 'ok' '电脑已登录，桌面在运行（锁屏没关系）' 'console session active (current marker)'
  }
  if ($consoleLines.Count -gt 0) {
    $line = [string]$consoleLines[0]
    if ($line -match 'Disc|断开') {
      return New-SelfResult 'warn' '电脑的桌面会话断开了（注销、切换用户或远程会话断开后会这样）' 'console session disconnected' `
        -Advice '去电脑前重新登录一次（锁屏可以，注销不行）。登录后 2 分钟内会自动恢复。'
    }
    return New-SelfResult 'ok' '检测到正在运行的桌面会话' 'console session line present'
  }
  return New-SelfResult 'warn' '没看到正在使用的桌面登录会话' 'no console session line' `
    -Advice '去电脑前登录一次；如果是刚重启，登录后等 2 分钟再跑一次自检。'
}

function Test-SelfTask {
  $taskName = 'DSH Phone Access'
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    return New-SelfResult 'warn' '负责自动启动和自愈的定时任务不存在' ('scheduled task "' + $taskName + '" missing') `
      -Advice '现在还能用，但重启后手机就连不上。把报告发给卖家，让我们重新注册这个任务。'
  }
  $state = [string]$task.State
  $rep = @($task.Triggers | Where-Object { $_.Repetition.Interval }) | Select-Object -First 1
  $lastRun = ''
  $nextRun = ''
  try {
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
    if ($info.LastRunTime) { $lastRun = ([datetime]$info.LastRunTime).ToString('MM-dd HH:mm') }
    if ($info.NextRunTime) { $nextRun = ([datetime]$info.NextRunTime).ToString('MM-dd HH:mm') }
  } catch { }
  $tech = ('state={0}; lastRun={1}; nextRun={2}; repetition={3}' -f $state, $lastRun, $nextRun, $(if ($rep) { $rep.Repetition.Interval } else { 'none' }))

  if ($state -eq 'Disabled') {
    return New-SelfResult 'warn' '负责自动启动和自愈的定时任务被禁用了' $tech `
      -Advice '把报告发给卖家，让我们重新启用（你自己在任务计划程序里改容易改错）。'
  }
  if (-not $rep) {
    return New-SelfResult 'warn' '定时任务没有定时检查（出问题不会自动恢复）' $tech `
      -Advice '把报告发给卖家重新注册这个任务。'
  }
  return New-SelfResult 'ok' ('系统定时检查已就绪（上次 ' + $lastRun + '，下次 ' + $nextRun + '）') $tech
}

function Test-SelfSupervisor {
  $sup = Get-SelfSupervisorInfo
  if ($sup.Count -lt 0) {
    return New-SelfResult 'unknown' '读不到自动恢复程序的状态（权限不足）' 'CIM Win32_Process 查询失败'
  }
  if ($sup.Count -eq 0) {
    return New-SelfResult 'warn' '自动恢复程序没在运行（系统会在 2 分钟内自动拉起）' 'supervise.ps1 count=0' `
      -Advice '等 2 分钟再跑一次自检；还是这样把报告发给卖家。'
  }
  if ($sup.Count -gt 1) {
    return New-SelfResult 'warn' ('有 ' + $sup.Count + ' 个自动恢复程序（正常只有 1 个）') ('supervise.ps1 count=' + $sup.Count) `
      -Advice '重启这台电脑后重跑自检。'
  }
  if ($sup.HeartbeatAge -lt 0) {
    return New-SelfResult 'warn' '自动恢复程序在跑，但没找到它的心跳文件' 'supervisor.heartbeat missing' `
      -Advice '等 1 分钟再跑一次自检；还是这样把报告发给卖家。'
  }
  if ($sup.HeartbeatAge -gt 60) {
    return New-SelfResult 'warn' ('自动恢复程序在跑，但已经 ' + [math]::Round($sup.HeartbeatAge) + ' 秒没动静了') ('heartbeat age=' + [math]::Round($sup.HeartbeatAge, 1) + 's') `
      -Advice '等 2 分钟再跑一次自检；还是这样把报告发给卖家。'
  }
  return New-SelfResult 'ok' ('自动恢复程序正常运行（' + [math]::Round($sup.HeartbeatAge) + ' 秒前刚检查过一次）') ('supervise.ps1 count=1; heartbeat=' + [math]::Round($sup.HeartbeatAge, 1) + 's')
}

function Test-SelfInput {
  $count = Get-SelfProcessCount 'input'
  if ($count -eq 0) {
    return New-SelfResult 'fail' '手机能看见画面，但点不动（远程操作组件没在运行）' 'input.exe count=0' `
      -Advice '重启这台电脑并登录，等 2 分钟再试；还不行把报告发给卖家。'
  }
  if ($count -gt 1) {
    return New-SelfResult 'warn' ('有 ' + $count + ' 个远程操作组件（正常只有 1 个）') ('input.exe count=' + $count) `
      -Advice '重启这台电脑后重跑自检。'
  }

  $detail = '远程操作组件正常运行'
  $status = 'ok'
  $advice = ''
  $tech = 'input.exe count=1'
  $health = Get-SelfHealth
  if ($health.Ok) {
    $ji = Get-HealthJson $health.Text 'input'
    if ($ji) {
      $sent = 0
      $errors = 0
      $blocked = 0
      try { $sent = [int]$ji.sent } catch { $sent = 0 }
      try { $errors = [int]$ji.errors } catch { $errors = 0 }
      try { $blocked = [int]$ji.blocked } catch { $blocked = 0 }
      $tech = ('input.exe count=1; connected={0}; sent={1}; errors={2}; blocked={3}' -f [string]$ji.connected, $sent, $errors, $blocked)
      if (-not [bool]$ji.connected) {
        $status = 'warn'
        $detail = '远程操作组件在运行，但没连上画面服务'
        $advice = '重启这台电脑后重跑自检；还不行把报告发给卖家。'
      } elseif ($blocked -gt 0) {
        $blkAge = ConvertTo-NumberOr (Get-HealthToken $health.Text 'blkage') -1
        if ($blkAge -ge 0 -and $blkAge -lt 60000) {
          $status = 'warn'
          $detail = '刚才有操作被挡住了（前台是管理员权限的窗口时会这样）'
          $advice = '把那个以管理员身份运行的窗口关掉或切到后台，再试一次。'
        } elseif ($sent -gt 0) {
          $detail = ('远程操作组件正常运行（历史上手机操作成功过 ' + $sent + ' 次）')
        }
      } elseif ($sent -gt 0) {
        $detail = ('远程操作组件正常运行（历史上手机操作成功过 ' + $sent + ' 次）')
      }
      if ($detail -eq '远程操作组件正常运行' -and $errors -gt 0) {
        $detail = ('远程操作组件正常运行（历史上有 ' + $errors + ' 次没送进去）')
      }
    }
  }

  if ($status -eq 'ok') { return New-SelfResult 'ok' $detail $tech }
  return New-SelfResult $status $detail $tech -Advice $advice
}

function Test-SelfFrame {
  $health = Get-SelfHealth
  if (-not $health.Ok) {
    return New-SelfResult 'unknown' '读不到画面服务的状态' ('/health 无响应, port=' + $health.Port) `
      -Advice '先处理上面标红的项；还不行把报告发给卖家。'
  }
  $viewers = [int](ConvertTo-NumberOr (Get-HealthToken $health.Text 'viewers') 0)
  $age = ConvertTo-NumberOr (Get-HealthToken $health.Text 'age') -1
  $outFps = ConvertTo-NumberOr (Get-HealthToken $health.Text 'out') -1
  $inFps = ConvertTo-NumberOr (Get-HealthToken $health.Text 'in') -1
  $mode = [string](Get-HealthToken $health.Text 'mode')
  $tech = ('viewers={0}; age={1}; out={2}; in={3}; mode={4}' -f $viewers, $age, $outFps, $inFps, $mode)

  # 服务自己说 no-frame：连"暂停"都算不上，是它根本没拿到过画面（抓屏管线没通）
  if ($health.Text -match '^no-frame') {
    return New-SelfResult 'warn' '画面服务在运行，但还没拿到画面数据（抓屏管线没通）' $tech `
      -Advice '重启这台电脑（重启后请登录一次），等 2 分钟再跑自检；还不行把报告发给卖家。'
  }
  if ($viewers -le 0) {
    return New-SelfResult 'ok' '现在没有手机在看，画面自动暂停（正常，省流量）' $tech
  }
  if ($age -lt 0) {
    return New-SelfResult 'warn' '有手机在看，但还没有画面数据传过来' $tech `
      -Advice '在手机上刷新一下页面；如果电脑锁屏了，去动一下鼠标。还不行重启电脑。'
  }
  if ($age -le 10) {
    return New-SelfResult 'ok' ('有 ' + $viewers + ' 台设备在看，画面 ' + [math]::Round($age, 1) + ' 秒前刷新过') $tech
  }
  return New-SelfResult 'warn' ('有手机在看，但画面停住了（已经 ' + [math]::Round($age) + ' 秒没更新）') $tech `
    -Advice '在手机上刷新页面；还不行重启这台电脑。'
}

function Test-SelfSmooth {
  $wrtcDir = Join-Path $here 'node_modules\@roamhq\wrtc'
  if (-not (Test-Path -LiteralPath $wrtcDir)) {
    return New-SelfResult 'warn' '产品包里没有「流畅模式」组件（这是打包问题，不是你用坏了）' 'node_modules/@roamhq/wrtc missing' `
      -Advice '先把报告发给卖家。在这之前用「清晰」模式不影响看屏幕。'
  }
  $nodeRes = Resolve-ProductRuntime -AppDir $here -Name 'node' -Config $cfg
  if (-not $nodeRes.Path) {
    return New-SelfResult 'unknown' '找不到 node，没法测试流畅模式' ('node resolve failed; tried=' + ($nodeRes.Tried -join '；'))
  }
  $nodeVersion = ''
  try { $nodeVersion = [string](& $nodeRes.Path --version 2>$null) } catch { $nodeVersion = '' }
  $probe = Invoke-SelfWrtcProbe -NodeExe $nodeRes.Path
  $tech = ('node=' + $nodeVersion.Trim() + '; probe=' + ([string]$probe).Trim())
  if ([string]$probe -match 'WRTC_OK') {
    return New-SelfResult 'ok' '流畅模式组件可用（切「流畅」画面更顺）' $tech
  }
  if ([string]$probe -match 'timeout') {
    return New-SelfResult 'warn' '流畅模式组件加载太慢（超时），可能和这台电脑不兼容' $tech `
      -Advice '用「清晰」模式不影响看屏幕；把报告发给卖家。'
  }
  return New-SelfResult 'warn' '流畅模式组件加载失败（通常是随包的 node 和组件版本对不上）' $tech `
    -Advice '用「清晰」模式不影响看屏幕；把报告发给卖家修。'
}

function Test-SelfDisk {
  $driveName = 'C'
  try { if ($env:SystemDrive) { $driveName = $env:SystemDrive.TrimEnd(':') } } catch { $driveName = 'C' }
  try {
    $d = Get-PSDrive -Name $driveName -ErrorAction Stop
    if ($null -eq $d -or $null -eq $d.Free) { return New-SelfResult 'unknown' '读不到磁盘剩余空间' ('Get-PSDrive ' + $driveName + ' 返回空') }
  } catch {
    return New-SelfResult 'unknown' '读不到磁盘剩余空间' ('Get-PSDrive ' + $driveName + ' 失败')
  }
  $freeGb = [math]::Round($d.Free / 1GB, 1)
  $tech = ('drive={0}; free={1}GB' -f $driveName, $freeGb)
  if ($freeGb -ge 10) { return New-SelfResult 'ok' ($driveName + ' 盘还剩 ' + $freeGb + ' GB') $tech }
  if ($freeGb -ge 5) {
    return New-SelfResult 'warn' ($driveName + ' 盘只剩 ' + $freeGb + ' GB，快不够用了') $tech `
      -Advice '清理磁盘，至少留 10GB（清回收站和下载文件夹最快）。'
  }
  return New-SelfResult 'warn' ($driveName + ' 盘只剩 ' + $freeGb + ' GB，会影响程序运行') $tech `
    -Advice '尽快清理磁盘或换一台电脑；空间太低会突然不出画面。'
}

function Test-SelfPower {
  $raw = ''
  try { $raw = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Out-String) } catch { $raw = '' }
  if (-not $raw -or -not $raw.Trim()) {
    return New-SelfResult 'unknown' '读不到电源设置（可能是权限不足）' 'powercfg 无输出'
  }
  $ac = -1
  $dc = -1
  $mAc = [regex]::Match($raw, '(?:交流|Current AC)[^\r\n]*?0x([0-9a-fA-F]{1,8})')
  if ($mAc.Success) { try { $ac = [long][Convert]::ToInt64($mAc.Groups[1].Value, 16) } catch { $ac = -1 } }
  $mDc = [regex]::Match($raw, '(?:直流|Current DC)[^\r\n]*?0x([0-9a-fA-F]{1,8})')
  if ($mDc.Success) { try { $dc = [long][Convert]::ToInt64($mDc.Groups[1].Value, 16) } catch { $dc = -1 } }
  if ($ac -lt 0) { return New-SelfResult 'unknown' '读不到电源设置' 'powercfg 输出无法解析' }

  $isLaptop = $false
  $pcsType = -1
  try {
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    $pcsType = [int]$cs.PCSystemType
    $isLaptop = ($pcsType -eq 2)
  } catch { $pcsType = -1 }

  $tech = ('AC=' + $ac + 's; DC=' + $dc + 's; PCSystemType=' + $pcsType)
  $problems = New-Object System.Collections.ArrayList
  if ($ac -gt 0) { [void]$problems.Add('插着电源时，' + (Format-IdleSeconds $ac) + '没动就会自动睡眠') }
  if ($isLaptop -and $dc -gt 0) { [void]$problems.Add('用电池时，' + (Format-IdleSeconds $dc) + '没动就会自动睡眠') }

  if ($problems.Count -gt 0) {
    return New-SelfResult 'warn' ($problems -join '；') $tech `
      -Advice '设置 → 系统 → 电源和睡眠 → 把「睡眠」改成「从不」（插电和电池两栏都改）。'
  }
  return New-SelfResult 'ok' '电脑不会自己睡眠' $tech
}

function Test-SelfEntry {
  $keyFile = Join-Path $here 'screen.key'
  $urlFile = Join-Path $here 'screen-url.txt'
  $keyOk = $false
  try {
    if (Test-Path -LiteralPath $keyFile) {
      $t = (Get-Content -LiteralPath $keyFile -Raw -ErrorAction Stop).Trim()
      $keyOk = [bool]($t -match '^[0-9a-fA-F]{16,64}$')
    }
  } catch { $keyOk = $false }
  $hasUrl = [bool](Test-Path -LiteralPath $urlFile)
  $savedHost = Get-SelfEntryHost
  $curIp = [string](Get-SelfTailscale).Info.Ip
  $tech = ('keyFile=' + [string]$keyOk + '; urlFile=' + [string]$hasUrl + '; hostMatches=' + [string]($savedHost -and $curIp -and ($savedHost -eq $curIp)))

  if (-not $keyOk -and -not $hasUrl) {
    return New-SelfResult 'warn' '手机上还没有可用的入口（登录密钥和网址都还没生成）' $tech `
      -Advice '双击电脑上的「启动」图标，等 2 分钟再跑自检；还不行把报告发给卖家。'
  }
  if (-not $keyOk) {
    return New-SelfResult 'warn' '登录密钥丢了，手机上的旧网址会打不开' $tech `
      -Advice '重新启动本产品会生成新密钥，然后重新扫一次二维码；不会操作把报告发给卖家。'
  }
  if (-not $hasUrl) {
    return New-SelfResult 'warn' '还没生成手机能用的网址' $tech `
      -Advice '双击电脑上的「启动」图标，等 1 分钟，然后重新扫二维码。'
  }
  if ($curIp -and $savedHost -and $savedHost -ne $curIp) {
    # 改动（HTTPS/PWA 引入的误报）：启用 Tailscale HTTPS 后，screen-url.txt 里是
    # https://<机器名>.ts.net/?k=... 这种**域名形式**，域名不会随 tailnet IP 变化而变化。
    # 原来无条件拿它和当前 IP 比对，必然不相等，于是天天报"地址变了"的假警报。
    # 现在：只有 http://<IP>:... 这种把 IP 写死在网址里的形式才需要比对。
    $urlNow = ''
    try { $urlNow = (Get-Content -LiteralPath (Join-Path $here 'screen-url.txt') -Raw -ErrorAction Stop).Trim() } catch { }
    $isDnsForm = [bool]($urlNow -match '^https?://[^/:]+\.')
    if (-not $isDnsForm) {
      return New-SelfResult 'warn' '电脑在私有网络里的地址变了，手机上的旧书签打不开了' $tech `
        -Advice '重新扫一次电脑上的二维码（「启动」图标旁边）；不会操作把报告发给卖家。'
    }
  }
  if (-not $curIp) {
    return New-SelfResult 'ok' '入口文件已生成（Tailscale 没连上，地址是否最新这一项没核对）' $tech
  }
  return New-SelfResult 'ok' '手机上的入口是最新的（网址里的地址和电脑当前地址一致）' $tech
}

function Test-SelfAv {
  $names = @()
  try {
    $names = @(Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop |
        ForEach-Object { [string]$_.displayName } | Where-Object { $_ })
  } catch {
    return New-SelfResult 'unknown' '读不到这台电脑装了哪些杀毒软件' 'SecurityCenter2 查询失败'
  }
  if ($names.Count -eq 0) { return New-SelfResult 'ok' '没检测到第三方杀毒软件' 'SecurityCenter2 返回空' }
  $thirdParty = @($names | Where-Object { $_ -notmatch 'Windows Defender' })
  if ($thirdParty.Count -eq 0) { return New-SelfResult 'ok' '杀毒软件：Windows Defender' ('av=' + ($names -join ', ')) }
  return New-SelfResult 'warn' ('装了第三方杀毒软件：' + ($thirdParty -join '、')) ('av=' + ($names -join ', ')) `
    -Advice '一般不影响。如果画面或操作突然不正常，先把报告发给我们，别自己关杀毒软件。'
}

function Test-SelfElevated {
  # 改动（第二轮 P0-2 / I1）：提权注入器现在必须装在 %ProgramFiles%\PhoneAccessInput（普通用户写不了）。
  # 判"开没开"的同时必须判"装在哪"：任务还指着用户可写目录（旧版本的装法）时，
  # 就等于一个标准用户能替换的 exe 被最高权限执行——这种状态要主动报出来，
  # 不能只看"标记在 + 任务在"就报"已开启"（那正是被审查指出的盲区）。
  $pfRootSc = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  $elevDirSc = Join-Path $pfRootSc 'PhoneAccessInput'
  $elevExeSc = Join-Path $elevDirSc 'input.exe'
  $legacyMarker = Join-Path $env:LOCALAPPDATA 'DshInput\elevated.enabled'
  $hasMarker = [bool]((Test-Path -LiteralPath (Join-Path $elevDirSc 'elevated.enabled')) -or (Test-Path -LiteralPath $legacyMarker))
  $hasTask = $false
  $taskExe = ''
  try {
    $t = Get-ScheduledTask -TaskName 'DSH Input Injector' -ErrorAction SilentlyContinue
    if ($t) { $hasTask = $true; $taskExe = [string](@($t.Actions)[0].Execute) }
  } catch { $hasTask = $false }
  $safePlace = [bool]($taskExe -and ($taskExe -eq $elevExeSc))
  $tech = ('task=' + [string]$hasTask + '; exe=' + $taskExe + '; marker=' + [string]$hasMarker)
  if ($hasTask -and (-not $safePlace)) {
    return New-SelfResult 'warn' '高权限操作装在用户能改的目录里（有安全风险），请重跑一次安装' $tech `
      -Advice '重跑安装程序会把它挪到系统目录、只有管理员能改。这一步不影响你现在正在用的功能。'
  }
  if ($hasMarker -and $hasTask) {
    return New-SelfResult 'ok' '已开启高权限操作（以管理员身份运行的窗口也能点）' $tech
  }
  return New-SelfResult 'warn' '没有开启高权限操作' $tech `
    -Advice '平时不影响。只有遇到某个窗口（比如以管理员身份运行的软件）点不动时，把报告发给我们。'
}

function Test-SelfAudio {
  $count = Get-SelfProcessCount 'audio'
  if ($count -eq 1) { return New-SelfResult 'ok' '进程正常运行（手机里能听到电脑声音）' ('audio.exe count=1') }
  if ($count -eq 0) {
    return New-SelfResult 'warn' '手机上没有电脑的声音（声音组件没在运行）' 'audio.exe count=0' `
      -Advice '不影响看屏幕和操作。需要声音的话重启电脑；还不行把报告发给卖家。'
  }
  return New-SelfResult 'warn' ('有 ' + $count + ' 个声音组件（正常只有 1 个）') ('audio.exe count=' + $count)
}

function Test-SelfStability {
  $log = Join-Path $here 'supervisor.log'
  if (-not (Test-Path -LiteralPath $log)) {
    return New-SelfResult 'unknown' '还没有运行日志，暂时看不出稳定性' 'supervisor.log missing'
  }
  $tail = @()
  try { $tail = @(Get-Content -LiteralPath $log -Tail 5000 -ErrorAction Stop) } catch { $tail = @() }
  $cut = (Get-Date).AddHours(-24)
  $starts = 0
  foreach ($line in $tail) {
    $s = [string]$line
    if ($s -notmatch '=== supervisor start ===') { continue }
    $m = [regex]::Match($s, '^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]')
    if (-not $m.Success) { $starts++; continue }
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParseExact($m.Groups[1].Value, 'yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$parsed)) {
      if ($parsed -ge $cut) { $starts++ }
    }
  }
  $tech = ('restarts24h=' + $starts + '; logTail=5000')
  if ($starts -ge 5) {
    return New-SelfResult 'warn' ('过去 24 小时自动恢复过 ' + $starts + ' 次（说明有点不稳定）') $tech `
      -Advice '不影响你现在使用，但把报告发给我们，让我们看日志定位。'
  }
  return New-SelfResult 'ok' ('过去 24 小时自动恢复 ' + $starts + ' 次（偶尔一次是正常的）') $tech
}

# 只有开通了「对话控制台」（方案乙）才会注册这一项
function Test-SelfDsh {
  $port = [int]$cfg.ports.dsh
  $listeners = @()
  try { $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) } catch { $listeners = @() }
  if ($listeners.Count -gt 0) { return New-SelfResult 'ok' ('对话控制台在运行（端口 ' + $port + '）') ('port=' + $port + '; listeners=' + $listeners.Count) }
  return New-SelfResult 'warn' '开通了对话控制台，但它没在运行' ('port=' + $port + '; no listener') `
    -Advice '如果你不用它，可以忽略；要用的话重启电脑后重跑自检。'
}

# ---------------------------------------------------------------------------
# 4. 检查注册表 —— 加新检查只需要在这里加一行
#    字段：Id（唯一）/ Title（客户看得懂）/ Severity / What（为什么重要）/
#          Advice（默认建议）/ Probe（探针函数）
# ---------------------------------------------------------------------------
$script:Registry = New-Object System.Collections.ArrayList

function Register-SelfCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$What,
    [Parameter(Mandatory = $true)][string]$Advice,
    [ValidateSet('blocker', 'caution', 'cosmetic')][string]$Severity = 'caution',
    [Parameter(Mandatory = $true)][scriptblock]$Probe
  )
  [void]$script:Registry.Add([pscustomobject]@{
      Id = $Id; Title = $Title; What = $What; Advice = $Advice; Severity = $Severity; Probe = $Probe
    })
}

Register-SelfCheck -Id 'os' -Title '电脑系统' -Severity 'blocker' `
  -What '这套远程功能需要 Windows 10（2004 版）以上的 64 位系统。' `
  -Advice '把报告发给卖家，商量升级系统或换一台电脑。' `
  -Probe { Test-SelfOs }

Register-SelfCheck -Id 'tailscale' -Title '私有网络（Tailscale）' -Severity 'blocker' `
  -What '手机和电脑之间靠一条私有网络连线，Tailscale 就是这条线。它断了，手机就完全连不上。' `
  -Advice '打开电脑右下角的 Tailscale 图标点「连接」；手机上也打开 Tailscale，然后重新跑一次自检。' `
  -Probe { Test-SelfTailscale }

Register-SelfCheck -Id 'screen-service' -Title '画面服务' -Severity 'blocker' `
  -What '手机看到的画面由电脑上的这个服务提供。它不在运行，手机上就是一片空白。' `
  -Advice '双击电脑上的「启动」图标，等 2 分钟再跑一次自检；还不行把报告发给卖家。' `
  -Probe { Test-SelfScreenService }

Register-SelfCheck -Id 'capture' -Title '屏幕读取' -Severity 'blocker' `
  -What '电脑上的这个组件负责把屏幕读出来。它没在跑，手机看到的就是黑屏。' `
  -Advice '重启这台电脑，重启后请登录一次，等 2 分钟再跑自检；还不行把报告发给卖家。' `
  -Probe { Test-SelfCapture }

Register-SelfCheck -Id 'tailnet-access' -Title '手机连进来的通道' -Severity 'blocker' `
  -What '这一项模拟手机的连接方式，从电脑这边访问画面服务，验证「手机进得来」。' `
  -Advice '先在手机和电脑上都打开 Tailscale，再跑一次自检；还不行把报告发给卖家。' `
  -Probe { Test-SelfTailnetAccess }

Register-SelfCheck -Id 'session' -Title '电脑的登录状态' -Severity 'caution' `
  -What '这些服务跟着「有人登录的桌面」一起运行。注销或停在登录界面时，手机连上也看不到东西。' `
  -Advice '去电脑前重新登录一次（锁屏没关系，注销不行），登录后 2 分钟内会自动恢复。' `
  -Probe { Test-SelfSession }

Register-SelfCheck -Id 'task' -Title '自动启动与自愈' -Severity 'caution' `
  -What 'Windows 定时检查这套程序还在不在，掉了就拉起来。这个定时任务没了，重启后手机就连不上。' `
  -Advice '现在还能用，但重启后会失效。把报告发给卖家，让我们重新注册这个任务。' `
  -Probe { Test-SelfTask }

Register-SelfCheck -Id 'supervisor' -Title '自动恢复程序' -Severity 'caution' `
  -What '它每十几秒检查一次画面和操作组件，卡死就自动重启。它不在了，出问题就没人修。' `
  -Advice '等 2 分钟再跑一次自检（系统会自动拉起它）；还是这样把报告发给卖家。' `
  -Probe { Test-SelfSupervisor }

Register-SelfCheck -Id 'input' -Title '手机操作电脑（鼠标键盘）' -Severity 'caution' `
  -What '你在手机上点一下、打一个字，都要靠它送进电脑。它出问题就是「能看不能点」。' `
  -Advice '再试一次操作；还不行重启电脑后重跑自检，把报告发给卖家。' `
  -Probe { Test-SelfInput }

Register-SelfCheck -Id 'frame' -Title '画面刷新' -Severity 'caution' `
  -What '这一项看的是画面有没有在真的刷新，还是卡在某一帧不动了。' `
  -Advice '在手机上刷新一下页面；如果电脑锁屏了，去动一下鼠标。还不行重启电脑。' `
  -Probe { Test-SelfFrame }

Register-SelfCheck -Id 'smooth' -Title '流畅模式（画面更顺）' -Severity 'caution' `
  -What '「流畅」模式用另一套方式传画面，比默认的清晰模式顺很多。它依赖随包的原生组件。' `
  -Advice '先用「清晰」模式，不影响看屏幕；把报告发给卖家修组件。' `
  -Probe { Test-SelfSmooth }

Register-SelfCheck -Id 'disk' -Title '磁盘空间' -Severity 'caution' `
  -What '系统盘要留够空间，程序缓存都写在这里。空间太低会突然不出画面。' `
  -Advice '清理磁盘，至少留 10GB（清回收站和下载文件夹最快）。' `
  -Probe { Test-SelfDisk }

Register-SelfCheck -Id 'power' -Title '自动睡眠' -Severity 'caution' `
  -What '人不在电脑前时，电脑一睡眠，手机就连不上。这是「昨天还好今天不行」最常见的原因。' `
  -Advice '设置 → 系统 → 电源和睡眠 → 把「睡眠」改成「从不」（插电和电池两栏都改）。' `
  -Probe { Test-SelfPower }

Register-SelfCheck -Id 'entry' -Title '手机上的入口（网址与密钥）' -Severity 'caution' `
  -What '手机是通过一条带密钥的网址进电脑的。密钥丢了或地址变了，手机上的旧书签就打不开。' `
  -Advice '重新扫一次电脑上的二维码（「启动」图标旁边）；不会操作把报告发给卖家。' `
  -Probe { Test-SelfEntry }

Register-SelfCheck -Id 'av' -Title '杀毒软件' -Severity 'cosmetic' `
  -What '杀毒软件有时会把远程组件当成可疑程序拦掉。' `
  -Advice '如果画面或操作突然不正常，把报告发给我们，别自己关杀毒。' `
  -Probe { Test-SelfAv }

Register-SelfCheck -Id 'elevated' -Title '管理员窗口的操作权限' -Severity 'cosmetic' `
  -What '有些窗口以管理员身份运行时，普通权限的远程操作点不进去。开了高权限注入就能点。' `
  -Advice '平时不影响。遇到某个窗口点不动，把报告发给卖家开高权限注入。' `
  -Probe { Test-SelfElevated }

Register-SelfCheck -Id 'audio' -Title '声音转发' -Severity 'cosmetic' `
  -What '手机里能不能听到电脑的声音。看屏幕和操作不受影响。' `
  -Advice '不需要声音可以不管；需要的话重启电脑，还不行把报告发给卖家。' `
  -Probe { Test-SelfAudio }

Register-SelfCheck -Id 'stability' -Title '最近稳定性' -Severity 'cosmetic' `
  -What '看最近一天自动恢复的次数。经常自动恢复说明有反复的故障。' `
  -Advice '把报告发给卖家，我们看日志定位（不影响你现在使用）。' `
  -Probe { Test-SelfStability }

# 方案乙才注册：配置里 enableDsh=true 时才有对话控制台
if ($cfg.enableDsh) {
  Register-SelfCheck -Id 'dsh' -Title '对话控制台（可选功能）' -Severity 'caution' `
    -What '可选的对话控制台。没开通这项的人不需要管它。' `
    -Advice '要用对话控制台的话重启电脑后重跑自检；不用可以忽略。' `
    -Probe { Test-SelfDsh }
}

# ---------------------------------------------------------------------------
# 5. 主流程：遍历注册表（加检查时不要改这一段）
# ---------------------------------------------------------------------------
function Invoke-SelfChecks {
  $total = $script:Registry.Count
  $index = 0
  $list = New-Object System.Collections.ArrayList
  foreach ($check in $script:Registry) {
    $index++
    try {
      Write-Progress -Activity '一键自检' -Status ('正在检查 ' + $index + '/' + $total + '：' + $check.Title) `
        -PercentComplete ([int](($index - 1) * 100 / [math]::Max($total, 1)))
    } catch { }

    $raw = $null
    try {
      $raw = & $check.Probe
    } catch {
      $raw = New-SelfResult 'unknown' ('这一项检查时出错了：' + $_.Exception.Message) ('探针异常：' + $_.Exception.Message)
    }
    if ($null -eq $raw) { $raw = New-SelfResult 'unknown' '这一项没有返回结果' '' }

    $status = 'unknown'
    try { $status = ([string]$raw.Status).ToLowerInvariant() } catch { $status = 'unknown' }
    if (@('ok', 'warn', 'fail', 'unknown') -notcontains $status) { $status = 'unknown' }

    $detail = ''
    try { $detail = [string]$raw.Detail } catch { $detail = '' }
    if (-not $detail) { $detail = '（没有更多信息）' }
    $tech = ''
    try { $tech = [string]$raw.Tech } catch { $tech = '' }
    $advice = [string]$check.Advice
    try { if ($raw.Advice) { $advice = [string]$raw.Advice } } catch { }

    [void]$list.Add([pscustomobject]@{
        Check = $check; Status = $status; Detail = $detail; Tech = $tech; Advice = $advice
      })
  }
  try { Write-Progress -Activity '一键自检' -Completed } catch { }
  return $list.ToArray()
}

# 把检查结果分成三档：必须处理 / 建议处理 / 没能检查 / 小提示 / 正常
function Split-SelfResults {
  param($Results)

  $red = @($Results | Where-Object { $_.Status -eq 'fail' -and $_.Check.Severity -eq 'blocker' })
  $yellow = @($Results | Where-Object {
      ($_.Status -eq 'fail' -or $_.Status -eq 'warn') -and ($_.Check.Severity -eq 'blocker' -or $_.Check.Severity -eq 'caution')
    })
  $unknown = @($Results | Where-Object {
      $_.Status -eq 'unknown' -and ($_.Check.Severity -eq 'blocker' -or $_.Check.Severity -eq 'caution')
    })
  $notes = @($Results | Where-Object { $_.Status -ne 'ok' -and $_.Check.Severity -eq 'cosmetic' })
  $green = @($Results | Where-Object { $_.Status -eq 'ok' })

  return [pscustomobject]@{ Red = $red; Yellow = $yellow; Unknown = $unknown; Notes = $notes; Green = $green }
}

function Get-SelfVerdict {
  param($Split)

  $redCount = @($Split.Red).Count
  $yellowCount = @($Split.Yellow).Count
  $unknownCount = @($Split.Unknown).Count

  if ($redCount -gt 0) {
    $first = @($Split.Red)[0]
    return [pscustomobject]@{
      Level = 'red'
      Text  = ('🔴 有问题 —— 现在手机很可能连不上。最该先做的一件事：' + $first.Advice)
    }
  }
  if ($yellowCount -gt 0) {
    $t = '🟡 注意 —— 现在手机能用，但有 ' + $yellowCount + ' 件事建议处理（见下面）。'
    if ($unknownCount -gt 0) { $t += '另有 ' + $unknownCount + ' 项没能检查。' }
    return [pscustomobject]@{ Level = 'yellow'; Text = $t }
  }
  if ($unknownCount -gt 0) {
    return [pscustomobject]@{
      Level = 'yellow'
      Text  = ('🟡 注意 —— 现在手机能用，但有 ' + $unknownCount + ' 项没能检查（见下面）。')
    }
  }
  return [pscustomobject]@{
    Level = 'green'
    Text  = '🟢 正常 —— 现在可以正常用手机连这台电脑，没发现问题。'
  }
}

# ---------------------------------------------------------------------------
# 6. 屏幕输出（白话）
# ---------------------------------------------------------------------------
function Write-SelfSection {
  param([string]$Title, [string]$Color)
  Write-Host ''
  Write-Host ('─' * 64) -ForegroundColor DarkGray
  Write-Host ('  ' + $Title) -ForegroundColor $Color
  Write-Host ('─' * 64) -ForegroundColor DarkGray
}

function Write-SelfItem {
  param($Item, [int]$No, [string]$Tag, [string]$Color)
  Write-Host ''
  Write-Host ('  ' + $No + '. [' + $Tag + '] ' + $Item.Check.Title) -ForegroundColor $Color
  Write-Host ('     为什么重要：' + $Item.Check.What) -ForegroundColor Gray
  if ($Tag -eq '没能检查') {
    Write-Host ('     没能检查的原因：' + $Item.Detail) -ForegroundColor White
  } else {
    Write-Host ('     现在的情况：' + $Item.Detail) -ForegroundColor White
  }
  Write-Host ('     你该做什么：' + $Item.Advice) -ForegroundColor Cyan
}

function Write-SelfConsoleReport {
  param($Split, $Verdict, [string]$ReportFile, [switch]$ReportSkipped)

  # 第一行就是人话结论
  $color = 'Green'
  if ($Verdict.Level -eq 'red') { $color = 'Red' }
  elseif ($Verdict.Level -eq 'yellow') { $color = 'Yellow' }
  Write-Host ''
  Write-Host ('  ' + $Verdict.Text) -ForegroundColor $color

  $totalChecked = @($Split.Red).Count + @($Split.Yellow).Count + @($Split.Unknown).Count + @($Split.Green).Count + @($Split.Notes).Count
  Write-Host ''
  Write-Host ('  ' + ('═' * 62)) -ForegroundColor DarkGray
  Write-Host '  手机远程访问 · 一键自检（只读，不会改动任何设置）' -ForegroundColor White
  Write-Host ('  ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' · 共检查 ' + $totalChecked + ' 项') -ForegroundColor DarkGray
  Write-Host ('  ' + ('═' * 62)) -ForegroundColor DarkGray

  $no = 0
  if (@($Split.Red).Count -gt 0) {
    Write-SelfSection '🔴 先处理这些（不处理，手机连不上 / 看不到）' 'Red'
    foreach ($item in $Split.Red) { $no++; Write-SelfItem -Item $item -No $no -Tag '必须处理' -Color 'Red' }
  }
  if (@($Split.Yellow).Count -gt 0) {
    Write-SelfSection '🟡 建议处理（现在能用，但会让体验变差或过几天出问题）' 'Yellow'
    foreach ($item in $Split.Yellow) { $no++; Write-SelfItem -Item $item -No $no -Tag '建议处理' -Color 'Yellow' }
  }
  if (@($Split.Unknown).Count -gt 0) {
    Write-SelfSection '⚪ 以下几项没能检查（不影响已经检查过的项）' 'DarkYellow'
    foreach ($item in $Split.Unknown) { $no++; Write-SelfItem -Item $item -No $no -Tag '没能检查' -Color 'DarkYellow' }
  }
  if (@($Split.Notes).Count -gt 0) {
    Write-SelfSection 'ℹ️ 小提示（不影响使用）' 'DarkGray'
    foreach ($item in $Split.Notes) {
      Write-Host ''
      Write-Host ('  · ' + $item.Check.Title + '：' + $item.Detail) -ForegroundColor DarkGray
      Write-Host ('    提示：' + $item.Advice) -ForegroundColor DarkGray
    }
  }
  if (@($Split.Green).Count -gt 0) {
    Write-SelfSection ('🟢 正常（' + @($Split.Green).Count + ' 项）') 'Green'
    foreach ($item in $Split.Green) {
      $line = '  ✔ ' + $item.Check.Title
      if ($item.Detail -and $item.Detail.Length -le 60) { $line = $line + '：' + $item.Detail }
      Write-Host $line -ForegroundColor Green
    }
  }

  Write-Host ''
  Write-Host ('─' * 64) -ForegroundColor DarkGray
  if ($ReportFile) {
    Write-Host '  报告已保存到：' -ForegroundColor White
    Write-Host ('  ' + $ReportFile) -ForegroundColor White
    Write-Host '  把这个文件发给卖家，比描述现象快得多。' -ForegroundColor Gray
  } elseif ($ReportSkipped) {
    Write-Host '  本次用 -NoReport 运行，没有生成报告文件（截图上面这些内容发卖家即可）。' -ForegroundColor DarkGray
  } else {
    Write-Host '  报告没能保存成文件。可以截图上面这些内容发给卖家。' -ForegroundColor Yellow
  }
  Write-Host ''
  Write-Host '  自检只读取信息：不启动服务、不改设置、不动任何正在运行的程序。' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# 7. 报告文件（可以贴给卖家；含技术细节，但不含密钥/网址/token）
# ---------------------------------------------------------------------------
function Get-StatusLabel {
  param([string]$Status)
  switch ($Status) {
    'ok' { return '正常' }
    'warn' { return '注意' }
    'fail' { return '失败' }
    default { return '没能检查' }
  }
}

function Get-SelfEnvironmentLines {
  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add('')
  [void]$lines.Add('【环境信息（给卖家排查用，不含密钥）】')

  try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    [void]$lines.Add('系统：' + $os.Caption + ' / build ' + $os.BuildNumber + ' / ' + $os.OSArchitecture)
  } catch { [void]$lines.Add('系统：读不到') }
  [void]$lines.Add('PowerShell：' + $PSVersionTable.PSVersion.ToString())
  [void]$lines.Add('产品目录：' + $here)
  if ($cfg.ConfigFound) { [void]$lines.Add('配置文件：已读到 product.config.json') }
  else { [void]$lines.Add('配置文件：没读到（按内置默认值运行）') }
  foreach ($w in @($cfg.Warnings)) { if ($w) { [void]$lines.Add('配置提示：' + $w) } }
  [void]$lines.Add('端口：画面=' + $cfg.ports.screen + ' / 门=' + $cfg.ports.door + ' / DSH=' + $cfg.ports.dsh + ' / 录屏=' + $cfg.ports.record)
  if ($cfg.enableDsh) { [void]$lines.Add('方案：乙（含对话控制台）') } else { [void]$lines.Add('方案：甲（只交付屏幕+触控）') }

  try {
    $geo = Get-CaptureGeometry -Config $cfg
    [void]$lines.Add('抓屏尺寸：' + $geo.Width + 'x' + $geo.Height + '（来源 ' + $geo.Source + '）')
  } catch { }

  foreach ($name in @('node', 'python', 'tailscale')) {
    $wellKnown = @()
    if ($name -eq 'tailscale') { $wellKnown = Get-TailscaleWellKnownDirs }
    $res = Resolve-ProductRuntime -AppDir $here -Name $name -Config $cfg -WellKnownDirs $wellKnown
    if ($res.Path) { [void]$lines.Add($name + '：已找到（来源：' + $res.Source + '）') }
    else { [void]$lines.Add($name + '：没找到') }
  }

  $ts = Get-SelfTailscale
  if ($ts.Path) {
    $state = ''
    $exp = ''
    if ($ts.Json) { try { $state = [string]$ts.Json.BackendState } catch { } }
    if ($ts.Json -and $ts.Json.Self -and $ts.Json.Self.KeyExpiry) {
      try {
        $expDate = [datetime]$ts.Json.Self.KeyExpiry
        if ($expDate.Year -ge 2000) { $exp = $expDate.ToLocalTime().ToString('yyyy-MM-dd') }
      } catch { }
    }
    $line = 'Tailscale：' + $state
    if ($ts.Info.Ip) { $line += ' / 私有地址 ' + $ts.Info.Ip }
    if ($exp) { $line += ' / 授权到期 ' + $exp }
    [void]$lines.Add($line)
  } else {
    [void]$lines.Add('Tailscale：没找到')
  }

  try {
    $taskName = 'DSH Phone Access'
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    [void]$lines.Add('计划任务「' + $taskName + '」：' + [string]$task.State)
  } catch {
    [void]$lines.Add('计划任务「DSH Phone Access」：不存在')
  }

  $sup = Get-SelfSupervisorInfo
  [void]$lines.Add('进程数：capture=' + (Get-SelfProcessCount 'capture') + ' / input=' + (Get-SelfProcessCount 'input') + ' / audio=' + (Get-SelfProcessCount 'audio') + ' / supervisor=' + $sup.Count)

  $health = Get-SelfHealth
  if ($health.Ok) {
    $ji = Get-HealthJson $health.Text 'input'
    $inLine = ''
    if ($ji) { try { $inLine = ' / input.connected=' + [string]$ji.connected } catch { } }
    [void]$lines.Add('/health：viewers=' + (Get-HealthToken $health.Text 'viewers') +
      ' age=' + (Get-HealthToken $health.Text 'age') +
      ' out=' + (Get-HealthToken $health.Text 'out') +
      ' in=' + (Get-HealthToken $health.Text 'in') +
      ' mode=' + (Get-HealthToken $health.Text 'mode') + $inLine)
  } else {
    [void]$lines.Add('/health：没有响应（端口 ' + $health.Port + '）')
  }

  [void]$lines.Add('登录密钥文件：' + $(if (Test-Path -LiteralPath (Join-Path $here 'screen.key')) { '已生成（内容不打印）' } else { '不存在' }))
  [void]$lines.Add('手机网址文件：' + $(if (Test-Path -LiteralPath (Join-Path $here 'screen-url.txt')) { '已生成（内容不打印）' } else { '不存在' }))
  # 改动（第二轮 P0-2 / I1）：标记文件搬到了 %ProgramFiles%\PhoneAccessInput；旧位置也认，便于排障
  $pfR = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  $elevReportMarker = Join-Path (Join-Path $pfR 'PhoneAccessInput') 'elevated.enabled'
  $elevReportLegacy = Join-Path $env:LOCALAPPDATA 'DshInput\elevated.enabled'
  $elevReportOn = [bool]((Test-Path -LiteralPath $elevReportMarker) -or (Test-Path -LiteralPath $elevReportLegacy))
  $elevReportTask = ''
  try {
    $tRep = Get-ScheduledTask -TaskName 'DSH Input Injector' -ErrorAction SilentlyContinue
    if ($tRep) { $elevReportTask = [string](@($tRep.Actions)[0].Execute) }
  } catch { }
  [void]$lines.Add('高权限注入：' + $(if ($elevReportOn) { '已启用' } else { '未启用' }) + $(if ($elevReportTask) { '（任务指向：' + $elevReportTask + '）' } else { '' }))

  try {
    $driveName = 'C'
    if ($env:SystemDrive) { $driveName = $env:SystemDrive.TrimEnd(':') }
    $d = Get-PSDrive -Name $driveName -ErrorAction Stop
    [void]$lines.Add($driveName + ' 盘剩余：' + [math]::Round($d.Free / 1GB, 1) + ' GB')
  } catch { }

  return $lines.ToArray()
}

function Format-CnIndex {
  param([int]$No)
  $digits = @('零', '一', '二', '三', '四', '五', '六', '七', '八', '九')
  if ($No -ge 0 -and $No -le 9) { return $digits[$No] }
  return [string]$No
}

function Get-SelfReportLines {
  param($Split, $Results, $Verdict)

  $lines = New-Object System.Collections.ArrayList
  [void]$lines.Add('手机远程访问 · 自检报告')
  [void]$lines.Add(('=' * 60))
  [void]$lines.Add('生成时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  [void]$lines.Add('自检脚本版本：' + $script:SelfVersion)
  [void]$lines.Add('')
  [void]$lines.Add('一句话结论：')
  [void]$lines.Add('  ' + $Verdict.Text)
  [void]$lines.Add('')
  [void]$lines.Add('这份报告可以整个发给卖家。里面不含登录密钥、cookie、token，也不会包含完整网址。')

  $no = 0
  $sectionNo = 0
  if (@($Split.Red).Count -gt 0) {
    $sectionNo++
    [void]$lines.Add('')
    [void]$lines.Add('【' + (Format-CnIndex $sectionNo) + '、先处理这些（不处理就连不上）】')
    foreach ($item in $Split.Red) {
      $no++
      [void]$lines.Add('')
      [void]$lines.Add('[' + $no + '] 🔴 ' + $item.Check.Title + '  —— ' + (Get-StatusLabel $item.Status))
      [void]$lines.Add('    为什么重要：' + $item.Check.What)
      [void]$lines.Add('    现在的情况：' + $item.Detail)
      if ($item.Tech) { [void]$lines.Add('    技术细节：' + $item.Tech) }
      [void]$lines.Add('    你该做什么：' + $item.Advice)
    }
  }
  if (@($Split.Yellow).Count -gt 0) {
    $sectionNo++
    [void]$lines.Add('')
    [void]$lines.Add('【' + (Format-CnIndex $sectionNo) + '、建议处理（还能用，但这些会让体验变差）】')
    foreach ($item in $Split.Yellow) {
      $no++
      [void]$lines.Add('')
      [void]$lines.Add('[' + $no + '] 🟡 ' + $item.Check.Title + '  —— ' + (Get-StatusLabel $item.Status))
      [void]$lines.Add('    为什么重要：' + $item.Check.What)
      [void]$lines.Add('    现在的情况：' + $item.Detail)
      if ($item.Tech) { [void]$lines.Add('    技术细节：' + $item.Tech) }
      [void]$lines.Add('    你该做什么：' + $item.Advice)
    }
  }
  if (@($Split.Unknown).Count -gt 0) {
    $sectionNo++
    [void]$lines.Add('')
    [void]$lines.Add('【' + (Format-CnIndex $sectionNo) + '、没能检查的项】')
    foreach ($item in $Split.Unknown) {
      $no++
      [void]$lines.Add('')
      [void]$lines.Add('[' + $no + '] ⚪ ' + $item.Check.Title + '  —— 没能检查')
      [void]$lines.Add('    没能检查的原因：' + $item.Detail)
      if ($item.Tech) { [void]$lines.Add('    技术细节：' + $item.Tech) }
      [void]$lines.Add('    你该做什么：' + $item.Advice)
    }
  }
  if (@($Split.Notes).Count -gt 0) {
    $sectionNo++
    [void]$lines.Add('')
    [void]$lines.Add('【' + (Format-CnIndex $sectionNo) + '、小提示（不影响使用）】')
    foreach ($item in $Split.Notes) {
      [void]$lines.Add('  · ' + $item.Check.Title + '：' + $item.Detail)
      [void]$lines.Add('    ' + $item.Advice)
    }
  }
  if (@($Split.Green).Count -gt 0) {
    $sectionNo++
    [void]$lines.Add('')
    [void]$lines.Add('【' + (Format-CnIndex $sectionNo) + '、正常（' + @($Split.Green).Count + ' 项）】')
    foreach ($item in $Split.Green) {
      $line = '  ✔ ' + $item.Check.Title
      if ($item.Detail) { $line += '：' + $item.Detail }
      [void]$lines.Add($line)
    }
  }

  [void]$lines.Add('')
  foreach ($envLine in @(Get-SelfEnvironmentLines)) { [void]$lines.Add([string]$envLine) }
  [void]$lines.Add('')
  [void]$lines.Add('（报告结束）')
  return $lines.ToArray()
}

function Get-SelfDefaultReportPath {
  $fileName = '自检报告-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt'
  # 改动（桌面整洁，用户要求）：报告不再散落在桌面根目录，统一放进
  # 「桌面\手机远程\报告」。桌面只保留一个「手机远程」文件夹。
  $desktop = ''
  try { $desktop = [Environment]::GetFolderPath('Desktop') } catch { $desktop = '' }
  if ($desktop -and (Test-Path -LiteralPath $desktop)) {
    $dir = Join-Path (Join-Path $desktop '手机远程') '报告'
    return (Join-Path $dir $fileName)
  }
  return (Join-Path $here $fileName)
}

function Save-SelfReport {
  param([string]$Path, $Lines)
  try {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $text = (($Lines | ForEach-Object { [string]$_ }) -join "`r`n") + "`r`n"
    Set-Content -LiteralPath $Path -Value $text -Encoding UTF8 -ErrorAction Stop
    return $Path
  } catch {
    return ''
  }
}

# ---------------------------------------------------------------------------
# 8. 跑起来
# ---------------------------------------------------------------------------
$results = @(Invoke-SelfChecks)
$split = Split-SelfResults -Results $results
$verdict = Get-SelfVerdict -Split $split
$reportLines = @(Get-SelfReportLines -Split $split -Results $results -Verdict $verdict)

$reportFile = ''
if (-not $NoReport) {
  $target = $ReportPath
  if (-not $target) { $target = Get-SelfDefaultReportPath }
  $reportFile = Save-SelfReport -Path $target -Lines $reportLines
  if (-not $reportFile -and -not $ReportPath) {
    $fallback = Join-Path $env:TEMP ('自检报告-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
    $reportFile = Save-SelfReport -Path $fallback -Lines $reportLines
  }
}

Write-SelfConsoleReport -Split $split -Verdict $verdict -ReportFile $reportFile -ReportSkipped:$NoReport

if (-not $Quiet) {
  Write-Host ''
  Read-Host '按回车键关闭窗口' | Out-Null
}
