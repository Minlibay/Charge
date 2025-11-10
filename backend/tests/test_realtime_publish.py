from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.websockets import WebSocketState

from app.monitoring.metrics import realtime_publish_errors_total
from charge.realtime.managers import (
    ParticipantState,
    PresenceManager,
    TypingManager,
    VoiceSignalManager,
)
from charge.realtime.transport import BrokerConfig, RedisNATSTransport


class DummyConnectionManager:
    def __init__(self) -> None:
        self.broadcasts: list[tuple[int, dict[str, Any], set[Any] | None]] = []

    async def broadcast(
        self, channel_id: int, payload: dict[str, Any], *, exclude: set[Any] | None = None
    ) -> None:
        self.broadcasts.append((channel_id, payload, exclude))


class DummyWebSocket:
    def __init__(self) -> None:
        self.application_state = WebSocketState.CONNECTED
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class DummyPresenceStatus:
    value = "online"


class DummyUser:
    def __init__(self) -> None:
        self.id = 1
        self.display_name = "Tester"
        self.login = "tester"
        self.presence_status = DummyPresenceStatus()
        self.avatar_url = None


class FailingRedis:
    async def publish(self, channel: str, payload: str) -> None:  # pragma: no cover - used in tests
        raise ConnectionError("boom")


@pytest.fixture(autouse=True)
def reset_publish_error_metrics() -> None:
    samples = realtime_publish_errors_total._samples
    samples.clear()
    yield
    samples.clear()


@pytest.fixture()
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio("asyncio")
async def test_presence_publish_connection_error_logs_warning_and_keeps_connection(caplog):
    transport = RedisNATSTransport(BrokerConfig(redis_url="redis://example"))
    transport._redis = FailingRedis()  # type: ignore[assignment]
    connection_manager = DummyConnectionManager()
    manager = PresenceManager(connection_manager, transport, node_id="node", backend="redis")
    websocket = DummyWebSocket()
    user = DummyUser()

    with caplog.at_level(logging.WARNING):
        await manager.join(42, user, websocket)

    assert websocket.sent, "Client websocket should receive presence snapshot despite publish failure"
    assert connection_manager.broadcasts, "Presence update should be broadcast locally"
    assert any(
        record.levelno == logging.WARNING and "presence update" in record.getMessage()
        for record in caplog.records
    ), "Publish failure should be logged as a warning"
    assert realtime_publish_errors_total._samples[("presence", "redis", "unavailable")] == 1.0


@pytest.mark.anyio("asyncio")
async def test_typing_publish_connection_error_logs_warning(caplog):
    transport = RedisNATSTransport(BrokerConfig(redis_url="redis://example"))
    transport._redis = FailingRedis()  # type: ignore[assignment]
    connection_manager = DummyConnectionManager()
    manager = TypingManager(
        connection_manager,
        transport,
        node_id="node",
        backend="redis",
        ttl_seconds=5.0,
    )
    user = DummyUser()

    with caplog.at_level(logging.WARNING):
        await manager.set_status(10, user, is_typing=True)

    assert connection_manager.broadcasts, "Typing update should be broadcast locally"
    assert any(
        record.levelno == logging.WARNING and "typing update" in record.getMessage()
        for record in caplog.records
    ), "Publish failure should be logged as a warning"
    assert realtime_publish_errors_total._samples[("typing", "redis", "unavailable")] == 1.0


@pytest.mark.anyio("asyncio")
async def test_voice_publish_connection_error_logs_warning(caplog):
    transport = RedisNATSTransport(BrokerConfig(redis_url="redis://example"))
    transport._redis = FailingRedis()  # type: ignore[assignment]
    settings = SimpleNamespace(
        webrtc_max_speakers=5,
        webrtc_default_role="listener",
        webrtc_auto_promote_first_speaker=False,
        voice_quality_monitoring_enabled=False,
        voice_quality_monitoring_endpoint=None,
        voice_recording_enabled=False,
        voice_recording_service_url=None,
    )
    manager = VoiceSignalManager(transport, node_id="node", backend="redis", settings=settings)
    websocket = DummyWebSocket()
    manager._rooms["room"][1] = ParticipantState(  # type: ignore[index]
        websocket=websocket,
        user_id=1,
        display_name="Tester",
        role="speaker",
    )

    with caplog.at_level(logging.WARNING):
        await manager.broadcast("room", {"type": "state"}, publish=True)

    assert websocket.sent, "Voice payload should be delivered locally"
    assert any(
        record.levelno == logging.WARNING and "voice update" in record.getMessage()
        for record in caplog.records
    ), "Publish failure should be logged as a warning"
    assert realtime_publish_errors_total._samples[("voice", "redis", "unavailable")] == 1.0
