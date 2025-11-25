# Исправление проблемы WebSocket подключения

## Проблема
WebSocket не может подключиться к `wss://charvi.ru/ws` с ошибкой:
```
WebSocket connection to 'wss://charvi.ru/ws' failed
```

## Решение

### 1. Проверьте, что SFU сервер запущен

```bash
docker ps | grep sfu
```

Должен быть запущен контейнер `charge-sfu-1` или похожий.

### 2. Проверьте, что SFU слушает на порту 3001

```bash
docker logs charge-sfu-1 --tail 20 | grep "Server listening"
```

Должно быть: `[HTTP] Server listening on 0.0.0.0:3001`

### 3. Проверьте nginx конфигурацию

Убедитесь, что в `docker/nginx/nginx.conf` для `/ws` используется правильный порт:

```nginx
location = /ws {
  proxy_pass http://host.docker.internal:3001;
  ...
}
```

### 4. Перезапустите nginx после изменения конфигурации

```bash
# Пересоберите frontend контейнер (если изменили nginx.conf)
docker-compose build frontend

# Перезапустите frontend
docker-compose restart frontend

# Или пересоздайте контейнер
docker-compose up -d --force-recreate frontend
```

### 5. Проверьте доступность SFU из nginx контейнера

```bash
# Проверьте, может ли nginx контейнер достучаться до SFU
docker exec frontend curl -I http://host.docker.internal:3001/health
```

Должен вернуть HTTP 200.

### 6. Проверьте логи nginx

```bash
# Проверьте ошибки nginx
docker logs frontend 2>&1 | grep -i error | tail -20

# Проверьте доступ к /ws
docker logs frontend 2>&1 | grep -i "ws\|websocket" | tail -20
```

### 7. Проверьте логи SFU при попытке подключения

```bash
# В одном терминале смотрите логи SFU
docker logs -f charge-sfu-1

# В другом терминале попробуйте подключиться через браузер
# Должны появиться логи о новом WebSocket подключении
```

## Альтернативное решение (если host.docker.internal не работает)

Если `host.docker.internal` не работает на вашем Linux сервере, можно использовать IP адрес хоста:

1. Узнайте IP адрес Docker bridge:
```bash
docker network inspect bridge | grep Gateway
```

2. Или используйте `172.17.0.1` (стандартный IP Docker bridge на Linux)

3. Измените nginx.conf:
```nginx
location = /ws {
  proxy_pass http://172.17.0.1:3001;  # или IP из шага 1
  ...
}
```

4. Перезапустите nginx:
```bash
docker-compose restart frontend
```

## Проверка работы

После исправления откройте браузер и проверьте:
1. Консоль браузера (F12) - не должно быть ошибок WebSocket
2. Должно появиться сообщение `[WebSocket] New connection` в логах SFU
3. Голосовой чат должен начать подключаться

