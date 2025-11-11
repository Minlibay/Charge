# Исправление проблем с пакетами Alpine Linux

## Проблема

При сборке Docker образа возникала ошибка:
```
ERROR: unable to select packages:
  cairo (no such package)
  giflib (no such package)
  jpeg (no such package)
  ...
```

## Причина

1. **Не обновлен индекс пакетов** - перед установкой пакетов нужно выполнить `apk update`
2. **Неправильные имена пакетов** - в Alpine Linux некоторые пакеты имеют другие имена:
   - `jpeg` → `libjpeg-turbo` (runtime) и `libjpeg-turbo-dev` (build)

## Решение

### Builder stage
- ✅ Добавлен `apk update` перед установкой пакетов
- ✅ Изменен `jpeg-dev` на `libjpeg-turbo-dev`

### Production stage
- ✅ Добавлен `apk update` перед установкой пакетов
- ✅ Изменен `jpeg` на `libjpeg-turbo`

## Изменения в Dockerfile

### Builder stage
```dockerfile
RUN apk update && apk add --no-cache \
    python3 \
    py3-pip \
    make \
    g++ \
    cairo-dev \
    libjpeg-turbo-dev \  # было: jpeg-dev
    pango-dev \
    giflib-dev \
    pixman-dev \
    bash
```

### Production stage
```dockerfile
RUN apk update && apk add --no-cache \
    python3 \
    cairo \
    libjpeg-turbo \  # было: jpeg
    pango \
    giflib \
    pixman
```

## Правильные имена пакетов Alpine Linux

### Runtime пакеты
- `cairo` - правильное имя
- `libjpeg-turbo` - для JPEG поддержки
- `pango` - правильное имя
- `giflib` - правильное имя
- `pixman` - правильное имя
- `python3` - правильное имя

### Build пакеты (dev)
- `cairo-dev` - правильное имя
- `libjpeg-turbo-dev` - для JPEG поддержки при сборке
- `pango-dev` - правильное имя
- `giflib-dev` - правильное имя
- `pixman-dev` - правильное имя

## Важно

Всегда выполняйте `apk update` перед установкой пакетов в Alpine Linux, чтобы обновить индекс пакетов.

## Проверка

После исправлений сборка должна пройти успешно:

```bash
docker compose build --no-cache sfu
```

