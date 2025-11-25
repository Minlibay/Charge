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


try:  # pragma: no cover - metrics are optional when running without the app package
    from app.monitoring.metrics import realtime_transport_restarts_total
except Exception:  # pragma: no cover - fallback when metrics registry is unavailable
    realtime_transport_restarts_total = None  # type: ignore[assignment]


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


@dataclass(slots=True)
class _RedisSubscriptionState:
    """Internal bookkeeping for Redis subscriptions."""

    topic: str
    channel: str
    handler: MessageHandler
    subscription: Subscription | None = None
    task: asyncio.Task[Any] | None = None
    pubsub: Any | None = None
    active: bool = True
    suspending: bool = False


_REDIS_RECOVERY_BASE_DELAY = 0.5
_REDIS_RECOVERY_MAX_DELAY = 30.0


class RedisNATSTransport:
    """Simple pub/sub helper built on top of Redis and optionally NATS."""

    def __init__(self, config: BrokerConfig) -> None:
        self._config = config
        self._redis: RedisClient | None = None
        self._redis_states: list[_RedisSubscriptionState] = []
        self._redis_recovery_lock = asyncio.Lock()
        self._redis_recovery_task: asyncio.Task[Any] | None = None
        self._nats: nats.aio.client.Client | None = None if nats is None else nats.aio.client.Client()
        self._nats_subscriptions: list[Subscription] = []
        self._started = False
        self._redis_warning_logged = False
        self._nats_warning_logged = False

    @property
    def node_id(self) -> str | None:
        return self._config.node_id

    async def start(self) -> None:
        if self._config.redis_url:
            if redis_asyncio is None:
                if not self._redis_warning_logged:
                    logger.info(
                        "Redis realtime URL configured but 'redis' is not installed; "
                        "install the Poetry 'realtime' dependency group to enable it",
                    )
                    self._redis_warning_logged = True
            elif self._redis is None:
                await self._connect_redis()
        if self._config.nats_url and nats is not None:
            if self._nats is None:
                self._nats = nats.aio.client.Client()
            if not self._nats.is_connected:
                try:
                    await self._nats.connect(self._config.nats_url, name=self._config.node_id)
                except Exception:  # pragma: no cover - connection errors are not deterministic
                    logger.exception("Failed to connect to NATS realtime backend")
                    raise
        elif self._config.nats_url and nats is None:
            if not self._nats_warning_logged:
                logger.info(
                    "NATS realtime URL configured but 'nats-py' is not installed; skipping NATS transport"
                )
                self._nats_warning_logged = True
        self._started = self._redis is not None or (
            self._nats is not None and self._nats.is_connected
        )

    async def stop(self) -> None:
        for state in list(self._redis_states):
            if state.subscription is not None:
                await state.subscription.close()
        self._redis_states.clear()
        if self._redis_recovery_task is not None:
            self._redis_recovery_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._redis_recovery_task
            self._redis_recovery_task = None
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
    async def _connect_redis(self) -> None:
        if self._config.redis_url is None or redis_asyncio is None:
            return
        client = redis_asyncio.from_url(
            self._config.redis_url,
            encoding="utf-8",
            decode_responses=True,
        )
        try:
            await client.ping()
        except OSError:
            logger.exception("Failed to connect to Redis realtime backend")
            await client.close()
            raise
        self._redis = client

    async def _pause_redis_state(self, state: _RedisSubscriptionState) -> None:
        state.suspending = True
        task = state.task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        state.task = None
        pubsub = state.pubsub
        if pubsub is not None:
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe(state.channel)
            with contextlib.suppress(Exception):
                await pubsub.close()
        state.pubsub = None
        state.suspending = False

    async def _close_redis_state(self, state: _RedisSubscriptionState) -> None:
        state.active = False
        await self._pause_redis_state(state)
        if state in self._redis_states:
            self._redis_states.remove(state)

    async def _restart_redis(self, reason: str) -> None:
        if self._config.redis_url is None or redis_asyncio is None:
            return
        async with self._redis_recovery_lock:
            for state in list(self._redis_states):
                await self._pause_redis_state(state)
            if self._redis is not None:
                with contextlib.suppress(Exception):
                    await self._redis.close()
                self._redis = None
            await self.start()
            attach_states = [state for state in self._redis_states if state.active]
            for state in attach_states:
                try:
                    await self._attach_redis_reader(state)
                except Exception:
                    logger.exception(
                        "Failed to restore Redis subscription", extra={"channel": state.channel}
                    )
                    raise

        if realtime_transport_restarts_total is not None:
            realtime_transport_restarts_total.labels("redis", reason).inc()
        logger.info(
            "Redis realtime backend recovered", extra={"reason": reason, "subscriptions": len(self._redis_states)}
        )

    async def _attach_redis_reader(self, state: _RedisSubscriptionState) -> None:
        if self._redis is None:
            raise TransportUnavailableError("Redis backend is not configured")
        pubsub = self._redis.pubsub()
        try:
            await pubsub.subscribe(state.channel)
        except _REDIS_PUBLISH_ERRORS as exc:
            await pubsub.close()
            raise TransportUnavailableError("Redis backend is unavailable") from exc
        state.pubsub = pubsub

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
                        logger.warning(
                            "Discarded malformed realtime payload", extra={"channel": state.channel}
                        )
                        continue
                    await state.handler(payload)
            finally:
                with contextlib.suppress(Exception):
                    await pubsub.unsubscribe(state.channel)
                with contextlib.suppress(Exception):
                    await pubsub.close()

        task = asyncio.create_task(reader(), name=f"realtime-redis-{state.channel}")
        state.task = task
        if state.subscription is not None:
            state.subscription._task = task
        task.add_done_callback(
            lambda finished: asyncio.create_task(self._on_redis_reader_done(state, finished))
        )

    async def _on_redis_reader_done(
        self, state: _RedisSubscriptionState, task: asyncio.Task[Any]
    ) -> None:
        state.task = None
        state.pubsub = None
        if not state.active or state.suspending:
            return
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.warning(
                "Redis subscription reader stopped due to error; scheduling recovery",
                exc_info=exc,
                extra={"channel": state.channel},
            )
        else:
            logger.warning(
                "Redis subscription reader exited unexpectedly; scheduling recovery",
                extra={"channel": state.channel},
            )
        self._trigger_redis_recovery("reader_stopped")

    def _trigger_redis_recovery(self, reason: str) -> None:
        if self._config.redis_url is None or redis_asyncio is None:
            return
        if self._redis_recovery_task is not None and not self._redis_recovery_task.done():
            return
        logger.info("Scheduling Redis realtime recovery", extra={"reason": reason})
        self._redis_recovery_task = asyncio.create_task(
            self._redis_recovery_runner(reason), name="realtime-redis-recovery"
        )

    async def _redis_recovery_runner(self, reason: str) -> None:
        attempt = 0
        while True:
            delay = min(_REDIS_RECOVERY_BASE_DELAY * (2**attempt), _REDIS_RECOVERY_MAX_DELAY)
            if delay:
                await asyncio.sleep(delay)
            try:
                await self._restart_redis(reason)
            except Exception:
                attempt += 1
                logger.exception(
                    "Redis realtime recovery attempt failed",
                    extra={"attempt": attempt, "reason": reason},
                )
                continue
            break
        self._redis_recovery_task = None

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
                await self.start()
            if self._redis is None:
                raise TransportUnavailableError("Redis backend is not configured")
            channel = self._redis_channel(topic)
            try:
                await self._redis.publish(channel, encoded)
            except _REDIS_PUBLISH_ERRORS as exc:
                self._trigger_redis_recovery("publish_failed")
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
                await self.start()
            if self._redis is None:
                raise TransportUnavailableError("Redis backend is not configured")
            channel = self._redis_channel(topic)
            state = _RedisSubscriptionState(topic=topic, channel=channel, handler=handler)

            async def cleanup() -> None:
                await self._close_redis_state(state)

            subscription = Subscription(channel, cleanup, None)
            state.subscription = subscription
            self._redis_states.append(state)
            try:
                await self._attach_redis_reader(state)
            except Exception as exc:
                await self._close_redis_state(state)
                self._trigger_redis_recovery("subscribe_failed")
                if isinstance(exc, TransportUnavailableError):
                    raise
                raise TransportUnavailableError("Redis backend is unavailable") from exc
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
