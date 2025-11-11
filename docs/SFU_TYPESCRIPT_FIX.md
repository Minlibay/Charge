# Исправление ошибок TypeScript в SFU сервере

## Проблема

При сборке TypeScript возникали ошибки:
```
error TS2459: Module '"mediasoup/node/lib/Router"' declares 'Router' locally, but it is not exported.
error TS2459: Module '"mediasoup/node/lib/Worker"' declares 'Worker' locally, but it is not exported.
```

## Причина

Mediasoup экспортирует классы (`Worker`, `Router`) и типы по-разному:
- **Классы** (`Worker`, `Router`) экспортируются из основного модуля `mediasoup`
- **Типы** (`WorkerSettings`, `RtpCapabilities`, и т.д.) экспортируются из `mediasoup/node/lib/types`

## Решение

Исправлены импорты во всех файлах:

### worker.ts
```typescript
// Было:
import { Worker, WorkerSettings } from 'mediasoup/node/lib/Worker';

// Стало:
import { Worker } from 'mediasoup';
import type { WorkerSettings } from 'mediasoup/node/lib/types';
```

### Room.ts
```typescript
// Было:
import { Router, RtpCapabilities, MediaKind, RtpParameters } from 'mediasoup/node/lib/types';
import { Worker } from 'mediasoup/node/lib/Worker';

// Стало:
import { Router, Worker } from 'mediasoup';
import type { RtpCapabilities, MediaKind, RtpParameters } from 'mediasoup/node/lib/types';
```

### Peer.ts
```typescript
// Было:
import { Transport, Producer, Consumer, RtpCapabilities } from 'mediasoup/node/lib/types';
import { Router } from 'mediasoup/node/lib/Router';

// Стало:
import { Router } from 'mediasoup';
import type { Transport, Producer, Consumer, RtpCapabilities } from 'mediasoup/node/lib/types';
```

## Правила импорта mediasoup

1. **Классы** (Worker, Router, Transport, Producer, Consumer) - импортируйте из `mediasoup`:
   ```typescript
   import { Worker, Router } from 'mediasoup';
   ```

2. **Типы** (WorkerSettings, RtpCapabilities, и т.д.) - импортируйте из `mediasoup/node/lib/types`:
   ```typescript
   import type { WorkerSettings, RtpCapabilities } from 'mediasoup/node/lib/types';
   ```

3. **Используйте `import type`** для типов, чтобы TypeScript правильно их обрабатывал.

## Проверка

После исправлений сборка должна пройти успешно:

```bash
docker compose build --no-cache sfu
```

Или локально:

```bash
cd sfu-server
npm run build
```

