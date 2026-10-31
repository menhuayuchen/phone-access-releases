$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here 'autostart.log'

function Log($message) {
  ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message) |
    Out-File -FilePath $log -Append -Encoding utf8
}

Log '--- autostart begin ---'

# 2026-10-31：自启仍然由计划任务「DSH Phone Access」负责（登录时触发 + 每 2 分钟兜底重试）。
# 但这里**不再等 2 分钟网络就绪**：产品已经改成只走 Tailscale，等 IPv4 只会让手机多等 1~2 分钟。
# 立即启动；如果这时 Tailscale 还没连上，start-screen/守护进程会在下一轮（8 秒）自动重试。
Log 'starting services now (no network wait)'

& (Join-Path $here 'start-phone-access.ps1') -Quiet 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
Log '--- autostart done ---'
