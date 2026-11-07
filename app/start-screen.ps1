param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 改动（P0-2/P0-3/P0-4，参数化）：原来这三行写死 node/python/tailscale 的绝对路径、写死画面端口 8660、
# 第 104 行写死抓屏宽度 2560。换台机器就整条链失效（而且只在日志里留一行，客户看不到）。
# 现在统一走 product.config.json + 自动发现：自带运行时目录 → PATH → 常见安装位置，找不到才报中文错误。
. (Join-Path $here 'product-config.ps1')
$cfg = Get-ProductConfig -AppDir $here
foreach ($warn in @($cfg.Warnings)) { if ($warn) { Write-Host "[!] 配置提示：$warn" } }
# 改动（PWA/HTTPS）：加载 HTTPS 支持模块。它负责探测"这个 tailnet 能不能签证书"
# 并把 https://<机器名>/ 指到画面服务——手机要"安装成 App"必须走这条 HTTPS 入口。
try { . (Join-Path $here 'https-setup.ps1') } catch { }

$nodeInfo = Resolve-ProductRuntime -AppDir $here -Name 'node' -Config $cfg
$node = $nodeInfo.Path
if (-not $node) {
  Write-Host '[x] 找不到 node.exe，画面服务起不来。三种解决办法，选一个：'
  Write-Host '    1) 把 node.exe 放进本目录的 runtime\ 里（产品自带运行时，客户机推荐这个）'
  Write-Host '    2) 在 product.config.json 的 runtime.nodePath 填 node.exe 的完整路径'
  Write-Host '    3) 把 node 装进系统 PATH 后重新运行'
  Write-Host ('    已尝试过：' + ($nodeInfo.Tried -join '；'))
  if (-not $Quiet) { Read-Host '按回车退出' }
  exit 1
}
$pyInfo = Resolve-ProductRuntime -AppDir $here -Name 'python' -Config $cfg
$py = $pyInfo.Path
$tsResolved = Resolve-ProductRuntime -AppDir $here -Name 'tailscale' -Config $cfg -WellKnownDirs (Get-TailscaleWellKnownDirs)
$ts = $tsResolved.Path
$screenPort = [int]$cfg.ports.screen
$frameFile = Join-Path $here 'screen-latest.jpg'
$keyFile = Join-Path $here 'screen.key'

function Test-Listen([string]$hostIp, [int]$p) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq $hostIp })
}

function Start-Detached([string]$commandLine) {
  # WMIClass.Create with a StartupInfo that hides the window: no console pops up,
  # and (unlike Start-Process) the child is not in the task scheduler's job tree.
  $startup = ([WMIClass]'Win32_ProcessStartup').CreateInstance()
  $startup.ShowWindow = 0
  $r = ([WMIClass]'Win32_Process').Create($commandLine, $here, $startup)
  if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($r.ReturnValue)" }
  $r.ProcessId
}

function Get-LanIp {
  $candidates = @()
  $candidates += Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceAlias -match 'WLAN|Wi-Fi' -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
  $candidates += Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
      $_.InterfaceAlias -notmatch 'VMware|Loopback|vEthernet|Bluetooth|Tailscale'
    }
  ($candidates | Select-Object -First 1).IPAddress
}

# key (stable across restarts so existing QR/pages keep working)
if (-not (Test-Path $keyFile)) {
  $key = -join (1..32 | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] })
  Set-Content -Path $keyFile -Value $key -Encoding ascii -NoNewline
}
$key = (Get-Content $keyFile -Raw).Trim()

# 改动（P0-1/P0-2）：tailnet 地址改成自动发现（tailscale ip -4 优先，失败再从 status --json 补），
# 不再依赖写死的 tailscale.exe 路径；取不到就抛错，不再回退到局域网地址。
# 2026-10-31 安全收紧：**所有访问都必须走 Tailscale**，同一 Wi-Fi 也不例外
# （Tailscale 自己会在同一局域网里走直连，速度不受影响）。局域网不带 Tailscale 的连接一律不监听。
$tsState = Get-TailscaleInfo -TailscaleExe $ts
$tsIp = $tsState.Ip
# 离线模式（没有互联网/没有 Tailscale）：允许只靠局域网/电脑热点启动。
# 开关在 product.config.json → screen.offline，由页面「离线模式」里的开关写入。
$offlineMode = [bool]($cfg.screen -and $cfg.screen.offline)
if (-not $tsIp) {
  if ($offlineMode) {
    Write-Host "[!] Tailscale 没有连上（$($tsState.Note)）：按离线模式继续，只用局域网/热点访问。" -ForegroundColor Yellow
  } else {
    Write-Host "[x] Tailscale 没有连上（$($tsState.Note)）。"
    Write-Host "    出于安全考虑，不提供绕过 Tailscale 的局域网入口；请先登录 Tailscale，再重新启动。"
    if (-not $Quiet) { Read-Host '按回车退出' }
    exit 1
  }
}
# 改动（PWA/HTTPS）：额外绑 127.0.0.1。
# 原因：手机要"安装成 App"必须走 HTTPS（service worker 只在安全上下文可用），
# 而 HTTPS 由 tailscale serve 提供，它默认转发到 127.0.0.1:<port>。
# 原来这里只绑 tailnet 地址和局域网地址，serve 转发过来会连接被拒。
# 绑 127.0.0.1 只对本机可见，不扩大暴露面（局域网和公网仍然进不来）。
$hosts = @('127.0.0.1', $tsIp) | Where-Object { $_ } | Select-Object -Unique
# 离线模式：把本机局域网 IPv4（Wi-Fi/以太网/电脑热点 192.168.137.x）也加进监听列表
# 2026-11-07：screen.lan=true 时也监听局域网（不必开离线模式）
$lanMode = $offlineMode -or [bool]($cfg.screen -and $cfg.screen.lan)
if ($lanMode) {
  $lanIps = @()
  try {
    $lanIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' -and $_.IPAddress -notmatch '^100\.' } |
      Select-Object -ExpandProperty IPAddress -Unique)
  } catch { }
  if ($lanIps.Count -gt 0) {
    $hosts = @($hosts + $lanIps) | Where-Object { $_ } | Select-Object -Unique
    Write-Host ('[i] 离线模式：额外监听 ' + ($lanIps -join ', '))
  }
}
$viewersFile = Join-Path $here 'viewers.count'

# 改动（P0-4）：启动前先查端口冲突。以前绑定失败只在 screen-server.log 里留一行，
# 客户看到的现象是"手机打不开、画面没有"，没有任何可操作的提示。现在直接说清谁占了、改哪个配置项。
$portConflict = Test-ProductPortConflict -Port $screenPort -OwnPattern 'screen-server\.mjs'
if ($portConflict) {
  Write-Host ('[x] ' + (Format-PortConflictMessage -Conflict $portConflict -ConfigKey 'ports.screen'))
  if (-not $Quiet) { Read-Host '按回车退出' }
  exit 1
}

# system sound: WASAPI loopback -> \\.\pipe\dsh-audio (WebRTC audio track)
$audioExe = Join-Path $here 'audio.exe'
if (Test-Path $audioExe) {
  $running = @(Get-Process audio -ErrorAction SilentlyContinue).Count
  if ($running -eq 0) {
    Start-Detached "cmd.exe /c `"`"$audioExe`" dsh-audio `"$(Join-Path $here 'audio.log')`" > nul 2>&1`"" | Out-Null
    Write-Host '[i] starting audio loopback capture'
  }
}

# 远程输入注入器。workspace 里的文件带低完整性标签，低 IL 进程会被 UIPI 拦住，
# SetCursorPos/SendInput 会失败（错误 1300），所以把 input.exe 部署到 workspace 之外再启动。
#
# 改动（第二轮 P0-2 / I1）：两种模式必须分开，提权模式下**不许**再往用户可写目录部署/启动。
#   提权模式：计划任务 DSH Input Injector 用 RunLevel=Highest 执行
#             %ProgramFiles%\PhoneAccessInput\input.exe（普通用户写不了那个目录 → 替换 exe 提权没了）
#   非提权模式：仍然部署到 %LOCALAPPDATA%\DshInput、用当前用户权限启动
#             （同一完整性级别，不跨越权限边界，不构成提权）
#   判定"是不是提权模式"以**计划任务指向哪里**为准，不看标记文件：
#   标记文件以前放在用户可写目录里，能被伪造或误判；任务 Action 是管理员注册的，普通用户改不动。
$inputSrc = Join-Path $here 'input.exe'
$inputDir = Join-Path $env:LOCALAPPDATA 'DshInput'
$inputExe = Join-Path $inputDir 'input.exe'
$pfRoot = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$elevDir = Join-Path $pfRoot 'PhoneAccessInput'
$elevExe = Join-Path $elevDir 'input.exe'
$taskName = 'DSH Input Injector'
$elevAction = ''
try {
  $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($t) { $elevAction = [string](@($t.Actions)[0].Execute) }
} catch { }
$useElevated = [bool]($elevAction -and ($elevAction -like ($elevDir + '\*')))

if (Test-Path $inputSrc) {
  if ($useElevated) {
    if (-not (Test-Path $elevExe)) {
      Write-Host "[!] 高权限注入器文件不在（$elevExe），这次退回普通权限启动；重跑一次安装可修好" -ForegroundColor Yellow
      $useElevated = $false
    }
    elseif ((Get-Item $elevExe).LastWriteTime -lt (Get-Item $inputSrc).LastWriteTime) {
      Write-Host '[!] 高权限注入器比安装目录里的旧（升级后没重跑安装？），请在「轻屏」里点一次「重启」并重跑安装' -ForegroundColor Yellow
    }
  }
  if (-not $useElevated) {
    New-Item -ItemType Directory -Force -Path $inputDir | Out-Null
    if (-not (Test-Path $inputExe) -or ((Get-Item $inputSrc).LastWriteTime -gt (Get-Item $inputExe).LastWriteTime)) {
      Copy-Item $inputSrc $inputExe -Force
    }
  }
  $running = @(Get-Process input -ErrorAction SilentlyContinue).Count
  if ($running -eq 0) {
    # 如果装过 install-elevated-input.ps1（任务指向 Program Files），注入器必须以管理员权限启动：
    # 只有 High 完整性进程才能绕过 UIPI，往"前台是管理员窗口"的情况下继续注入。
    if ($useElevated) {
      Start-ScheduledTask -TaskName $taskName
      Start-Sleep -Seconds 2
      if (Get-Process input -ErrorAction SilentlyContinue) {
        Write-Host "[i] starting remote input injector (elevated task: $taskName)"
      } else {
        Write-Host "[!] 高权限注入器没被计划任务拉起来（$taskName），这一次会没有远程鼠标键盘" -ForegroundColor Yellow
      }
    } else {
      Start-Detached "cmd.exe /c `"`"$inputExe`" dsh-input `"$(Join-Path $here 'input.log')`" > nul 2>&1`"" | Out-Null
      Write-Host '[i] starting remote input injector (deployed copy)'
    }
  }
}


# 1) capture loop (compiled helper: Defender blocks the equivalent PowerShell script)
# 改动（P0-3）：抓屏宽度不再写死 2560，改成按主显示器物理分辨率推导（DPI 感知后读，150% 缩放下
# 也不会读成 1707）；product.config.json 的 screen.captureWidth/Height 可显式覆盖，推导失败才退回 2560×1600。
$geo = Get-CaptureGeometry -Config $cfg
Write-Host "[i] capture geometry $($geo.Width)x$($geo.Height) (来源: $($geo.Source))"
$cap = @(Get-Process capture -ErrorAction SilentlyContinue)
if ($cap.Count -eq 0) {
  Write-Host '[i] starting screen capture loop'
  $capExe = Join-Path $here 'capture.exe'
  if (-not (Test-Path $capExe)) {
    # Defender can quarantine the exe; restore the backup instead of failing
    $bak = "$capExe.bak"
    if (Test-Path $bak) { Copy-Item $bak $capExe -Force; Write-Host '[!] capture.exe restored from backup' }
    else { throw "capture.exe missing - compile capture.cs with csc" }
  }
$capCmd = "`"$capExe`" `"$frameFile`" $($geo.Width) 33 `"$(Join-Path $here 'screen-capture.log')`" 70 `"$viewersFile`" dsh-screen-frames `"$(Join-Path $here 'capture.interval')`" `"$(Join-Path $here 'capture.mode')`""
  # 改动（P0-3）：抓屏宽度参数 2560 → $geo.Width。上面那行 $capCmd 是历史遗留死代码（定义了但没用），
  # 为免以后有人 grep 到 2560 又抄错，一并换成同一个变量，不删（删代码属于重构，不在本次范围）。
  Start-Detached "cmd.exe /c `"`"$capExe`" `"$frameFile`" $($geo.Width) 33 `"$(Join-Path $here 'screen-capture.log')`" 70 `"$viewersFile`" dsh-screen-frames `"$(Join-Path $here 'capture.interval')`" `"$(Join-Path $here 'capture.mode')`" > nul 2>&1`"" | Out-Null
  Start-Sleep -Seconds 3
} else {
  Write-Host "[i] capture already running (pid $($cap[0].Id))"
}

# 2) viewer server, bound to the private addresses only
$missing = @($hosts | Where-Object { -not (Test-Listen $_ $screenPort) })
$extra = @(Get-NetTCPConnection -State Listen -LocalPort $screenPort -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -notin $hosts })
if ($missing.Count -gt 0 -or $extra.Count -gt 0) {
  # the WLAN address changes with DHCP, so a stale binding has to be replaced wholesale
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'node' -and $_.CommandLine -match 'screen-server\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400
  Write-Host "[i] starting screen server on $($hosts -join ', '):$screenPort"
  # 改动（P0-3）：多传第 6 个位置参数 "宽x高"，告诉服务端这次实际抓的是多大，不再由服务端假定 2560。
  # 第 6 个参数是可选新增项：老调用方式（只传 5 个）仍然按 2560×1600 工作，行为不变。
  $arg = "`"$here\screen-server.mjs`" `"$($hosts -join ',')`" $screenPort `"$frameFile`" `"$keyFile`" `"$(Join-Path $here 'viewers.count')`" `"$($geo.Width)x$($geo.Height)`""

  Start-Detached "cmd.exe /c `"`"$node`" $arg > `"$(Join-Path $here 'screen-server.log')`" 2>&1`"" | Out-Null
  # 2026-11-05：2 秒 → 0.8 秒。node 绑定端口通常 200–400ms；守护下一轮会复核，
  # 这段等待只是为了让后面的网址/二维码打印时服务已经起来，不用蹲满 2 秒。
  Start-Sleep -Milliseconds 800
} else {
  Write-Host "[i] screen server already listening"
}

# 3) URLs + QR
# 改动（PWA/HTTPS）：先尝试把 HTTPS 入口配好，再生成网址。
# 这样客户只要在 Tailscale 后台把 HTTPS 打开，重启一次服务（或等守护跑一轮）
# 就会自动多出 https://<机器名>/ 这个"能装成 App"的入口，不用重装产品。
if (Get-Command Enable-HttpsServeForScreen -ErrorAction SilentlyContinue) {
  $httpsRes = $null
  try { $httpsRes = Enable-HttpsServeForScreen -TailscaleExe $ts -ScreenPort $screenPort -SkipProbe:$false }
  catch { $httpsRes = $null }
  if ($httpsRes -and $httpsRes.Ok) {
    Write-Host ('[i] 手机 App 入口：' + $httpsRes.Url + '（可在手机上"添加到主屏幕"）')
  } elseif ($httpsRes -and $httpsRes.Note) {
    Write-Host ('[!] 手机暂时不能"安装成 App"：' + $httpsRes.Note) -ForegroundColor Yellow
    Write-Host '    不影响使用——浏览器打开照样能看能操作，只是没有桌面图标。' -ForegroundColor Yellow
  }
}

# 改动（PWA/HTTPS）：优先给 HTTPS 地址。
# 原因：手机要"安装成 App"必须走安全上下文，而 tailscale serve 提供的
# https://<机器名>.ts.net/ 正好满足；私有 IP 上的 http 地址装不了。
# 检测方式：看 tailscale serve 的配置里，443 端口的 / 是否转发到本机画面端口。
# 找不到就退回原来的 IP 形式（不影响老书签，只是装不了 App）。
function Get-HttpsScreenUrl([string]$tailscaleExe, [int]$port, [string]$key) {
  if (-not $tailscaleExe) { return $null }
  try {
    $json = & $tailscaleExe serve status --json 2>$null | Out-String
    if (-not $json) { return $null }
    $cfg = $json | ConvertFrom-Json
    if (-not $cfg.Web) { return $null }
    $want = 'http://127.0.0.1:' + $port
    foreach ($name in $cfg.Web.PSObject.Properties.Name) {
      if ($name -notmatch ':443$') { continue }
      $hostName = ($name -replace ':443$', '')
      $handlers = $cfg.Web.$name.Handlers
      if (-not $handlers) { continue }
      $root = $handlers.'/'
      if ($root -and ([string]$root.Proxy).TrimEnd('/') -eq $want) {
        return ('https://' + $hostName + '/?k=' + $key)
      }
    }
  } catch { }
  return $null
}

$httpsUrl = Get-HttpsScreenUrl -tailscaleExe $ts -port $screenPort -key $key
# 改动（用户要求）：两个地址都要保留并落盘，不能只留优先级高的那个。
#   screen-url.txt      = 主入口（HTTPS 可用时就是域名形式，能装 App）
#   screen-url-ip.txt   = 备用入口（永远是 http://<tailnet IP>:<port>/?k=…）
# 备用入口必须在：Tailscale 的域名解析偶尔会抽，那时只有数字 IP 能进。
$ipUrl    = if ($tsIp) { "http://${tsIp}:$screenPort/?k=$key" } else { $null }
$tailUrl  = if ($httpsUrl) { $httpsUrl } elseif ($ipUrl) { $ipUrl } else { $null }

function Write-Qr([string]$url, [string]$urlFile, [string]$qrFile) {
  $previous = if (Test-Path $urlFile) { (Get-Content $urlFile -Raw).Trim() } else { '' }
  Set-Content -Path $urlFile -Value $url -Encoding UTF8
  if ($previous -eq $url -and (Test-Path $qrFile)) { return $qrFile }
  # 改动（P0-2）：python 从"写死路径"改成自动发现。找不到时二维码不生成但 URL 照写
  # （二维码只是方便扫码，不是链路依赖；以前找不到 python 会在这里抛一堆红字）。
  if (-not $py) {
    Write-Host '[!] 没找到 python，二维码不生成；网址已写进 txt，可以手动复制到手机'
    return $urlFile
  }
  $line = & $py (Join-Path $here 'make-qr.py') $url $qrFile | Select-Object -Last 1
  $path = [regex]::Match([string]$line, 'qr written: (.+) \(').Groups[1].Value
  if (-not $path) { $path = $qrFile }
  return $path
}

$qr = $null
if ($tailUrl) { $qr = Write-Qr $tailUrl (Join-Path $here 'screen-url.txt') (Join-Path $here 'screen-qr.png') }
# 备用 http 入口单独落盘 + 单独出二维码（域名走不通时靠它）
$qrIp = $null
if ($ipUrl) {
    $qrIp = Write-Qr $ipUrl (Join-Path $here 'screen-url-ip.txt') (Join-Path $here 'screen-qr-ip.png')
}

Write-Host ''
if ($httpsUrl) {
    Write-Host 'Screen viewer (tailnet, HTTPS —— 可在手机上"添加到主屏幕"):'
    Write-Host "  $httpsUrl"
    Write-Host 'Screen viewer (tailnet, HTTP 备用 —— 域名解析不了时用这个):'
    Write-Host "  $ipUrl"
} else {
    Write-Host 'Screen viewer (tailnet):'
    if ($tailUrl) { Write-Host "  $tailUrl" } else { Write-Host '  (Tailscale not connected)' }
}
if ($qr -and -not $Quiet) { Start-Process -FilePath $qr }
if (-not $Quiet) { Read-Host 'Press Enter to exit' }
