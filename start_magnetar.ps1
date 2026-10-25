# MAGNETAR - PowerShell Launcher
$pyPath = "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe"

if (-not (Test-Path $pyPath)) {
    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    if ($pyCmd) { $pyPath = $pyCmd.Source }
}

Write-Host "======================================================================" -ForegroundColor Yellow
Write-Host " MAGNETAR - Geomagnetic Storm Early Warning Station" -ForegroundColor Cyan
Write-Host " Using Python: $pyPath" -ForegroundColor Gray
Write-Host " Starting bridge on COM7 @ 115200 baud..." -ForegroundColor Green
Write-Host " Web Interface: http://localhost:8080" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Yellow

# Launch browser after short delay
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:8080"
} | Out-Null

& $pyPath bridge.py --port 8080 --serial COM7
