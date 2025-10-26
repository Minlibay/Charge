"""Utility helpers for working with slugs."""

from __future__ import annotations

import re
import secrets
import unicodedata
from typing import Callable

MAX_SLUG_LENGTH = 64


def _normalize(value: str) -> str:
    """Normalize and clean up the raw value prior to slugification."""

    normalized = unicodedata.normalize("NFKC", value).strip()
    if not normalized:
        return ""
    lowered = normalized.casefold()
    slug = re.sub(r"[^\w]+", "-", lowered, flags=re.UNICODE)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug


def generate_slug(value: str) -> str:
    """Generate a URL-friendly slug based on the provided value."""

    base_slug = _normalize(value)
    if not base_slug:
        base_slug = secrets.token_hex(4)
    if len(base_slug) > MAX_SLUG_LENGTH:
        base_slug = base_slug[:MAX_SLUG_LENGTH].rstrip("-")
    base_slug = base_slug or secrets.token_hex(4)
    return base_slug


def unique_slug(value: str, exists: Callable[[str], bool]) -> str:
    """Generate a unique slug using the provided existence callback."""

    base_slug = generate_slug(value)
    slug = base_slug
    counter = 2

    while exists(slug):
        suffix = f"-{counter}"
        allowed_length = max(1, MAX_SLUG_LENGTH - len(suffix))
        base_part = base_slug[:allowed_length].rstrip("-")
        if not base_part:
            base_part = base_slug[:allowed_length] or base_slug[:1]
        slug = f"{base_part}{suffix}"
        if len(slug) > MAX_SLUG_LENGTH:
            slug = slug[:MAX_SLUG_LENGTH].rstrip("-") or slug[:MAX_SLUG_LENGTH]
        counter += 1

    return slug
