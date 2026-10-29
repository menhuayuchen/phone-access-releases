$e = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile(
  'C:\Users\ccj\Documents\deepseek-harness\default-workspace\phone-access\install-elevated-input.ps1',
  [ref]$null, [ref]$e)
if ($e -and $e.Count -gt 0) {
  "错误数 $($e.Count)"
  $e | Select-Object -First 3 | ForEach-Object { "  $($_.Extent.StartLineNumber): $($_.Message)" }
} else { '语法 OK' }
