# 以管理员身份运行一次：把远程注入器改成"管理员权限运行"，从此前台是什么窗口都不会被 UIPI 挡。
#
# 为什么需要它：
#   LegionZone / SSID 这类程序是管理员权限（由 Lenovo 的 SYSTEM 服务拉起，普通权限既杀不掉也最小化不了，
#   UIPI 会拦）。只要它们在**前台**，普通权限的 input.exe 注入就会被整段丢弃。
#   把 input.exe 提到 High 完整性之后，UIPI 对它不再生效，注入永远可用，不用再去抢前台。
#
# 改动（第二轮 P0-2 / I1）：注入器不能再放在用户可写目录里。
#   原来部署到 %LOCALAPPDATA%\PaInput —— 那个目录的 ACL 继承自用户目录，标准用户可写；
#   而计划任务以 RunLevel=Highest 执行它 → 标准用户替换 input.exe 即可无 UAC 拿到管理员
#   （而且那个目录还在 Defender 排除里）。现在整条链搬到 %ProgramFiles%\PhoneAccessInput：
#   普通用户只有读+执行，写不了。
#   日志、标记文件、工作目录一并搬过去：提权进程不许往用户可写路径写任何东西
#   （往用户能控制的位置写文件，等于把受保护文件的操作权送出去）。
#   注意：非提权模式仍然用 %LOCALAPPDATA%\PaInput —— 那条链跑在用户的完整性级别上，
#   不跨越任何权限边界，不构成提权，所以保留（回退路径要能用）。
#
# 用法：
#   右键"以管理员身份运行"PowerShell，然后：
#     powershell -ExecutionPolicy Bypass -File .\install-elevated-input.ps1
#   卸载（改回普通权限）：
#     powershell -ExecutionPolicy Bypass -File .\install-elevated-input.ps1 -Uninstall
#
# 全过程写进日志：%ProgramFiles%\PhoneAccessInput\install.log
param([switch]$Uninstall)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- 两个目录：提权用的（用户不可写）和普通权限回退用的（用户可写）-------------
# ProgramW6432 兜底：万一这段被 32 位 PowerShell 拉起，$env:ProgramFiles 会变成
# "C:\Program Files (x86)"，跟安装器/自启脚本算出来的目录就分叉了（两处各装一份）。
$pfRoot = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$elevDir = Join-Path $pfRoot 'PhoneAccessInput'
$elevExe = Join-Path $elevDir 'input.exe'
$elevLog = Join-Path $elevDir 'input.log'           # 提权进程的日志（High 才写得进）
$installLog = Join-Path $elevDir 'install.log'       # 本脚本的 transcript
$marker = Join-Path $elevDir 'elevated.enabled'      # 只有管理员能创建 → 可信信号

$legacyDir = Join-Path $env:LOCALAPPDATA 'PaInput'  # 普通权限回退用的目录，目录本身保留
$legacyExe = Join-Path $legacyDir 'input.exe'
$legacyMarker = Join-Path $legacyDir 'elevated.enabled'
$legacyInstallLog = Join-Path $legacyDir 'install.log'

$inputSrc = Join-Path $here 'input.exe'
$taskName = 'PhoneAccess Input'

$failed = $false
$removeDirAfterLog = $false

New-Item -ItemType Directory -Force -Path $elevDir | Out-Null
try { Start-Transcript -Path $installLog -Append | Out-Null } catch { }

try {
  $ErrorActionPreference = 'Stop'

  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Write-Host "管理员权限: $isAdmin"
  Write-Host "注入器目录: $elevDir"
  if (-not $isAdmin) {
    # 客户可见文案：不提内部代号，也不提一个根本不存在的 .bat。
    Write-Host '需要管理员权限：请右键这个文件选「以管理员身份运行」，或在安装程序里点「是」。' -ForegroundColor Yellow
    $failed = $true
    exit 3
  }

  if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
      try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
      Write-Host "[i] 已删除计划任务: $taskName"
    }
    Remove-Item $marker -Force -ErrorAction SilentlyContinue
    Remove-Item $legacyMarker -Force -ErrorAction SilentlyContinue
    Get-Process input -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    # 注入器文件现在在 Program Files 里，要连目录一起删（我们是管理员）。
    # 真正删除放到 Stop-Transcript 之后：transcript 正写着 install.log，文件被占用时删不掉目录。
    $removeDirAfterLog = $true
    Write-Host '[i] 已切回普通权限模式（supervisor 会自动用普通权限重新拉起 input.exe）'
  }
  else {
    # 1. 部署最新 injector —— 必须先停掉正在运行的 input.exe，否则 exe 被占用、Copy-Item 会失败
    Get-Process input -ErrorAction SilentlyContinue | Stop-Process -Force
    for ($k = 0; $k -lt 20; $k++) {
      try { Copy-Item $inputSrc $elevExe -Force -ErrorAction Stop; break }
      catch { Start-Sleep -Milliseconds 300 }
    }
    if (-not (Test-Path $elevExe)) { throw "找不到 input.exe: $elevExe" }
    if ((Get-FileHash $inputSrc).Hash -ne (Get-FileHash $elevExe).Hash) { throw "input.exe 没复制成功（文件被占用？）" }
    Write-Host "[i] injector: $elevExe（已更新到最新）"

    # 2. 权限自检（只告警、不阻断）：Program Files 默认继承就是 Users:(RX)，
    #    但有的机器被第三方权限工具改过。这里只查"有没有给普通用户写权限的 Allow 项"。
    try {
      $acl = Get-Acl -LiteralPath $elevDir
      $weak = @($acl.Access | Where-Object {
          $_.AccessControlType -eq 'Allow' -and
          $_.IdentityReference -match 'Users|Everyone|Authenticated Users|INTERACTIVE' -and
          (($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Write) -ne 0)
        })
      if ($weak.Count -gt 0) {
        Write-Host ('[!] 警告：' + $elevDir + ' 的权限里有普通用户可写的项，这个目录本该只有管理员能写。') -ForegroundColor Yellow
        Write-Host '    注入器仍然会安装，但请把这条发给卖家核对（多半是装了第三方权限管理工具）。' -ForegroundColor Yellow
      }
      else {
        Write-Host '[i] 权限自检：普通用户对这个目录没有写权限'
      }
    }
    catch { }

    # 3. 注册"最高权限"计划任务（无触发器，由 supervisor / start-screen.ps1 按需启动）
    #    WorkingDirectory 和日志也放在 Program Files：提权进程的工作目录不能是用户可写目录。
    $action = New-ScheduledTaskAction -Execute $elevExe -Argument "pa-input `"$elevLog`"" -WorkingDirectory $elevDir
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings `
      -Description '远程注入器（管理员权限，避免 UIPI 拦截前台高权限窗口的鼠标键盘）' | Out-Null
    Write-Host "[i] 已注册计划任务: $taskName（RunLevel=Highest / Interactive / 指向 Program Files）"

    # 4. 打标记 + 重启注入器
    Set-Content -Path $marker -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding ASCII
    Get-Process input -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    Start-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 3

    $p = Get-Process input -ErrorAction SilentlyContinue
    if ($p) {
      Write-Host "[OK] input.exe 已以管理员权限启动（pid $($p.Id)）" -ForegroundColor Green
      $line = (Get-Content $elevLog -Encoding UTF8 -ErrorAction SilentlyContinue | Select-String 'input service start' | Select-Object -Last 1)
      if ($line) { Write-Host "     启动行: $($line.Line.Trim())" }
      if (-not $line -or $line.Line -notmatch 'integrity=high') {
        Write-Host '[!] 启动行里没看到 integrity=high，稍后再核对。' -ForegroundColor Yellow
      }
      else {
        # 5. 确认新进程真的是 High 之后，才清理旧的那份（用户可写目录里的 exe 已经没有存在理由，
        #    留着只会让"到底哪份在跑"变成谜）。删早了万一新任务起不来就没有回退路径，所以放最后。
        #    目录本身不删：非提权回退、探针日志都还在里面。
        foreach ($old in @($legacyExe, $legacyInstallLog, $legacyMarker)) {
          if (Test-Path -LiteralPath $old) {
            try { Remove-Item -LiteralPath $old -Force -ErrorAction Stop; Write-Host ('[i] 已清理旧文件: ' + $old) }
            catch { Write-Host ('[!] 旧文件删不掉（可忽略）: ' + $old) -ForegroundColor Yellow }
          }
        }
      }
    }
    else {
      Write-Host '[!] input.exe 没起来，见 input.log / install.log 末尾。' -ForegroundColor Yellow
    }
  }
}
catch {
  $failed = $true
  Write-Host "[X] 出错: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "    位置: $($_.InvocationInfo.PositionMessage)"
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
  if (-not $Uninstall) { Write-Host "日志: $installLog" }
}

# 卸载时把 Program Files 里的注入器目录整个删掉（放在 transcript 关闭之后，否则目录被占用删不掉）
if ($removeDirAfterLog -and -not $failed) {
  if (Test-Path -LiteralPath $elevDir) {
    for ($k = 0; $k -lt 10; $k++) {
      try { Remove-Item -LiteralPath $elevDir -Recurse -Force -ErrorAction Stop; break }
      catch { Start-Sleep -Milliseconds 400 }
    }
    if (Test-Path -LiteralPath $elevDir) {
      Write-Host ('[!] 注入器目录没删干净（可能在运行中）：' + $elevDir) -ForegroundColor Yellow
    }
    else {
      Write-Host ('[i] 已删除注入器目录: ' + $elevDir)
    }
  }
}

if ($failed) { exit 3 }
exit 0
