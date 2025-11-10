# Фоновые задачи для событий

## Обзор

Система событий включает две фоновые задачи, которые должны выполняться периодически:

1. **Обновление статусов событий** - автоматически обновляет статусы событий (scheduled → ongoing → completed)
2. **Отправка напоминаний** - отправляет напоминания пользователям о предстоящих событиях

## Endpoints

### Обновление статусов

#### Для конкретного канала
```http
POST /api/channels/{channel_id}/events/update-statuses
Authorization: Bearer <token>
```

#### Для всех каналов
```http
POST /api/channels/events/update-all-statuses
Authorization: Bearer <token>
```

**Ответ:**
```json
{
  "scheduled_to_ongoing": 2,
  "ongoing_to_completed": 1,
  "total_updated": 3
}
```

### Отправка напоминаний

```http
POST /api/channels/events/send-reminders
Authorization: Bearer <token>
```

**Ответ:**
```json
{
  "reminders_sent": 5,
  "reminders_failed": 0
}
```

## Настройка cron

### Рекомендуемая частота

- **Обновление статусов**: каждые 5-10 минут
- **Отправка напоминаний**: каждую минуту

### Пример конфигурации cron

```bash
# Обновление статусов событий каждые 5 минут
*/5 * * * * curl -X POST "http://localhost:8000/api/channels/events/update-all-statuses" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json"

# Отправка напоминаний каждую минуту
* * * * * curl -X POST "http://localhost:8000/api/channels/events/send-reminders" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json"
```

### Использование с systemd timer (альтернатива cron)

Создайте файл `/etc/systemd/system/charge-event-status.service`:

```ini
[Unit]
Description=Charge Event Status Update
After=network.target

[Service]
Type=oneshot
User=charge
ExecStart=/usr/bin/curl -X POST "http://localhost:8000/api/channels/events/update-all-statuses" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json"
```

Создайте файл `/etc/systemd/system/charge-event-status.timer`:

```ini
[Unit]
Description=Charge Event Status Update Timer
Requires=charge-event-status.service

[Timer]
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
```

Аналогично для напоминаний.

## Безопасность

Для production рекомендуется:

1. Использовать отдельный API токен с ограниченными правами
2. Ограничить доступ к endpoints только с внутренних IP
3. Использовать HTTPS для всех запросов
4. Настроить rate limiting на endpoints

## Мониторинг

Все операции логируются. Проверяйте логи для отслеживания:

- Количество обновленных событий
- Количество отправленных напоминаний
- Ошибки при выполнении задач

## Интеграция с системой уведомлений

В настоящее время напоминания только логируются. Для полной интеграции:

1. Добавьте вызов функции отправки push-уведомлений в `send_event_reminders`
2. Добавьте вызов функции отправки email в `send_event_reminders`
3. Настройте интеграцию с вашей системой уведомлений

