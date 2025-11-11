# Инструкция по установке и настройке SFU

## Этап 1: Подготовка SFU сервера

### Шаг 1.1: Установка зависимостей (ВРУЧНУЮ)

**Выполнить в терминале:**

```bash
cd sfu-server
npm install
```

**Что это делает:**
- Устанавливает все зависимости Node.js (mediasoup, express, ws и т.д.)
- Создает `node_modules/` директорию

**Если возникнут ошибки:**
- Убедитесь, что Node.js версии 18+ установлен: `node --version`
- Убедитесь, что npm установлен: `npm --version`
- Если проблемы с компиляцией нативных модулей, может потребоваться установка build tools

### Шаг 1.2: Настройка переменных окружения

**Создать файл `.env` в корне проекта** (если его еще нет):

```bash
# Добавить в .env следующие переменные:

# SFU Configuration
SFU_API_KEY=your-secret-api-key-change-in-production
SFU_ANNOUNCED_IP=45.144.66.105
SFU_RTC_MIN_PORT=40000
SFU_RTC_MAX_PORT=49999
SFU_CORS_ORIGIN=http://localhost:80,https://charvi.ru
```

**Важно:**
- `SFU_API_KEY` - секретный ключ для аутентификации API. **ОБЯЗАТЕЛЬНО измените на уникальный!**
- `SFU_ANNOUNCED_IP` - публичный IP вашего сервера (уже указан в docker-compose.yml)
- `SFU_RTC_MIN_PORT` и `SFU_RTC_MAX_PORT` - диапазон UDP портов для RTP медиа

### Шаг 1.3: Проверка структуры проекта

**Убедитесь, что созданы следующие файлы:**

```
sfu-server/
├── package.json          ✅
├── tsconfig.json         ✅
├── Dockerfile            ✅
├── .gitignore            ✅
├── README.md             ✅
├── src/
│   ├── index.ts          ✅
│   ├── config.ts         ✅
│   ├── worker.ts         ✅
│   ├── rooms/
│   │   ├── Room.ts       ✅
│   │   ├── Peer.ts       ✅
│   │   └── RoomManager.ts ✅
│   └── ws/
│       └── handler.ts    ✅
└── .env.example          ✅
```

### Шаг 1.4: Тестирование локально (опционально)

**Для тестирования без Docker:**

```bash
cd sfu-server
npm run dev
```

**Ожидаемый результат:**
- Сервер запускается на порту 3000 (HTTP) и 3001 (WebSocket)
- В консоли видны логи: `[HTTP] Server listening on 0.0.0.0:3000`

**Если ошибки:**
- Проверьте, что порты 3000 и 3001 свободны
- Проверьте переменные окружения
- Проверьте логи ошибок

## Этап 2: Обновление docker-compose.yml

### ✅ Автоматически выполнено

Файл `docker-compose.yml` уже обновлен с новым сервисом `sfu`.

**Что добавлено:**
- Сервис `sfu` с Dockerfile
- Порты: 3000 (REST API), 3001 (WebSocket), 40000-49999/udp (RTP)
- Переменные окружения
- Зависимости от `api` сервиса

**Проверка:**
```bash
# Проверить, что docker-compose.yml корректен
docker-compose config
```

## Этап 3: Сборка и запуск

### Шаг 3.1: Сборка Docker образа (ВРУЧНУЮ)

**Выполнить в терминале:**

```bash
# Из корня проекта
docker-compose build sfu
```

**Что это делает:**
- Собирает Docker образ для SFU сервера
- Устанавливает зависимости внутри контейнера
- Компилирует TypeScript в JavaScript

**Время выполнения:** 5-10 минут (первый раз дольше из-за загрузки базового образа)

**Если ошибки:**
- Убедитесь, что Docker запущен
- Проверьте, что есть доступ к интернету (для загрузки образов)
- Проверьте логи: `docker-compose build sfu 2>&1 | tee build.log`

### Шаг 3.2: Запуск SFU сервера (ВРУЧНУЮ)

**Выполнить в терминале:**

```bash
# Запустить только SFU (для тестирования)
docker-compose up sfu

# Или запустить все сервисы
docker-compose up -d
```

**Ожидаемый результат:**
- SFU сервер запускается
- В логах: `[HTTP] Server listening on 0.0.0.0:3000`
- Health check доступен: `curl http://localhost:3000/health`

**Проверка работы:**
```bash
# Health check
curl http://localhost:3000/health

# Должен вернуть: {"status":"ok","timestamp":"..."}
```

### Шаг 3.3: Проверка портов (ВРУЧНУЮ)

**Убедитесь, что порты открыты:**

```bash
# Проверить, что порты слушаются
netstat -tuln | grep -E '3000|3001|40000'

# Или
ss -tuln | grep -E '3000|3001|40000'
```

**Если порты не открыты:**
- Проверьте firewall правила
- Убедитесь, что Docker имеет доступ к портам
- Проверьте логи: `docker-compose logs sfu`

## Этап 4: Интеграция с бэкендом

### ✅ Будет выполнено автоматически в следующих этапах

Следующие файлы будут созданы/обновлены:
- `backend/app/services/sfu_manager.py` - сервис для работы с SFU
- `backend/app/config.py` - настройки SFU
- `backend/app/api/ws.py` - обновление signaling

## Этап 5: Обновление клиента

### ✅ Будет выполнено автоматически в следующих этапах

Следующие файлы будут созданы/обновлены:
- `frontend/src/webrtc/SFUVoiceClient.ts` - новый SFU клиент
- `frontend/src/webrtc/VoiceClient.ts` - рефакторинг
- `frontend/src/hooks/useVoiceConnection.ts` - интеграция

## Проверка работоспособности

### После завершения всех этапов:

1. **Проверить SFU сервер:**
   ```bash
   curl http://localhost:3000/health
   ```

2. **Проверить создание комнаты:**
   ```bash
   curl -X POST http://localhost:3000/api/rooms/test-room \
     -H "X-API-Key: your-secret-api-key-change-in-production" \
     -H "Content-Type: application/json"
   ```

3. **Проверить список комнат:**
   ```bash
   curl http://localhost:3000/api/rooms \
     -H "X-API-Key: your-secret-api-key-change-in-production"
   ```

## Устранение проблем

### Проблема: SFU сервер не запускается

**Решение:**
1. Проверьте логи: `docker-compose logs sfu`
2. Убедитесь, что порты свободны
3. Проверьте переменные окружения
4. Убедитесь, что Node.js образ загружен: `docker images | grep node`

### Проблема: Ошибки компиляции TypeScript

**Решение:**
1. Проверьте версию TypeScript: `npm list typescript`
2. Убедитесь, что все зависимости установлены: `npm install`
3. Проверьте tsconfig.json

### Проблема: Порты не открываются

**Решение:**
1. Проверьте firewall: `sudo ufw status`
2. Убедитесь, что порты в docker-compose.yml правильные
3. Проверьте, что Docker имеет доступ к портам

### Проблема: Mediasoup worker не найден

**Решение:**
1. Mediasoup worker должен быть установлен автоматически через npm
2. Если проблемы, проверьте логи сборки Docker образа
3. Убедитесь, что используются правильные зависимости

## Следующие шаги

После успешной установки SFU сервера:
1. Перейти к Этапу 2: Интеграция с бэкендом
2. Перейти к Этапу 3: Обновление клиента
3. Тестирование с реальными участниками

## Полезные команды

```bash
# Просмотр логов SFU
docker-compose logs -f sfu

# Перезапуск SFU
docker-compose restart sfu

# Остановка SFU
docker-compose stop sfu

# Удаление и пересборка
docker-compose down
docker-compose build --no-cache sfu
docker-compose up -d sfu
```

