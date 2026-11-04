# product-config.ps1 — 产品配置读取 + 运行时/显示器/端口 自动发现（PowerShell 5.1 专用）
#
# 为什么单独成一个文件：start-phone-access.ps1、start-screen.ps1、supervise.ps1 需要同一套
# 「读 product.config.json + 找 node/python/tailscale + 推导抓屏宽度 + 查端口冲突」逻辑。
# 抄三份以后必然漂移，而漂移正是本次要消灭的那类静默失败。
#
# 用法：调用方先 `. (Join-Path $here 'product-config.ps1')` 点源本文件，然后调下面的函数。
# 本文件只有函数定义，点源时不产生任何副作用，也不覆盖调用方的变量（$here 等）。
#
# 注意：目标环境是 Windows PowerShell 5.1，不要在这里用 PS7 语法（?? / ?. / -Parallel 等）。

# 取嵌套配置值：$Config 里按 $Path 逐层找，找不到/为空就返回 $Default（配置文件残缺时不崩）
function Get-ConfigValue {
  param($Config, [string[]]$Path, $Default = $null)
  $cur = $Config
  foreach ($key in $Path) {
    if ($null -eq $cur) { return $Default }
    if (-not ($cur -is [psobject])) { return $Default }
    $prop = $cur.PSObject.Properties[$key]
    if ($null -eq $prop -or $null -eq $prop.Value) { return $Default }
    $cur = $prop.Value
  }
  if ($null -eq $cur) { return $Default }
  return $cur
}

# 端口数值：非法/越界就用默认值
function ConvertTo-PortOr {
  param($Value, [int]$Default)
  $n = 0
  if ($null -ne $Value -and [int]::TryParse(([string]$Value).Trim(), [ref]$n)) {
    if ($n -ge 1 -and $n -le 65535) { return $n }
  }
  return $Default
}

# 布尔值：配置文件里写成字符串 "false" 时 [bool] 会得到 True，这里必须显式判断
function ConvertTo-BoolOr {
  param($Value, [bool]$Default)
  if ($null -eq $Value) { return $Default }
  if ($Value -is [bool]) { return [bool]$Value }
  $s = ([string]$Value).Trim().ToLowerInvariant()
  if ($s -eq 'true' -or $s -eq '1' -or $s -eq 'yes' -or $s -eq 'on') { return $true }
  if ($s -eq 'false' -or $s -eq '0' -or $s -eq 'no' -or $s -eq 'off') { return $false }
  return $Default
}

# 两个配置对象深合并（本地覆盖用）：覆盖文件里有的键优先，对象逐层合并，其它类型直接替换。
function Merge-ConfigObject {
  param($Base, $Overlay)
  if ($null -eq $Overlay) { return $Base }
  if ($null -eq $Base) { return $Overlay }
  $baseIsObj = ($Base -is [System.Management.Automation.PSCustomObject])
  $overIsObj = ($Overlay -is [System.Management.Automation.PSCustomObject])
  if (-not $baseIsObj -or -not $overIsObj) { return $Overlay }
  $result = [ordered]@{}
  foreach ($p in $Base.PSObject.Properties) { $result[$p.Name] = $p.Value }
  foreach ($p in $Overlay.PSObject.Properties) {
    $curIsObj = ($result.Contains($p.Name)) -and ($result[$p.Name] -is [System.Management.Automation.PSCustomObject])
    $newIsObj = ($p.Value -is [System.Management.Automation.PSCustomObject])
    if ($curIsObj -and $newIsObj) {
      $result[$p.Name] = Merge-ConfigObject -Base $result[$p.Name] -Overlay $p.Value
    } else {
      $result[$p.Name] = $p.Value
    }
  }
  return [pscustomobject]$result
}

# 读 product.config.json，返回一个字段一定齐全的对象（缺什么补内置默认值）。
# 配置文件不存在 / JSON 坏了 / 字段类型不对，一律退回默认值继续跑，不抛异常。
function Get-ProductConfig {
  param([Parameter(Mandatory = $true)][string]$AppDir)

  $raw = $null
  $file = Join-Path $AppDir 'product.config.json'
  try {
    if (Test-Path -LiteralPath $file) {
      $text = Get-Content -LiteralPath $file -Raw -Encoding UTF8 -ErrorAction Stop
      if ($text -and $text.Trim()) { $raw = $text | ConvertFrom-Json }
    }
  } catch {
    $raw = $null   # 配置坏了不能用异常把整条启动链打断：按默认值继续，调用方据 Warnings 提示人工检查
  }

  $warnings = New-Object System.Collections.ArrayList
  if ($null -eq $raw) {
    [void]$warnings.Add("没有读到 $file（或内容不是合法 JSON），全部按内置默认值运行")
  }

  # 本地覆盖（2026-11-04 新增）：<AppDir>\product.config.local.json，可选。
  # 为什么需要：开发时把产品源 app\ 下的文件同步到安装目录，会顺手把 product.config.json 覆盖回去，
  # 本机改过的 enableDsh 等开关就丢了 —— 2026-11-04 实际踩到：同步一次，方案乙被打回方案甲，
  # 手机上忽然"登不上 DSH"。这个文件不存在于产品源里，同步不会碰它，本机设置因此能活下来。
  # 约定：只有需要"本机/客户现场覆盖出厂默认"的键才写在这里（enableDsh、ports.*、tailnetServePort 等）。
  $localFile = Join-Path $AppDir 'product.config.local.json'
  if (Test-Path -LiteralPath $localFile) {
    try {
      $localText = Get-Content -LiteralPath $localFile -Raw -Encoding UTF8 -ErrorAction Stop
      if ($localText -and $localText.Trim()) {
        $overlay = $localText | ConvertFrom-Json
        $raw = Merge-ConfigObject -Base $raw -Overlay $overlay
      }
    } catch {
      [void]$warnings.Add("$localFile 不是合法 JSON，已忽略本地覆盖")
    }
  }

  $installDir = [string](Get-ConfigValue $raw @('installDir') '%LOCALAPPDATA%\PhoneAccess')
  if ($installDir.Trim()) {
    try { $installDir = [Environment]::ExpandEnvironmentVariables($installDir.Trim().Trim('"')) } catch { }
  } else {
    $installDir = [Environment]::ExpandEnvironmentVariables('%LOCALAPPDATA%\PhoneAccess')
  }

  $cfg = [pscustomobject]@{
    ConfigFile       = $file
    ConfigFound      = ($null -ne $raw)
    ConfigLocalFile  = $localFile
    ConfigLocalFound = (Test-Path -LiteralPath $localFile)
    Warnings         = @()
    ports            = [pscustomobject]@{
      door   = (ConvertTo-PortOr (Get-ConfigValue $raw @('ports', 'door') 8650) 8650)
      screen = (ConvertTo-PortOr (Get-ConfigValue $raw @('ports', 'screen') 8660) 8660)
      record = (ConvertTo-PortOr (Get-ConfigValue $raw @('ports', 'record') 8780) 8780)
      dsh    = (ConvertTo-PortOr (Get-ConfigValue $raw @('ports', 'dsh') 8642) 8642)
    }
    tailnetServePort = (ConvertTo-PortOr (Get-ConfigValue $raw @('tailnetServePort') 80) 80)
    enableDsh        = (ConvertTo-BoolOr (Get-ConfigValue $raw @('enableDsh') $false) $false)
    installDir       = $installDir
    runtime          = [pscustomobject]@{
      nodePath      = ([string](Get-ConfigValue $raw @('runtime', 'nodePath') '')).Trim()
      pythonPath    = ([string](Get-ConfigValue $raw @('runtime', 'pythonPath') '')).Trim()
      tailscalePath = ([string](Get-ConfigValue $raw @('runtime', 'tailscalePath') '')).Trim()
      dshPath       = ([string](Get-ConfigValue $raw @('runtime', 'dshPath') '')).Trim()
    }
    screen           = [pscustomobject]@{
      captureWidth    = [int](Get-ConfigValue $raw @('screen', 'captureWidth') 0)
      captureHeight   = [int](Get-ConfigValue $raw @('screen', 'captureHeight') 0)
      rtcWidth        = [int](Get-ConfigValue $raw @('screen', 'rtcWidth') 0)
      maxCaptureWidth = [int](Get-ConfigValue $raw @('screen', 'maxCaptureWidth') 2560)
    }
  }
  $cfg.Warnings = $warnings.ToArray()
  return $cfg
}

# 找一个运行时程序的真实路径。查找顺序（这就是 P0-2 要的"不再依赖本机绝对路径"）：
#   1) product.config.json 的 runtime.<name>Path（填了就用填的，不再猜）
#   2) 程序自带运行时目录 <app>\runtime\...（产品交付时把 node.exe 放进这里，客户机不用装 node）
#   3) PATH
#   4) 常见安装位置（只用于 Tailscale / Python 这类第三方软件，不随产品交付）
# 返回 {Path, Source, Tried}；找不到时 Path 为空，Tried 里是试过的地方，供调用方打印中文提示。
function Resolve-ProductRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [Parameter(Mandatory = $true)][string]$Name,
    $Config = $null,
    [string[]]$WellKnownDirs = @()
  )

  $tried = New-Object System.Collections.ArrayList
  $result = [pscustomobject]@{ Path = ''; Source = ''; Tried = @(); Name = $Name }

  # dsh 只有一个入口：命令行 dsh.cmd（DSH 安装时自带的启动器）
  $exe = $Name + '.exe'
  if ($Name -eq 'dsh') { $exe = 'dsh.cmd' }

  # 1) 配置文件里显式指定
  $cfgKey = 'runtime.' + $Name + 'Path'
  $configured = ''
  try { $configured = [string](Get-ConfigValue $Config @('runtime', ($Name + 'Path')) '') } catch { $configured = '' }
  if ($configured -and $configured.Trim()) {
    $p = $configured.Trim().Trim('"')
    try { $p = [Environment]::ExpandEnvironmentVariables($p) } catch { }
    [void]$tried.Add($cfgKey + ' = ' + $p)
    if (Test-Path -LiteralPath $p -PathType Leaf) {
      $result.Path = $p; $result.Source = $cfgKey; $result.Tried = $tried.ToArray(); return $result
    }
  }

  # 2) 程序自带运行时目录
  $bundled = New-Object System.Collections.ArrayList
  [void]$bundled.Add([pscustomobject]@{ Path = (Join-Path $AppDir ('runtime\' + $exe)); Source = '自带运行时目录' })
  [void]$bundled.Add([pscustomobject]@{ Path = (Join-Path $AppDir ('runtime\' + $Name + '\' + $exe)); Source = '自带运行时目录' })
  [void]$bundled.Add([pscustomobject]@{ Path = (Join-Path $AppDir ('runtime\' + $Name + '\bin\' + $exe)); Source = '自带运行时目录' })
  [void]$bundled.Add([pscustomobject]@{ Path = (Join-Path $AppDir ('runtime\bin\' + $exe)); Source = '自带运行时目录' })
  if ($Name -eq 'node') {
    # 老约定：安装时把 node 路径写进 node-path.txt（start-screen.ps1 原来就只读这个文件）
    $nodeTxt = Join-Path $AppDir 'node-path.txt'
    try {
      if (Test-Path -LiteralPath $nodeTxt) {
        $v = (Get-Content -LiteralPath $nodeTxt -Raw -ErrorAction Stop).Trim()
        if ($v) { [void]$bundled.Add([pscustomobject]@{ Path = $v; Source = 'node-path.txt' }) }
      }
    } catch { }
  }
  foreach ($c in $bundled) {
    [void]$tried.Add($c.Source + ' ' + $c.Path)
    if ($c.Path -and (Test-Path -LiteralPath $c.Path -PathType Leaf)) {
      $result.Path = $c.Path; $result.Source = $c.Source; $result.Tried = $tried.ToArray(); return $result
    }
  }

  # 3) PATH
  [void]$tried.Add('PATH 里的 ' + $Name)
  try {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) {
      $result.Path = [string]$cmd.Source; $result.Source = 'PATH'; $result.Tried = $tried.ToArray(); return $result
    }
  } catch { }

  # 4) 常见安装位置
  foreach ($dir in $WellKnownDirs) {
    if (-not $dir) { continue }
    $c = Join-Path $dir $exe
    [void]$tried.Add('常见安装位置 ' + $c)
    if (Test-Path -LiteralPath $c -PathType Leaf) {
      $result.Path = $c; $result.Source = '常见安装位置'; $result.Tried = $tried.ToArray(); return $result
    }
  }

  $result.Tried = $tried.ToArray()
  return $result
}

# Tailscale 的官方默认安装目录（第三方软件，产品不打包它；只在这几个位置找，属自动发现而非写死本机路径）
function Get-TailscaleWellKnownDirs {
  $dirs = New-Object System.Collections.ArrayList
  [void]$dirs.Add((Join-Path $env:ProgramFiles 'Tailscale'))
  if (${env:ProgramFiles(x86)}) { [void]$dirs.Add((Join-Path ${env:ProgramFiles(x86)} 'Tailscale')) }
  if ($env:LOCALAPPDATA) { [void]$dirs.Add((Join-Path $env:LOCALAPPDATA 'Tailscale')) }
  return $dirs.ToArray()
}

# Tailscale 状态：IP 优先用 `tailscale ip -4`（P0-1 指定的做法，不依赖 MagicDNS 也不依赖 JSON 结构），
# 再用 `status --json` 补 DNSName / Running，并在 ip -4 失败时从 JSON 里补 IP。
# 任何一步失败都不抛异常，返回 Ip='' 由调用方决定退回 127.0.0.1 或跳过 tailnet 功能。
function Get-TailscaleInfo {
  param([string]$TailscaleExe)

  $info = [pscustomobject]@{ Ip = ''; DnsName = ''; Running = $false; Note = '' }
  if (-not $TailscaleExe -or -not (Test-Path -LiteralPath $TailscaleExe -PathType Leaf)) {
    $info.Note = 'tailscale.exe 未找到'
    return $info
  }

  try {
    $lines = @(& $TailscaleExe ip -4 2>$null)
    foreach ($l in $lines) {
      $s = ([string]$l).Trim()
      if ($s -match '^(\d{1,3}\.){3}\d{1,3}$') { $info.Ip = $s; break }
    }
  } catch { }

  try {
    $raw = (& $TailscaleExe status --json 2>$null | Out-String)
    if ($raw -and $raw.Trim()) {
      $st = $raw | ConvertFrom-Json
      if ($st.BackendState -eq 'Running') { $info.Running = $true }
      if ($st.Self -and $st.Self.DNSName) { $info.DnsName = ([string]$st.Self.DNSName).TrimEnd('.') }
      if (-not $info.Ip -and $st.Self) {
        foreach ($ip in @($st.Self.TailscaleIPs)) {
          if (([string]$ip) -match '^(\d{1,3}\.){3}\d{1,3}$') { $info.Ip = [string]$ip; break }
        }
      }
    }
  } catch { }

  return $info
}

# 主显示器物理像素。必须先声明 DPI 感知再读：不声明时 150% 缩放下
# [System.Windows.Forms.Screen] 返回的是逻辑像素（2560×1600 会读成 1707×1067，
# 见 docs/环境矩阵.md §5.3 问题 2）。失败则退回 WMI，再失败返回 $null。
function Get-PrimaryScreenSize {
  try {
    if (-not ('DshProductDpi' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshProductDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
'@ -ErrorAction Stop
    }
    try { [void][DshProductDpi]::SetProcessDpiAwareness(2) } catch { try { [void][DshProductDpi]::SetProcessDPIAware() } catch { } }
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($b.Width -ge 320 -and $b.Height -ge 200) {
      return [pscustomobject]@{ Width = [int]$b.Width; Height = [int]$b.Height; Source = 'dpi-aware-screen' }
    }
  } catch { }

  try {
    $vc = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
      Where-Object { $_.CurrentHorizontalResolution -ge 320 } | Select-Object -First 1
    if ($vc) {
      return [pscustomobject]@{ Width = [int]$vc.CurrentHorizontalResolution; Height = [int]$vc.CurrentVerticalResolution; Source = 'wmi' }
    }
  } catch { }

  return $null
}

# 抓屏几何（P0-3）：不再写死 2560×1600。
#   1) product.config.json 的 screen.captureWidth/Height 非 0 → 用它
#   2) 否则读主显示器物理分辨率（DPI 感知后读，1920 的机器就是 1920，不是 2560）
#   3) 再不行才退回 2560×1600（唯一允许的写死默认值，只作为兜底）
# maxCaptureWidth（默认 2560）在 1.0.7 起不再影响抓屏：它只是"发送宽度"档位（由 screen-server 缩放）。
# 抓屏宽度只受硬上限 2560 约束（4K 机器仍然只抓 2560 宽，避免带宽/CPU 翻倍）。
function Get-CaptureGeometry {
  param($Config)

  $fallback = [pscustomobject]@{ Width = 2560; Height = 1600; Source = 'fallback-default' }

  $w = 0; $h = 0
  try { $w = [int](Get-ConfigValue $Config @('screen', 'captureWidth') 0) } catch { $w = 0 }
  try { $h = [int](Get-ConfigValue $Config @('screen', 'captureHeight') 0) } catch { $h = 0 }
  $source = 'config'

  if ($w -lt 320) {
    $det = Get-PrimaryScreenSize
    if ($null -eq $det) { return $fallback }
    $w = [int]$det.Width; $h = [int]$det.Height; $source = [string]$det.Source
  }
  if ($h -lt 200) { $h = [int][math]::Round($w * 1600 / 2560) }   # 只知道宽时按原默认比例 16:10 估高

  # 改动（2026-10-30 画质修复）：抓屏宽度只受产品硬上限 2560 约束，**不再被画质档位
  # screen.maxCaptureWidth 压小**——画质档位现在是服务端的"发送宽度"（见 screen-server.mjs）。
  # 实测：让 capture.exe 内缩到 1440 只有 18.6fps（GDI+ 缩放占住 GDI 通道，copy 31→47ms），
  # 原生抓 2560 有 24.7~29.7fps，而且服务端 Lanczos 缩放比抓屏侧 Bilinear 清晰。
  $maxW = 2560
  if ($maxW -gt 0 -and $w -gt $maxW) {
    $h = [int][math]::Round($h * $maxW / [double]$w)
    $w = $maxW
  }
  if ($w -lt 320) { return $fallback }
  if ($h -lt 200) { $h = [int][math]::Round($w * 1600 / 2560) }

  return [pscustomobject]@{ Width = $w; Height = $h; Source = $source }
}

# 某个端口现在的监听者（去重前，可能同一个 pid 在多个地址上各有一条）
function Get-PortOwner {
  param([int]$Port)

  $out = New-Object System.Collections.ArrayList
  $conns = @()
  try {
    $conns = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  } catch { $conns = @() }

  foreach ($c in $conns) {
    $pname = ''; $pcmd = ''; $ppath = ''
    try {
      $proc = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$c.OwningProcess) -ErrorAction SilentlyContinue
      if ($proc) {
        $pname = [string]$proc.Name; $pcmd = [string]$proc.CommandLine
        # 命令行读不到时（用 Win32_Process.Create detached 起来的进程就是这种），
        # 用可执行文件路径兜底，否则会把自己的进程当成"别人占了端口"。
        try { $ppath = [string]$proc.ExecutablePath } catch { }
      }
    } catch { }
    [void]$out.Add([pscustomobject]@{
      Port = $Port; Address = [string]$c.LocalAddress; Pid = [int]$c.OwningProcess; Name = $pname; CommandLine = $pcmd; Path = $ppath
    })
  }
  return $out.ToArray()
}

# 端口冲突检测（P0-4）：返回 $null 表示没冲突（没人监听，或监听的是我们自己的进程）。
# $OwnPattern 用来认出"自家的进程"：脚本会被计划任务每 2 分钟重跑，已经在自己监听不能算冲突。
# 返回的对象里带 pid/进程名/命令行，供调用方打印"谁占了端口、怎么改"。
function Test-ProductPortConflict {
  param([int]$Port, [string]$OwnPattern = '')

  $owners = @(Get-PortOwner -Port $Port)
  if ($owners.Count -eq 0) { return $null }
  foreach ($o in $owners) {
    if ($OwnPattern -and $o.CommandLine -and ($o.CommandLine -match $OwnPattern)) { continue }
    # 兜底 1：用可执行文件路径认自己（有些环境下 CommandLine 读不到但 Path 能读到）
    if ($o.Path -and ($o.Path -match '\\PhoneAccess\\runtime\\node\.exe$')) { continue }
    # 兜底 2：用 Win32_Process.Create detached 起来的进程，CommandLine 和 Path **都可能读不到**
    # （实测 screen-server 就是这样：pid 有、进程名有，但这两个字段都是空）。
    # 本产品所有后台服务都是 node.exe，端口又来自我们自己的配置，所以按"自己人"处理。
    # 不这么做，服务在跑的时候再执行一次启动/重启，就会把自己的进程当成"别的程序占了端口"，
    # 直接退出 —— 用户看到的现象是"重启失败"。
    if ($o.Name -match '^node\.exe$' -and (-not $o.Path) -and (-not $o.CommandLine)) { continue }
    return $o
  }
  return $null
}

# 冲突时给一个可用端口建议（不让客户自己翻端口表）
function Get-FreePortHint {
  param([int]$Port)

  for ($i = 1; $i -le 20; $i++) {
    $p = $Port + $i
    if ($p -gt 65535) { break }
    $busy = $false
    try { $busy = [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) } catch { $busy = $false }
    if (-not $busy) { return $p }
  }
  return 0
}

# 一句中文的冲突说明：谁占了、改哪个配置项、建议改成多少
function Format-PortConflictMessage {
  param($Conflict, [string]$ConfigKey)

  $who = if ($Conflict.Name) { "$($Conflict.Name)（pid=$($Conflict.Pid)）" } else { "pid=$($Conflict.Pid)（进程名读不到，可能是系统进程）" }
  $addr = if ($Conflict.Address) { $Conflict.Address } else { '?' }
  $hint = Get-FreePortHint -Port ([int]$Conflict.Port)
  $suggest = if ($hint -gt 0) { "例如改成 $hint" } else { '换一个空闲端口' }
  $cmd = ''
  if ($Conflict.CommandLine) {
    $len = [math]::Min(120, $Conflict.CommandLine.Length)
    $cmd = "；命令行：" + $Conflict.CommandLine.Substring(0, $len)
  }
  return ("端口 {0} 已被其它程序占用（{1}，监听 {2}{3}）。请修改 product.config.json 里的 {4}（{5}），然后重新运行。" -f $Conflict.Port, $who, $addr, $cmd, $ConfigKey, $suggest)
}
