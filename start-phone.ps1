param([Parameter(Mandatory=$true)][string]$Address,[Parameter(Mandatory=$true)][string[]]$Client)
$ErrorActionPreference = 'Stop'
function Test-PilotPrivateIPv4([string]$Value) {
    if ($Value -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return $false }
    $parts = $Value.Split('.')
    foreach ($part in $parts) { if ([string][int]$part -cne $part -or [int]$part -gt 255) { return $false } }
    return [int]$parts[0] -eq 10 -or ([int]$parts[0] -eq 172 -and [int]$parts[1] -ge 16 -and [int]$parts[1] -le 31) -or ([int]$parts[0] -eq 192 -and [int]$parts[1] -eq 168)
}
if (!(Test-PilotPrivateIPv4 $Address)) { throw 'Address must be an explicit RFC1918 IPv4 address.' }
if (!$Client -or @($Client | Where-Object { !(Test-PilotPrivateIPv4 $_) }).Count -gt 0) { throw 'Client must contain explicit RFC1918 IPv4 addresses.' }
if (!(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $Address -ErrorAction SilentlyContinue)) { throw 'Address is not assigned to this computer. Check your private hotspot.' }
if (Get-NetTCPConnection -State Listen -LocalPort 5300 -ErrorAction SilentlyContinue) { throw 'Port 5300 is occupied. Stop the existing pilot service before using this launcher.' }
$pilotKeys = @('HOST','PORT','PUBLIC_BASE_URL','PILOT_LAN_PREVIEW','PILOT_LAN_CLIENTS','PILOT_PRIMARY_UI','DATABASE_PATH')
$pilotPrevious = @{}
foreach ($key in $pilotKeys) { $pilotPrevious[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
try {
    $env:HOST = $Address
    $env:PORT = '5300'
    $env:PUBLIC_BASE_URL = 'http://' + $Address + ':5300'
    $env:PILOT_LAN_PREVIEW = '1'
    $env:PILOT_LAN_CLIENTS = $Client -join ','
    $env:PILOT_PRIMARY_UI = 'page'
    $env:DATABASE_PATH = Join-Path $PSScriptRoot 'data/phone-preview.sqlite'
    Write-Host ('PHONE TEST URL: ' + $env:PUBLIC_BASE_URL)
    Write-Host 'HTTP TEST ONLY. Use fictional messages on your private hotspot. Keep this process running.'
    & (Join-Path $PSScriptRoot 'start.ps1')
} finally {
    foreach ($key in $pilotKeys) { [Environment]::SetEnvironmentVariable($key,$pilotPrevious[$key],'Process') }
}
