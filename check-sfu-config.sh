#!/bin/bash

echo "=== SFU Configuration Check ==="
echo ""

echo "1. Checking SFU server environment variables:"
echo "   SFU_ANNOUNCED_IP: ${SFU_ANNOUNCED_IP:-NOT SET (defaults to 127.0.0.1)}"
echo "   SFU_HOST: ${SFU_HOST:-NOT SET (defaults to 0.0.0.0)}"
echo "   SFU_PORT: ${SFU_PORT:-NOT SET (defaults to 3000)}"
echo "   SFU_WS_PORT: ${SFU_WS_PORT:-NOT SET (defaults to 3001)}"
echo "   SFU_RTC_MIN_PORT: ${SFU_RTC_MIN_PORT:-NOT SET (defaults to 40000)}"
echo "   SFU_RTC_MAX_PORT: ${SFU_RTC_MAX_PORT:-NOT SET (defaults to 49999)}"
echo ""

echo "2. Checking if SFU container is running:"
SFU_CONTAINER=$(docker ps --format "{{.Names}}" | grep -E "sfu|charge-sfu" | head -1)
if [ -n "$SFU_CONTAINER" ]; then
    echo "   ✓ SFU container is running: $SFU_CONTAINER"
    echo "   Container details:"
    docker ps | grep -E "sfu|charge-sfu" | sed 's/^/   /'
else
    echo "   ✗ SFU container is NOT running"
    echo "   Run: docker-compose up -d sfu"
fi
echo ""

echo "3. Checking SFU container logs (last 20 lines):"
if [ -n "$SFU_CONTAINER" ]; then
    echo "   Recent logs from $SFU_CONTAINER:"
    docker logs --tail 20 "$SFU_CONTAINER" 2>&1 | sed 's/^/   /'
else
    echo "   Container not running, cannot check logs"
fi
echo ""

echo "4. Checking network connectivity:"
if [ -n "$SFU_ANNOUNCED_IP" ]; then
    echo "   Testing connectivity to $SFU_ANNOUNCED_IP:"
    if ping -c 1 -W 2 "$SFU_ANNOUNCED_IP" > /dev/null 2>&1; then
        echo "   ✓ Can ping $SFU_ANNOUNCED_IP"
    else
        echo "   ✗ Cannot ping $SFU_ANNOUNCED_IP"
    fi
else
    echo "   SFU_ANNOUNCED_IP not set, skipping connectivity test"
fi
echo ""

echo "5. Checking if ports are accessible:"
if [ -n "$SFU_PORT" ]; then
    if nc -z -w 2 localhost "$SFU_PORT" 2>/dev/null; then
        echo "   ✓ Port $SFU_PORT is open"
    else
        echo "   ✗ Port $SFU_PORT is NOT accessible"
    fi
fi

if [ -n "$SFU_WS_PORT" ]; then
    if nc -z -w 2 localhost "$SFU_WS_PORT" 2>/dev/null; then
        echo "   ✓ Port $SFU_WS_PORT (WebSocket) is open"
    else
        echo "   ✗ Port $SFU_WS_PORT (WebSocket) is NOT accessible"
    fi
fi
echo ""

echo "6. Checking RTC port range:"
if [ -n "$SFU_RTC_MIN_PORT" ] && [ -n "$SFU_RTC_MAX_PORT" ]; then
    echo "   RTC ports: $SFU_RTC_MIN_PORT - $SFU_RTC_MAX_PORT"
    echo "   Note: These ports must be open in firewall for WebRTC to work"
else
    echo "   RTC port range not configured"
fi
echo ""

echo "=== Recommendations ==="
echo ""
echo "If transport connection is failing, check:"
echo "1. SFU_ANNOUNCED_IP should be your public IP address (45.144.66.105)"
echo "2. RTC ports (40000-49999) must be open in firewall"
echo "3. TURN server should be configured and running"
echo "4. Check SFU container logs for ICE/DTLS errors"
echo ""
echo "To view real-time SFU logs:"
if [ -n "$SFU_CONTAINER" ]; then
    echo "  docker logs -f $SFU_CONTAINER"
else
    echo "  docker logs -f \$(docker ps --format '{{.Names}}' | grep -E 'sfu|charge-sfu' | head -1)"
fi
echo ""

