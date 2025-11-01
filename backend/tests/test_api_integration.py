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
    assert history["items"], history
    assert len(history["items"]) == 1
    message_payload = history["items"][0]
    assert message_payload["content"] == "Hello team!"
    assert message_payload["delivered_count"] == 0
    assert message_payload["read_count"] == 0

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


def _establish_friendship(
    client: TestClient,
    requester_token: str,
    target_login: str,
    target_token: str,
) -> int:
    request_response = client.post(
        "/api/dm/requests",
        json={"login": target_login},
        headers=auth_headers(requester_token),
    )
    assert request_response.status_code == 201, request_response.text
    payload = request_response.json()
    request_id = payload["id"]
    accept_response = client.post(
        f"/api/dm/requests/{request_id}/accept",
        headers=auth_headers(target_token),
    )
    assert accept_response.status_code == 200, accept_response.text
    return request_id


def test_direct_group_conversation_flow(client: TestClient):
    alice = register_user(client, "alice", "alicepass", "Alice")
    bob = register_user(client, "bob", "bobsecure", "Bob")
    carol = register_user(client, "carol", "carolpass", "Carol")

    alice_token = login_user(client, "alice", "alicepass")
    bob_token = login_user(client, "bob", "bobsecure")
    carol_token = login_user(client, "carol", "carolpass")

    _establish_friendship(client, alice_token, "bob", bob_token)
    _establish_friendship(client, alice_token, "carol", carol_token)

    direct_response = client.post(
        "/api/dm/conversations",
        json={"participant_ids": [bob["id"]]},
        headers=auth_headers(alice_token),
    )
    assert direct_response.status_code == 201, direct_response.text
    pair_conversation = direct_response.json()

    reuse_response = client.post(
        "/api/dm/conversations",
        json={"participant_ids": [bob["id"]]},
        headers=auth_headers(alice_token),
    )
    assert reuse_response.status_code == 201
    assert reuse_response.json()["id"] == pair_conversation["id"]

    create_response = client.post(
        "/api/dm/conversations",
        json={
            "participant_ids": [bob["id"], carol["id"]],
            "title": "Weekend Plans",
        },
        headers=auth_headers(alice_token),
    )
    assert create_response.status_code == 201, create_response.text
    conversation = create_response.json()
    assert conversation["is_group"] is True
    assert len(conversation["participants"]) == 3
    assert conversation["title"] == "Weekend Plans"

    list_response = client.get("/api/dm/conversations", headers=auth_headers(bob_token))
    assert list_response.status_code == 200
    bob_conversations = list_response.json()
    assert any(item["id"] == conversation["id"] for item in bob_conversations)

    message_response = client.post(
        f"/api/dm/conversations/{conversation['id']}/messages",
        json={"content": "Привет всем"},
        headers=auth_headers(alice_token),
    )
    assert message_response.status_code == 201, message_response.text
    message = message_response.json()
    assert message["content"] == "Привет всем"
    assert message["sender_id"] == alice["id"]

    history_response = client.get(
        f"/api/dm/conversations/{conversation['id']}/messages",
        headers=auth_headers(carol_token),
    )
    assert history_response.status_code == 200
    history = history_response.json()
    assert len(history) == 1
    assert history[0]["content"] == "Привет всем"

    note_payload = {"note": "Отвечу позже"}
    note_response = client.patch(
        f"/api/dm/conversations/{conversation['id']}/note",
        json=note_payload,
        headers=auth_headers(carol_token),
    )
    assert note_response.status_code == 200, note_response.text
    note_data = note_response.json()
    assert note_data["note"] == "Отвечу позже"

    refresh_response = client.get("/api/dm/conversations", headers=auth_headers(carol_token))
    assert refresh_response.status_code == 200
    refreshed = refresh_response.json()
    target = next(item for item in refreshed if item["id"] == conversation["id"])
    carol_participant = next(
        participant
        for participant in target["participants"]
        if participant["user"]["id"] == carol["id"]
    )
    assert carol_participant["note"] == "Отвечу позже"
