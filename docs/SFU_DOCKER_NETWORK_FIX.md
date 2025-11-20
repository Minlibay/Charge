# Исправление проблем с сетью при сборке Docker образа

## Проблема

При сборке Docker образа возникает ошибка:
```
failed to resolve source metadata for docker.io/library/node:22-alpine:
failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/22-alpine":
dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: read udp 127.0.0.1:33344->127.0.0.53:53: read: connection refused
```

## Причина

Проблема с DNS или сетью на сервере:
1. DNS сервер (127.0.0.53) недоступен или не отвечает
2. Нет доступа к интернету
3. Проблемы с firewall/сетевыми настройками

## Решения

### Решение 1: Проверка DNS

```bash
# Проверить DNS
nslookup registry-1.docker.io
# или
dig registry-1.docker.io

# Если не работает, попробовать другой DNS
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
echo "nameserver 8.8.4.4" | sudo tee -a /etc/resolv.conf
```

### Решение 2: Проверка доступа к интернету

```bash
# Проверить доступность Docker registry
curl -I https://registry-1.docker.io/v2/

# Проверить общий доступ к интернету
ping -c 3 8.8.8.8
```

### Решение 3: Настройка Docker DNS

Создайте или обновите `/etc/docker/daemon.json`:

```json
{
  "dns": ["8.8.8.8", "8.8.4.4"]
}
```

Затем перезапустите Docker:

```bash
sudo systemctl restart docker
```

### Решение 4: Использование прокси (если есть)

Если у вас есть прокси, настройте Docker:

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf <<EOF
[Service]
Environment="HTTP_PROXY=http://proxy.example.com:8080"
Environment="HTTPS_PROXY=http://proxy.example.com:8080"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF

sudo systemctl daemon-reload
sudo systemctl restart docker
```

### Решение 5: Использование локального образа (если уже есть)

Если образ `node:22-alpine` уже есть локально:

```bash
# Проверить локальные образы
docker images | grep node

# Если есть, можно использовать его напрямую
# Или загрузить образ вручную с другого сервера
```

### Решение 6: Использование альтернативного registry

Можно использовать альтернативный registry или загрузить образ вручную.

### Решение 7: Перевод SFU на host-сеть Docker

Если проблема проявляется уже при запуске контейнера (ошибка `failed to start userland proxy ... 42033/udp` при публикации большого диапазона UDP-портов), можно перевести сервис `sfu` в режим `network_mode: host`. В этом случае Docker не будет создавать userland proxy и контейнер получит прямой доступ к сетевому стеку хоста.

Пример блока `sfu` в `docker-compose.yml`:

```
  sfu:
    build:
      context: ./sfu-server
      dockerfile: Dockerfile
    ...
    network_mode: host
```

Важно: при использовании host-сети блок `ports` нужно удалить, потому что контейнер уже работает напрямую на портах хоста (3000/3001 и диапазон 40000-49999 должны быть свободны на сервере). Решение работает на Linux-хостах (Docker Desktop для macOS/Windows не поддерживает host network для Linux-контейнеров).

## Быстрая проверка

```bash
# 1. Проверить DNS
cat /etc/resolv.conf

# 2. Проверить доступность интернета
ping -c 3 google.com

# 3. Проверить Docker
docker info

# 4. Попробовать простую команду
docker pull hello-world
```

## После исправления

После решения проблемы с сетью/DNS, попробуйте снова:

```bash
docker compose build --no-cache sfu
```

## Альтернатива: Сборка на другой машине

Если проблема с сетью критична, можно:
1. Собрать образ на локальной машине
2. Сохранить образ: `docker save -o sfu-image.tar charge-sfu:latest`
3. Загрузить на сервер: `docker load -i sfu-image.tar`

## Проверка конфигурации сети

```bash
# Проверить сетевые интерфейсы
ip addr show

# Проверить маршруты
ip route show

# Проверить firewall
sudo iptables -L -n
```





