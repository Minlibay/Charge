# SFU Troubleshooting Guide

## Проверка логов сервера

### 1. Просмотр логов SFU контейнера

```bash
# Просмотр последних 50 строк логов
docker logs --tail 50 sfu

# Просмотр логов в реальном времени
docker logs -f sfu

# Просмотр логов с фильтрацией по ошибкам
docker logs sfu 2>&1 | grep -i error
```

### 2. Проверка логов на ошибки ICE/DTLS

Ищите в логах следующие сообщения:
- `[Transport ...] ICE state: failed` - проблема с ICE соединением
- `[Transport ...] DTLS state: failed` - проблема с DTLS handshake
- `[Transport ...] Connection state: failed` - общая проблема с соединением
- `[ConnectTransport] Failed to connect` - ошибка при подключении транспорта

### 3. Проверка конфигурации

Запустите скрипт проверки:

**На Linux/Mac:**
```bash
chmod +x check-sfu-config.sh
./check-sfu-config.sh
```

**На Windows (PowerShell):**
```powershell
.\check-sfu-config.ps1
```

## Проверка сетевых настроек

### 1. Проверка портов

Убедитесь, что следующие порты открыты в firewall:

- **SFU_PORT** (по умолчанию 3001) - основной порт SFU сервера
- **SFU_WS_PORT** (по умолчанию 3001) - WebSocket порт
- **SFU_RTC_MIN_PORT - SFU_RTC_MAX_PORT** (по умолчанию 40000-49999) - порты для WebRTC медиа

**Проверка на Linux:**
```bash
# Проверка основного порта
nc -zv localhost 3001

# Проверка WebSocket порта
nc -zv localhost 3001

# Проверка диапазона RTC портов (пример)
nc -zv localhost 40000
```

**Проверка на Windows:**
```powershell
# Проверка основного порта
Test-NetConnection -ComputerName localhost -Port 3001

# Проверка WebSocket порта
Test-NetConnection -ComputerName localhost -Port 3001
```

### 2. Проверка SFU_ANNOUNCED_IP

**КРИТИЧЕСКИ ВАЖНО:** `SFU_ANNOUNCED_IP` должен быть установлен в **публичный IP адрес** вашего сервера, а не `127.0.0.1` или `localhost`.

В вашем случае это должно быть: `45.144.66.105`

Проверьте в `docker-compose.yml`:
```yaml
environment:
  - SFU_ANNOUNCED_IP=45.144.66.105  # Должен быть публичный IP
```

### 3. Проверка firewall

Убедитесь, что firewall разрешает входящие соединения на порты:

**UFW (Ubuntu):**
```bash
sudo ufw allow 3001/tcp
sudo ufw allow 3001/tcp
sudo ufw allow 40000:49999/udp
sudo ufw allow 40000:49999/tcp
```

**firewalld (CentOS/RHEL):**
```bash
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --permanent --add-port=40000-49999/udp
sudo firewall-cmd --permanent --add-port=40000-49999/tcp
sudo firewall-cmd --reload
```

**Windows Firewall:**
```powershell
# Открыть порты через PowerShell (от имени администратора)
New-NetFirewallRule -DisplayName "SFU Port 3001" -Direction Inbound -LocalPort 3001 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "SFU Port 3001 WS" -Direction Inbound -LocalPort 3001 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "SFU RTC UDP" -Direction Inbound -LocalPort 40000-49999 -Protocol UDP -Action Allow
New-NetFirewallRule -DisplayName "SFU RTC TCP" -Direction Inbound -LocalPort 40000-49999 -Protocol TCP -Action Allow
```

## Типичные проблемы и решения

### Проблема: "Send transport failed" / "Recv transport failed"

**Возможные причины:**

1. **Неправильный SFU_ANNOUNCED_IP**
   - Решение: Установите публичный IP адрес сервера
   - Проверка: `docker exec sfu printenv SFU_ANNOUNCED_IP`

2. **Закрытые порты в firewall**
   - Решение: Откройте порты 40000-49999 (UDP и TCP) в firewall
   - Проверка: Используйте скрипт `check-sfu-config.sh` или `check-sfu-config.ps1`

3. **Проблемы с NAT/сетью**
   - Решение: Убедитесь, что TURN сервер настроен и работает
   - Проверка: Проверьте логи TURN сервера: `docker logs turn`

4. **Проблемы с ICE кандидатами**
   - Решение: Проверьте, что сервер может получить ICE кандидаты
   - Проверка: Смотрите логи SFU на наличие `ICE state: failed`

### Проблема: Транспорт не подключается

**Диагностика:**

1. Проверьте логи SFU:
   ```bash
   docker logs -f sfu | grep -E "(Transport|ConnectTransport|ICE|DTLS)"
   ```

2. Проверьте, что сервер получает запросы:
   - Ищите `[ConnectTransport] Connecting` в логах
   - Если нет - проблема с WebSocket соединением

3. Проверьте ICE кандидаты:
   - В логах должны быть ICE кандидаты с правильным IP
   - Если IP `127.0.0.1` - проблема с `SFU_ANNOUNCED_IP`

### Проблема: WebSocket соединение не устанавливается

**Проверка:**

1. Проверьте, что контейнер запущен:
   ```bash
   docker ps | grep sfu
   ```

2. Проверьте WebSocket порт:
   ```bash
   curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" http://localhost:3001/ws
   ```

3. Проверьте CORS настройки:
   - В `docker-compose.yml` должно быть: `SFU_CORS_ORIGIN=http://localhost:80,https://charvi.ru`

## Дополнительная диагностика

### Включение детального логирования

В `sfu-server/src/config.ts` установите:
```typescript
log: {
  level: 'debug' as 'debug' | 'info' | 'warn' | 'error',
}
```

Или через переменную окружения:
```bash
SFU_LOG_LEVEL=debug
```

### Проверка TURN сервера

```bash
# Проверка логов TURN
docker logs turn

# Проверка доступности TURN
turnutils_stunclient 45.144.66.105:3478
```

### Тестирование WebRTC соединения

Используйте инструменты для тестирования WebRTC:
- https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
- Введите ваш TURN сервер и проверьте ICE кандидаты

## Контакты для помощи

Если проблема не решена:
1. Соберите логи: `docker logs sfu > sfu-logs.txt`
2. Проверьте конфигурацию: `./check-sfu-config.sh > config-check.txt`
3. Создайте issue с этими файлами

