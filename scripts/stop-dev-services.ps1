$ports = @(3000, 8787)
foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and ($proc.ProcessName -eq 'node' -or $proc.ProcessName -eq 'npm' -or $proc.ProcessName -eq 'tsx')) {
            Write-Host "Stopping $($proc.ProcessName) PID $($proc.Id) on port $port"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
Write-Host 'Done'
