param(
  [int]$Minutes = 3,
  [switch]$Clear
)
# 给守护进程开一个"更新维护窗口"：这段时间里 supervise.ps1 只探活，不会重启 DSH。
# 用法（更新前跑一次）：
#   .\maintenance.ps1 -Minutes 3      # 开 3 分钟窗口
#   .\maintenance.ps1 -Clear          # 立刻结束窗口
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$flag = Join-Path $here 'maintenance.flag'

if ($Clear) {
  Remove-Item $flag -Force -ErrorAction SilentlyContinue
  Write-Host 'maintenance window cleared'
  exit 0
}

if ($Minutes -lt 1) { $Minutes = 1 }
Set-Content -Path $flag -Value ([string]($Minutes * 60)) -Encoding ascii
Write-Host ("maintenance window armed: {0} min ({1}s) -> {2}" -f $Minutes, ($Minutes * 60), $flag)
Write-Host '守护进程在此期间不会重启 DSH；更新完成后可用 -Clear 提前结束。'
