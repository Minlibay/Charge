"""Security helpers for password hashing and token management."""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

import jwt
from fastapi import HTTPException, Response, status
from passlib.context import CryptContext

from app.config import get_settings
from app.services import get_cache

settings = get_settings()

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


@dataclass(slots=True)
class RefreshTokenData:
    """Structured data extracted from a stored refresh token."""

    token_id: str
    subject: str
    remember_me: bool
    expires_at: datetime


class RefreshTokenError(Exception):
    """Raised when a refresh token cannot be validated."""


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain password against its hashed counterpart."""

    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """Hash a password for storing in the database."""

    return pwd_context.hash(password)


def create_access_token(data: Dict[str, Any], expires_delta: timedelta | None = None) -> str:
    """Create a signed JWT access token with an expiration time."""

    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta if expires_delta is not None else timedelta(minutes=settings.access_token_expire_minutes)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> Dict[str, Any]:
    """Decode and validate a JWT access token."""

    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError as exc:  # pragma: no cover - simple error mapping
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token has expired") from exc
    except jwt.InvalidTokenError as exc:  # pragma: no cover - simple error mapping
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Could not validate credentials") from exc
    return payload


def _refresh_cache_key(token_id: str) -> str:
    prefix = settings.refresh_token_cookie_name.replace(" ", "").lower() or "refresh_token"
    return f"auth:{prefix}:{token_id}"


def _refresh_token_lifetime(remember_me: bool) -> timedelta:
    if remember_me and settings.remember_me_enabled:
        minutes = settings.refresh_token_remember_me_expire_minutes
    else:
        minutes = settings.refresh_token_expire_minutes
    minutes = max(int(minutes), 1)
    return timedelta(minutes=minutes)


def _hash_refresh_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def create_refresh_token(subject: str, remember_me: bool = False) -> tuple[str, int]:
    """Generate and persist a refresh token bound to a subject."""

    remember = bool(remember_me and settings.remember_me_enabled)
    token_id = secrets.token_urlsafe(16)
    token_secret = secrets.token_urlsafe(32)
    token_hash = _hash_refresh_secret(token_secret)
    lifetime = _refresh_token_lifetime(remember)
    expires_at = datetime.now(timezone.utc) + lifetime

    payload = {
        "sub": subject,
        "hash": token_hash,
        "exp": int(expires_at.timestamp()),
        "remember_me": remember,
    }

    cache = get_cache()
    cache.set(_refresh_cache_key(token_id), json.dumps(payload), int(lifetime.total_seconds()))

    return f"{token_id}.{token_secret}", int(lifetime.total_seconds())


def validate_refresh_token(token: str, *, revoke: bool = False) -> RefreshTokenData:
    """Validate a refresh token and optionally revoke it."""

    parts = token.split(".", 1)
    if len(parts) != 2:
        raise RefreshTokenError("Malformed refresh token")
    token_id, token_secret = parts
    cache_key = _refresh_cache_key(token_id)
    cache = get_cache()
    cached = cache.get(cache_key)
    if cached is None:
        raise RefreshTokenError("Refresh token not found")

    try:
        payload = json.loads(cached)
    except json.JSONDecodeError as exc:  # pragma: no cover - defensive
        cache.delete(cache_key)
        raise RefreshTokenError("Corrupted refresh token payload") from exc

    expected_hash = payload.get("hash")
    if not expected_hash:
        cache.delete(cache_key)
        raise RefreshTokenError("Refresh token is missing signature")

    actual_hash = _hash_refresh_secret(token_secret)
    if not secrets.compare_digest(expected_hash, actual_hash):
        cache.delete(cache_key)
        raise RefreshTokenError("Refresh token signature mismatch")

    exp_timestamp = payload.get("exp")
    if not isinstance(exp_timestamp, (int, float)):
        cache.delete(cache_key)
        raise RefreshTokenError("Refresh token is missing expiration")

    expires_at = datetime.fromtimestamp(exp_timestamp, tz=timezone.utc)
    if expires_at <= datetime.now(timezone.utc):
        cache.delete(cache_key)
        raise RefreshTokenError("Refresh token expired")

    if revoke:
        cache.delete(cache_key)

    subject = str(payload.get("sub"))
    remember = bool(payload.get("remember_me"))
    return RefreshTokenData(token_id=token_id, subject=subject, remember_me=remember, expires_at=expires_at)


def set_refresh_cookie(response: Response, token: str, ttl_seconds: int) -> None:
    """Attach the refresh token to an HTTP-only cookie."""

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=max(ttl_seconds, 1))
    response.set_cookie(
        key=settings.refresh_token_cookie_name,
        value=token,
        max_age=ttl_seconds,
        expires=expires_at,
        httponly=True,
        secure=settings.refresh_token_cookie_secure,
        samesite=settings.refresh_token_cookie_samesite,
        path=settings.refresh_token_cookie_path,
        domain=settings.refresh_token_cookie_domain,
    )


def clear_refresh_cookie(response: Response) -> None:
    """Clear the refresh token cookie from the client."""

    response.delete_cookie(
        key=settings.refresh_token_cookie_name,
        path=settings.refresh_token_cookie_path,
        domain=settings.refresh_token_cookie_domain,
    )
