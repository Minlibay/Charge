#!/bin/bash

echo "=== WebSocket Connection Check ==="
echo ""

echo "1. Checking container status:"
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "sfu|nginx|frontend"
echo ""

echo "2. Checking if SFU server is listening on port 3000:"
docker exec charge-sfu-1 netstat -tlnp 2>/dev/null | grep 3000 || echo "Cannot check (netstat not available or container not running)"
echo ""

echo "3. Checking nginx logs (last 20 lines):"
docker logs --tail 20 frontend 2>&1 | grep -E "ws|WebSocket|/ws" || echo "No WebSocket-related logs found"
echo ""

echo "4. Testing SFU server connectivity from nginx container:"
docker exec frontend curl -I http://host.docker.internal:3000/health 2>&1 | head -5
echo ""

echo "5. Checking nginx configuration for /ws location:"
docker exec frontend cat /etc/nginx/nginx.conf | grep -A 10 "location = /ws" || echo "Configuration not found"
echo ""

echo "6. Testing WebSocket endpoint (from host):"
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: test" http://localhost:3000/ws 2>&1 | head -10
echo ""

echo "=== Recommendations ==="
echo "If WebSocket connection fails:"
echo "1. Make sure SFU container is running: docker ps | grep sfu"
echo "2. Check SFU logs: docker logs charge-sfu-1 --tail 50"
echo "3. Restart nginx: docker restart frontend"
echo "4. Check nginx error logs: docker logs frontend 2>&1 | grep error"

