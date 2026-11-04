param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 改动（P0-2/P0-4，参数化改造）：原来第 4-7 行写死四个绝对路径（dsh.cmd / node.exe / python.exe / tailscale.exe），
# 第 9-10 行写死端口 8642/8650，第 95 行写死 tailscale serve 的 :80。客户机上任一条不满足，整条链第一步就失败，
# 而计划任务每 2 分钟重复失败一次、只在日志里留一行，客户看到的现象是"手机打不开"，没有任何可操作线索。
# 现在：运行时路径自动发现（自带运行时 → PATH → 常见安装位置），端口和 DSH 开关读 product.config.json。
. (Join-Path $here 'product-config.ps1')
$cfg = Get-ProductConfig -AppDir $here
. (Join-Path $here 'dsh-port.ps1')   # 自动发现 DSH 网页端口（桌面版端口是动态的）
foreach ($warn in @($cfg.Warnings)) { if ($warn) { Write-Host "[!] 配置提示：$warn" } }

$dshPort = [int]$cfg.ports.dsh
$tailPort = [int]$cfg.ports.door
$screenPort = [int]$cfg.ports.screen
$servePort = [int]$cfg.tailnetServePort
$enableDsh = [bool]$cfg.enableDsh
$proxy = Join-Path $here 'tunnel-proxy.mjs'
$log = Join-Path $here 'web-lan.log'

# node 是画面服务的硬依赖（没有它连画面都起不来）：找不到就明确说清怎么办再退出
$nodeInfo = Resolve-ProductRuntime -AppDir $here -Name 'node' -Config $cfg
$node = $nodeInfo.Path
if (-not $node) {
  Write-Host '[x] 找不到 node.exe，整套服务起不来。三种解决办法，选一个：'
  Write-Host '    1) 把 node.exe 放进本目录的 runtime\ 里（产品自带运行时，客户机推荐这个）'
  Write-Host '    2) 在 product.config.json 的 runtime.nodePath 填 node.exe 的完整路径'
  Write-Host '    3) 把 node 装进系统 PATH 后重新运行'
  Write-Host ('    已尝试过：' + ($nodeInfo.Tried -join '；'))
  if (-not $Quiet) { Read-Host '按回车退出' }
  exit 1
}
# python 只用来画二维码：找不到就降级（网址照写、二维码不生成），不阻断启动
$py = (Resolve-ProductRuntime -AppDir $here -Name 'python' -Config $cfg).Path
# tailscale 用来取 tailnet 地址、发布 serve 门；找不到只影响 tailnet 入口，局域网仍然可用
$ts = (Resolve-ProductRuntime -AppDir $here -Name 'tailscale' -Config $cfg -WellKnownDirs (Get-TailscaleWellKnownDirs)).Path

# 许可证：算一次状态写 licence.state.json（画面服务按它决定是否放行）。
# 未授权不阻断启动——页面要照常打开，客户才能看到机器码和购买方式（软停）。
# 改动（独立审查 M1）：启动时用 -Force **重新计算机器码**，不吃 machine.id 缓存。
# 否则客户复制一份改过的 machine.id 就能把许可证搬到别的机器上；
# 日常守护进程仍走缓存（每 8 秒查一次 CIM 太贵）。
try {
  $licScript = Join-Path $here 'licence-state.ps1'
  if (Test-Path -LiteralPath $licScript) {
    & $licScript -AppDir $here -Force -Quiet | Out-Null
  }
} catch {
  Write-Host ('[!] 许可证状态计算失败（不影响画面服务启动）：' + $_.Exception.Message) -ForegroundColor Yellow
}

# 改动（P0-2）：dsh.cmd 相关逻辑整体收进 enableDsh 开关。方案甲（默认 false）完全不碰 DSH，
# 客户机上不需要装 DSH、不需要 AI 账号、没有模型费用。
$cli = $null
if ($enableDsh) {
  $dshInfo = Resolve-ProductRuntime -AppDir $here -Name 'dsh' -Config $cfg
  $cli = $dshInfo.Path
  if (-not $cli) {
    Write-Host '[x] product.config.json 里 enableDsh=true，但找不到 dsh.cmd（DSH 没装或不在 PATH）。'
    Write-Host '    方案甲（只交付屏幕+触控）请把 enableDsh 改成 false；'
    Write-Host '    要用 DSH 对话控制台，请在 runtime.dshPath 填 dsh.cmd 的完整路径。'
    Write-Host ('    已尝试过：' + ($dshInfo.Tried -join '；'))
    if (-not $Quiet) { Read-Host '按回车退出' }
    exit 1
  }
}

# （Get-LanIp 已移除：产品只走 Tailscale，不再需要局域网地址）

function Test-Listen([string]$addr, [int]$port) {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq $addr } | Select-Object -First 1
}

# Spawn outside this process's job object, so the service survives the shell /
# scheduled-task that launched it (Task Scheduler kills its job tree on completion).
function Start-Detached([string]$commandLine) {
  # WMIClass.Create with a StartupInfo that hides the window: no console pops up,
  # and (unlike Start-Process) the child is not in the task scheduler's job tree.
  $startup = ([WMIClass]'Win32_ProcessStartup').CreateInstance()
  $startup.ShowWindow = 0
  $r = ([WMIClass]'Win32_Process').Create($commandLine, $here, $startup)
  if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($r.ReturnValue)" }
  $r.ProcessId
}

function Start-Proxy([string]$listenHost, [int]$listenPort, [string]$targetHost, [int]$targetPort, [string]$name) {
  if (Test-Listen $listenHost $listenPort) {
    Write-Host "[i] ${name} already listening on ${listenHost}:$listenPort"
    return
  }
  Write-Host "[i] ${name}: ${listenHost}:$listenPort -> ${targetHost}:$targetPort"
  $out = Join-Path $here "proxy-$name.log"
  $cmd = "cmd.exe /c `"`"$node`" `"$proxy`" $listenHost $listenPort $targetHost $targetPort > `"$out`" 2>&1`""
  Start-Detached $cmd | Out-Null
  Start-Sleep -Seconds 1
}

# 2026-10-31 安全收紧：不再提供局域网（不带 Tailscale）的入口。
# 所有访问都必须走 Tailscale；同一 Wi-Fi 下 Tailscale 自己会选直连路径，速度不受影响。

# 改动（P0-4）：DSH 与它的三扇门只在 enableDsh=true 时启动（方案甲下 8642/8650 完全不出现）。
if ($enableDsh) {
  # 1) DSH on loopback only: the bind authority never changes, so the browser
  #    cookie stays valid across DHCP lease changes.
  # 改动（P0-4）：启动前查端口冲突，被别的程序占着就明确报错（survey 实测客户机上这三个端口全被占过）。
  # 改动（bug 修复）：8642 上可能同时有我们自己两种进程——
  #   · 127.0.0.1:8642  = DSH 网页（--profile web）
  #   · tailnet/LAN 地址:8642 = 门 tunnel-proxy.mjs
  # 原来只认 '--profile web'，所以只杀掉画面服务、门还活着时，重启会把自己的门误判成"别的程序"并拒绝启动。
  $dshConflict = Test-ProductPortConflict -Port $dshPort -OwnPattern '\-\-profile web|tunnel-proxy\.mjs'
  # 兜底：我们自己启动的 dsh web 也是 DeepSeek Harness.exe，且 detached 起来后命令行读不到，
  # 上面那个 OwnPattern 匹配不上，会把自己人误判成"别人占了 8642"直接退出。这里再认一次。
  if ($dshConflict -and $dshConflict.Name -match '^DeepSeek Harness' -and (-not $dshConflict.CommandLine)) { $dshConflict = $null }
  if ($dshConflict) {
    Write-Host ('[x] ' + (Format-PortConflictMessage -Conflict $dshConflict -ConfigKey 'ports.dsh'))
    if (-not $Quiet) { Read-Host '按回车退出' }
    exit 1
  }
  # 说明（踩过的坑）：手机那扇门（tunnel-proxy）是**从 web-lan.log 里抓 token 登录**的，
  # 而 web-lan.log 只有"我们自己启动 dsh web"时才有。DSH 桌面版不写这个日志，
  # 所以复用桌面版实例虽然端口对得上，/go 却会一直返回 503（实测）。
  # 结论：门必须指向我们自己启动的那个 dsh web（监听配置里的 $dshPort）。
  # 下面的探测只用来在日志里提示"桌面上还跑着一个 DSH"，不参与选端口。
  $dshTargetPort = 0
  if (Test-Listen '127.0.0.1' $dshPort) {
    Write-Host "[i] DSH already listening on 127.0.0.1:$dshPort"
    $dshTargetPort = $dshPort
  }
  $otherDsh = Get-DshWebPort -Preferred 0
  if ($otherDsh -gt 0 -and $otherDsh -ne $dshPort) {
    Write-Host "[i] 另有一个 DSH 网页在 127.0.0.1:$otherDsh（桌面版），手机那扇门不使用它"
  }
  if ($dshTargetPort -le 0) {
    Write-Host "[i] Starting DSH web on 127.0.0.1:$dshPort (log: $log)"
    $cmd = "cmd.exe /c `"`"$cli`" --profile web --host 127.0.0.1 --port $dshPort --no-open > `"$log`" 2>&1`""
    Start-Detached $cmd | Out-Null
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Seconds 2
      if (Test-Listen '127.0.0.1' $dshPort) { break }
    }
    if (-not (Test-Listen '127.0.0.1' $dshPort)) {
      Write-Host '[x] DSH did not come up. Last log lines:'
      Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 12
      if (-not $Quiet) { Read-Host 'Press Enter to exit' }
      exit 1
    }
    Write-Host '[i] DSH is up.'
  $dshTargetPort = $dshPort
  } else {
  Write-Host ('[i] 复用已在运行的 DSH 网页（127.0.0.1:' + $dshTargetPort + '）')
  }

  # 2) front doors, all rewriting the authority to loopback
  # 改动（P0-1/P0-2）：tailnet 地址改成自动发现（tailscale ip -4 优先），不再依赖写死的 tailscale.exe 路径与 JSON 结构。
  $tsState = Get-TailscaleInfo -TailscaleExe $ts
  $tsIp = $tsState.Ip

  $doorConflict = Test-ProductPortConflict -Port $tailPort -OwnPattern 'tunnel-proxy\.mjs'
  if ($doorConflict) {
    Write-Host ('[x] ' + (Format-PortConflictMessage -Conflict $doorConflict -ConfigKey 'ports.door'))
    if (-not $Quiet) { Read-Host '按回车退出' }
    exit 1
  }

  Start-Proxy '127.0.0.1' $tailPort '127.0.0.1' $dshTargetPort 'tailnet'
  # 2026-10-31：去掉 LAN 门——不允许绕过 Tailscale 从同一局域网直接访问。
  # DNS-free tailnet door: works even when a peer cannot resolve MagicDNS names
  if ($tsIp) { Start-Proxy $tsIp $dshPort '127.0.0.1' $dshTargetPort 'tailip' }

  # 3) publish the tailnet front door (config persists across reboots)
  # 改动（P0-4）：serve 端口不再写死 80，改读 product.config.json 的 tailnetServePort。
  if ($tsState.Running -and $tsState.DnsName) {
    # tailnet 里可能已经有别的 serve 占用同一端口：覆盖前先把现有配置打出来（不静默覆盖）
    $serveBefore = ''
    try { $serveBefore = (& $ts serve status 2>$null | Out-String).Trim() } catch { $serveBefore = '' }
    if ($serveBefore -and ($serveBefore -notmatch "127\.0\.0\.1:$tailPort")) {
      Write-Host "[!] tailscale 里已有别的 serve 配置，本次会用 :$servePort 覆盖它，先确认一下："
      ($serveBefore -split "`r?`n" | Select-Object -First 8) | ForEach-Object { Write-Host "    $_" }
    }
    & $ts serve --bg --http=$servePort "http://127.0.0.1:$tailPort" | Out-Null
    # 改动（2026-11-04）：再给对话控制台单开一个 **HTTPS** 入口（默认 8443 → 同一扇门）。
    # 为什么需要：:80 的 HTTPS 已经给了画面页（那才是客户要"添加到主屏幕"的 App 入口），
    # 手机浏览器里存的 DSH 标签如果是 https://<域名>/ 就会落到画面页，看起来"标签失效、要重输地址"。
    # 这个入口是纯 tailnet 的，不对外暴露；关掉用 tailscale serve --https=8443 off。
    # 端口可被配置覆盖：dshServePort（缺省 8443）。
    $dshServePort = 8443
    try {
      $cfgForServe = Get-ProductConfig -AppDir $here
      $p = Get-ConfigValue $cfgForServe @('dshServePort') 0
      if ($p) { $dshServePort = [int]$p }
    } catch { }
    if ($dshServePort -gt 0) {
      & $ts serve --bg --https=$dshServePort "http://127.0.0.1:$tailPort" 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Host "[!] HTTPS 控制台入口 :$dshServePort 没建起来（端口可能被占用），改用 http://<tailnet 地址>:$dshPort/ 也能用" }
    }
  } else {
    Write-Host '[!] Tailscale is not connected; the name-based entry is skipped (IP still works).'
  }
} else {
  # 客户可见文案：交付给客户的版本里绝不出现"DSH"字样（那是卖家自用时的叫法）。
  Write-Host '[i] 本轮只启动画面服务（手机看屏幕 + 触控）'
  # 改动（2026-11-04）：从方案乙切到方案甲时，8642/8650 上还留着上一轮的 DSH 与门，
  # 而谁都不负责停它们 —— supervisor 只按自己启动时的配置办事，autostart 只负责"起"。
  # 结果"改成方案甲"看起来没生效（手机还能打开对话控制台，微信群里看起来像又崩了）。
  # 这里收尾：只清我们自己那两类进程（node 门 / DeepSeek Harness），绝不动桌面版 DSH。
  # autostart 每 2 分钟跑一次本脚本，所以切换最迟 2 分钟内生效，不需要重启任何东西。
  $stale = @()
  foreach ($prt in @($dshPort, $tailPort)) {
    Get-NetTCPConnection -State Listen -LocalPort $prt -ErrorAction SilentlyContinue |
      ForEach-Object { $stale += [pscustomobject]@{ Port = $prt; Owner = [int]$_.OwningProcess } }
  }
  foreach ($s in ($stale | Sort-Object Owner -Unique)) {
    if ($s.Owner -le 0) { continue }
    $proc = Get-Process -Id $s.Owner -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.ProcessName -notmatch '^(node|DeepSeek Harness)$') { continue }
    try {
      Stop-Process -Id $s.Owner -Force -ErrorAction Stop
      Write-Host ("[i] 方案甲：已停掉上一轮残留的 {0}（pid {1}，端口 {2}）" -f $proc.ProcessName, $s.Owner, $s.Port)
    } catch {
      Write-Host ("[!] 方案甲：停不掉 {0}（pid {1}）: {2}" -f $proc.ProcessName, $s.Owner, $_.Exception.Message)
    }
  }
  $tsState = Get-TailscaleInfo -TailscaleExe $ts
}

# 4) resident supervisor: health-check every 8s, restart a hung/dead instance
# The singleton state is supervisor.lock (an exclusive OS handle held by the live
# supervisor), not a process-name scan — that scan can race and start a second copy.
$beat = Join-Path $here 'supervisor.heartbeat'
$lockPath = Join-Path $here 'supervisor.lock'
$beatAge = if (Test-Path $beat) { ((Get-Date) - (Get-Item $beat).LastWriteTime).TotalMinutes } else { 999 }$lockFree = $false
try {
  $h = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
  $h.Close()
  $lockFree = $true
} catch { $lockFree = $false }

$sup = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'powershell' -and $_.CommandLine -match '-File\s+\S+supervise\.ps1' })

# 注意：$beatAge 的单位是**分钟**（TotalMinutes）。这里 3 表示 3 分钟，不是 3 秒。
# 锁本身由存活进程持有，进程死了锁会自动释放；这条只处理"活着但卡死"的情况，别调太小。
if (-not $lockFree -and $beatAge -gt 3) {
  Write-Host '[!] supervisor holds the lock but its heartbeat is stale; replacing it'
  $sup | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  $lockFree = $true
}

if ($lockFree) {
  Write-Host '[i] starting supervisor (health check every 8s)'
  $supCmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$here\supervise.ps1`""
  Start-Detached $supCmd | Out-Null
} else {
  $who = if ($sup.Count -gt 0) { "pid $($sup[0].ProcessId)" } else { 'unknown pid' }
  Write-Host "[i] supervisor already running ($who)"
}

# 5) screen viewer (phone/tablet can watch the desktop; independent of DSH)
$screenScript = Join-Path $here 'start-screen.ps1'
if (Test-Path $screenScript) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $screenScript -Quiet 2>&1 |
    Select-Object -Last 6
  Start-Sleep -Seconds 2
}

# 6) URLs + QR for the phone
# 改动（P0-4）：DSH 关掉时这些入口本来就不存在，不去读 web-lan.log 找 token（找不到只会让人误会服务坏了）。
if ($enableDsh) {
  $line = Get-Content $log -ErrorAction SilentlyContinue |
    Where-Object { $_ -match 'dsh web:\s*https?://\S+' } | Select-Object -Last 1
  $token = ''
  if ($line) {
    $token = [regex]::Match([regex]::Match($line, 'https?://\S+').Value.Trim(), '[?&]token=([^&\s]+)').Groups[1].Value
  }
  $dns = $tsState.DnsName
  $tsIp = $tsState.Ip

  $tailUrl = if ($dns -and $token) { "http://$dns/?token=$token" } else { $null }
  $ipUrl   = if ($tsIp -and $token) { "http://${tsIp}:$dshPort/?token=$token" } else { $null }

  function Write-Qr([string]$url, [string]$urlFile, [string]$qrFile) {
    $previous = if (Test-Path $urlFile) { (Get-Content $urlFile -Raw).Trim() } else { '' }
    Set-Content -Path $urlFile -Value $url -Encoding UTF8
    # the watchdog re-runs every couple of minutes: only redraw when the token changed
    if ($previous -eq $url -and (Test-Path $qrFile)) { return $qrFile }
    # 改动（P0-2）：python 改成自动发现；找不到时二维码不生成但 URL 照写，不再抛一串红字
    if (-not $py) {
      Write-Host '[!] 没找到 python，二维码不生成；网址已写进 txt，可以手动复制到手机'
      return $urlFile
    }

    $stage = "$qrFile.stage.png"
    & $py (Join-Path $here 'make-qr.py') $url $stage | Out-Null
    if (-not (Test-Path $stage)) { return $qrFile }

    try {
      Move-Item $stage $qrFile -Force -ErrorAction Stop
      $path = $qrFile
    } catch {
      # the canonical file is held open by an image viewer: write a token-unique one and
      # try to remove the stale canonical file so nobody scans an expired QR by mistake
      $suffix = [regex]::Match($url, 'token=([0-9A-Za-z_\-]{8})').Groups[1].Value
      if (-not $suffix) { $suffix = Get-Date -Format 'HHmmss' }
      $path = Join-Path (Split-Path $qrFile) "phone-qr-$suffix.png"
      Move-Item $stage $path -Force -ErrorAction SilentlyContinue
      Remove-Item $qrFile -Force -ErrorAction SilentlyContinue
      Write-Host "[!] $qrFile is locked; wrote $path instead"
    }
    return $path
  }

  $qrPath = $null
  if ($tailUrl) { $qrPath = Write-Qr $tailUrl (Join-Path $here 'phone-url.txt') (Join-Path $here 'phone-qr.png') }
  if ($ipUrl) { Write-Qr $ipUrl (Join-Path $here 'tailip-url.txt') (Join-Path $here 'qr-tailip.png') | Out-Null }

  # Permanent bookmark: /go?k=<screen key> always redirects to the *current* token, so this
  # URL+QR never expires (DSH mints a new token on every start, this rides along).
  $keyFile = Join-Path $here 'screen.key'
  $key = if (Test-Path $keyFile) { (Get-Content $keyFile -Raw).Trim() } else { '' }
  $loginUrl = $null
  if ($key -and $ipUrl) {
    $loginUrl = "http://${tsIp}:$dshPort/go?k=$key"
    Write-Qr $loginUrl (Join-Path $here 'login-url.txt') (Join-Path $here 'qr-login.png') | Out-Null
  }
  if ($qrPath -and -not $Quiet) { Start-Process -FilePath $qrPath }

  Write-Host ''
  Write-Host 'Permanent login (never expires, no rescan):'
  if ($loginUrl) { Write-Host "  $loginUrl" } else { Write-Host '  (screen key missing)' }
  Write-Host 'Tailnet by name (MagicDNS):'
  if ($tailUrl) { Write-Host "  $tailUrl" } else { Write-Host '  (Tailscale not connected)' }
  Write-Host 'Tailnet by IP (no DNS needed):'
  if ($ipUrl) { Write-Host "  $ipUrl" }
} else {
  Write-Host ''
  # 客户可见文案：不提 DSH。顺带把"能装成 App"的 https 地址也标出来。
  Write-Host '手机入口（画面服务）：'
  $surl = Join-Path $here 'screen-url.txt'
  $surlIp = Join-Path $here 'screen-url-ip.txt'
  if (Test-Path $surl) {
    $main = (Get-Content $surl -Raw).Trim()
    if ($main -match '^https://') {
      Write-Host ('  主入口（https，可在手机上"添加到主屏幕"）: ' + $main)
    } else {
      Write-Host ('  主入口: ' + $main)
    }
  } else { Write-Host '  主入口: (未生成，Tailscale 可能没连上)' }
  if (Test-Path $surlIp) { Write-Host ('  备用入口（http，数字 IP）: ' + (Get-Content $surlIp -Raw).Trim()) }
}
if (-not $Quiet) { Read-Host 'Press Enter to exit' }
