"""Integration tests exercising API endpoints via FastAPI's TestClient."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.models import Message, RoomMember, RoomRole


def register_user(
    client: TestClient,
    login: str,
    password: str,
    display_name: str = "Test",
) -> dict[str, Any]:
    response = client.post(
        "/api/auth/register",
        json={"login": login, "password": password, "display_name": display_name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def login_user(client: TestClient, login: str, password: str) -> str:
    response = client.post(
        "/api/auth/login",
        json={"login": login, "password": password},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    return body["access_token"]


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_register_and_login_flow(client: TestClient):
    """End-to-end flow for registering and logging in a user."""

    payload = {"login": "alice", "password": "wonderland", "display_name": "Alice"}
    response = client.post("/api/auth/register", json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["login"] == "alice"

    login_response = client.post(
        "/api/auth/login", json={"login": "alice", "password": "wonderland"}
    )
    assert login_response.status_code == 200
    token_data = login_response.json()
    assert token_data["token_type"] == "bearer"
    assert isinstance(token_data["access_token"], str)


def test_room_access_controls_and_history(client: TestClient, session_factory):
    """Creating rooms and channels requires membership, and history respects permissions."""

    owner = register_user(client, "owner", "ownerpassword", "Owner")
    owner_token = login_user(client, "owner", "ownerpassword")

    response = client.post(
        "/api/rooms",
        json={"title": "Strategy"},
        headers=auth_headers(owner_token),
    )
    assert response.status_code == 201
    room = response.json()
    slug = room["slug"]

    response = client.post(
        f"/api/rooms/{slug}/channels",
        json={"name": "General", "type": "text"},
        headers=auth_headers(owner_token),
    )
    assert response.status_code == 201
    channel = response.json()

    # Seed a message directly through the session factory
    session = session_factory()
    try:
        session.add(
            Message(
                channel_id=channel["id"],
                author_id=owner["id"],
                content="Hello team!",
            )
        )
        session.commit()
    finally:
        session.close()

    history_response = client.get(
        f"/api/channels/{channel['id']}/history",
        headers=auth_headers(owner_token),
    )
    assert history_response.status_code == 200
    history = history_response.json()
    assert len(history) == 1
    assert history[0]["content"] == "Hello team!"

    outsider = register_user(client, "outsider", "outsiderpassword", "Outsider")
    outsider_token = login_user(client, "outsider", "outsiderpassword")

    room_response = client.get(f"/api/rooms/{slug}", headers=auth_headers(outsider_token))
    assert room_response.status_code == 403

    # Promote outsider to admin to verify elevated permissions
    session = session_factory()
    try:
        session.add(
            RoomMember(
                room_id=room["id"],
                user_id=outsider["id"],
                role=RoomRole.ADMIN,
            )
        )
        session.commit()
    finally:
        session.close()

    channel_response = client.post(
        f"/api/rooms/{slug}/channels",
        json={"name": "Voice", "type": "voice"},
        headers=auth_headers(outsider_token),
    )
    assert channel_response.status_code == 201


def test_cors_allows_configured_origin(client: TestClient):
    """CORS middleware should echo allowed origins on preflight requests."""

    response = client.options(
        "/health",
        headers={
            "Origin": "http://localhost:3000/",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000/"
