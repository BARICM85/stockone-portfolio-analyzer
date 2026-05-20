$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
param(
    [int]$StartupDelaySeconds = 0,
    [switch]$OpenBrowser = $true
)

$frontendPort = 5178
$backendPort = 8000
$frontendUrl = "http://127.0.0.1:$frontendPort"

function Test-PortListening {
    param([int]$Port)

    try {
        return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
    } catch {
        return $false
    }
}

function Start-ServiceWindow {
    param(
        [string]$Title,
        [string]$Command
    )

    Start-Process powershell -ArgumentList @(
        '-NoExit',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        "Set-Location '$projectRoot'; `$host.UI.RawUI.WindowTitle = '$Title'; $Command"
    ) | Out-Null
}

if ($StartupDelaySeconds -gt 0) {
    Start-Sleep -Seconds $StartupDelaySeconds
}

if (-not (Test-PortListening -Port $backendPort)) {
    Start-ServiceWindow -Title 'StockOne Backend' -Command 'npm run dev:server'
}

if (-not (Test-PortListening -Port $frontendPort)) {
    Start-ServiceWindow -Title 'StockOne Frontend' -Command 'npm run dev'
}

if ($OpenBrowser) {
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        if (Test-PortListening -Port $frontendPort) {
            break
        }
        Start-Sleep -Seconds 1
    }

    Start-Process $frontendUrl
}
