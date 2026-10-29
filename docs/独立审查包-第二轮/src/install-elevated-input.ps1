# 以管理员身份运行一次：把远程注入器改成"管理员权限运行"，从此前台是什么窗口都不会被 UIPI 挡。
#
# 为什么需要它：
#   LegionZone / SSID 这类程序是管理员权限（由 Lenovo 的 SYSTEM 服务拉起，普通权限既杀不掉也最小化不了，
#   UIPI 会拦）。只要它们在**前台**，普通权限的 input.exe 注入就会被整段丢弃。
#   把 input.exe 提到 High 完整性之后，UIPI 对它不再生效，注入永远可用，不用再去抢前台。
#
# 用法：
#   双击桌面上的 Install-DSH-Input-Admin.bat →
#   （或）右键"以管理员身份运行"PowerShell，然后：
#     powershell -ExecutionPolicy Bypass -File .\install-elevated-input.ps1
#   卸载（改回普通权限）：
#     powershell -ExecutionPolicy Bypass -File .\install-elevated-input.ps1 -Uninstall
#
# 全过程写进日志：%LOCALAPPDATA%\DshInput\install.log
param([switch]$Uninstall)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$inputDir = Join-Path $env:LOCALAPPDATA 'DshInput'
$inputExe = Join-Path $inputDir 'input.exe'
$inputSrc = Join-Path $here 'input.exe'
$logFile = Join-Path $here 'input.log'
$installLog = Join-Path $inputDir 'install.log'
$marker = Join-Path $inputDir 'elevated.enabled'
$taskName = 'DSH Input Injector'

New-Item -ItemType Directory -Force -Path $inputDir | Out-Null
try { Start-Transcript -Path $installLog -Append | Out-Null } catch { }

$failed = $false
try {
  $ErrorActionPreference = 'Stop'

  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Write-Host "管理员权限: $isAdmin"
  if (-not $isAdmin) {
    # 客户可见文案：不提 DSH，也不提一个根本不存在的 .bat。
    Write-Host '需要管理员权限：请右键这个文件选「以管理员身份运行」，或在安装程序里点「是」。' -ForegroundColor Yellow
    $failed = $true
    return
  }

  if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
      Write-Host "[i] 已删除计划任务: $taskName"
    }
    Remove-Item $marker -Force -ErrorAction SilentlyContinue
    Get-Process input -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host '[i] 已切回普通权限模式（supervisor 会自动用普通权限重新拉起 input.exe）'
    return
  }

  # 1. 部署最新 injector —— 必须先停掉正在运行的 input.exe，否则 exe 被占用、Copy-Item 会失败
  Get-Process input -ErrorAction SilentlyContinue | Stop-Process -Force
  for ($k = 0; $k -lt 20; $k++) {
    try { Copy-Item $inputSrc $inputExe -Force -ErrorAction Stop; break }
    catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not (Test-Path $inputExe)) { throw "找不到 input.exe: $inputExe" }
  if ((Get-FileHash $inputSrc).Hash -ne (Get-FileHash $inputExe).Hash) { throw "input.exe 没复制成功（文件被占用？）" }
  Write-Host "[i] injector: $inputExe（已更新到最新）"

  # 2. 注册"最高权限"计划任务（无触发器，由 supervisor / start-screen.ps1 按需启动）
  $action = New-ScheduledTaskAction -Execute $inputExe -Argument "dsh-input `"$logFile`"" -WorkingDirectory $here
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings `
    -Description 'DSH 远程注入器（管理员权限，避免 UIPI 拦截前台高权限窗口的鼠标键盘）' | Out-Null
  Write-Host "[i] 已注册计划任务: $taskName（RunLevel=Highest / Interactive）"

  # 3. 打标记 + 重启注入器
  Set-Content -Path $marker -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding ASCII
  Get-Process input -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 3

  $p = Get-Process input -ErrorAction SilentlyContinue
  if ($p) {
    Write-Host "[OK] input.exe 已以管理员权限启动（pid $($p.Id)）" -ForegroundColor Green
    $line = (Get-Content $logFile -Encoding UTF8 -ErrorAction SilentlyContinue | Select-String 'input service start' | Select-Object -Last 1)
    if ($line) { Write-Host "     启动行: $($line.Line.Trim())" }
    if (-not $line -or $line.Line -notmatch 'integrity=high') {
      Write-Host '[!] 启动行里没看到 integrity=high，稍后再核对。' -ForegroundColor Yellow
    }
  }
  else {
    Write-Host '[!] input.exe 没起来，见 input.log / install.log 末尾。' -ForegroundColor Yellow
  }
}
catch {
  $failed = $true
  Write-Host "[X] 安装出错: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "    位置: $($_.InvocationInfo.PositionMessage)"
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
  Write-Host "日志: $installLog"
}

if ($failed) { exit 3 }
