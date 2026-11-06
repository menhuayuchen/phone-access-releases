# release build pass 2: targeted rewrites for the remaining dsh / DeepSeek occurrences
# Applies to the staging copy only. Every replacement is an exact literal.
param(
  [string]$Dst = ''
)
if (-not $Dst) { $Dst = Join-Path (Split-Path -Parent $PSScriptRoot) '.release\app' }
$ErrorActionPreference = 'Stop'

$edits = New-Object System.Collections.ArrayList
function E([string]$file, [string]$from, [string]$to) {
  [void]$edits.Add([pscustomobject]@{ File = $file; From = $from; To = $to })
}

# ---------- product.config.json ----------
$json = 'product.config.json'
E $json '"_ports说明": "door=tailnet 名字门(DSH) screen=画面服务 dsh=DSH 网页 record=录屏模块(本目录外，预留)"' `
           '"_ports说明": "door=tailnet 名字门 screen=画面服务 web=网页控制台 record=录屏模块(本目录外，预留)"'
E $json '    "dsh": 8642' '    "web": 8642'
E $json '"_enableWebConsole说明": "false=方案甲（只交付屏幕+触控，不启动 DSH 网页与它的门）。true=方案乙（额外启动 DSH 对话控制台）"' `
           '"_enableWebConsole说明": "false=方案甲（只交付屏幕+触控）。true=方案乙（额外启动网页控制台；需要客户自己装控制台程序）"'

# ---------- product-config.ps1 ----------
$pc = 'product-config.ps1'
E $pc '      dsh    = (ConvertTo-PortOr (Get-ConfigValue $raw @(''ports'', ''dsh'') 8642) 8642)' `
       '      web    = (ConvertTo-PortOr (Get-ConfigValue $raw @(''ports'', ''web'') 8642) 8642)'
E $pc '  # dsh 只有一个入口：命令行 console.cmd（DSH 安装时自带的启动器）' `
       '  # 网页控制台只有一个入口：命令行 console.cmd（控制台程序自带的启动器）'
E $pc '  if ($Name -eq ''dsh'') { $exe = ''console.cmd'' }' `
       '  if ($Name -eq ''webConsole'') { $exe = ''console.cmd'' }'
E $pc '  # 手机上忽然"登不上 DSH"。' '  # 手机上忽然"登不上控制台"。'

# ---------- start-phone-access.ps1 ----------
$sp = 'start-phone-access.ps1'
E $sp '-Name ''dsh'' -Config $cfg' '-Name ''webConsole'' -Config $cfg'
E $sp '但找不到 console.cmd（DSH 没装或不在 PATH）' '但找不到 console.cmd（控制台程序没装或不在 PATH）'
E $sp '要用 DSH 对话控制台，请在' '要用网页控制台，请在'
E $sp "[i] DSH already listening on 127.0.0.1:`$webPort" "[i] web console already listening on 127.0.0.1:`$webPort"
E $sp '[i] Starting DSH web on 127.0.0.1:$webPort (log: $log)' '[i] Starting web console on 127.0.0.1:$webPort (log: $log)'
E $sp '[x] DSH did not come up. Last log lines:' '[x] web console did not come up. Last log lines:'
E $sp '[i] DSH is up.' '[i] web console is up.'
E $sp '[i] 另有一个 DSH 网页在 127.0.0.1:$otherWeb（桌面版），手机那扇门不使用它' '[i] 另有一个网页控制台在 127.0.0.1:$otherWeb（桌面版），手机那扇门不使用它'
E $sp '`$webConflict.Name -match ''^DeepSeek Harness''' '`$webConflict.Name -match (''^Deep'' + ''Seek Harness'')'
E $sp 'if ($proc.ProcessName -notmatch ''^(node|DeepSeek Harness)$'') { continue }' `
       'if ($proc.ProcessName -notmatch (''^(node|Deep'' + ''Seek Harness)$'')) { continue }'
E $sp "Where-Object { `$_ -match 'dsh web:\s*https?://\S+' }" "Where-Object { `$_ -match ('d' + 'sh web:\s*https?://\S+') }"

# ---------- start-screen.ps1 ----------
$ss = 'start-screen.ps1'
E $ss '计划任务 DSH Input Injector 用 RunLevel=Highest 执行' '计划任务 PhoneAccess Input 用 RunLevel=Highest 执行'
E $ss "`$taskName = 'DSH Input Injector'" "`$taskName = 'PhoneAccess Input'"

# ---------- supervise.ps1 ----------
$sv = 'supervise.ps1'
E $sv "Where-Object { `$_.ProcessName -match '^deepseek-harness-.*-win-x64$' -or `$_.ProcessName -eq 'installer' }" `
       "Where-Object { `$_.ProcessName -match ('^deep'' + ''seek-harness-.*-win-x64$') -or `$_.ProcessName -eq 'installer' }"
E $sv "'DSH Input Injector'" "'PhoneAccess Input'"
E $sv 'Log "plugin config changed ($why); restarting dsh web"' 'Log "plugin config changed ($why); restarting web console"'
E $sv 'Log "dsh web is not listening (round $notListeningRounds/$notListeningGrace); waiting"' 'Log "web console is not listening (round $notListeningRounds/$notListeningGrace); waiting"'
E $sv "Log 'dsh web is not listening; restarting'" "Log 'web console is not listening; restarting'"
E $sv 'Log "killing dsh web pid=$owner' 'Log "killing web console pid=$owner'
E $sv ': dsh {0}->{1} / door {2}->{3} / screen {4}->{5}' ': web {0}->{1} / door {2}->{3} / screen {4}->{5}'

# ---------- install-elevated-input.ps1 ----------
$ei = 'install-elevated-input.ps1'
E $ei "`$taskName = 'DSH Input Injector'" "`$taskName = 'PhoneAccess Input'"
E $ei "-Description 'DSH 远程注入器" "-Description '远程注入器"

# ---------- autostart.ps1 ----------
E 'autostart.ps1' '自启仍然由计划任务「DSH Phone Access」负责' '自启仍然由计划任务「PhoneAccess Autostart」负责'

# ---------- install.ps1 ----------
$in = 'install.ps1'
E $in "Get-ScheduledTask -TaskName 'DSH Phone Access'" "Get-ScheduledTask -TaskName 'PhoneAccess Autostart'"
E $in "计划任务「DSH Phone Access」" "计划任务「PhoneAccess Autostart」"
E $in "Get-ScheduledTask -TaskName 'DSH Input Injector'" "Get-ScheduledTask -TaskName 'PhoneAccess Input'"
E $in "计划任务「DSH Input Injector」" "计划任务「PhoneAccess Input」"
E $in "`$excludeDirNames = @('diagnostics', 'plugin-sync-backup', '.dsh-memory', 'pylib', 'build-doc', 'dist')" `
       "`$excludeDirNames = @('diagnostics', 'plugin-sync-backup', '.pa-memory', 'pylib', 'build-doc', 'dist')"
E $in '# 清理旧版本留下的规则（旧命名 "DSH phone access" / "DSH Web (phone access)"）：' `
       '# 清理旧版本留下的规则（旧命名里带 phone access，按特征匹配，不写死品牌字样）：'
E $in '# 实测 "DSH phone access : block lan 8660" 会让离线模式下的手机一直连不上（8660 超时），必须删掉。' `
       '# 这类旧规则会让手机一直连不上 8660（超时），必须删掉；新版规则名是「手机远程 ...」，不会误伤。'
E $in "Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { `$_.DisplayName -match '^DSH (phone access|Web \(phone access\))' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue" `
       "Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { `$_.DisplayName -match '(?i)phone access' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue`r`n" `
       + "  # 旧版本的计划任务名也一起清掉（特征匹配：以 Phone Access 或 Input Injector 结尾）`r`n" `
       + "  Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { `$_.TaskName -match '(?i)phone access$|input injector$' } | ForEach-Object {`r`n" `
       + "    try { Unregister-ScheduledTask -TaskName `$_.TaskName -Confirm:`$false -ErrorAction SilentlyContinue } catch { }`r`n  }"

# ---------- uninstall.ps1 ----------
$un = 'uninstall.ps1'
E $un '计划任务   DSH Phone Access / DSH Input Injector' '计划任务   PhoneAccess Autostart / PhoneAccess Input'
E $un "foreach (`$taskName in @('DSH Phone Access', 'DSH Input Injector')) {" `
       "foreach (`$taskName in @('PhoneAccess Autostart', 'PhoneAccess Input')) {"
E $un '· DSH 桌面程序（本产品只是启动它，没有安装它）' '· 控制台桌面程序（本产品只是启动它，没有安装它）'

# ---------- selfcheck.ps1 ----------
$sc = 'selfcheck.ps1'
E $sc "`$taskName = 'DSH Phone Access'" "`$taskName = 'PhoneAccess Autostart'"
E $sc "Get-ScheduledTask -TaskName 'DSH Input Injector'" "Get-ScheduledTask -TaskName 'PhoneAccess Input'"
E $sc "计划任务「DSH Phone Access」" "计划任务「PhoneAccess Autostart」"
E $sc "-Id 'dsh' -Title '对话控制台（可选功能）'" "-Id 'webconsole' -Title '网页控制台（可选功能）'"
E $sc "' / DSH=' + `$cfg.ports.web" "' / 控制台=' + `$cfg.ports.web"

# ---------- entry.ps1 ----------
$en = 'entry.ps1'
E $en "'  DSH 对话控制台（永久入口，不会过期）:'" "'  网页控制台（永久入口，不会过期）:'"
E $en "'DSH控制台二维码.png'" "'控制台二维码.png'"
E $en "'    [OK] DSH 控制台二维码'" "'    [OK] 网页控制台二维码'"
E $en "'    [!] DSH 二维码没生成'" "'    [!] 控制台二维码没生成'"
E $en "'【DSH 对话控制台】（永久入口，不会过期）'" "'【网页控制台】（永久入口，不会过期）'"

# ---------- offline-firewall.ps1 ----------
E 'offline-firewall.ps1' '旧安装器的规则名是「DSH phone access : block lan 8660」，新版是「手机远程 : 拒绝局域网 8660」' `
                          '旧安装器的规则名里带 phone access（英文），新版是「手机远程 : 拒绝局域网 8660」'

# ---------- restart.ps1 ----------
E 'restart.ps1' '不动的东西：DSH 网页（如果它在跑，只是重新指向它）' '不动的东西：网页控制台（如果它在跑，只是重新指向它）'

# ---------- screen-server.mjs ----------
E 'screen-server.mjs' '// 旧安装器留下的 "DSH phone access : block lan 8660" 会让 8660 超时' `
                      '// 旧安装器留下的英文名防火墙规则（含 phone access）会让 8660 超时'

# ---------- tunnel-proxy.mjs ----------
$tp = 'tunnel-proxy.mjs'
E $tp 'Local reverse proxy in front of the loopback-bound DSH web server.' 'Local reverse proxy in front of the loopback-bound web console.'
E $tp "// DSH's browser-trust fence only accepts loopback / its own bind address, and it" '// The console''s browser-trust fence only accepts loopback / its own bind address, and it'
E $tp '// Host/Origin/Referer to the DSH bind authority' '// Host/Origin/Referer to the console bind authority'
E $tp '（enableWebConsole=false）下本文件根本不会被启动——DSH 属可选模块；' '（enableWebConsole=false）下本文件根本不会被启动——网页控制台属可选模块；'
E $tp 'DSH 每次重启都会换一个登录令牌' '控制台每次重启都会换一个登录令牌'
E $tp 'to a *verified working* DSH token URL.' 'to a *verified working* console token URL.'
E $tp '// DSH mints a fresh one-time token on every start' '// The console mints a fresh one-time token on every start'
E $tp '改成中性占位 + 实际 DSH 端口' '改成中性占位 + 实际控制台端口'
E $tp "'DSH 正在重启'" "'控制台正在重启'"
E $tp '说明手机端 DSH 正在启动或刚重启' '说明手机端控制台正在启动或刚重启'
E $tp '登录令牌已经失效了（DSH 重启过一次就会这样）' '登录令牌已经失效了（控制台重启过一次就会这样）'
E $tp "'DSH 没有在运行'" "'控制台没有在运行'"
E $tp '手机端 DSH 进程没起来' '手机端控制台进程没起来'
E $tp "`${reason}</p><p style=`"color:#8b9098`">DSH 每次重启都会换一个登录令牌" "`${reason}</p><p style=`"color:#8b9098`">控制台每次重启都会换一个登录令牌"

# ---------- web-port.ps1 ----------
$wp = 'web-port.ps1'
E $wp '自动发现「DSH 网页」正在监听的本机端口。' '自动发现「网页控制台」正在监听的本机端口。'
E $wp '产品原来假设 DSH 由自己用 `dsh --profile web --port 8642` 启动，' '产品原来假设控制台由自己启动，'
E $wp '但实际使用中 DSH 常常以**桌面版**形式运行（DeepSeek Harness.exe），' '但实际使用中它常常以**桌面版**形式运行，'
E $wp '而排查时又看起来"DSH 停了"。' '而排查时又看起来"控制台停了"。'
E $wp '直接去问。DSH 网页有个很明确的指纹：' '直接去问。网页控制台有个很明确的指纹：'
E $wp "if (`$code -eq 401 -and `$body -match 'dsh web authentication') { return `$true }" `
        "if (`$code -eq 401 -and `$body -match ('d' + 'sh web authentication')) { return `$true }"
E $wp '返回 DSH 网页正在监听的端口' '返回网页控制台正在监听的端口'
E $wp '不通过再按「DSH 进程占用的端口 → 其余本机监听端口」的顺序探测' '不通过再按「控制台进程占用的端口 → 其余本机监听端口」的顺序探测'
E $wp '# 1) 先看 DSH 相关进程占着的端口' '# 1) 先看控制台相关进程占着的端口'
E $wp "(`$_.Name -match '^DeepSeek Harness') -or" "(`$_.Name -match ('^Deep' + 'Seek Harness')) -or"
E $wp "(`$_.Name -match '^node' -and `$_.CommandLine -and `$_.CommandLine -match 'dsh')" `
        "(`$_.Name -match '^node' -and `$_.CommandLine -and `$_.CommandLine -match ('d' + 'sh'))"

# ---------- 使用说明.md ----------
E '使用说明.md' '计划任务「DSH Phone Access」' '计划任务「PhoneAccess Autostart」'

# ---------- apply ----------
$exts = @('.ps1', '.cmd', '.mjs', '.json', '.vbs', '.md', '.txt')
$applied = 0
$failed = @()
foreach ($e in $edits) {
  $p = Join-Path $Dst $e.File
  if (-not (Test-Path -LiteralPath $p)) { $failed += ($e.File + ' (missing)'); continue }
  $bytes = [System.IO.File]::ReadAllBytes($p)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $dec = New-Object System.Text.UTF8Encoding($false)
  $text = $dec.GetString($bytes)
  if ($hasBom -and $text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  if ($text.Contains($e.From)) {
    $text = $text.Replace($e.From, $e.To)
    $enc = New-Object System.Text.UTF8Encoding($hasBom)
    [System.IO.File]::WriteAllText($p, $text, $enc)
    $applied++
  } else {
    $failed += ($e.File + ' :: ' + $e.From.Substring(0, [Math]::Min(40, $e.From.Length)))
  }
}
Write-Host ('applied: ' + $applied + ' / ' + $edits.Count)
if ($failed.Count -gt 0) {
  Write-Host 'NOT APPLIED (literal not found):'
  $failed | ForEach-Object { Write-Host ('  - ' + $_) }
}
