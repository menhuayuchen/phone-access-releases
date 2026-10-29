param([switch]$Restart, [switch]$Quiet)
$ErrorActionPreference = 'Stop'
$profiles = Join-Path $env:USERPROFILE '.dsh\profiles'
$desktop = Join-Path $profiles 'desktop'
$web = Join-Path $profiles 'web'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path (Join-Path $desktop 'package.json'))) {
  Write-Host "[x] Desktop profile not found: $desktop"
  if (-not $Quiet) { Read-Host 'Press Enter to exit' }
  exit 1
}

# 1) plugin set: same dependencies + bundles as the desktop profile
$manifest = Get-Content (Join-Path $desktop 'package.json') -Raw | ConvertFrom-Json
$manifest.name = 'dsh-profile-web'
$json = $manifest | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $web 'package.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[i] package.json synced ($($manifest.dsh.profile.bundles.Count) bundles)"

# 2) config layer: providers, media-gen, vision-router, permission, computer-use...
Copy-Item (Join-Path $desktop 'cordis.patch.yml') (Join-Path $web 'cordis.patch.yml') -Force
Copy-Item (Join-Path $desktop 'pnpm-workspace.yaml') (Join-Path $web 'pnpm-workspace.yaml') -Force
if (Test-Path (Join-Path $desktop 'pnpm-lock.yaml')) {
  Copy-Item (Join-Path $desktop 'pnpm-lock.yaml') (Join-Path $web 'pnpm-lock.yaml') -Force
}
Write-Host '[i] cordis.patch.yml + workspace files synced'

# 3) shared node_modules (junction, so new desktop installs are visible immediately)
$nm = Join-Path $web 'node_modules'
if (-not (Test-Path $nm)) {
  & cmd.exe /c "mklink /J `"$nm`" `"$(Join-Path $desktop 'node_modules')`"" | Out-Null
  Write-Host '[i] node_modules junction created'
} else {
  $item = Get-Item $nm -Force
  if ($item.LinkType -ne 'Junction') { Write-Host '[!] web/node_modules is a real directory, not a junction; desktop installs will not show up' }
}

# 4) restart the phone-facing instance so it reloads the profile
if ($Restart) {
  Write-Host '[i] restarting web instance...'
  Get-NetTCPConnection -State Listen -LocalPort 8642 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
      if ($p) { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    }
  Start-Sleep -Seconds 3
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$here\start-phone-access.ps1`"", '-Quiet') -WindowStyle Hidden
  Write-Host '[i] instance restarting in background; QR/URL refresh in a few seconds.'
}

Write-Host ''
Write-Host 'Done. Then: refresh the page on the phone (cookie survives, no rescan needed).'
if (-not $Quiet) { Read-Host 'Press Enter to exit' }
