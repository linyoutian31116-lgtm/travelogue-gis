$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledPython = 'C:\Users\yarin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'

if (Test-Path -LiteralPath $bundledPython) {
    $pythonExecutable = $bundledPython
} else {
    $pythonExecutable = (Get-Command python -ErrorAction Stop).Source
}

Set-Location -LiteralPath $projectRoot
Write-Host '正在啟動「行旅地圖工坊」……' -ForegroundColor Cyan
Write-Host '瀏覽器會自動開啟；關閉這個視窗即可停止本機服務。' -ForegroundColor DarkGray
& $pythonExecutable 'app.py' '--open'

