$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here 'autostart.log'

function Log($message) {
  ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message) |
    Out-File -FilePath $log -Append -Encoding utf8
}

Log '--- autostart begin ---'

# 改动（自启修复）：原来这里只等 WLAN|Wi-Fi 网卡，4 分钟等不到就 `exit 1` 直接退出。
# 后果：有线网、网卡别名是"以太网/Ethernet"、或机器主要靠 Tailscale 的客户，开机后
# 自启永久失败，日志里只有一行 "no WLAN IPv4; aborting"。客户表现为"用了几天突然连不上"，
# 而且重启能好——因为重启恰好碰上有人登录。这是最伤口碑的一类故障。
#
# 现在改成三层兜底：
#   1) 优先等 WLAN|Wi-Fi（原行为，笔记本最常见）
#   2) 等不到就接受任何可用网卡（有线、改名网卡都能过）
#   3) 还是等不到也照样继续启动 —— start-phone-access.ps1 自己会走纯 Tailscale 路径，
#      根本不需要局域网地址（局域网门只在 enableDsh=true 时才用）。
function Get-UsableIpv4 {
  $wlan = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.InterfaceAlias -match 'WLAN|Wi-Fi' -and
      $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'
    } | Select-Object -First 1
  if ($wlan) { return $wlan.IPAddress }

  $any = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
      $_.InterfaceAlias -notmatch 'VMware|Loopback|vEthernet|Bluetooth'
    } | Select-Object -First 1
  if ($any) { return $any.IPAddress }

  return $null
}

$deadline = (Get-Date).AddMinutes(2)
$ip = $null
while ((Get-Date) -lt $deadline) {
  $ip = Get-UsableIpv4
  if ($ip) { break }
  Start-Sleep -Seconds 3
}

if ($ip) {
  Log "network ready, ip=$ip"
} else {
  Log 'no usable IPv4 after 2 min; proceeding anyway (pure Tailscale path, does not need LAN)'
}

& (Join-Path $here 'start-phone-access.ps1') -Quiet 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
Log '--- autostart done ---'
