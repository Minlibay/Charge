# Charge SFU Server

SFU (Selective Forwarding Unit) server для голосовых каналов Charge на базе Mediasoup.

## Установка

```bash
npm install
```

## Разработка

```bash
npm run dev
```

## Сборка

```bash
npm run build
```

## Запуск

```bash
npm start
```

## Переменные окружения

См. `.env.example` для списка переменных окружения.

## Docker

```bash
docker build -t charge-sfu .
docker run -p 3000:3000 -p 3001:3001 -p 40000-49999:40000-49999/udp charge-sfu
```

## API

### REST API

- `POST /api/rooms/:roomId` - Создать комнату
- `DELETE /api/rooms/:roomId` - Удалить комнату
- `GET /api/rooms/:roomId` - Получить информацию о комнате
- `GET /api/rooms` - Список всех комнат
- `GET /health` - Health check

### WebSocket API

Подключение: `ws://localhost:3001/ws`

Сообщения:
- `join` - Присоединиться к комнате
- `getRouterRtpCapabilities` - Получить RTP capabilities
- `createWebRtcTransport` - Создать WebRTC transport
- `connectTransport` - Подключить transport
- `produce` - Создать producer
- `consume` - Создать consumer
- `resumeConsumer` - Возобновить consumer
- `closeProducer` - Закрыть producer
- `closeConsumer` - Закрыть consumer
- `leave` - Покинуть комнату

