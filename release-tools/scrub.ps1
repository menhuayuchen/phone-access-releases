# release build string scrub (staging copy only; never touches app\)
# order matters: longer tokens first, replaces are ordinal (case-sensitive)
param(
  [string]$Src = '',
  [string]$Dst = '',
  [switch]$ReportOnly
)

if (-not $Src) { $Src = Join-Path (Split-Path -Parent $PSScriptRoot) 'app' }
if (-not $Dst) { $Dst = Join-Path (Split-Path -Parent $PSScriptRoot) '.release\app' }

$ErrorActionPreference = 'Stop'

if (-not $ReportOnly) {
  if (Test-Path -LiteralPath $Dst) { Remove-Item -LiteralPath $Dst -Recurse -Force }
  New-Item -ItemType Directory -Path $Dst -Force | Out-Null
  Copy-Item -Path (Join-Path $Src '*') -Destination $Dst -Recurse -Force
  Write-Host ('[copy] ' + $Src + ' -> ' + $Dst)
}

# file renames (file name contains the token)
if (-not $ReportOnly) {
  $renames = @{ 'dsh-port.ps1' = 'web-port.ps1' }
  foreach ($k in $renames.Keys) {
    $from = Join-Path $Dst $k
    if (Test-Path -LiteralPath $from) {
      Move-Item -LiteralPath $from -Destination (Join-Path $Dst $renames[$k]) -Force
      Write-Host ('[rename] ' + $k + ' -> ' + $renames[$k])
    }
  }
}

# ordered replacement table
$pairs = New-Object System.Collections.ArrayList
function AddPair([string]$from, [string]$to) { [void]$pairs.Add(@($from, $to)) }

AddPair 'Test-DshWebFingerprint' 'Test-WebConsoleFingerprint'
AddPair 'Get-DshWebPort'         'Get-WebConsolePort'
AddPair 'Test-SelfDsh'           'Test-SelfWebConsole'
AddPair 'DshProductDpi'          'PaProductDpi'
AddPair 'dsh-screen-frames'      'pa-screen-frames'
AddPair 'deepseek-aidsh-desktop-updater' 'phoneaccess-updater'
AddPair 'enableDsh'              'enableWebConsole'
AddPair 'EnableDsh'              'EnableWebConsole'
AddPair '_enableDsh说明'          '_webConsole说明'
AddPair 'dshTargetPort'          'webTargetPort'
AddPair 'dshServePort'           'webServePort'
AddPair 'dshConflict'            'webConflict'
AddPair 'dsh-port.ps1'           'web-port.ps1'
AddPair 'dsh-audio'              'pa-audio'
AddPair 'dsh-input'              'pa-input'
AddPair 'DshInput'               'PaInput'
AddPair 'DshFg'                  'PaFg'
AddPair '__DSH_BOOT__'           '__PA_BOOT__'
AddPair 'otherDsh'               'otherWeb'
AddPair 'portDsh'                'portWeb'
AddPair 'dshPids'                'webPids'
AddPair 'dshPid'                 'webPid'
AddPair 'dshHint'                'webHint'
AddPair 'dshPath'                'webConsolePath'
AddPair 'dshInfo'                'webInfo'
AddPair 'dshUrl'                 'webUrl'
AddPair 'dshPort'                'webPort'
AddPair 'DshPort'                'WebPort'
AddPair 'dshk'                   'pawk'
AddPair 'dsh.cmd'                'console.cmd'
AddPair 'runtime.dshPath'        'runtime.webConsolePath'
AddPair 'ports.dsh'              'ports.web'
AddPair "Join-Path `$env:USERPROFILE '.dsh\profiles\web'" "Join-Path `$here 'profiles\web'"

function Convert-Text([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $dec = New-Object System.Text.UTF8Encoding($false)
  $text = $dec.GetString($bytes)
  if ($hasBom -and $text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  $orig = $text
  foreach ($p in $pairs) { $text = $text.Replace($p[0], $p[1]) }
  $didChange = ($text -ne $orig)
  if ($didChange -and -not $ReportOnly) {
    $enc = New-Object System.Text.UTF8Encoding($hasBom)
    [System.IO.File]::WriteAllText($path, $text, $enc)
  }
  return $didChange
}

$exts = @('.ps1', '.cmd', '.mjs', '.json', '.vbs', '.md', '.txt', '.cjs')
$changed = 0
foreach ($f in Get-ChildItem -LiteralPath $Dst -Recurse -File) {
  if ($exts -notcontains $f.Extension.ToLower()) { continue }
  if (Convert-Text $f.FullName) { $changed++ }
}
Write-Host ('[map] files changed: ' + $changed)

Write-Host ''
Write-Host '==== remaining hits ===='
$left = @()
foreach ($f in Get-ChildItem -LiteralPath $Dst -Recurse -File) {
  if ($exts -notcontains $f.Extension.ToLower()) { continue }
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $dec = New-Object System.Text.UTF8Encoding($false)
  $text = $dec.GetString($bytes)
  $lines = $text -split "`r?`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'dsh|DeepSeek') {
      if ($lines[$i] -match 'expectedSha') { continue }
      $left += ('{0}:{1}: {2}' -f $f.Name, ($i + 1), $lines[$i].Trim())
    }
  }
}
Write-Host ('remaining lines: ' + $left.Count)
$left | ForEach-Object { $_ }
