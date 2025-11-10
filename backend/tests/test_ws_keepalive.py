from __future__ import annotations

import time

from starlette.testclient import WebSocketTestSession

from app.api import ws as ws_module
from app.core.security import create_access_token
from app.models import User


def test_presence_connection_survives_keepalive_timeout(client, session_factory) -> None:
    """Ensure that the server side keepalive pings keep the socket open."""

    with session_factory() as session:
        user = User(login="keepalive-user", hashed_password="hashed")
        session.add(user)
        session.commit()
        user_id = user.id

    token = create_access_token({"sub": str(user_id)})

    settings = ws_module.settings
    original_timeout = settings.websocket_keepalive_timeout_seconds
    original_interval = settings.websocket_keepalive_ping_interval_seconds

    settings.websocket_keepalive_timeout_seconds = 0.1
    settings.websocket_keepalive_ping_interval_seconds = 0.05

    try:
        with client.websocket_connect(f"/ws/presence?token={token}") as connection:
            _assert_keepalive_sequence(connection)
    finally:
        settings.websocket_keepalive_timeout_seconds = original_timeout
        settings.websocket_keepalive_ping_interval_seconds = original_interval


def _assert_keepalive_sequence(connection: WebSocketTestSession) -> None:
    """Observe two keepalive pings with client responses to keep the connection active."""

    snapshot = connection.receive_json()
    assert snapshot["type"] == "status_snapshot"

    time.sleep(0.15)
    ping = connection.receive_json()
    assert ping["type"] == "ping"
    connection.send_json({"type": "pong"})

    time.sleep(0.12)
    ping_again = connection.receive_json()
    assert ping_again["type"] == "ping"
    connection.send_json({"type": "pong"})

    connection.send_json({"type": "ping"})
    pong = connection.receive_json()
    assert pong["type"] == "pong"
