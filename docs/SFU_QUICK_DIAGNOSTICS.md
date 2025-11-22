# Быстрая диагностика проблем SFU

## Текущая ситуация

✅ **Сервер работает правильно:**
- SFU_ANNOUNCED_IP=45.144.66.105 (правильно установлен)
- Транспорты успешно создаются и подключаются на сервере
- Логи показывают: `[ConnectTransport] Successfully connected`

❌ **Проблема на клиенте:**
- Ошибка "Send transport failed" / "Recv transport failed"
- WebRTC соединение не устанавливается между клиентом и сервером

## Шаги диагностики

### 1. Проверьте логи клиента в браузере

Откройте консоль браузера (F12) и ищите:
- `[SFU] Send transport ICE gathering state` - должно быть `complete`
- `[SFU] Send transport ICE candidate error` - не должно быть ошибок
- `[SFU] Send transport connection state` - отслеживайте изменения
- `[SFU] Creating send transport` - проверьте ICE кандидаты

### 2. Проверьте firewall на сервере

**КРИТИЧЕСКИ ВАЖНО:** Порты 40000-49999 (UDP и TCP) должны быть открыты!

```bash
# Проверка UFW (Ubuntu)
sudo ufw status
sudo ufw allow 40000:49999/udp
sudo ufw allow 40000:49999/tcp

# Проверка firewalld (CentOS/RHEL)
sudo firewall-cmd --list-ports
sudo firewall-cmd --permanent --add-port=40000-49999/udp
sudo firewall-cmd --permanent --add-port=40000-49999/tcp
sudo firewall-cmd --reload
```

### 3. Проверьте TURN сервер

```bash
# Проверка логов TURN
docker logs turn

# Проверка доступности TURN
docker exec turn turnutils_stunclient 45.144.66.105:3478
```

### 4. Проверьте ICE кандидаты в логах клиента

В консоли браузера ищите логи с `iceCandidates`. Должны быть кандидаты с IP `45.144.66.105`, а не `127.0.0.1`.

### 5. Проверьте сетевые настройки

Если клиент находится за NAT или корпоративным firewall:
- Убедитесь, что TURN сервер настроен и работает
- Проверьте, что клиент может подключиться к TURN серверу

## Что делать дальше

1. **Откройте консоль браузера** и скопируйте все логи с префиксом `[SFU]`
2. **Проверьте firewall** - порты 40000-49999 должны быть открыты
3. **Проверьте TURN сервер** - должен быть доступен
4. **Пришлите логи** - особенно:
   - ICE кандидаты при создании транспорта
   - Ошибки ICE candidate error
   - Состояния connection state

## Типичные проблемы

### Проблема: ICE кандидаты с 127.0.0.1
**Решение:** Проверьте SFU_ANNOUNCED_IP - должен быть публичный IP

### Проблема: ICE candidate error
**Решение:** Проверьте TURN сервер и firewall

### Проблема: Connection state: failed
**Решение:** Проверьте порты 40000-49999 в firewall и TURN сервер

