св# Charge Monorepo

Charge is a sample monorepo that bundles a FastAPI backend and a static playground frontend. This document describes the local development workflow, Docker setup, CI pipeline, and the main API surface.

## Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose v2
- Python 3.12 with [Poetry](https://python-poetry.org/) **2.2.1** (for local backend development)
- Node.js 20+ with npm (for building the static frontend)

## Quick start with Docker Compose

1. Ensure the `.env` file contains the desired configuration (a ready-to-use example is committed).
2. Build and start the stack:

   ```bash
   docker-compose up --build
   ```

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

1. Configure the backend `.env` with production-safe values, for example:

   ```env
   ENVIRONMENT=production
   DEBUG=False
   JWT_SECRET_KEY=change-me-in-prod
   CORS_ORIGINS=https://charge.example.com,https://app.charge.example.com
   CORS_ALLOW_ORIGIN_REGEX=^https://(charge|app\.charge)\.example\.com$
   ```

   The explicit `CORS_ORIGINS` list ensures browsers can reach the API from the public domain and the dedicated application subdomain.

2. Point the frontend at the HTTPS API endpoint by defining `frontend/.env.production` (or an equivalent deployment secret):

   ```env
   VITE_API_BASE_URL=https://api.charge.example.com
   ```

3. Terminate TLS at your ingress (for example, an Nginx or cloud load balancer) so that both the API and the static frontend are served over HTTPS.

4. After rolling out the configuration, restart the Docker Compose stack (or your orchestrated services) and smoke-test the UI against `https://charge.example.com` to confirm authentication and room/channel operations continue to work.

## Environment variables

The backend reads configuration from environment variables (the `.env` file is mounted in Docker and loaded via `pydantic-settings`). Key settings are outlined below:

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
