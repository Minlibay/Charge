# Realtime Load Testing Guide

This document describes how to exercise the distributed websocket stack that powers
presence, typing and voice signalling. The helper script introduced in this change-set
opens many concurrent websocket sessions, publishes synthetic traffic and records the
aggregated metrics so we can validate behaviour under load.

## Prerequisites

* A running instance of the Charge API (typically via `docker-compose up api`).
* A valid JWT token for the test user (needed for authenticated websocket routes).
* Python dependencies installed via Poetry: `poetry install --with dev`.

The load test script depends on the [`websockets`](https://websockets.readthedocs.io/) client
library, which is added to the backend development dependencies.

## Running the tool

```
poetry run python scripts/realtime_load_test.py \
  "ws://localhost:8000/ws/presence?token=<JWT>" \
  --connections 50 \
  --session-duration 60 \
  --interval 10
```

### Useful flags

* `--payload` – JSON payload to send on every interval (for example
  `{"type": "ping"}` for channel websockets that accept ping frames).
* `--expect-reply` – wait for a response after sending the payload and include
  round-trip latency statistics.
* `--json` – emit a machine-friendly summary that can be archived alongside
  Prometheus snapshots.
* `--header` – add arbitrary websocket headers (`--header "X-Debug: true"`).

## Observability

While the script is running, scrape the existing Prometheus metrics exposed by the API.
The following metrics were added to track realtime behaviour:

* `realtime_events_total` – total number of messages processed by topic and direction.
* `realtime_active_connections` – gauge of active websocket connections.
* `realtime_pubsub_subscriptions` – gauge of active broker subscriptions.

Combine these metrics with the script’s reported throughput to spot saturation points.
Logs emitted by the realtime managers also include node identifiers to help correlate
traffic with Redis/NATS message flow.

## Sharing results

For repeatability, capture the command used, summary JSON and any relevant
Prometheus/Log aggregation screenshots. Place them in the project wiki or your team’s
runbook so future investigations can compare baselines.
