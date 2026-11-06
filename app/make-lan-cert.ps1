param(
    [string]$OutDir = '',
    [string]$DnsName = ''
)
$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = $PSScriptRoot }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' } |
    Select-Object -ExpandProperty IPAddress -Unique)
if ($ips.Count -eq 0) { Write-Output '{"ok":false,"error":"no-lan-ip"}'; exit 1 }

$rsa = [System.Security.Cryptography.RSA]::Create(2048)

$subj = New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName('CN=PhoneAccess-LAN')
$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest($subj, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
foreach ($ip in $ips) { try { $san.AddIpAddress([System.Net.IPAddress]::Parse($ip)) } catch { } }
$san.AddDnsName('localhost')
if ($DnsName) { $san.AddDnsName($DnsName) }
$req.CertificateExtensions.Add($san.Build())
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($false, $false, 0, $false)))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $false)))
$notBefore = [DateTimeOffset]::Now.AddDays(-1)
$notAfter = [DateTimeOffset]::Now.AddYears(5)
$cert = $req.CreateSelfSigned($notBefore, $notAfter)

# .NET Framework 不支持导出 PKCS#8，但支持 PKCS#12(PFX)，Node 的 https 直接吃 pfx
$pfx = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx)
$certPath = Join-Path $OutDir 'lan-cert.pfx'
[System.IO.File]::WriteAllBytes($certPath, $pfx)
$rsa.Dispose()
$result = [ordered]@{ ok = $true; cert = $certPath; key = $keyPath; ips = $ips; notAfter = $notAfter.ToString('yyyy-MM-dd') }
$result | ConvertTo-Json -Depth 4

