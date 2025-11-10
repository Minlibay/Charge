from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.monitoring.metrics import realtime_transport_restarts_total
from charge.realtime.transport import (
    BrokerConfig,
    RedisNATSTransport,
    TransportUnavailableError,
)


class FakePubSub:
    def __init__(self, redis: FakeRedis) -> None:
        self._redis = redis
        self._queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._channels: set[str] = set()

    async def subscribe(self, channel: str) -> None:
        if not self._redis.online:
            raise ConnectionError("offline")
        self._channels.add(channel)
        self._redis.register(channel, self)

    async def unsubscribe(self, channel: str) -> None:
        if channel in self._channels:
            self._redis.unregister(channel, self)
            self._channels.discard(channel)

    async def close(self) -> None:
        for channel in list(self._channels):
            await self.unsubscribe(channel)
        self._channels.clear()

    async def listen(self):
        while True:
            message = await self._queue.get()
            if message is None:
                break
            yield message

    def push(self, message: dict[str, Any] | None) -> None:
        self._queue.put_nowait(message)


class FakeRedis:
    def __init__(self) -> None:
        self.online = True
        self._pubsubs: dict[str, set[FakePubSub]] = {}

    async def ping(self) -> None:
        if not self.online:
            raise ConnectionError("offline")

    async def publish(self, channel: str, payload: str) -> None:
        if not self.online:
            raise ConnectionError("offline")
        for pubsub in list(self._pubsubs.get(channel, set())):
            pubsub.push({"type": "message", "data": payload})

    def pubsub(self) -> FakePubSub:
        return FakePubSub(self)

    async def close(self) -> None:
        self.online = False
        for subscribers in list(self._pubsubs.values()):
            for pubsub in list(subscribers):
                pubsub.push(None)
        self._pubsubs.clear()

    def register(self, channel: str, pubsub: FakePubSub) -> None:
        self._pubsubs.setdefault(channel, set()).add(pubsub)

    def unregister(self, channel: str, pubsub: FakePubSub) -> None:
        subscribers = self._pubsubs.get(channel)
        if not subscribers:
            return
        subscribers.discard(pubsub)
        if not subscribers:
            self._pubsubs.pop(channel, None)

    def fail(self) -> None:
        self.online = False
        for subscribers in list(self._pubsubs.values()):
            for pubsub in list(subscribers):
                pubsub.push(None)


class FakeRedisFactory:
    def __init__(self) -> None:
        self.instances: list[FakeRedis] = []

    def from_url(self, *_args: Any, **_kwargs: Any) -> FakeRedis:
        client = FakeRedis()
        self.instances.append(client)
        return client


@pytest.fixture(autouse=True)
def reset_transport_restart_metric() -> None:
    realtime_transport_restarts_total._samples.clear()
    yield
    realtime_transport_restarts_total._samples.clear()


@pytest.fixture()
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio("asyncio")
async def test_redis_transport_recovers_after_disconnect(monkeypatch):
    factory = FakeRedisFactory()
    monkeypatch.setattr(
        "charge.realtime.transport.redis_asyncio",
        SimpleNamespace(from_url=factory.from_url),
    )
    monkeypatch.setattr("charge.realtime.transport._REDIS_RECOVERY_BASE_DELAY", 0.01)
    monkeypatch.setattr("charge.realtime.transport._REDIS_RECOVERY_MAX_DELAY", 0.05)

    transport = RedisNATSTransport(BrokerConfig(redis_url="redis://fake"))
    await transport.start()

    received: list[dict[str, Any]] = []
    received_event = asyncio.Event()

    async def handler(payload: dict[str, Any]) -> None:
        received.append(payload)
        received_event.set()

    subscription = await transport.subscribe("room", handler, backend="redis")

    await transport.publish("room", {"value": 1}, backend="redis")
    await asyncio.wait_for(received_event.wait(), timeout=1.0)
    received_event.clear()
    received.clear()

    first_client = factory.instances[0]
    first_client.fail()
    await asyncio.sleep(0)

    with pytest.raises(TransportUnavailableError):
        await transport.publish("room", {"value": 2}, backend="redis")

    async def wait_for_instances(expected: int) -> None:
        for _ in range(50):
            if len(factory.instances) >= expected:
                return
            await asyncio.sleep(0.02)
        raise AssertionError("Redis client was not recreated")

    await wait_for_instances(2)

    async def publish_with_retry(payload: dict[str, Any]) -> None:
        for _ in range(20):
            try:
                await transport.publish("room", payload, backend="redis")
                return
            except TransportUnavailableError:
                await asyncio.sleep(0.05)
        raise AssertionError("Redis transport did not recover in time")

    await publish_with_retry({"value": 3})
    await asyncio.wait_for(received_event.wait(), timeout=1.5)

    assert received == [{"value": 3}]
    assert realtime_transport_restarts_total._samples[("redis", "publish_failed")] >= 1.0

    await subscription.close()
    await transport.stop()
