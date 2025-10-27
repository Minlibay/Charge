"""Utilities for storing uploaded files for attachments."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final
from uuid import uuid4

from fastapi import HTTPException, UploadFile, status

from app.config import get_settings

settings = get_settings()

_CHUNK_SIZE: Final[int] = 1024 * 1024  # 1 MiB


@dataclass(slots=True)
class StoredFile:
    """Represents a file persisted by the storage backend."""

    file_name: str
    content_type: str | None
    file_size: int
    absolute_path: Path
    relative_path: str


def _media_root() -> Path:
    root = settings.media_root
    root.mkdir(parents=True, exist_ok=True)
    return root


async def store_upload(channel_id: int, upload: UploadFile) -> StoredFile:
    """Persist an uploaded file and return its storage metadata."""

    target_dir = _media_root() / f"channel_{channel_id}"
    target_dir.mkdir(parents=True, exist_ok=True)

    original_name = upload.filename or "upload.bin"
    extension = Path(original_name).suffix
    file_name = f"{uuid4().hex}{extension}"
    absolute_path = target_dir / file_name

    total_size = 0
    try:
        with absolute_path.open("wb") as buffer:
            while True:
                chunk = await upload.read(_CHUNK_SIZE)
                if not chunk:
                    break
                total_size += len(chunk)
                if total_size > settings.max_upload_size:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="Attachment exceeds allowed size",
                    )
                buffer.write(chunk)
    except HTTPException:
        if absolute_path.exists():
            absolute_path.unlink()
        raise
    finally:
        await upload.close()

    relative_path = os.path.relpath(absolute_path, _media_root())
    return StoredFile(
        file_name=original_name,
        content_type=upload.content_type,
        file_size=total_size,
        absolute_path=absolute_path,
        relative_path=relative_path,
    )


async def store_user_avatar(user_id: int, upload: UploadFile) -> StoredFile:
    """Persist a user avatar image, replacing any previous upload."""

    if upload.content_type and not upload.content_type.startswith("image/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Avatar must be an image file",
        )

    target_dir = _media_root() / "avatars" / f"user_{user_id}"
    target_dir.mkdir(parents=True, exist_ok=True)

    # Remove previous avatar files to avoid stale data lingering on disk.
    for existing in target_dir.iterdir():
        if existing.is_file():
            try:
                existing.unlink()
            except OSError:
                continue

    original_name = upload.filename or "avatar.png"
    extension = Path(original_name).suffix or ".png"
    file_name = f"avatar{extension}"
    absolute_path = target_dir / file_name

    total_size = 0
    try:
        with absolute_path.open("wb") as buffer:
            while True:
                chunk = await upload.read(_CHUNK_SIZE)
                if not chunk:
                    break
                total_size += len(chunk)
                if total_size > settings.max_upload_size:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail="Avatar exceeds allowed size",
                    )
                buffer.write(chunk)
    except HTTPException:
        if absolute_path.exists():
            absolute_path.unlink()
        raise
    finally:
        await upload.close()

    relative_path = os.path.relpath(absolute_path, _media_root())
    return StoredFile(
        file_name=original_name,
        content_type=upload.content_type,
        file_size=total_size,
        absolute_path=absolute_path,
        relative_path=relative_path,
    )


def resolve_path(relative_path: str) -> Path:
    """Return an absolute path for a stored file relative path."""

    candidate = (_media_root() / relative_path).resolve()
    if not candidate.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not str(candidate).startswith(str(_media_root().resolve())):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid file path")
    return candidate


def build_download_url(channel_id: int, attachment_id: int) -> str:
    """Construct a relative download URL for an attachment."""

    base = settings.media_base_url.rstrip("/")
    return f"{base}/{channel_id}/{attachment_id}/download"
