# release build pass 3: last sweep (comments + task names + leftover literals)

param(
  [string]$Dst = ''
)
if (-not $Dst) { $Dst = Join-Path (Split-Path -Parent $PSScriptRoot) '.release\app' }
$ErrorActionPreference = 'Stop'

$shipped = @(
  'product.config.json','product-config.ps1','selfcheck.ps1','自检.cmd','entry.ps1','手机入口.cmd',
  'offline-mode.ps1','离线模式.cmd','offline-firewall.ps1','offline-mode-off.ps1','关闭离线模式.cmd',
  'licence.ps1','licence-state.ps1','sunshine-integration.ps1','hotspot-ctl.ps1','make-lan-cert.ps1',
  'make-lan-ca.ps1','trial.ps1','https-setup.ps1','start-phone-access.ps1','start-phone-access.cmd',
  'start-screen.ps1','start-screen.cmd','stop-phone-access.ps1','stop-phone-access.cmd','supervise.ps1',
  'autostart.ps1','run-autostart.vbs','install-elevated-input.ps1','install.ps1','install.cmd',
  'screen-server.mjs','page.mjs','lock-screen.ps1','rtc.mjs','decode.mjs','input.mjs','audio.mjs',
  'tunnel-proxy.mjs','package.json','uninstall.ps1','uninstall.cmd','使用说明.md','web-port.ps1',
  'restart.ps1','restart.cmd','branding\联系.txt'
)

# exact line rewrites first
$exact = @(
  @{ F='run-autostart.vbs'; From="' 改动（与 P0-2 同类：消灭绝对路径）：原来这一行把 autostart.ps1 的路径写死成 C:\Users\ccj\Documents\...，
' 换台机器/换用户名后，计划任务每 2 分钟跑一次、每次都失败，只在日志里留一行 —— 整套自愈层静默死掉。
' 现在改成用本文件所在目录推导：app 目录整体拷到哪里都能跑，不需要改这里。"; To="' Paths are derived from this file's own folder, so the app directory can be copied
' anywhere: no hard-coded absolute path and no per-machine edits." }
  @{ F='web-port.ps1'; From='        body: "dsh web authentication required; reopen the URL printed by dsh web."'; To='        body: "<控制台程序> authentication required; reopen the URL printed by it."' },
  @{ F='start-phone-access.ps1'; From='  # 客户可见文案：交付给客户的版本里绝不出现"DSH"字样（那是卖家自用时的叫法）。'; To='  # 客户可见文案：交付给客户的版本里不提控制台程序（那是卖家自用时才需要的东西）。' },
  @{ F='start-phone-access.ps1'; From='  # 客户可见文案：不提 DSH。顺带把"能装成 App"的 https 地址也标出来。'; To='  # 客户可见文案：不提控制台程序。顺带把"能装成 App"的 https 地址也标出来。' }
)

# ordered global replacements
$globals = @(
  @('''DSH Phone Access''', '''PhoneAccess Autostart'''),
  @('''DSH Input Injector''', '''PhoneAccess Input'''),
  @('DSH Phone Access', 'PhoneAccess Autostart'),
  @('DSH Input Injector', 'PhoneAccess Input'),
  @('dsh web', 'web console'),
  @('DSH 网页', '控制台网页'),
  @('DSH 对话控制台', '网页控制台'),
  @('DSH 桌面版', '控制台桌面版'),
  @('DSH 桌面端', '控制台桌面端'),
  @('DSH 的', '控制台的'),
  @('DSH 和', '控制台和'),
  @('DSH 与', '控制台与'),
  @('DSH 拉', '控制台拉'),
  @('DSH 当', '控制台当'),
  @('DSH,', '控制台,'),
  @('DSH)', '控制台)'),
  @('DSH(', '控制台('),
  @('DSH。', '控制台。'),
  @('DSH，', '控制台，'),
  @(' DSH', ' 控制台'),
  @('DSH ', '控制台 '),
  @('DSH', '控制台'),
  @('DeepSeek Harness', '控制台程序'),
  @('dsh', 'web')
)

function Read-Text([string]$p) {
  $bytes = [System.IO.File]::ReadAllBytes($p)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $dec = New-Object System.Text.UTF8Encoding($false)
  $text = $dec.GetString($bytes)
  if ($hasBom -and $text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  return @{ Text = $text; Bom = $hasBom }
}
function Write-Text([string]$p, [string]$text, [bool]$bom) {
  $enc = New-Object System.Text.UTF8Encoding($bom)
  [System.IO.File]::WriteAllText($p, $text, $enc)
}

$changed = 0
foreach ($f in $shipped) {
  $p = Join-Path $Dst $f
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $r = Read-Text $p
  $text = $r.Text
  $orig = $text
  foreach ($e in $exact) { if ($e.F -eq $f) { $text = $text.Replace($e.From, $e.To) } }
  foreach ($g in $globals) { $text = $text.Replace($g[0], $g[1]) }
  if ($text -ne $orig) { Write-Text $p $text $r.Bom; $changed++ }
}
Write-Host ('files changed: ' + $changed)

# final scan
$left = 0
foreach ($f in $shipped) {
  $p = Join-Path $Dst $f
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $r = Read-Text $p
  $lines = $r.Text -split "`r?`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '(?i)dsh|deepseek') {
      if ($lines[$i] -match 'expectedSha') { continue }
      $left++
      Write-Host ('{0}:{1}: {2}' -f $f, ($i + 1), $lines[$i].Trim())
    }
  }
}
Write-Host ('remaining: ' + $left)
