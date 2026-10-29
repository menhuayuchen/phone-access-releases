<#
插件对齐：把桌面 profile(profiles\desktop) 里已装好的插件，补到手机 profile(profiles\web) 上，
免得以后每次在电脑端装了新插件，手机端还要手动加一遍。

设计原则（都是踩过坑换来的）：
  1. 只加不减：绝不删除、不修改 web 已有的依赖/bundle。
  2. 只同步 node_modules 里真实存在的包。桌面 node_modules 和 web 是 junction 共享同一份，
     所以"存在"就代表能加载；不存在就跳过并记日志，绝不写一条会让 web 起不来的依赖。
  3. 本脚本**不重启**任何东西：有改动只写 plugin-sync.pending，由 supervise.ps1 统一重启。
     两个进程抢着重启会把 web-lan.log 清空、token 丢掉，那就是 2026-10-25 手机 401 的成因。
  4. 每次改动前把原文件拷到 plugin-sync-backup\，supervise.ps1 在重启失败时会用它回滚。

用法：
  .\sync-profile-plugins.ps1           手动跑一次（有改动会写 pending）
  .\sync-profile-plugins.ps1 -DryRun   只看看差什么，不落盘
  .\sync-profile-plugins.ps1 -Quiet    给 supervisor 定时调用，不输出到控制台
#>
param(
  [switch]$Quiet,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath    = Join-Path $here 'plugin-sync.log'
$desktopDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$webDir     = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$nm         = Join-Path $desktopDir 'node_modules'
$pending    = Join-Path $here 'plugin-sync.pending'
$backupDir  = Join-Path $here 'plugin-sync-backup'

function Log([string]$m) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
  $line | Out-File -FilePath $logPath -Append -Encoding utf8
  if (-not $Quiet) { Write-Host $line }
}

function Get-Json($p) { Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json }

try {
  if (-not (Test-Path (Join-Path $desktopDir 'package.json')) -or -not (Test-Path (Join-Path $webDir 'package.json'))) {
    Log '找不到两边的 package.json，跳过'
    exit 0
  }

  $dj = Get-Json (Join-Path $desktopDir 'package.json')
  $wj = Get-Json (Join-Path $webDir 'package.json')

  $deskDeps = [ordered]@{}
  $dj.dependencies.PSObject.Properties | ForEach-Object { $deskDeps[$_.Name] = $_.Value }
  $webDeps = [ordered]@{}
  $wj.dependencies.PSObject.Properties | ForEach-Object { $webDeps[$_.Name] = $_.Value }

  $addDeps = @()
  foreach ($name in $deskDeps.Keys) {
    if ($webDeps.Contains($name)) { continue }
    if (-not (Test-Path (Join-Path $nm ($name -replace '/', '\')))) {
      Log "跳过依赖 $name：桌面 node_modules 里没有这个包，装了也加载不了"
      continue
    }
    $addDeps += $name
  }

  $webBundles  = @($wj.dsh.profile.bundles)
  $deskBundles = @($dj.dsh.profile.bundles)
  $addBundles  = @($deskBundles | Where-Object { $webBundles -notcontains $_ })
  # bundle 里可能引用还没装上依赖的包，这种加了会让 web 起不来
  $addBundles  = @($addBundles | Where-Object {
    $n = $_
    if ($webDeps.Contains($n) -or $deskDeps.Contains($n)) { return $true }
    Log "跳过 bundle $n：两边都没有这个依赖"
    return $false
  })

  # 黑名单：plugin-sync-exclude.txt 里一行一个包名，这些永远不同步（比如只适合桌面端的插件）
  $excludeFile = Join-Path $here 'plugin-sync-exclude.txt'
  $excludes = @()
  if (Test-Path $excludeFile) {
    $excludes = @(Get-Content $excludeFile -Encoding UTF8 | ForEach-Object { ($_ -split '#')[0].Trim() } | Where-Object { $_ })
  }
  if ($excludes.Count) {
    $kept = @($addDeps | Where-Object { $excludes -notcontains $_ })
    if ($kept.Count -ne $addDeps.Count) {
      Log ('按黑名单跳过依赖：' + (($addDeps | Where-Object { $excludes -contains $_ }) -join ', '))
    }
    $addDeps = $kept
    $addBundles = @($addBundles | Where-Object { $excludes -notcontains $_ })
  }

  # 桌面上有、web 上没有的 patch 配置条目：只提示，不自动抄（里面可能有只在桌面成立的路径）
  $patchHint = @()
  $dp = Join-Path $desktopDir 'cordis.patch.yml'
  $wp = Join-Path $webDir 'cordis.patch.yml'
  if ((Test-Path $dp) -and (Test-Path $wp)) {
    $dIds = [regex]::Matches((Get-Content $dp -Raw -Encoding UTF8), '(?m)^-\s+id:\s*([A-Za-z0-9_.\-]+)') | ForEach-Object { $_.Groups[1].Value }
    $wIds = [regex]::Matches((Get-Content $wp -Raw -Encoding UTF8), '(?m)^-\s+id:\s*([A-Za-z0-9_.\-]+)') | ForEach-Object { $_.Groups[1].Value }
    $patchHint = @($dIds | Where-Object { $wIds -notcontains $_ })
  }

  if ($addDeps.Count -eq 0 -and $addBundles.Count -eq 0) {
    Log '两边插件已对齐，无需改动'
    if ($patchHint.Count -gt 0) { Log ('提示：这些 patch 配置只有桌面端有（需要的话手动同步）：' + ($patchHint -join ', ')) }
    exit 0
  }

  $desc = @()
  if ($addDeps.Count)    { $desc += ('依赖 +' + ($addDeps -join ', ')) }
  if ($addBundles.Count) { $desc += ('bundle +' + ($addBundles -join ', ')) }
  Log ('发现差异：' + ($desc -join ' ；'))

  if ($DryRun) {
    Log 'DryRun：不写文件'
    exit 0
  }

  # 先把原文件备份好，supervise.ps1 重启失败时要靠它回滚
  if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
  Copy-Item (Join-Path $webDir 'package.json') (Join-Path $backupDir 'package.json') -Force
  if (Test-Path (Join-Path $webDir 'cordis.patch.yml')) {
    Copy-Item (Join-Path $webDir 'cordis.patch.yml') (Join-Path $backupDir 'cordis.patch.yml') -Force
  }

  foreach ($n in $addDeps) { $webDeps[$n] = $deskDeps[$n] }
  $wj.dependencies = [pscustomobject]$webDeps
  $wj.dsh.profile.bundles = @($webBundles + $addBundles)

  $json = $wj | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText((Join-Path $webDir 'package.json'), $json, (New-Object System.Text.UTF8Encoding($false)))

  Set-Content -Path $pending -Value ($desc -join ' ；') -Encoding UTF8
  Log ('已写入 web/package.json；已排队重启（plugin-sync.pending），supervisor 下一轮会重启 web 实例')
} catch {
  Log ('同步失败：' + $_.Exception.Message)
  exit 1
}