"""Lightweight cache abstraction for authentication flows."""

from __future__ import annotations

import threading
import time
from functools import lru_cache
from typing import Protocol

try:  # pragma: no cover - redis is optional in some deployments
    from redis import Redis
except ImportError:  # pragma: no cover - gracefully degrade when redis is unavailable
    Redis = None  # type: ignore[misc, assignment]

from app.config import get_settings


class CacheBackend(Protocol):
    """Protocol describing cache operations we rely on."""

    def set(self, key: str, value: str, ttl_seconds: int) -> None:
        """Store a key/value pair with a time-to-live in seconds."""

    def get(self, key: str) -> str | None:
        """Retrieve a cached value if it exists and has not expired."""

    def delete(self, key: str) -> None:
        """Remove a cached entry, ignoring missing values."""


class _InMemoryCache:
    """Fallback cache implementation used when Redis is not available."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[str, float | None]] = {}
        self._lock = threading.Lock()

    def set(self, key: str, value: str, ttl_seconds: int) -> None:
        expires_at: float | None = None
        if ttl_seconds > 0:
            expires_at = time.time() + ttl_seconds
        with self._lock:
            self._store[key] = (value, expires_at)

    def get(self, key: str) -> str | None:
        with self._lock:
            entry = self._store.get(key)
            if not entry:
                return None
            value, expires_at = entry
            if expires_at is not None and expires_at <= time.time():
                self._store.pop(key, None)
                return None
            return value

    def delete(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)


class _RedisCache:
    """Thin Redis wrapper adhering to :class:`CacheBackend`."""

    def __init__(self, url: str) -> None:
        if Redis is None:  # pragma: no cover - should not happen when redis is installed
            raise RuntimeError("Redis support is not available")
        self._client = Redis.from_url(url, decode_responses=True)

    def set(self, key: str, value: str, ttl_seconds: int) -> None:
        if ttl_seconds > 0:
            self._client.setex(key, ttl_seconds, value)
        else:
            self._client.set(key, value)

    def get(self, key: str) -> str | None:
        return self._client.get(key)

    def delete(self, key: str) -> None:
        self._client.delete(key)


@lru_cache(maxsize=1)
def get_cache() -> CacheBackend:
    """Return the configured cache backend, defaulting to Redis when available."""

    settings = get_settings()
    cache_url = settings.auth_cache_url or settings.realtime_redis_url
    if cache_url and Redis is not None:
        try:
            return _RedisCache(cache_url)
        except Exception:  # pragma: no cover - fallback path when Redis misbehaves
            pass
    return _InMemoryCache()
