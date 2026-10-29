param([switch]$Quiet)

# One-page health report for the phone/tablet access stack.
# Usage: powershell -File check-health.ps1   (add -Quiet to skip the "press enter")

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 改动（参数化）：这里原来写死 tailscale.exe 的绝对路径、写死本机 tailnet IP，
# 还有三个端口散落在各处。换一台机器（或换一个 tailnet）后这些值全部失效，
# 体检会把正常系统报成"全红"。现在与启动脚本同源：点源 product-config.ps1，
# 值来自 product.config.json + 自动发现，本文件不再写死任何机器相关的常量
# （tailscale 路径 / tailnet IP / 三个端口）。
. (Join-Path $here 'product-config.ps1')
$cfg = Get-ProductConfig -AppDir $here
$portDsh = [int]$cfg.ports.dsh
$portDoor = [int]$cfg.ports.door
$portScreen = [int]$cfg.ports.screen
$tsResolved = Resolve-ProductRuntime -AppDir $here -Name 'tailscale' -Config $cfg -WellKnownDirs (Get-TailscaleWellKnownDirs)
$ts = $tsResolved.Path
$tsInfo = Get-TailscaleInfo -TailscaleExe $ts

$rows = @()
$problems = @()

function Add([string]$item, [string]$value, [string]$ok = 'ok') {
  $script:rows += [pscustomobject]@{ 检查项 = $item; 结果 = $value; 状态 = $ok }
  if ($ok -ne 'ok') { $script:problems += "$item -> $value" }
}

function ReadUrl([string]$name) {
  $f = Join-Path $here $name
  if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
  return ''
}

$screenUrl = ReadUrl 'screen-url.txt'
$phoneUrl = ReadUrl 'phone-url.txt'
$screenKey = ''
$keyFile = Join-Path $here 'screen.key'
if (Test-Path $keyFile) { $screenKey = (Get-Content $keyFile -Raw).Trim() }

# --- 1. scheduled task -------------------------------------------------------
$task = Get-ScheduledTask -TaskName 'DSH Phone Access' -ErrorAction SilentlyContinue
if (-not $task) {
  Add '计划任务' '不存在' 'fail'
} else {
  $info = Get-ScheduledTaskInfo -TaskName 'DSH Phone Access' -ErrorAction SilentlyContinue
  $stateOk = if ($task.State -eq 'Ready' -or $task.State -eq 'Running') { 'ok' } else { 'warn' }
  Add '计划任务' "$($task.State) / 上次 $($info.LastRunTime.ToString('MM-dd HH:mm')) / 下次 $($info.NextRunTime.ToString('MM-dd HH:mm')) / 结果 $($info.LastTaskResult)" $stateOk
  $rep = ($task.Triggers | Where-Object { $_.Repetition.Interval } | Select-Object -First 1)
  if ($rep) {
    Add '看门狗周期' "$($rep.Repetition.Interval)（持续到 $($rep.Repetition.Duration)）" 'ok'
  } else {
    Add '看门狗周期' '没有重复触发器' 'fail'
  }
  $act = $task.Actions[0]
  $hidden = $act.Execute -match 'wscript'
  Add '任务动作（无窗口）' "$($act.Execute)" $(if ($hidden) { 'ok' } else { 'warn' })
}

# --- 2. processes + listeners ------------------------------------------------
# 改动（参数化）：DSH 端口改成配置里的 ports.dsh（DSH 是 enableDsh=true 时的可选模块，
# 本文件是工程师体检，照旧探测它的端口；客户版自检会按 enableDsh 跳过这一段）。
$dshPid = (Get-NetTCPConnection -State Listen -LocalPort $portDsh -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1).OwningProcess
if ($dshPid) {
  $p = Get-Process -Id $dshPid -ErrorAction SilentlyContinue
  Add ('DSH (' + $portDsh + ')') "pid $dshPid / $([math]::Round($p.WorkingSet64 / 1MB))MB / 启动 $($p.StartTime.ToString('MM-dd HH:mm'))" 'ok'
} else {
  Add ('DSH (' + $portDsh + ')') '没有监听' 'fail'
}

# 改动（参数化）：三个端口全部来自 product.config.json；门名字里的端口也跟着配置走。
$doors = @(
  @{ Name = ('tailnet 名字门 127.0.0.1:' + $portDoor); Host = '127.0.0.1'; Port = $portDoor }
  @{ Name = 'tailnet IP 门'; Host = (ReadUrl 'tailip-url.txt') -replace '.*//([^:/]+):.*', '$1'; Port = $portDsh }
  @{ Name = 'LAN 门'; Host = (ReadUrl 'lan-url.txt') -replace '.*//([^:/]+):.*', '$1'; Port = $portDsh }
  @{ Name = '画面服务'; Host = $screenUrl -replace '.*//([^:/]+):.*', '$1'; Port = $portScreen }
)
foreach ($d in $doors) {
  if (-not $d.Host) { continue }
  $ok = [bool](Get-NetTCPConnection -State Listen -LocalPort $d.Port -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -eq $d.Host })
  Add $d.Name "$($d.Host):$($d.Port)" $(if ($ok) { 'ok' } else { 'fail' })
}

$sup = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'powershell' -and $_.CommandLine -match 'supervise\.ps1' })
$beat = Join-Path $here 'supervisor.heartbeat'
if ($sup.Count -eq 1 -and (Test-Path $beat)) {
  $age = ((Get-Date) - (Get-Item $beat).LastWriteTime).TotalSeconds
  Add 'supervisor' "1 个 / 心跳 $([math]::Round($age,1))s 前" $(if ($age -lt 30) { 'ok' } else { 'warn' })
} elseif ($sup.Count -eq 0) {
  Add 'supervisor' '没有运行（看门狗 2 分钟内会拉起）' 'warn'
} else {
  Add 'supervisor' "$($sup.Count) 个（应只有 1 个）" 'warn'
}

$cap = @(Get-Process capture -ErrorAction SilentlyContinue)
if ($cap.Count -eq 1) {
  Add '抓屏进程' "pid $($cap[0].Id) / $([math]::Round($cap[0].WorkingSet64 / 1MB))MB" 'ok'
} else {
  Add '抓屏进程' "$($cap.Count) 个" 'fail'
}

$aud = @(Get-Process audio -ErrorAction SilentlyContinue)
$inp = @(Get-Process input -ErrorAction SilentlyContinue)
Add '声音转发' $(if ($aud.Count -eq 1) { "audio.exe pid $($aud[0].Id)" } else { "$($aud.Count) 个（应为 1）" }) $(if ($aud.Count -eq 1) { 'ok' } else { 'warn' })
Add '远程鼠标键盘' $(if ($inp.Count -eq 1) { "input.exe pid $($inp[0].Id)（/input 可用）" } else { "$($inp.Count) 个（应为 1）" }) $(if ($inp.Count -eq 1) { 'ok' } else { 'warn' })

# 改动（第二轮 P0-2 / I1）：注入器现在有两种位置——提权模式在 %ProgramFiles%\PhoneAccessInput
# （普通用户写不了），非提权模式在 %LOCALAPPDATA%\DshInput。当前是哪种由**计划任务指向**决定。
# 不能只靠下面"优先用进程实际路径"那行：进程没起来时它会回落，写死 DshInput 就会给出假结论。
$pfRootHc = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$elevDirHc = Join-Path $pfRootHc 'PhoneAccessInput'
$elevExeHc = Join-Path $elevDirHc 'input.exe'
$dshExeHc = Join-Path $env:LOCALAPPDATA 'DshInput\input.exe'
$taskElevHc = $false
try {
  $tHc = Get-ScheduledTask -TaskName 'DSH Input Injector' -ErrorAction SilentlyContinue
  $taskElevHc = [bool]($tHc -and ([string](@($tHc.Actions)[0].Execute) -eq $elevExeHc))
} catch { }
$inj = if ($taskElevHc) { $elevExeHc } else { $dshExeHc }
if (Test-Path $inj) {
  $under = (Get-Process input -ErrorAction SilentlyContinue | Select-Object -First 1).Path
  $where = if ($under) { $under } else { $inj }
  $leaked = $where -match 'default-workspace'
  # 提权模式下进程必须真的跑在 Program Files 里；跑在用户可写目录说明任务还指着旧路径
  $wrongPlace = ($taskElevHc -and $under -and ($under -ne $elevExeHc))
  $modeNote = if ($taskElevHc) { '高权限模式，目录用户不可写' } else { '普通权限模式' }
  $note = if ($leaked) { '（在 workspace 里 → 会被低完整性标签限制）' } else { '（已脱离 workspace 低完整性标签；' + $modeNote + '）' }
  Add '输入注入器路径' "$where$note" $(if ($leaked -or $wrongPlace) { 'fail' } else { 'ok' })
} else {
  Add '输入注入器路径' ('缺少 input.exe：' + $inj) 'warn'
}

# --- 3. screen server /health ------------------------------------------------
$healthText = ''
if ($screenUrl) {
  $hUrl = ($screenUrl -replace '\?.*$', '' -replace '/+$', '') + '/health'
  for ($k = 0; $k -lt 3 -and -not $healthText; $k++) {
    try { $healthText = (& curl.exe -s --max-time 4 $hUrl) -join '' } catch { }
    if (-not $healthText) { Start-Sleep -Milliseconds 400 }
  }
}
$viewers = 0
$viewersFile = Join-Path $here 'viewers.count'
if (Test-Path $viewersFile) { try { $viewers = [int]((Get-Content $viewersFile -Raw).Trim()) } catch { $viewers = 0 } }

if ($healthText -match 'source=(\w+)') { $src = $Matches[1] } else { $src = '?' }
if ($healthText -match 'age=([0-9.]+)') { $ageS = [double]$Matches[1] } else { $ageS = -1 }
if ($healthText -match 'mode=(\w+)') { $mode = $Matches[1] } else { $mode = '?' }
$paused = ($viewers -eq 0)

$srcTxt = if ($src -eq 'pipe') { '管道' } else { '文件' }
if ($paused) {
  Add '画面帧' "无人观看（已暂停）/ 来源 $srcTxt" 'ok'
} elseif ($ageS -ge 0) {
  Add '画面帧' "有人观看($viewers) / $ageS s 前 / 来源 $srcTxt" $(if ($ageS -lt 10) { 'ok' } else { 'warn' })
} else {
  Add '画面帧' '服务未返回 age=' 'warn'
}

if ($healthText -match 'rtc=\{([^}]*)\}') {
  $rtc = $Matches[1]
  $peers = if ($rtc -match '"peers":(\d+)') { $Matches[1] } else { '0' }
  $fr = if ($rtc -match '"frames":(\d+)') { $Matches[1] } else { '0' }
  if ($mode -eq 'raw' -or [int]$peers -gt 0) {
    Add '流畅模式(WebRTC)' "peers=$peers / 已编码 $fr 帧" 'ok'
  } else {
    Add '流畅模式(WebRTC)' '未启用（当前走 MJPEG，点页面「流畅」开启）' 'ok'
  }
}

Add '抓屏来源' "全屏/单显示器/指定窗口 由 /mode 切换（当前 $mode 编码）" 'ok'

$outFps = -1
$inFps = -1
$capMs = -1
if ($healthText -match 'out=([0-9.]+)') { $outFps = [double]$Matches[1] }
if ($healthText -match ' in=([0-9.]+)') { $inFps = [double]$Matches[1] }
if ($healthText -match 'cap=([0-9]+)') { $capMs = [int]$Matches[1] }
if ($outFps -ge 0) {
  $capTxt = ''
  if ($capMs -gt 0) { $capTxt = '（上限 ' + [math]::Round(1000 / $capMs, 1) + ' fps）' }
  $inTxt = if ($inFps -ge 0) { '抓屏 ' + $inFps + ' fps / ' } else { '' }
  $state = if ($viewers -gt 0 -and $outFps -lt 3) { 'warn' } elseif ($viewers -gt 0 -and $inFps -gt 0 -and $outFps -lt $inFps * 0.7) { 'warn' } else { 'ok' }
  Add '实际帧率' "$inTxt$outFps fps$capTxt" $state
} else {
  Add '实际帧率' '服务未返回 out=' 'warn'
}

# --- 注入是否被前台高权限窗口挡住（UIPI）-----------------------------------
$blk = -1
$blkAge = -1
$fgTitle = ''
if ($healthText -match 'blk=([0-9]+)') { $blk = [int]$Matches[1] }
if ($healthText -match 'blkage=(-?[0-9]+)') { $blkAge = [long]$Matches[1] }
if ($healthText -match 'fg=("(?:[^"\\]|\\.)*")') {
  try { $fgTitle = (ConvertFrom-Json $Matches[1]) } catch { $fgTitle = $Matches[1].Trim('"') }
}
# 注入器是否以管理员权限运行（High 完整性 → UIPI 拦不住它，前台是什么都不影响）
# 改动（第二轮 P0-2 / I1）：日志现在分两份——提权模式写 %ProgramFiles%\PhoneAccessInput\input.log，
# 非提权模式写安装根 input.log。只读一份的后果：提权模式下永远匹配不到 integrity=high，
# "注入通道"一栏会静默降级成 ?（这是本次改动最容易引入的静默回归）。所以按模式取，取不到再退另一份。
$injectorElevated = $taskElevHc
if ($injectorElevated) {
  $logCandidates = @((Join-Path $elevDirHc 'input.log'), (Join-Path $here 'input.log'))
} else {
  $logCandidates = @((Join-Path $here 'input.log'), (Join-Path $elevDirHc 'input.log'))
}
$injectorLog = @($logCandidates | Where-Object { Test-Path -LiteralPath $_ })[0]
$startLine = $null
if ($injectorLog) {
  $startLine = (Get-Content -LiteralPath $injectorLog -Encoding UTF8 -ErrorAction SilentlyContinue |
      Select-String 'input service start' | Select-Object -Last 1)
}
if ($injectorElevated) {
  $integrity = if ($startLine -and $startLine.Line -match 'integrity=(\w+)') { $Matches[1] } else { '?' }
} else { $integrity = 'medium' }

if ($blk -lt 0) {
  Add '注入通道' '服务未返回 blk=' 'warn'
} elseif ($integrity -eq 'high') {
  Add '注入通道' "正常（管理员权限运行，UIPI 不拦；前台「$fgTitle」）" 'ok'
} elseif ($blk -gt 0 -and $blkAge -ge 0 -and $blkAge -lt 20000) {
  Add '注入通道' "被挡 $blk 次（刚刚还在挡），前台是「$fgTitle」——切后台或关掉，页面会自动/手动抢前台" 'warn'
} elseif ($blk -gt 0) {
  Add '注入通道' "正常（历史被挡 $blk 次，已恢复；前台「$fgTitle」）" 'ok'
} else {
  Add '注入通道' "正常（前台「$fgTitle」不影响注入）" 'ok'
}

# --- 4. DPI scaling sanity ---------------------------------------------------
$dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI
$scalePct = if ($dpi) { [math]::Round($dpi / 96 * 100) } else { 100 }
$probe = Join-Path $env:LOCALAPPDATA 'DshInput\cursor-probe.exe'
$probeLog = Join-Path $env:LOCALAPPDATA 'DshInput\cursor-probe.log'
$probeTxt = ''
if (Test-Path $probe) {
  Remove-Item $probeLog -Force -ErrorAction SilentlyContinue
  try { Start-Process -FilePath $probe -WindowStyle Hidden -Wait } catch { }
  $probeTxt = (Get-Content $probeLog -ErrorAction SilentlyContinue | Select-Object -Last 1)
}
$cursorApi = ''
if ($screenUrl) {
  $cUrl = ($screenUrl -replace '\?.*$', '' -replace '/+$', '') + '/cursor'
  for ($k = 0; $k -lt 3 -and -not $cursorApi; $k++) {
    try { $cursorApi = (& curl.exe -s --max-time 4 $cUrl) -join '' } catch { }
    if (-not $cursorApi) { Start-Sleep -Milliseconds 400 }
  }
}
$dpiOk = $true
if ($probeTxt -match 'x=(-?\d+) y=(-?\d+)') {
  $px = [int]$Matches[1]; $py = [int]$Matches[2]
  if ($cursorApi -match '"x":(-?\d+),"y":(-?\d+)') {
    $ax = [int]$Matches[1]; $ay = [int]$Matches[2]
    $dpiOk = ([math]::Abs($px - $ax) -le 2 -and [math]::Abs($py - $ay) -le 2)
  }
}
Add '显示缩放' "系统 $scalePct% / 探针 $probeTxt / API $cursorApi" $(if ($dpiOk) { 'ok' } else { 'warn' })

# --- 5. permanent login door -------------------------------------------------
if ($screenKey) {
  # 改动（参数化）：原来把 tailnet IP 和 DSH 端口都写死在 URL 里。现在 IP 用自动发现的
  # 结果（Get-TailscaleInfo），端口用配置里的 ports.dsh。取不到 IP 时明确写"跳过"，
  # 不再拿一个写死的假地址去 curl 然后报一个看不懂的错。
  if (-not $tsInfo.Ip) {
    Add '永久登录门 /go' '跳过：没取到 tailnet IP（Tailscale 未连接）' 'warn'
  } else {
    $goUrl = 'http://' + $tsInfo.Ip + ':' + $portDsh + '/go?k=' + $screenKey
    $code = (& curl.exe -s -o NUL -w '%{http_code}' --max-time 5 $goUrl) -join ''
    Add '永久登录门 /go' "HTTP $code（303 = 直接登录，不用扫码）" $(if ($code -match '^30[23]$') { 'ok' } else { 'warn' })
  }
}
if ($phoneUrl) {
  $tok = ($phoneUrl -replace '.*token=', '')
  Add '当前 token' ($tok.Substring(0, [Math]::Min(12, $tok.Length)) + '…') 'ok'
  $qr = Join-Path $here 'phone-qr.png'
  if (Test-Path $qr) {
    Add '二维码文件' "$([math]::Round((Get-Item $qr).Length / 1KB))KB" 'ok'
  } else {
    Add '二维码文件' '缺少 phone-qr.png' 'warn'
  }
}

# --- 6. expiry / resources ---------------------------------------------------
# 改动（参数化）：原来直接 & 一个写死的 tailscale.exe 路径。现在用自动发现的结果；
# 没装 / 没连时给出中文原因（而不是 & $null 抛异常再被 $ErrorActionPreference 静默吞掉）。
$tsState = $null
if ($ts) { try { $tsState = (& $ts status --json 2>$null | ConvertFrom-Json) } catch { $tsState = $null } }
if ($tsState -and $tsState.BackendState -eq 'Running') {
  $exp = if ($tsState.Self.KeyExpiry) { ([datetime]$tsState.Self.KeyExpiry).ToLocalTime().ToString('yyyy-MM-dd') } else { 'never' }
  $dns = if ($tsState.Self.DNSName) { [string]$tsState.Self.DNSName } else { [string]$tsInfo.DnsName }
  Add 'Tailscale' "$dns / 本机 key 到期 $exp" 'ok'
} else {
  $why = if ($tsState) { [string]$tsState.BackendState } else { 'tailscale.exe 未找到' }
  Add 'Tailscale' "未连接（$why）" 'fail'
}
Add '会话 cookie 有效期' '30 天（HttpOnly，重启不失效；每个入口各一份）' 'ok'

# 改动（参数化）：C: 改成系统盘。系统盘不是 C: 的机器上不再误报"读不到"。
$sysDrive = 'C'
if ($env:SystemDrive) { $sysDrive = $env:SystemDrive.TrimEnd(':') }
$free = [math]::Round((Get-PSDrive $sysDrive).Free / 1GB, 1)
Add ($sysDrive + ': 剩余空间') "$free GB" $(if ($free -gt 5) { 'ok' } else { 'warn' })

$supLog = Join-Path $here 'supervisor.log'
if (Test-Path $supLog) {
  $restarts = (Get-Content $supLog | Select-String -Pattern '=== supervisor start ===').Count
  Add 'supervisor 累计启动次数' "$restarts（每次重启都有记录）" 'ok'
}

# --- report -----------------------------------------------------------------
$rows | Format-Table -AutoSize
if ($problems.Count -gt 0) {
  Write-Host ''
  Write-Host '需要处理的项：' -ForegroundColor Yellow
  $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
} else {
  Write-Host ''
  Write-Host '全部正常。' -ForegroundColor Green
}

if (-not $Quiet) { Read-Host 'Press Enter to exit' }
