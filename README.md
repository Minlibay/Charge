св# Charge Monorepo

Charge is a sample monorepo that bundles a FastAPI backend and a static playground frontend. This document describes the local development workflow, Docker setup, CI pipeline, and the main API surface.

## Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose v2
- Python 3.12 with [Poetry](https://python-poetry.org/) **2.2.1** (for local backend development)
- Node.js 20+ with npm (for building the static frontend)

## Quick start with Docker Compose

1. Copy `.env` to `.env.local` and adjust sensitive overrides there (for example `WEBRTC_TURN_CREDENTIAL`). The committed `.env`
   only contains safe defaults; `.env.local` is ignored by Git and loaded automatically by the backend settings loader.
2. Build and start the stack:

   ```bash
   docker-compose up --build
   ```

   If you keep secrets in `.env.local`, pass it explicitly so Docker Compose can
   substitute the variables: `docker compose --env-file .env.local up --build`.

   The backend container waits for the MariaDB service, applies Alembic migrations automatically, and starts Uvicorn. The frontend image bundles the static playground and proxies API traffic through Nginx, which is published to the host on port `8080`.

3. Visit [http://localhost:8080](http://localhost:8080) for the frontend playground or [http://localhost:8000/docs](http://localhost:8000/docs) for the interactive API docs.

4. Stop the stack with `Ctrl+C` and remove the containers if required:

   ```bash
   docker-compose down -v
   ```

## Local backend development

```bash
cd backend
poetry self update 2.2.1  # ensure the expected Poetry release is installed
poetry install
poetry run alembic upgrade head  # prepare the database
poetry run uvicorn app.main:app --reload
```

The API will be available at `http://localhost:8000`. Tests and linters can be executed with:

```bash
poetry run ruff check
poetry run black --check .
poetry run pytest
```

## Local frontend workflow

```bash
cd frontend
npm ci
npm run build   # outputs static files to frontend/dist
```

Serve the generated `dist` directory with any static file server (for example `npx serve dist`) or rely on Docker Compose, which performs these steps automatically.

Set the `VITE_API_BASE_URL` variable in `frontend/.env` (or `.env.local`) to point the UI at a specific backend origin, for example:

```
VITE_API_BASE_URL=http://192.168.0.42:8000
```

If the variable is omitted, the frontend automatically targets the current browser host on port `8000`.

The static playground теперь разделён на два экрана:

- `index.html` — страница авторизации и сохранения базового URL API.
- `workspace.html` — рабочая область для загрузки комнат, создания каналов и проверки текстовых/голосовых сессий. Доступна после успешного входа (токен хранится в `localStorage`).

## Continuous integration

The repository includes a GitHub Actions workflow that runs on pushes and pull requests targeting `main`:

- **Backend job** – installs dependencies with Poetry, runs Ruff, Black, and pytest.
- **Frontend job** – installs npm dependencies and verifies the static build step.

## Production deployment notes

For a hardened environment exposed on the public internet:

1. Configure the backend secrets via `.env.local` (or your secret manager) with production-safe values, for example:

   ```env
   ENVIRONMENT=production
   DEBUG=False
   JWT_SECRET_KEY=change-me-in-prod
   CORS_ORIGINS=https://charvi.ru,https://ru.charvi.ru
   CORS_ALLOW_ORIGIN_REGEX=^(https?://([a-z0-9-]+\.)?charvi\.ru(:\d+)?)$
   ```

   The explicit `CORS_ORIGINS` list ensures browsers can reach the API from the public domain and the dedicated application subdomain.

2. Point the frontend at the HTTPS API endpoint by defining `frontend/.env.production` (or an equivalent deployment secret):

   ```env
   VITE_API_BASE_URL=https://api.charvi.ru
   ```

3. Terminate TLS at your ingress (for example, an Nginx or cloud load balancer) so that both the API and the static frontend are served over HTTPS.

4. After rolling out the configuration, restart the Docker Compose stack (or your orchestrated services) and smoke-test the UI against `https://charvi.ru` to confirm authentication and room/channel operations continue to work.

## Environment variables

The backend reads configuration from environment variables. The committed `.env` file provides safe defaults, while `.env.local`
overrides (or values from a secret manager) are loaded automatically via `pydantic-settings`. Key settings are outlined below:

| Variable | Default | Description |
| --- | --- | --- |
| `APP_NAME` | `Charge API` | Human-readable service name. |
| `ENVIRONMENT` | `development` | Current deployment environment label. |
| `DEBUG` | `True` | Enables FastAPI debug mode. |
| `DB_HOST` | `db` | Database host name (MariaDB in Docker). |
| `DB_PORT` | `3306` | Database port. |
| `DB_USER` | `charge` | Database username. |
| `DB_PASSWORD` | `charge` | Database password. |
| `DB_NAME` | `charge` | Database schema. |
| `JWT_SECRET_KEY` | `super-secret-key` | Secret key for signing JWT tokens. |
| `JWT_ALGORITHM` | `HS256` | JWT signing algorithm. |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `30` | Access token expiration in minutes. |
| `CHAT_HISTORY_DEFAULT_LIMIT` | `50` | Default number of chat messages returned for history endpoints. |
| `CHAT_HISTORY_MAX_LIMIT` | `100` | Upper bound for chat history queries. |
| `CHAT_MESSAGE_MAX_LENGTH` | `2000` | Maximum text length of a chat message. |
| `WEBSOCKET_RECEIVE_TIMEOUT_SECONDS` | `30` | Idle timeout for WebSocket consumers. |
| `WEBRTC_TURN_SERVERS` | `[]` | Comma-separated or JSON list of primary TURN URLs exposed to clients. |
| `WEBRTC_TURN_USERNAME` | `None` | Shared TURN username distributed to clients. |
| `WEBRTC_TURN_CREDENTIAL` | `None` | Shared TURN password distributed to clients. Store the real value in `.env.local` or a secret manager; never commit it. |
| `WEBRTC_TURN_FALLBACK_SERVERS` | `[]` | JSON/CSV list of fallback TURN server definitions (see TURN operations). |

## TURN operations and monitoring

TURN availability is critical for voice rooms. The backend ships with a lightweight monitoring toolkit that validates both port
reachability (UDP `3478`, TLS `5349`) and credential correctness.

When running the Docker Compose stack the `turn` service is built from
`docker/turnserver` and reads runtime parameters from the following environment
variables:

- `TURN_REALM` (defaults to `WEBRTC_TURN_REALM`).
- `TURN_USER` / `TURN_PASSWORD` (defaults to `WEBRTC_TURN_USERNAME` and
  `WEBRTC_TURN_CREDENTIAL`). The password must be provided via `.env.local` or a
  secret manager.
- `TURN_CERT_FILE` / `TURN_KEY_FILE` – paths to TLS materials inside the container
  (the compose file mounts `./certbot/conf` at `/certs`).
- `TURN_EXTERNAL_IP` for announcing a public address when the host sits behind
  NAT.

Adjust these variables per environment to match your infrastructure.

### Configuring fallback TURN servers

Define alternative servers with the `WEBRTC_TURN_FALLBACK_SERVERS` variable. Values can be provided as JSON or as a comma-
separated list. Each entry accepts the same structure as the WebRTC `iceServers` definition:

```env
# Example JSON payload
WEBRTC_TURN_FALLBACK_SERVERS=[
  {
    "urls": ["turn:backup-eu.example.net:3478"],
    "username": "backup_user",
    "credential": "backup_password"
  },
  {
    "urls": ["turns:backup-na.example.net:5349?transport=tcp"],
    "username": "na_user",
    "credential": "strong-secret"
  }
]
```

Fallback definitions are exposed to the frontend via `GET /api/config/webrtc` under the `turn.fallbackServers` key so clients can
switch automatically if the primary instance becomes unreachable.

### Managing TURN credentials

- Generate rotation-ready secrets with `python scripts/generate_turn_secret.py`. The script prints a high-entropy value by
  default and can update `.env.local` in-place with `--update-env .env.local --silent`.
- Keep the generated secret in an external manager (for example, Docker/Swarm/Kubernetes secrets or a vault). Only mirror the
  value in `.env.local` on developer machines for local testing.
- Follow the [DevOps rotation guide](docs/devops/turn-credential-rotation.md) for the coordinated steps required to update both
  the backend and the coturn container without downtime.

### Running the TURN health probe

The `app.services.turn_health` module performs an allocation handshake to every configured TURN endpoint. Run it manually or on
a schedule from the backend directory:

```bash
cd backend
poetry run python -m app.services.turn_health --log-level INFO
```

Useful flags:

- `--interval <seconds>` – keep probing continuously (ideal for a sidecar container).
- `--timeout <seconds>` – adjust socket timeouts when links are slow.
- `--turn-url <url>` – probe additional ad-hoc endpoints without changing the environment file (flag can be repeated).

Example crontab entry that executes the probe every five minutes and logs to `/var/log/turn_health.log`:

```cron
*/5 * * * * cd /srv/charge/backend && /usr/bin/poetry run python -m app.services.turn_health >> /var/log/turn_health.log 2>&1
```

### Metrics and alerting

The backend exposes a Prometheus-compatible endpoint at `GET /metrics`. Key series for alerting include:

- `turn_port_availability{server="…",port="3478",transport="udp"}` – 0 when the probe cannot reach the listener.
- `turn_auth_success_total` / `turn_auth_failure_total` – counters for successful and failed authentication attempts.
- `turn_health_last_run_timestamp` and `turn_health_duration_seconds` – sanity checks for probe freshness and runtime.

Integrate these signals with alert rules (for example, fire an alert if `turn_port_availability` remains `0` for five minutes or
if failures increase compared with successes).

### Recovery checklist

1. **Run the health probe** (`poetry run python -m app.services.turn_health`). Note the failing endpoints and failure category
   (`connect`, `auth`, `protocol`, `config`, or `unexpected`).
2. **Inspect metrics** at `/metrics` to confirm whether issues persist across multiple runs and to feed alerting dashboards.
3. **Check the TURN container**. In Docker environments restart it with `docker compose restart turn` and confirm that ports `3478`
   and `5349` are bound.
4. **Validate credentials**. Ensure `WEBRTC_TURN_USERNAME` and `WEBRTC_TURN_CREDENTIAL` match the `coturn` user configured in
   `docker-compose.yml`. Update `.env.local` (or your secret manager) if necessary and redeploy (`docker compose up -d turn`).
5. **Fail over if required**. Populate or update `WEBRTC_TURN_FALLBACK_SERVERS` with a healthy remote instance so clients can
   continue to connect while the local node is repaired.
6. **Re-run the probe** to verify that authentication succeeds and that `turn_port_availability` returns to `1` for every target.

Document probe results and corrective actions in your incident tracker so recurring issues can be triaged quickly.

## API overview

All API routes are served under the `/api` prefix. The most important resources are:

- `GET /health` – Service health probe.
- `GET /api/` – Root endpoint returning a welcome message.
- **Auth (`/api/auth`)**
  - `POST /register` – Create a new user account.
  - `POST /login` – Obtain a JWT bearer token.
- **Rooms (`/api/rooms`)**
  - `POST /` – Create a room (current user becomes owner).
  - `GET /{slug}` – Fetch room details with channel list (membership required).
  - `POST /{slug}/channels` – Create a new channel in the room (admin/owner only).
  - `DELETE /{slug}/channels/{letter}` – Remove a channel by its letter (admin/owner only).
- **Channels (`/api/channels`)**
  - `GET /{channel_id}/history` – Retrieve the latest messages of a text channel, respecting pagination limits.
- **WebSocket gateways**
  - `/ws/text/{channel_id}` – Real-time chat streaming for a text channel.
  - `/ws/signal/{room_slug}` – WebRTC signalling for voice rooms.

Refer to the autogenerated [OpenAPI specification](http://localhost:8000/docs) for schema details.

## Project structure

```
backend/    # FastAPI application, Alembic migrations, tests
frontend/   # Static playground and build scripts
```

## Troubleshooting

- Ensure Docker Desktop has at least 2 GB of memory allocated for the MariaDB container.
- If the frontend reports `ERR_CONNECTION_REFUSED`, verify that port `8080` is free on the host or adjust the `ports` mapping in `docker-compose.yml`.
- If migrations fail during startup, inspect the API container logs (`docker-compose logs api`).
- To reset the database volume, run `docker-compose down -v` before starting the stack again.
