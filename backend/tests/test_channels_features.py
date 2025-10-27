"""Tests for advanced channel features: attachments, reactions, and search."""

from __future__ import annotations

import io
import io
from datetime import datetime, timedelta, timezone
from typing import Dict, Tuple

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.models import Message, MessageAttachment, RoomMember, RoomRole


Headers = Dict[str, str]
RoomChannel = Tuple[dict[str, object], dict[str, object]]


def _register_user(client: TestClient, login: str) -> dict[str, object]:
    response = client.post(
        "/api/auth/register",
        json={"login": login, "password": "secret123", "display_name": login.title()},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _login_user(client: TestClient, login: str) -> str:
    response = client.post(
        "/api/auth/login",
        json={"login": login, "password": "secret123"},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def _auth_headers(token: str) -> Headers:
    return {"Authorization": f"Bearer {token}"}


def _create_room_and_channel(client: TestClient, token: str) -> RoomChannel:
    room_response = client.post("/api/rooms", json={"title": "Project"}, headers=_auth_headers(token))
    assert room_response.status_code == 201, room_response.text
    room = room_response.json()

    channel_response = client.post(
        f"/api/rooms/{room['slug']}/channels",
        json={"name": "general", "type": "text"},
        headers=_auth_headers(token),
    )
    assert channel_response.status_code == 201, channel_response.text
    channel = channel_response.json()
    return room, channel


@pytest.mark.parametrize("content_type, preview_expected", [("text/plain", None), ("image/png", "non-null")])
def test_attachment_upload_and_download_flow(
    client: TestClient, tmp_path, content_type: str, preview_expected: str | None
) -> None:
    """Uploading an attachment should persist the file and allow downloading it."""

    user = _register_user(client, f"u_{content_type.replace('/', '_')}")
    token = _login_user(client, user["login"])
    _, channel = _create_room_and_channel(client, token)

    settings = get_settings()
    original_root = settings.media_root
    original_max_size = settings.max_upload_size
    try:
        settings.media_root = tmp_path
        settings.max_upload_size = 1024 * 1024

        payload = io.BytesIO(b"hello world")
        files = {"file": ("greeting.bin", payload, content_type)}
        response = client.post(
            f"/api/channels/{channel['id']}/attachments",
            files=files,
            headers=_auth_headers(token),
        )
        assert response.status_code == 201, response.text
        data = response.json()
        assert data["channel_id"] == channel["id"]
        assert data["uploaded_by"] == user["id"]
        assert data["file_name"] == "greeting.bin"
        if preview_expected:
            assert data["preview_url"] == data["download_url"]
        else:
            assert data["preview_url"] is None

        stored_dir = tmp_path / f"channel_{channel['id']}"
        stored_files = list(stored_dir.glob("*"))
        assert stored_files, "Expected stored file for attachment"

        download = client.get(
            f"/api/channels/{channel['id']}/attachments/{data['id']}/download",
            headers=_auth_headers(token),
        )
        assert download.status_code == 200, download.text
        assert download.content == b"hello world"
        assert download.headers["content-type"] == content_type
    finally:
        settings.media_root = original_root
        settings.max_upload_size = original_max_size


def test_reaction_toggle_flow(client: TestClient, session_factory) -> None:
    """Users can add and remove reactions, with duplicate adds rejected."""

    user = _register_user(client, "reactor")
    token = _login_user(client, user["login"])
    _, channel = _create_room_and_channel(client, token)

    session = session_factory()
    try:
        message = Message(channel_id=channel["id"], author_id=user["id"], content="Hello team")
        session.add(message)
        session.commit()
        session.refresh(message)
    finally:
        session.close()

    reaction_response = client.post(
        f"/api/channels/{channel['id']}/messages/{message.id}/reactions",
        json={"emoji": "🔥"},
        headers=_auth_headers(token),
    )
    assert reaction_response.status_code == 201, reaction_response.text
    body = reaction_response.json()
    assert body["author_id"] == user["id"]
    assert body["author"]["login"] == user["login"]
    assert body["deleted_at"] is None
    assert body["moderated_at"] is None
    assert body["edited_at"] is None
    assert "updated_at" in body
    assert body["delivered_count"] == 0
    assert body["read_count"] == 0
    assert body["reactions"] == [
        {
            "emoji": "🔥",
            "count": 1,
            "reacted": True,
            "user_ids": [user["id"]],
        }
    ]

    duplicate = client.post(
        f"/api/channels/{channel['id']}/messages/{message.id}/reactions",
        json={"emoji": "🔥"},
        headers=_auth_headers(token),
    )
    assert duplicate.status_code == 409

    removed = client.delete(
        f"/api/channels/{channel['id']}/messages/{message.id}/reactions",
        params={"emoji": "🔥"},
        headers=_auth_headers(token),
    )
    assert removed.status_code == 200, removed.text
    removed_body = removed.json()
    assert removed_body["author_id"] == user["id"]
    assert removed_body["reactions"] == []
    assert removed_body["delivered_count"] == 0
    assert removed_body["read_count"] == 0


def test_search_filters_by_text_dates_and_attachments(client: TestClient, session_factory) -> None:
    """Search endpoint supports text matching, date ranges, and attachment filters."""

    user = _register_user(client, "searcher")
    token = _login_user(client, user["login"])
    _, channel = _create_room_and_channel(client, token)

    session = session_factory()
    try:
        now = datetime.now(timezone.utc).replace(microsecond=0)
        root = Message(
            channel_id=channel["id"],
            author_id=user["id"],
            content="Quarterly report",
            created_at=now,
        )
        session.add(root)
        session.commit()
        session.refresh(root)

        attachment = MessageAttachment(
            channel_id=channel["id"],
            message_id=root.id,
            uploader_id=user["id"],
            file_name="report.pdf",
            content_type="application/pdf",
            file_size=128,
            storage_path="dummy/report.pdf",
        )
        reply = Message(
            channel_id=channel["id"],
            author_id=user["id"],
            content="Follow-up actions",
            parent_id=root.id,
            thread_root_id=root.id,
            created_at=now + timedelta(minutes=1),
        )
        other = Message(
            channel_id=channel["id"],
            author_id=user["id"],
            content="General discussion",
            created_at=now + timedelta(minutes=2),
        )
    session.add_all([attachment, reply, other])
    session.commit()
    session.refresh(reply)
        session.refresh(other)
    finally:
        session.close()

    with_attachments = client.get(
        f"/api/channels/{channel['id']}/search",
        params={"has_attachments": True},
        headers=_auth_headers(token),
    )
    assert with_attachments.status_code == 200, with_attachments.text
    results = with_attachments.json()
    assert [item["id"] for item in results] == [root.id]
    assert results[0]["attachments"]

    text_match = client.get(
        f"/api/channels/{channel['id']}/search",
        params={"query": "discussion"},
        headers=_auth_headers(token),
    )
    assert text_match.status_code == 200
    assert [item["id"] for item in text_match.json()] == [other.id]

    start_range = (now + timedelta(seconds=30)).isoformat()
    end_range = (now + timedelta(minutes=3)).isoformat()
    ranged = client.get(
        f"/api/channels/{channel['id']}/search",
        params={"start": start_range, "end": end_range},
        headers=_auth_headers(token),
    )
    assert ranged.status_code == 200
    assert {item["id"] for item in ranged.json()} == {reply.id, other.id}

    thread_results = client.get(
        f"/api/channels/{channel['id']}/search",
        params={"thread_root_id": root.id},
        headers=_auth_headers(token),
    )
    assert thread_results.status_code == 200
    assert {item["id"] for item in thread_results.json()} == {root.id, reply.id}


def test_message_receipts_update_counts(client: TestClient, session_factory) -> None:
    """Delivery and read receipts should update per-user counters."""

    sender = _register_user(client, "sender")
    sender_token = _login_user(client, sender["login"])
    room, channel = _create_room_and_channel(client, sender_token)

    reader = _register_user(client, "reader")
    reader_token = _login_user(client, reader["login"])
    observer = _register_user(client, "observer")
    observer_token = _login_user(client, observer["login"])

    session = session_factory()
    try:
        session.add_all(
            [
                RoomMember(room_id=room["id"], user_id=reader["id"], role=RoomRole.MEMBER),
                RoomMember(room_id=room["id"], user_id=observer["id"], role=RoomRole.MEMBER),
            ]
        )
        message = Message(
            channel_id=channel["id"],
            author_id=sender["id"],
            content="Release checklist",
        )
        session.add(message)
        session.commit()
        session.refresh(message)
    finally:
        session.close()

    delivered = client.post(
        f"/api/channels/{channel['id']}/messages/{message.id}/receipts",
        json={"delivered": True},
        headers=_auth_headers(reader_token),
    )
    assert delivered.status_code == 200, delivered.text
    delivered_body = delivered.json()
    assert delivered_body["delivered_count"] == 1
    assert delivered_body["read_count"] == 0
    assert delivered_body["delivered_at"] is not None
    assert delivered_body["read_at"] is None

    read_response = client.post(
        f"/api/channels/{channel['id']}/messages/{message.id}/receipts",
        json={"read": True},
        headers=_auth_headers(reader_token),
    )
    assert read_response.status_code == 200, read_response.text
    read_body = read_response.json()
    assert read_body["delivered_count"] == 1
    assert read_body["read_count"] == 1
    assert read_body["read_at"] is not None

    observer_receipt = client.post(
        f"/api/channels/{channel['id']}/messages/{message.id}/receipts",
        json={"delivered": True},
        headers=_auth_headers(observer_token),
    )
    assert observer_receipt.status_code == 200, observer_receipt.text
    observer_body = observer_receipt.json()
    assert observer_body["delivered_count"] == 2
    assert observer_body["read_count"] == 1
    assert observer_body["delivered_at"] is not None
    assert observer_body["read_at"] is None

    # Repeating the update should not change aggregate counts.
    repeat = client.post(
        f"/api/channels/{channel['id']}/messages/{message.id}/receipts",
        json={"delivered": True, "read": True},
        headers=_auth_headers(observer_token),
    )
    assert repeat.status_code == 200, repeat.text
    repeat_body = repeat.json()
    assert repeat_body["delivered_count"] == 2
    assert repeat_body["read_count"] == 2


def test_message_crud_flow(client: TestClient, session_factory, tmp_path) -> None:
    """Creating, editing, deleting and moderating messages works via the HTTP API."""

    user = _register_user(client, "messenger")
    token = _login_user(client, user["login"])
    _, channel = _create_room_and_channel(client, token)

    settings = get_settings()
    original_root = settings.media_root
    original_max = settings.max_upload_size
    try:
        settings.media_root = tmp_path
        settings.max_upload_size = 1024 * 1024

        files = [("files", ("hello.png", io.BytesIO(b"\x89PNG"), "image/png"))]
        response = client.post(
            "/api/messages",
            data={"channel_id": str(channel["id"]), "content": "Hello world"},
            files=files,
            headers=_auth_headers(token),
        )
        assert response.status_code == 201, response.text
        created = response.json()
        assert created["author"]["login"] == user["login"]
        assert created["attachments"]
        assert created["attachments"][0]["preview_url"] == created["attachments"][0]["download_url"]

        message_id = created["id"]

        updated = client.patch(
            f"/api/messages/{message_id}",
            json={"content": "Updated text"},
            headers=_auth_headers(token),
        )
        assert updated.status_code == 200, updated.text
        updated_body = updated.json()
        assert updated_body["content"] == "Updated text"
        assert updated_body["edited_at"] is not None

        deleted = client.delete(
            f"/api/messages/{message_id}",
            headers=_auth_headers(token),
        )
        assert deleted.status_code == 200, deleted.text
        deleted_body = deleted.json()
        assert deleted_body["deleted_at"] is not None

        other = client.post(
            "/api/messages",
            data={"channel_id": str(channel["id"]), "content": "Needs review"},
            headers=_auth_headers(token),
        )
        assert other.status_code == 201, other.text
        other_id = other.json()["id"]

        moderated = client.post(
            f"/api/messages/{other_id}/moderate",
            json={"action": "suppress", "note": "spam"},
            headers=_auth_headers(token),
        )
        assert moderated.status_code == 200, moderated.text
        moderated_body = moderated.json()
        assert moderated_body["moderated_at"] is not None
        assert moderated_body["moderated_by"]["id"] == user["id"]
        assert moderated_body["moderation_note"] == "spam"

        restored = client.post(
            f"/api/messages/{other_id}/moderate",
            json={"action": "restore"},
            headers=_auth_headers(token),
        )
        assert restored.status_code == 200, restored.text
        restored_body = restored.json()
        assert restored_body["moderated_at"] is None
        assert restored_body["moderation_note"] is None
    finally:
        settings.media_root = original_root
        settings.max_upload_size = original_max
