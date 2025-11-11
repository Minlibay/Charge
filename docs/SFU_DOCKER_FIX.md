# Исправление проблемы сборки Docker образа SFU

## Проблема

При сборке Docker образа возникает ошибка:
```
npm error /usr/bin/python3: No module named pip
```

Это происходит потому, что mediasoup пытается собрать worker бинарник, но не может найти `pip` для Python.

## Решение

Обновлен Dockerfile для установки всех необходимых зависимостей:

1. **В builder stage** добавлены:
   - `py3-pip` - pip для Python 3
   - `bash` - требуется для некоторых скриптов
   - Все зависимости для сборки mediasoup worker (cairo-dev, jpeg-dev, и т.д.)

2. **В production stage**:
   - Используются runtime версии библиотек (без -dev суффикса)
   - Изменен `npm ci` на `npm install --production=false` для корректной установки optional dependencies

## Что было изменено

### Dockerfile
- Добавлен `py3-pip` в builder stage
- Добавлен `bash` в builder stage
- Добавлены все необходимые dev зависимости для сборки mediasoup worker
- Изменен способ установки зависимостей в production stage

### package.json
- Добавлен `mediasoup-worker` в `optionalDependencies` (хотя это обычно не требуется, так как mediasoup сам управляет worker)

## Пересборка

После изменений выполните:

```bash
docker compose build --no-cache sfu
```

Флаг `--no-cache` необходим, чтобы пересобрать все слои с нуля.

## Альтернативное решение (если проблема сохраняется)

Если проблема все еще возникает, можно попробовать:

1. Использовать предсобранный worker бинарник:
   ```dockerfile
   ENV MEDIASOUP_WORKER_BIN=/usr/local/bin/mediasoup-worker
   ```

2. Или установить worker вручную:
   ```dockerfile
   RUN npm install -g mediasoup-worker
   ```

3. Или использовать multi-stage build с копированием worker из builder stage:
   ```dockerfile
   COPY --from=builder /app/node_modules/mediasoup/worker/out/Release/mediasoup-worker /usr/local/bin/mediasoup-worker
   ```

## Проверка

После успешной сборки проверьте:

```bash
docker compose up -d sfu
docker compose logs -f sfu
```

Должны увидеть:
```
[HTTP] Server listening on 0.0.0.0:3000
```

