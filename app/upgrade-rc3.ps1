$ErrorActionPreference = 'Continue'
# 无人值守升级脚本：rc.2 -> rc.3（B 方案）
# 由 Agent 以「脱离 DSH 进程树」的方式启动，即使 DSH 被结束也能跑完。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $here 'upgrade-rc3.log'
$res  = Join-Path $here 'upgrade-rc3.result.txt'
$exe  = 'D:\deepseek\DeepSeek Harness.exe'
$installer = Join-Path $env:LOCALAPPDATA '@deepseek-aidsh-desktop-updater\pending\deepseek-harness-0.2.1-rc.3-win-x64.exe'
$taskName = 'DSH Phone Access'
$target = '0.2.1-rc.3'
$vbs = Join-Path $here 'run-autostart.vbs'
$vbsOff = "$vbs.off"

function Log([string]$m) {
  ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Out-File -FilePath $log -Append -Encoding utf8
}
function ExeVer {
  try { (Get-Item $exe).VersionInfo.FileVersion } catch { '' }
}
function DshProcs {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
}

Log '=== upgrade start (rc.2 -> rc.3, plan B) ==='
Log "before: version=$(ExeVer)"

if (-not (Test-Path $installer)) {
  Log "ABORT: installer missing: $installer"
  Set-Content -Path $res -Value 'ABORT: installer missing' -Encoding UTF8
  exit 1
}
$sig = $null
try { $sig = Get-AuthenticodeSignature $installer } catch { }
if ($null -eq $sig -or $sig.Status -ne 'Valid') {
  Log "ABORT: installer signature status=$($sig.Status)"
  Set-Content -Path $res -Value "ABORT: bad signature ($($sig.Status))" -Encoding UTF8
  exit 1
}
Log 'installer present, signature valid'
Log 'takeoff grace 40s (so the chat reply lands before DSH closes)'
Start-Sleep -Seconds 40

# 1) 停守护：维护窗口 + 禁用计划任务 + 杀 supervisor
Set-Content -Path (Join-Path $here 'maintenance.flag') -Value '900' -Encoding ascii
$taskDisabled = $false
try {
  Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
  $taskDisabled = $true
  Log 'scheduled task disabled'
} catch {
  Log "disable task failed: $($_.Exception.Message)"
  if (Test-Path $vbs) {
    Move-Item $vbs $vbsOff -Force -ErrorAction SilentlyContinue
    Log 'run-autostart.vbs renamed (task neutralised)'
  }
}
$sup = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'supervise\.ps1' })
foreach ($s in $sup) {
  Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
  Log "supervisor killed pid=$($s.ProcessId)"
}
Start-Sleep -Seconds 3

# 2) 结束 DSH（GUI / web / 插件宿主）
$procs = DshProcs
Log "killing $($procs.Count) DSH process(es)"
foreach ($p in $procs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
for ($i = 0; $i -lt 30; $i++) {
  if ((DshProcs).Count -eq 0) { break }
  Start-Sleep -Seconds 1
}
Log "DSH processes left: $((DshProcs).Count)"
Start-Sleep -Seconds 4

# 3) 静默安装（--force-run：装完自动重开应用）
$exit = -1
try {
  $p = Start-Process -FilePath $installer -ArgumentList '--updated', '/S', '--force-run', '/D=D:\deepseek' -PassThru -Wait -ErrorAction Stop
  $exit = $p.ExitCode
} catch {
  Log "installer start failed: $($_.Exception.Message)"
}
Log "installer exit=$exit"

# 4) 校验版本
$ver = ''
for ($i = 0; $i -lt 30; $i++) {
  $ver = ExeVer
  if ($ver -eq $target) { break }
  Start-Sleep -Seconds 3
}
Log "after: version=$ver"

# 5) 恢复守护
if (Test-Path $vbsOff) {
  Move-Item $vbsOff $vbs -Force -ErrorAction SilentlyContinue
  Log 'run-autostart.vbs restored'
}
if ($taskDisabled) {
  try {
    Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
    Log 'scheduled task re-enabled'
  } catch {
    & schtasks.exe /Change /TN $taskName /ENABLE 2>&1 | ForEach-Object { Log "schtasks enable: $_" }
  }
}
Remove-Item (Join-Path $here 'maintenance.flag') -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 6) 拉回应用与手机入口
if ((DshProcs).Count -eq 0) {
  try {
    Start-Process -FilePath $exe -ErrorAction Stop
    Log 'GUI relaunched'
  } catch {
    Log "GUI relaunch failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 8
}
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'start-phone-access.ps1') -Quiet 2>&1 |
    Out-File -FilePath $log -Append -Encoding utf8
  Log 'start-phone-access.ps1 finished'
} catch {
  Log "start-phone-access failed: $($_.Exception.Message)"
}
Start-Sleep -Seconds 5
$listening = [bool](Get-NetTCPConnection -State Listen -LocalPort 8642 -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' })

$ok = ($ver -eq $target) -and $listening
$summary = @(
  "time: $(Get-Date -Format o)",
  "version: $ver (target $target)",
  "installer exit: $exit",
  "port 8642 listening: $listening",
  "result: $(if ($ok) { 'OK' } else { 'ATTENTION' })"
)
Set-Content -Path $res -Value $summary -Encoding UTF8
Log ("=== upgrade done: version=$ver listening=$listening exit=$exit -> " + $(if ($ok) { 'OK' } else { 'ATTENTION' }) + ' ===')
