# build-release.ps1 — 一条命令产出「发布版」安装包（去掉 dsh / DeepSeek / 本机私人信息）
#
# 做什么：
#   1) 把 app\ 复制到 .release\app（staging），绝不动 app\ 源目录
#   2) 跑三段字符串清理（scrub / scrub2 / scrub3）：标识符、文件名、配置键、注释、日志文案
#   3) 修 BOM（.ps1 必须 UTF-8 BOM；staging 里被 edit 工具动过的文件会丢 BOM）
#   4) 清掉 staging 里不该存在的私密/开发文件
#   5) 调 pack.ps1（-Zip）出目录 + zip
#   6) 后处理 dist：run-autostart.vbs 用 ASCII 版覆盖、删掉 pnpm 生成的 .bin 垫片
#   7) 全文扫描断言：dsh / DeepSeek / 本机用户名 / 本机路径 / tailnet IP 一个都不许剩
#   8) 调 sfx\build-sfx.ps1 出单文件安装包（并自验证解包一致）
#
# 用法（在 phone-access-product 根目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File release-tools\build-release.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File release-tools\build-release.ps1 -Version 1.0.17
#
# 说明：三段 scrub 用的是精确字面量替换，命中不到的条目会打印出来；正常情况下应该是 0 条。
param(
  [string]$Version = '1.0.16',
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$app  = Join-Path $root 'app'
$rel  = Join-Path $root '.release'
$stg  = Join-Path $rel 'app'
$dist = Join-Path $rel 'dist'
if (-not $OutFile) { $OutFile = Join-Path $dist ('PhoneAccess-Setup-v' + $Version + '-release.exe') }
$ps = 'powershell.exe'

function Head([string]$t) { Write-Host ''; Write-Host ('==== ' + $t) -ForegroundColor Cyan }

Head '1/8 复制 app\ 到 staging'
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'scrub.ps1') -Src $app -Dst $stg | Out-Host

Head '2/8 逐条清理（scrub2）'
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'scrub2.ps1') -Dst $stg | Out-Host

Head '3/8 收尾清理（scrub3）'
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'scrub3.ps1') -Dst $stg | Out-Host

Head '3b/8 双轨标记：改写成发布版'
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'mark-release.ps1') -Dst $stg | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'mark-release 失败' }

Head '4/8 修 BOM + 语法检查'
$bad = 0
foreach ($f in Get-ChildItem -LiteralPath $stg -Filter *.ps1) {
  $b = [System.IO.File]::ReadAllBytes($f.FullName)
  if (-not ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)) {
    $t = [System.IO.File]::ReadAllText($f.FullName)
    [System.IO.File]::WriteAllText($f.FullName, $t, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host ('  [fix] 补 BOM: ' + $f.Name)
  }
  $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
  if ($errs -and $errs.Count -gt 0) { $bad++; Write-Host ('  [X] 语法错误 ' + $f.Name + ': ' + $errs[0].Message) -ForegroundColor Red }
}
if ($bad -gt 0) { throw ('有 ' + $bad + ' 个 .ps1 语法错误，停止') }
Write-Host '  [OK] 所有 .ps1 解析通过'

Head '5/8 清掉 staging 里的私密/开发文件'
$drop = @(
  'node-path.txt','machine.id','licence.json','licence.state.json','trial.json','product.config.local.json',
  'screen-url.txt','screen-url-ip.txt','screen-url-lan.txt','tailip-url.txt','login-url.txt','phone-url.txt','lan-url.txt',
  'supervisor.heartbeat','supervisor.lock','viewers.count','maintenance.flag','plugin-sync.stamp','plugin-sync.pending',
  'capture.mode','capture.interval','screen-latest.jpg','ultra-usage.json','PARAMETERIZATION.md','check-health.ps1',
  'rotate-key.ps1','maintenance.ps1','harden-firewall.ps1','sync-profile.ps1','sync-profile.cmd','sync-profile-plugins.ps1',
  'plugin-sync-exclude.txt','win-scan.ps1','pack.ps1.bak','product-config.ps1.bak','start-phone-access.ps1.bak'
)
$n = 0
foreach ($f in $drop) { $p = Join-Path $stg $f; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; $n++ } }
foreach ($f in Get-ChildItem -LiteralPath $stg -Filter *.log) { Remove-Item -LiteralPath $f.FullName -Force; $n++ }
foreach ($f in Get-ChildItem -LiteralPath $stg -Filter *.cs) { Remove-Item -LiteralPath $f.FullName -Force; $n++ }
foreach ($f in Get-ChildItem -LiteralPath $stg -Filter 'qr-cache-*.png') { Remove-Item -LiteralPath $f.FullName -Force; $n++ }
Write-Host ('  [OK] 清掉 ' + $n + ' 个文件')

# run-autostart.vbs：用 release-tools 里的 ASCII 干净版覆盖（源码里的那份带本机路径注释，只给自用/dev 用）
$cleanVbs = Join-Path $here 'run-autostart.clean.vbs'
if (Test-Path -LiteralPath $cleanVbs) {
  Copy-Item -LiteralPath $cleanVbs -Destination (Join-Path $stg 'run-autostart.vbs') -Force
  Write-Host '  [OK] run-autostart.vbs 已换成 ASCII 干净版'
}

Head '6/8 pack.ps1（目录 + zip）'
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $stg 'pack.ps1') -AppDir $stg -OutDir $dist -Zip -Version $Version | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'pack.ps1 失败' }

Head '7/8 后处理 dist + 断言'
$pkg = Join-Path $dist ('PhoneAccess-Basic-' + $Version)
if (-not (Test-Path -LiteralPath $pkg)) { throw ('找不到产物目录: ' + $pkg) }
Copy-Item (Join-Path $stg 'run-autostart.vbs') (Join-Path $pkg 'run-autostart.vbs') -Force
foreach ($b in (Get-ChildItem (Join-Path $pkg 'node_modules') -Recurse -Directory -Filter '.bin' -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $b.FullName -Recurse -Force
}
$exts = @('.ps1','.cmd','.mjs','.json','.md','.vbs','.txt','.cjs')
$pat  = '(?i)dsh|deepseek|ccj|D:\\download|laptop-0fimmv7j|100\.108\.92|43ed48b4'
$falsePos = 'expectedSha|buildSharpLibvips|isValidShape|integrity: sha512'
$hits = @()
foreach ($f in Get-ChildItem -LiteralPath $pkg -Recurse -File) {
  if ($exts -notcontains $f.Extension.ToLower()) { continue }
  $lines = (Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8) -split "`r?`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $pat -and $lines[$i] -notmatch $falsePos) {
      $hits += ('{0}:{1}: {2}' -f $f.FullName.Replace($pkg,''), ($i+1), $lines[$i].Trim())
    }
  }
}
if ($hits.Count -gt 0) {
  Write-Host '  [X] 仍有可能泄露的字样：' -ForegroundColor Red
  $hits | Select-Object -First 20 | ForEach-Object { Write-Host ('    ' + $_) }
  throw '清理不彻底，停止出包'
}
Write-Host '  [OK] dsh / DeepSeek / 本机信息：0 处'

# 双轨断言：发布包里必须是 release 渠道，否则实验接口会被挂出去
$pkgCfg = Join-Path $pkg 'product.config.json'
if (-not (Test-Path -LiteralPath $pkgCfg)) { throw '发布包里没有 product.config.json' }
$pkgTxt = Get-Content -LiteralPath $pkgCfg -Raw -Encoding UTF8
if ($pkgTxt -notmatch '"profile"\s*:\s*"release"') { throw '发布包的 product.config.json 里 profile 不是 release，停止' }
Write-Host '  [OK] profile=release（实验接口不会挂载）'

Head '8/8 出单文件安装包'
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'sfx\build-sfx.ps1') -DistRoot $dist -OutFile $OutFile | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'build-sfx 失败' }

Write-Host ''
Write-Host ('发布版安装包：' + $OutFile) -ForegroundColor Green
$h = (Get-FileHash $OutFile -Algorithm SHA256).Hash
Write-Host ('  ' + [math]::Round((Get-Item $OutFile).Length / 1MB, 1) + ' MB  SHA256 ' + $h)
