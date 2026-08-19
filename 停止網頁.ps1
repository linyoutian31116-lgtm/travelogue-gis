$listeners = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
    Write-Host '行旅地圖工坊目前沒有運行。' -ForegroundColor Yellow
    exit 0
}

$stopped = $false
foreach ($listener in $listeners) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($processInfo.CommandLine -match 'travelogue-gis-web' -and $processInfo.CommandLine -match 'app\.py') {
        Stop-Process -Id $listener.OwningProcess
        $stopped = $true
    }
}

if ($stopped) {
    Write-Host '行旅地圖工坊已停止。' -ForegroundColor Green
} else {
    Write-Host '8765 連接埠由其他程式使用，未進行停止。' -ForegroundColor Yellow
}
