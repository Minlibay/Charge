# PowerShell script to check SFU configuration on Windows

Write-Host "=== SFU Configuration Check ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "1. Checking SFU server environment variables:" -ForegroundColor Yellow
$announcedIp = $env:SFU_ANNOUNCED_IP
if (-not $announcedIp) { $announcedIp = "NOT SET (defaults to 127.0.0.1)" }
Write-Host "   SFU_ANNOUNCED_IP: $announcedIp"

$host = $env:SFU_HOST
if (-not $host) { $host = "NOT SET (defaults to 0.0.0.0)" }
Write-Host "   SFU_HOST: $host"

$port = $env:SFU_PORT
if (-not $port) { $port = "NOT SET (defaults to 3001)" }
Write-Host "   SFU_PORT: $port"

$wsPort = $env:SFU_WS_PORT
if (-not $wsPort) { $wsPort = "NOT SET (defaults to 3001)" }
Write-Host "   SFU_WS_PORT: $wsPort"

$rtcMin = $env:SFU_RTC_MIN_PORT
if (-not $rtcMin) { $rtcMin = "NOT SET (defaults to 40000)" }
Write-Host "   SFU_RTC_MIN_PORT: $rtcMin"

$rtcMax = $env:SFU_RTC_MAX_PORT
if (-not $rtcMax) { $rtcMax = "NOT SET (defaults to 49999)" }
Write-Host "   SFU_RTC_MAX_PORT: $rtcMax"
Write-Host ""

Write-Host "2. Checking if SFU container is running:" -ForegroundColor Yellow
$sfuContainer = docker ps --format "{{.Names}}" 2>$null | Select-String -Pattern "sfu|charge-sfu" | Select-Object -First 1
if ($sfuContainer) {
    $containerName = $sfuContainer.ToString().Trim()
    Write-Host "   ✓ SFU container is running: $containerName" -ForegroundColor Green
    Write-Host "   Container details:"
    docker ps --filter "name=$containerName" 2>$null | ForEach-Object { Write-Host "   $_" }
} else {
    Write-Host "   ✗ SFU container is NOT running" -ForegroundColor Red
    Write-Host "   Run: docker-compose up -d sfu"
}
Write-Host ""

Write-Host "3. Checking SFU container logs (last 20 lines):" -ForegroundColor Yellow
if ($sfuContainer) {
    $containerName = $sfuContainer.ToString().Trim()
    Write-Host "   Recent logs from $containerName:"
    docker logs --tail 20 $containerName 2>&1 | ForEach-Object { Write-Host "   $_" }
} else {
    Write-Host "   Container not running, cannot check logs"
}
Write-Host ""

Write-Host "4. Checking network connectivity:" -ForegroundColor Yellow
if ($env:SFU_ANNOUNCED_IP) {
    $ip = $env:SFU_ANNOUNCED_IP
    Write-Host "   Testing connectivity to $ip:"
    $ping = Test-Connection -ComputerName $ip -Count 1 -Quiet -ErrorAction SilentlyContinue
    if ($ping) {
        Write-Host "   ✓ Can ping $ip" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Cannot ping $ip" -ForegroundColor Red
    }
} else {
    Write-Host "   SFU_ANNOUNCED_IP not set, skipping connectivity test"
}
Write-Host ""

Write-Host "5. Checking if ports are accessible:" -ForegroundColor Yellow
if ($env:SFU_PORT) {
    $port = [int]$env:SFU_PORT
    try {
        $connection = Test-NetConnection -ComputerName localhost -Port $port -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
        if ($connection.TcpTestSucceeded) {
            Write-Host "   ✓ Port $port is open" -ForegroundColor Green
        } else {
            Write-Host "   ✗ Port $port is NOT accessible" -ForegroundColor Red
        }
    } catch {
        Write-Host "   ✗ Port $port is NOT accessible" -ForegroundColor Red
    }
}

if ($env:SFU_WS_PORT) {
    $wsPort = [int]$env:SFU_WS_PORT
    try {
        $connection = Test-NetConnection -ComputerName localhost -Port $wsPort -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
        if ($connection.TcpTestSucceeded) {
            Write-Host "   ✓ Port $wsPort (WebSocket) is open" -ForegroundColor Green
        } else {
            Write-Host "   ✗ Port $wsPort (WebSocket) is NOT accessible" -ForegroundColor Red
        }
    } catch {
        Write-Host "   ✗ Port $wsPort (WebSocket) is NOT accessible" -ForegroundColor Red
    }
}
Write-Host ""

Write-Host "6. Checking RTC port range:" -ForegroundColor Yellow
if ($env:SFU_RTC_MIN_PORT -and $env:SFU_RTC_MAX_PORT) {
    Write-Host "   RTC ports: $env:SFU_RTC_MIN_PORT - $env:SFU_RTC_MAX_PORT"
    Write-Host "   Note: These ports must be open in firewall for WebRTC to work"
} else {
    Write-Host "   RTC port range not configured"
}
Write-Host ""

Write-Host "=== Recommendations ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "If transport connection is failing, check:"
Write-Host "1. SFU_ANNOUNCED_IP should be your public IP address (45.144.66.105)"
Write-Host "2. RTC ports (40000-49999) must be open in firewall"
Write-Host "3. TURN server should be configured and running"
Write-Host "4. Check SFU container logs for ICE/DTLS errors"
Write-Host ""
Write-Host "To view real-time SFU logs:"
if ($sfuContainer) {
    $containerName = $sfuContainer.ToString().Trim()
    Write-Host "  docker logs -f $containerName"
} else {
    Write-Host "  docker logs -f `$(docker ps --format '{{.Names}}' | Select-String -Pattern 'sfu|charge-sfu' | Select-Object -First 1)"
}
Write-Host ""

