# Инструкция по сборке SFU Docker образа

## Проблема и решение

При сборке Docker образа возникала ошибка:
```
npm error /usr/bin/python3: No module named pip
```

**Причина:** mediasoup пытается собрать worker бинарник, но не может найти `pip` для Python.

**Решение:** Обновлен Dockerfile для установки всех необходимых зависимостей.

## Изменения в Dockerfile

### Builder stage
- ✅ Добавлен `py3-pip` - pip для Python 3
- ✅ Добавлен `bash` - требуется для некоторых скриптов
- ✅ Добавлены все зависимости для сборки mediasoup worker:
  - `cairo-dev`
  - `jpeg-dev`
  - `pango-dev`
  - `giflib-dev`
  - `pixman-dev`

### Production stage
- ✅ Используются runtime версии библиотек (без -dev суффикса)
- ✅ Копируются `node_modules` из builder stage (где worker уже собран)
- ✅ Убран `npm install` из production stage

## Сборка

Выполните команду:

```bash
docker compose build --no-cache sfu
```

**Важно:** Используйте флаг `--no-cache` для первой сборки, чтобы пересобрать все слои с нуля.

## Проверка

После успешной сборки проверьте:

```bash
# Запустить SFU
docker compose up -d sfu

# Проверить логи
docker compose logs -f sfu
```

**Ожидаемый результат:**
```
[HTTP] Server listening on 0.0.0.0:3000
```

## Health check

```bash
curl http://localhost:3000/health
```

Должен вернуть:
```json
{"status":"ok","timestamp":"..."}
```

## Если проблема сохраняется

1. **Проверьте версию Node.js:**
   ```bash
   docker run --rm node:20-alpine node --version
   ```

2. **Проверьте логи сборки:**
   ```bash
   docker compose build sfu 2>&1 | tee build.log
   ```

3. **Попробуйте собрать вручную:**
   ```bash
   cd sfu-server
   npm install
   npm run build
   ```

4. **Проверьте размер образа:**
   ```bash
   docker images | grep sfu
   ```

## Оптимизация размера образа

Если размер образа слишком большой, можно:

1. Использовать `.dockerignore` для исключения ненужных файлов
2. Использовать multi-stage build более эффективно
3. Удалить dev зависимости в production stage

Но для начала лучше оставить как есть, чтобы все работало.

