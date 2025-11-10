"""Distributed transport helpers for realtime events."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, TYPE_CHECKING

try:  # pragma: no cover - optional dependency
    import redis.asyncio as redis_asyncio
    from redis.exceptions import RedisError
except Exception:  # pragma: no cover - fallback when Redis is unavailable
    redis_asyncio = None  # type: ignore[assignment]
    RedisError = None  # type: ignore[assignment]

if TYPE_CHECKING:  # pragma: no cover - typing helper
    from redis.asyncio import Redis as RedisClient
else:
    RedisClient = Any  # type: ignore[assignment,misc]

try:  # pragma: no cover - optional dependency
    import nats
    from nats.aio.msg import Msg as NatsMessage
    from nats.errors import Error as NatsError
except Exception:  # pragma: no cover - fallback when NATS is unavailable
    nats = None
    NatsMessage = Any  # type: ignore[assignment]
    NatsError = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

if RedisError is not None:
    _REDIS_PUBLISH_ERRORS: tuple[type[BaseException], ...] = (
        RedisError,
        ConnectionError,
        TimeoutError,
        asyncio.TimeoutError,
    )
else:
    _REDIS_PUBLISH_ERRORS = (
        ConnectionError,
        TimeoutError,
        asyncio.TimeoutError,
    )

if "NatsError" in globals() and NatsError is not None:
    _NATS_PUBLISH_ERRORS: tuple[type[BaseException], ...] = (
        NatsError,
        ConnectionError,
        TimeoutError,
        asyncio.TimeoutError,
    )
else:
    _NATS_PUBLISH_ERRORS = (
        ConnectionError,
        TimeoutError,
        asyncio.TimeoutError,
    )


MessageHandler = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass(slots=True)
class BrokerConfig:
    """Configuration used for wiring the realtime transport layer."""

    redis_url: str | None
    redis_prefix: str = "charge.realtime"
    nats_url: str | None = None
    nats_prefix: str = "charge.realtime"
    node_id: str | None = None


class Subscription:
    """Handle returned when subscribing to a broker topic."""

    def __init__(
        self,
        name: str,
        cleanup: Callable[[], Awaitable[None]],
        task: asyncio.Task[Any] | None = None,
    ) -> None:
        self._name = name
        self._cleanup = cleanup
        self._task = task

    @property
    def name(self) -> str:
        return self._name

    async def close(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        await self._cleanup()


class TransportUnavailableError(RuntimeError):
    """Raised when publishing to a broker backend that is not configured."""


class RedisNATSTransport:
    """Simple pub/sub helper built on top of Redis and optionally NATS."""

    def __init__(self, config: BrokerConfig) -> None:
        self._config = config
        self._redis: RedisClient | None = None
        self._redis_subscriptions: list[Subscription] = []
        self._nats: nats.aio.client.Client | None = None if nats is None else nats.aio.client.Client()
        self._nats_subscriptions: list[Subscription] = []
        self._started = False

    @property
    def node_id(self) -> str | None:
        return self._config.node_id

    async def start(self) -> None:
        if self._started:
            return
        if self._config.redis_url:
            if redis_asyncio is None:
                logger.info(
                    "Redis realtime URL configured but 'redis' is not installed; "
                    "install the Poetry 'realtime' dependency group to enable it",
                )
            else:
                self._redis = redis_asyncio.from_url(
                    self._config.redis_url,
                    encoding="utf-8",
                    decode_responses=True,
                )
                try:
                    await self._redis.ping()
                except OSError:
                    logger.exception("Failed to connect to Redis realtime backend")
                    raise
        if self._config.nats_url and nats is not None:
            try:
                await self._nats.connect(self._config.nats_url, name=self._config.node_id)
            except Exception:  # pragma: no cover - connection errors are not deterministic
                logger.exception("Failed to connect to NATS realtime backend")
                raise
        elif self._config.nats_url and nats is None:
            logger.info(
                "NATS realtime URL configured but 'nats-py' is not installed; skipping NATS transport"
            )
        self._started = True

    async def stop(self) -> None:
        for subscription in list(self._redis_subscriptions):
            await subscription.close()
        self._redis_subscriptions.clear()
        for subscription in list(self._nats_subscriptions):
            await subscription.close()
        self._nats_subscriptions.clear()
        if self._redis is not None:
            await self._redis.close()
            self._redis = None
        if self._nats is not None and self._nats.is_connected:  # pragma: no branch - depends on backend
            await self._nats.drain()
            await self._nats.close()
        self._started = False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _redis_channel(self, topic: str) -> str:
        prefix = self._config.redis_prefix.rstrip(".")
        return f"{prefix}.{topic}" if prefix else topic

    def _nats_subject(self, topic: str) -> str:
        prefix = self._config.nats_prefix.rstrip(".")
        return f"{prefix}.{topic}" if prefix else topic

    # ------------------------------------------------------------------
    # Publishing helpers
    # ------------------------------------------------------------------
    async def publish(
        self,
        topic: str,
        payload: dict[str, Any],
        *,
        backend: str | None = None,
    ) -> None:
        target = backend or self._default_backend()
        encoded = json.dumps(payload)
        if target == "redis":
            if self._redis is None:
                raise TransportUnavailableError("Redis backend is not configured")
            channel = self._redis_channel(topic)
            try:
                await self._redis.publish(channel, encoded)
            except _REDIS_PUBLISH_ERRORS as exc:
                raise TransportUnavailableError("Redis backend is unavailable") from exc
            logger.debug("Published realtime payload via Redis", extra={"channel": channel})
            return
        if target == "nats":
            if self._nats is None:
                raise TransportUnavailableError(
                    "NATS backend is unavailable (install the 'nats-py' package to enable it)"
                )
            if not self._nats.is_connected:
                raise TransportUnavailableError("NATS backend is not configured")
            subject = self._nats_subject(topic)
            try:
                await self._nats.publish(subject, encoded.encode("utf-8"))
            except _NATS_PUBLISH_ERRORS as exc:  # pragma: no cover - nats optional
                raise TransportUnavailableError("NATS backend is unavailable") from exc
            logger.debug("Published realtime payload via NATS", extra={"subject": subject})
            return
        raise TransportUnavailableError(f"Unsupported backend '{target}'")

    # ------------------------------------------------------------------
    # Subscription helpers
    # ------------------------------------------------------------------
    async def subscribe(
        self,
        topic: str,
        handler: MessageHandler,
        *,
        backend: str | None = None,
    ) -> Subscription:
        target = backend or self._default_backend()
        if target == "redis":
            if self._redis is None:
                raise TransportUnavailableError("Redis backend is not configured")
            channel = self._redis_channel(topic)
            pubsub = self._redis.pubsub()
            await pubsub.subscribe(channel)

            async def reader() -> None:
                try:
                    async for message in pubsub.listen():
                        if message.get("type") != "message":
                            continue
                        raw = message.get("data")
                        if not isinstance(raw, str):
                            continue
                        try:
                            payload = json.loads(raw)
                        except json.JSONDecodeError:
                            logger.warning("Discarded malformed realtime payload", extra={"channel": channel})
                            continue
                        await handler(payload)
                finally:
                    await pubsub.unsubscribe(channel)
                    await pubsub.close()

            task = asyncio.create_task(reader(), name=f"realtime-redis-{channel}")

            async def cleanup() -> None:
                if not task.done():
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task

            subscription = Subscription(channel, cleanup, task)
            self._redis_subscriptions.append(subscription)
            return subscription

        if target == "nats":
            if self._nats is None:
                raise TransportUnavailableError(
                    "NATS backend is unavailable (install the 'nats-py' package to enable it)"
                )
            if not self._nats.is_connected:
                raise TransportUnavailableError("NATS backend is not configured")
            subject = self._nats_subject(topic)

            async def callback(message: NatsMessage) -> None:  # pragma: no cover - nats optional
                raw = message.data.decode("utf-8") if isinstance(message.data, (bytes, bytearray)) else message.data
                if not isinstance(raw, str):
                    return
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning(
                        "Discarded malformed realtime payload", extra={"subject": subject}
                    )
                    return
                await handler(payload)

            subscription = await self._nats.subscribe(subject, cb=callback)

            async def cleanup() -> None:
                await subscription.unsubscribe()

            wrapper = Subscription(subject, cleanup, None)
            self._nats_subscriptions.append(wrapper)
            return wrapper

        raise TransportUnavailableError(f"Unsupported backend '{target}'")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _default_backend(self) -> str:
        if self._redis is not None:
            return "redis"
        if self._nats is not None and self._nats.is_connected:
            return "nats"
        raise TransportUnavailableError("No realtime backend is configured")


# Convenience topic names used throughout the realtime managers
PRESENCE_TOPIC = "presence"
TYPING_TOPIC = "typing"
VOICE_TOPIC = "voice"
