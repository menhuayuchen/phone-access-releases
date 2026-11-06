param(
    [ValidateSet('status', 'start', 'stop')]
    [string]$Action = 'status',
    [string]$Ssid = 'PhoneAccess-Offline',
    [string]$Pass = 'phoneaccess'
)
$ErrorActionPreference = 'Continue'
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null } catch { }
try {
    [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime] | Out-Null
    [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime] | Out-Null
} catch { Write-Output ('{"ok":false,"error":"winrt load failed"}'); exit 1 }

$asTaskGeneric = $null
try {
    $methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $asTaskGeneric = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1)
    $asTaskAction = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1)
} catch { }

function AwaitOp($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    [void]$t.Wait(30000)
    return $t.Result
}
function AwaitAction($act) {
    $t = $asTaskAction.Invoke($null, @($act))
    [void]$t.Wait(30000)
    return $t.IsCompleted
}

$profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
if (-not $profile) {
    # 没有任何"连接配置"（完全离线）时，退而求其次用第一个连接配置
    try {
        $profiles = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles()
        if ($profiles -and $profiles.Count -gt 0) { $profile = $profiles[0] }
    } catch { }
}
if (-not $profile) { Write-Output '{"ok":false,"error":"没有可用的网络连接配置（完全离线时 Windows 热点 API 不可用）"}'; exit 1 }

$tm = $null
try { $tm = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile) } catch { Write-Output ('{"ok":false,"error":"create manager failed: ' + $_.Exception.Message + '"}'); exit 1 }

$cap = 'Unknown'
try { $cap = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::GetTetheringCapabilityFromConnectionProfile($profile) } catch { }

if ($Action -eq 'start') {
    try {
        $cfg = $tm.GetCurrentAccessPointConfiguration()
        if ($cfg.Ssid -ne $Ssid -or $cfg.Passphrase -ne $Pass) {
            $cfg.Ssid = $Ssid
            $cfg.Passphrase = $Pass
            $cfg.AuthenticationKind = [Windows.Networking.NetworkOperators.TetheringWiFiAuthenticationKind]::Wpa2
            [void](AwaitAction ($tm.ConfigureAccessPointAsync($cfg)))
        }
    } catch { }
    try {
        $r = AwaitOp ($tm.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
        Write-Output ('{"ok":true,"action":"start","status":"' + $r.Status + '","state":"' + $tm.TetheringOperationalState + '","capability":"' + $cap + '"}')
    } catch { Write-Output ('{"ok":false,"action":"start","error":"' + $_.Exception.Message + '"}') }
    exit 0
}
if ($Action -eq 'stop') {
    try {
        $r = AwaitOp ($tm.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
        Write-Output ('{"ok":true,"action":"stop","status":"' + $r.Status + '","state":"' + $tm.TetheringOperationalState + '"}')
    } catch { Write-Output ('{"ok":false,"action":"stop","error":"' + $_.Exception.Message + '"}') }
    exit 0
}
$cfg = $null
try { $cfg = $tm.GetCurrentAccessPointConfiguration() } catch { }
Write-Output ('{"ok":true,"action":"status","state":"' + $tm.TetheringOperationalState + '","capability":"' + $cap + '","ssid":"' + $(if ($cfg) { $cfg.Ssid } else { '' }) + '","clients":"' + $tm.ClientCount + '"}')
