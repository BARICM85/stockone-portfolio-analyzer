$ports = @(5178, 8000)
$processIds = @()

foreach ($port in $ports) {
    try {
        $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction Stop
        $processIds += $connections.OwningProcess
    } catch {
    }
}

$processIds = $processIds | Sort-Object -Unique

foreach ($processId in $processIds) {
    try {
        Stop-Process -Id $processId -Force -ErrorAction Stop
    } catch {
    }
}

Write-Host 'StockOne frontend/backend stopped if they were running.'
