$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here 'supervisor.log'
$beat = Join-Path $here 'supervisor.heartbeat'
$diag = Join-Path $here 'diagnostics'

# 改动（P0-4，参数化）：端口不再写死 8642/8650/8660，改读 product.config.json（文件缺失就用内置默认值继续跑）。
# 8642 属 DSH 可选模块：enableDsh=false（方案甲）时守护完全不碰 DSH 和它的三扇门，只守画面子系统。
# 为什么必须这样：以前守护把 DSH 当必活组件，方案甲下它会每十几秒去重启一个永远不该启动的 DSH，
# 日志被 restart 记录刷满，真正该管的画面故障反而被淹没。
. (Join-Path $here 'product-config.ps1')
$cfg = Get-ProductConfig -AppDir $here
$port = [int]$cfg.ports.dsh
$proxyPort = [int]$cfg.ports.door
$screenPort = [int]$cfg.ports.screen
$enableDsh = [bool]$cfg.enableDsh

# 改动（P0-1）：$screenIp 原来写死一个固定的 tailnet 地址。换一台机器/换一个 tailnet 后，守护拿它去 curl /health
# 必然失败，而且是**静默**失败：退回去看 screen-latest.jpg 的时间戳，可管道模式根本不写这个文件
# （capture.cs 只在没有管道客户端时才写文件），于是"画面卡死"和"注入器卡死"这两类最重要的自愈全部失效。
# 现在改成自动发现：tailscale ip -4 → 取不到才退回 127.0.0.1（不写进配置文件让客户填）。
$tsResolved = Resolve-ProductRuntime -AppDir $here -Name 'tailscale' -Config $cfg -WellKnownDirs (Get-TailscaleWellKnownDirs)
$tsInfo = Get-TailscaleInfo -TailscaleExe $tsResolved.Path
$screenIp = $tsInfo.Ip
if (-not $screenIp) { $screenIp = '127.0.0.1' }
$serviceLog = Join-Path $here 'web-lan.log'
$restart = Join-Path $here 'start-phone-access.ps1'
$syncScript  = Join-Path $here 'sync-profile-plugins.ps1'
$syncStamp   = Join-Path $here 'plugin-sync.stamp'
$syncPending = Join-Path $here 'plugin-sync.pending'
$syncBackup  = Join-Path $here 'plugin-sync-backup'
$webProfile  = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$memLimitMB = 4500
$logLimitMB = 25
# 桌面端自更新维护窗口：更新时应用会先退出、再由 NSIS 安装器替换 exe/app.asar，
# 这段时间 8642 本来就是断的。守护若在十几秒内就把 DSH 拉起来，安装器会因为
# “程序仍在运行 / 文件被占用”直接放弃（2026-10-27 的 0.2.1-rc.3 更新就是这么失败的）。
# 三种来源：手工 maintenance.flag（内容可写秒数，默认 180）、安装器进程在跑、刚下完包。
$maintenanceFlag = Join-Path $here 'maintenance.flag'
$updaterPending  = Join-Path $env:LOCALAPPDATA '@deepseek-aidsh-desktop-updater\pending'
$maintenanceSec  = 180
$notListeningGrace = 2   # 连续几轮探测不到 8642 才重启（每轮 8 秒）

if (-not (Test-Path $diag)) { New-Item -ItemType Directory -Path $diag -Force | Out-Null }

function Log([string]$message) {
  ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message) |
    Out-File -FilePath $log -Append -Encoding utf8
}

function Test-Endpoint {
  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 6 -ErrorAction Stop
    return $true
  } catch {
    if ($null -ne $_.Exception.Response) { return $true }  # 401/403 still means alive
    return $false
  }
}

function Get-Owner([int]$localPort) {
  (Get-NetTCPConnection -State Listen -LocalPort $localPort -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
    Select-Object -First 1).OwningProcess
}

# Extra doors (LAN on the WLAN address, tailnet IP) are separate proxy processes and
# need their own checks; the tailnet name door is the 127.0.0.1:8650 listener above.
function Test-UrlDoor([string]$urlFile) {
  if (-not (Test-Path $urlFile)) { return $true }
  $u = (Get-Content $urlFile -Raw).Trim()
  $m = [regex]::Match($u, '//([^:/]+):(\d+)/')
  if (-not $m.Success) { return $true }
  $hostIp = $m.Groups[1].Value
  $p = [int]$m.Groups[2].Value
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -eq $hostIp })
}

function Test-LanDoor {
  return (Test-UrlDoor (Join-Path $here 'lan-url.txt')) -and (Test-UrlDoor (Join-Path $here 'tailip-url.txt'))
}

function Save-Diagnostics([string]$reason) {
  try {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $target = Join-Path $diag "restart-$stamp.txt"
    $lines = @("reason: $reason", "time: $(Get-Date -Format o)")
    $owner = Get-Owner $port
    if ($owner) {
      $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
      if ($proc) {
        $lines += "pid: $($proc.Id) name: $($proc.ProcessName) cpu: $([math]::Round($proc.CPU, 1))s ws: $([math]::Round($proc.WorkingSet64 / 1MB))MB threads: $($proc.Threads.Count) responding: $($proc.Responding)"
      }
    }
    $lines += '--- service log tail ---'
    $lines += (Get-Content $serviceLog -ErrorAction SilentlyContinue | Select-Object -Last 40)
    Set-Content -Path $target -Value $lines -Encoding UTF8
    Log "diagnostics saved: $target"
  } catch {
    Log "diagnostics failed: $($_.Exception.Message)"
  }
}

# 更新/安装期间一律不许重启：返回非空字符串表示当前处于维护窗口（内容写进日志）。
# 手工方式（推荐）：更新前跑 `maintenance.ps1 -Minutes 3`，3 分钟内守护只探活不动手。
function Get-MaintenanceWindow {
  if (Test-Path $maintenanceFlag) {
    $seconds = $maintenanceSec
    $raw = Get-Content $maintenanceFlag -Raw -ErrorAction SilentlyContinue
    if ($raw -and $raw.Trim() -match '^\d+$') { $seconds = [int]$raw.Trim() }
    $age = ((Get-Date) - (Get-Item $maintenanceFlag).LastWriteTime).TotalSeconds
    if ($age -lt $seconds) { return ('maintenance.flag {0}s/{1}s' -f [math]::Round($age), $seconds) }
  }
  $installer = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match '^deepseek-harness-.*-win-x64$' -or $_.ProcessName -eq 'installer' }
  if ($installer) { return ('installer running pid={0}' -f $installer[0].Id) }
  $info = Join-Path $updaterPending 'update-info.json'
  if (Test-Path $info) {
    $age = ((Get-Date) - (Get-Item $info).LastWriteTime).TotalSeconds
    if ($age -lt $maintenanceSec) { return ('update downloaded {0}s ago' -f [math]::Round($age)) }
  }
  return $null
}

function Restart-Service([string]$reason) {
  Save-Diagnostics $reason
  $owner = Get-Owner $port
  if ($owner) {
    $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($p) {
      Log "killing dsh web pid=$owner ($($p.ProcessName), ws=$([math]::Round($p.WorkingSet64/1MB))MB): $reason"
      Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 2
  if ((Test-Path $serviceLog) -and ((Get-Item $serviceLog).Length -gt ($logLimitMB * 1MB))) {
    Move-Item $serviceLog "$serviceLog.old" -Force -ErrorAction SilentlyContinue
    Log 'service log rotated'
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restart -Quiet 2>&1 |
    Out-File -FilePath $log -Append -Encoding utf8
  Start-Sleep -Seconds 15
}

# singleton guard: an OS-exclusive handle on supervisor.lock; a second copy exits
try {
  $script:lockHandle = [IO.File]::Open((Join-Path $here 'supervisor.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Log 'another supervisor already holds supervisor.lock; exiting'
  exit 0
}

Log '=== supervisor start ==='
# 改动（P0-1）：把自动发现的结果写进日志。不写的话，"守护的眼睛没接上"这件事本身还是静默的。
if ($tsInfo.Ip) {
  Log ("tailnet ip discovered: {0}; screen health probe -> http://{1}:{2}/health" -f $screenIp, $screenIp, $screenPort)
} else {
  Log ("[warn] tailnet ip 没取到（{0}）；/health 探测退回 http://127.0.0.1:{1} —— 如果画面服务没有绑定 127.0.0.1，帧新鲜度判断会失效（会在下面反复告警）" -f $tsInfo.Note, $screenPort)
}
if ($enableDsh) {
  Log ("enableDsh=true: 同时守护 DSH({0})、门({1}) 与画面({2})" -f $port, $proxyPort, $screenPort)
} else {
  Log ("enableDsh=false（方案甲）: 只守护画面子系统({0})，不检查也不拉起 DSH 与它的门" -f $screenPort)
}
$fails = 0
$inputHungRounds = 0
$notListeningRounds = 0
$probeFailRounds = 0
$maintenanceLogged = $false
$lastBeat = Get-Date

while ($true) {
  try {
    Set-Content -Path $beat -Value (Get-Date -Format o) -Encoding ascii -ErrorAction SilentlyContinue
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
      Move-Item $log "$log.old" -Force -ErrorAction SilentlyContinue
      Log 'supervisor log rotated'
    }

    # 许可证状态刷新：客户把 licence.json 放进安装目录后，不用重启服务就会生效
    # （machine.id 有缓存，这一句很便宜；失败不吞掉守护逻辑）
    try {
      $licState = Join-Path $here 'licence-state.ps1'
      if (Test-Path -LiteralPath $licState) { & $licState -AppDir $here -Quiet | Out-Null }
    } catch { Log ('licence-state failed: ' + $_.Exception.Message) }

    # 维护窗口优先于一切重启动作：更新安装期间 8642 断属于正常现象，
    # 这一轮只写 heartbeat、不碰任何进程。
    # 改动（P0-4）：维护窗口是为 DSH 桌面端自更新准备的，方案甲（enableDsh=false）下没有 DSH，直接跳过。
    $maint = if ($enableDsh) { Get-MaintenanceWindow } else { $null }
    if ($maint) {
      if (-not $maintenanceLogged) {
        Log "update in progress ($maint); suppressing restarts"
        $maintenanceLogged = $true
      }
      $notListeningRounds = 0
      $fails = 0
      Start-Sleep -Seconds 5
      continue
    }
    if ($maintenanceLogged) {
      Log 'update window ended; restart checks resumed'
      $maintenanceLogged = $false
    }

    # 插件自动对齐：每 10 分钟和桌面 profile 比一次。脚本自己只写文件、不重启，
    # 重启统一由本循环做，避免两个进程抢着重启把 web-lan.log 清空、token 弄丢。
    # 改动（P0-4）：插件对齐是 DSH 的事，方案甲（enableDsh=false）下跳过。
    try {
      if ($enableDsh -and (Test-Path $syncScript)) {
        $due = (-not (Test-Path $syncStamp)) -or (((Get-Date) - (Get-Item $syncStamp).LastWriteTime).TotalMinutes -ge 10)
        if ($due) {
          & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncScript -Quiet 2>&1 |
            Out-File -FilePath $log -Append -Encoding utf8
          Set-Content -Path $syncStamp -Value (Get-Date -Format o) -Encoding ascii -ErrorAction SilentlyContinue
        }
      }
    } catch { Log "plugin sync failed: $($_.Exception.Message)" }

    if ($enableDsh -and (Test-Path $syncPending)) {
      $why = (Get-Content $syncPending -Raw -ErrorAction SilentlyContinue).Trim()
      Log "plugin config changed ($why); restarting dsh web"
      Restart-Service 'plugin-sync'
      Start-Sleep -Seconds 20
      if (-not (Get-Owner $port)) {
        Log 'plugin sync broke startup; rolling back web/package.json'
        try {
          Copy-Item (Join-Path $syncBackup 'package.json') (Join-Path $webProfile 'package.json') -Force -ErrorAction Stop
          $bkPatch = Join-Path $syncBackup 'cordis.patch.yml'
          if (Test-Path $bkPatch) { Copy-Item $bkPatch (Join-Path $webProfile 'cordis.patch.yml') -Force }
          Restart-Service 'plugin-sync-rollback'
        } catch { Log "rollback failed: $($_.Exception.Message)" }
      }
      Remove-Item $syncPending -Force -ErrorAction SilentlyContinue
      continue
    }

    # 改动（P0-4）：DSH 与它的门只在 enableDsh=true 时参与判活；方案甲下这两行取到 0，
    # 下面的两个 if 也因此整段跳过（否则守护会每十几秒重启一个不该存在的 DSH）。
    $dshPid = if ($enableDsh) { Get-Owner $port } else { 0 }
    $proxyPid = if ($enableDsh) { Get-Owner $proxyPort } else { 0 }

    if ($enableDsh -and -not $dshPid) {
      # 端口断开先别急着拉起来：应用退出/更新时端口本来就是断的。
      # 连续 $notListeningGrace 轮（约 16 秒）都不通，才认定真的挂了。
      $notListeningRounds++
      if ($notListeningRounds -lt $notListeningGrace) {
        Log "dsh web is not listening (round $notListeningRounds/$notListeningGrace); waiting"
        Start-Sleep -Seconds 8
        continue
      }
      Log 'dsh web is not listening; restarting'
      Restart-Service 'not-listening'
      $fails = 0
      $notListeningRounds = 0
      continue
    }
    $notListeningRounds = 0

    if ($enableDsh -and (-not $proxyPid -or -not (Test-LanDoor))) {
      Log "a proxy door is not listening (tailnet=$([bool]$proxyPid) lan=$([bool](Test-LanDoor))); restarting proxies"
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restart -Quiet 2>&1 |
        Out-File -FilePath $log -Append -Encoding utf8
      Start-Sleep -Seconds 10
      continue
    }

    # screen viewer: capture helper + viewer server (separate from DSH, cheap to restart)
    $capProc = Get-Process capture -ErrorAction SilentlyContinue
    $captureOk = [bool]$capProc
    $screenOk = [bool](Get-NetTCPConnection -State Listen -LocalPort $screenPort -ErrorAction SilentlyContinue)
    $capFat = $capProc -and ($capProc.WorkingSet64 -gt 300MB)
    # 声音采集 / 输入注入器是独立进程，任何一个掉线都重新走一次 start-screen.ps1 补齐
    $helperDown = -not (Get-Process audio -ErrorAction SilentlyContinue) -or -not (Get-Process input -ErrorAction SilentlyContinue)

    # 注入器若以管理员权限运行（计划任务 DSH Input Injector），普通权限的 supervisor
    # 既 Stop-Process 不掉它、也读不到它的细节：只能靠 /health 的 input.connected 判断它是否活着。
    # 进程在、但管道连不上超过 2 轮 → 重启计划任务（Stop/Start-ScheduledTask 不需要管理员）。
    $inputHung = $false
    if ((Get-Process input -ErrorAction SilentlyContinue) -and
        (Test-Path (Join-Path $env:LOCALAPPDATA 'DshInput\elevated.enabled'))) {
      $h = ''
      try { $h = (& curl.exe -s --max-time 3 "http://${screenIp}:$screenPort/health") -join '' } catch { }
      if ($h -match '"connected":false') {
        $inputHungRounds++
        if ($inputHungRounds -ge 2) { $inputHung = $true; $inputHungRounds = 0 }
      }
      else { $inputHungRounds = 0 }
    }

    # capture parks itself when nobody watches, so only judge frame freshness while a
    # viewer is actually connected (a parked capture would otherwise look dead)
    $viewers = 0
    try { $viewers = [int]((Get-Content (Join-Path $here 'viewers.count') -Raw).Trim()) } catch { $viewers = 0 }
    # pipe mode never writes screen-latest.jpg, so ask the viewer server for the newest
    # frame's age instead of stat()ing a file that is intentionally stale
    $frameStale = $false
    if ($viewers -gt 0) {
      $healthText = ''
      try { $healthText = (& curl.exe -s --max-time 3 "http://${screenIp}:$screenPort/health") -join '' } catch { }
      # 改动（P0-1）：探测彻底打不通要留痕。不写这段的话，/health 失败 → 退回看 screen-latest.jpg →
      # 管道模式下那个文件永远不更新 → 一帧过期就重启抓屏，现场看起来像"守护在乱杀进程"。
      if (-not $healthText.Trim()) {
        $probeFailRounds++
        if ($probeFailRounds -eq 1 -or ($probeFailRounds % 30) -eq 0) {
          Log ("[warn] /health 探测不通（第 {0} 轮）: http://{1}:{2}/health；帧新鲜度判断退回 screen-latest.jpg（管道模式下该文件不更新，可能误判）" -f $probeFailRounds, $screenIp, $screenPort)
        }
      } else {
        $probeFailRounds = 0
      }
      if ($healthText -match 'age=([0-9.]+)') {
        $frameStale = ([double]$Matches[1] -gt 10)
      } else {
        $framePath = Join-Path $here 'screen-latest.jpg'
        if (Test-Path $framePath) {
          $frameStale = (((Get-Date) - (Get-Item $framePath).LastWriteTime).TotalSeconds -gt 10)
        } else { $frameStale = $true }
      }
    }

    if ($inputHung) {
      Log 'input injector alive but pipe not connected (elevated mode); restarting scheduled task'
      Stop-ScheduledTask -TaskName 'DSH Input Injector' -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
      Start-ScheduledTask -TaskName 'DSH Input Injector' -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 4
    }

    if (-not $captureOk -or -not $screenOk -or $capFat -or $frameStale -or $helperDown) {
      if ($capFat -and $capProc) {
        Log ("capture.exe memory high ({0}MB); restarting it" -f [math]::Round($capProc.WorkingSet64 / 1MB))
        Stop-Process -Id $capProc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
      }
      if ($frameStale -and $capProc) {
        Log "capture stalled (>10s without a frame while $viewers viewer(s) connected); restarting it"
        Stop-Process -Id $capProc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
      }
      Log "screen viewer down (capture=$captureOk server=$screenOk fat=$capFat stale=$frameStale helpers=$(-not $helperDown)); restarting it"
      $capLog = Join-Path $here 'screen-capture.log'
      if ((Test-Path $capLog) -and ((Get-Item $capLog).Length -gt 2MB)) {
        Move-Item $capLog "$capLog.old" -Force -ErrorAction SilentlyContinue
      }
      $screenScript = Join-Path $here 'start-screen.ps1'
      if (Test-Path $screenScript) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $screenScript -Quiet 2>&1 |
          Out-File -FilePath $log -Append -Encoding utf8
      }
      Start-Sleep -Seconds 5
    }

    # 改动（P0-4）：下面是 DSH 自身的存活/内存/HTTP 探活，只在 enableDsh=true 时有意义（方案甲整段跳过）。
    if ($enableDsh) {
    $proc = Get-Process -Id $dshPid -ErrorAction SilentlyContinue
    if (-not $proc) { $fails = 0; Start-Sleep -Seconds 5; continue }

    if ($proc.WorkingSet64 -gt ($memLimitMB * 1MB)) {
      Log "memory over limit ($([math]::Round($proc.WorkingSet64/1MB))MB > ${memLimitMB}MB); restarting"
      Restart-Service 'memory-limit'
      $fails = 0
      continue
    }

    if (Test-Endpoint) {
      $fails = 0
    } else {
      $fails++
      Log "health check failed ($fails/3)"
      if ($fails -ge 3) {
        Restart-Service 'unresponsive'
        $fails = 0
        continue
      }
    }

    if (((Get-Date) - $lastBeat).TotalMinutes -ge 30) {
      $up = (Get-Date) - $proc.StartTime
      Log ("heartbeat: pid={0} uptime={1:hh\:mm\:ss} ws={2}MB threads={3}" -f $dshPid, $up, [math]::Round($proc.WorkingSet64/1MB), $proc.Threads.Count)
      $lastBeat = Get-Date
    }
    }
  } catch {
    Log "supervisor loop error: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds 8
}