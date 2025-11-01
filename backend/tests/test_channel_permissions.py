from __future__ import annotations

from typing import Dict

from fastapi.testclient import TestClient

from app.models import RoomMember, RoomRole

Headers = Dict[str, str]


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


def _create_room_and_channel(client: TestClient, token: str) -> tuple[dict[str, object], dict[str, object]]:
    room_response = client.post("/api/rooms", json={"title": "Workspace"}, headers=_auth_headers(token))
    assert room_response.status_code == 201, room_response.text
    room = room_response.json()

    channel_response = client.post(
        f"/api/rooms/{room['slug']}/channels",
        json={"name": "general", "type": "text"},
        headers=_auth_headers(token),
    )
    assert channel_response.status_code == 201, channel_response.text
    return room, channel_response.json()


def test_channel_permission_crud_flow(client: TestClient, session_factory) -> None:
    owner = _register_user(client, "owner")
    owner_token = _login_user(client, owner["login"])
    room, channel = _create_room_and_channel(client, owner_token)

    listing = client.get(
        f"/api/channels/{channel['id']}/permissions",
        headers=_auth_headers(owner_token),
    )
    assert listing.status_code == 200, listing.text
    assert listing.json() == {"channel_id": channel["id"], "roles": [], "users": []}

    role_response = client.put(
        f"/api/channels/{channel['id']}/permissions/roles/member",
        json={
            "allow": ["view", "send_messages", "manage_channel"],
            "deny": ["manage_messages", "manage_permissions"],
        },
        headers=_auth_headers(owner_token),
    )
    assert role_response.status_code == 200, role_response.text
    role_body = role_response.json()
    assert role_body["role"] == "member"
    assert set(role_body["allow"]) == {"view", "send_messages", "manage_channel"}
    assert set(role_body["deny"]) == {"manage_messages", "manage_permissions"}

    listing = client.get(
        f"/api/channels/{channel['id']}/permissions",
        headers=_auth_headers(owner_token),
    )
    assert listing.status_code == 200, listing.text
    data = listing.json()
    assert data["roles"]
    assert set(data["roles"][0]["allow"]) == {"view", "send_messages", "manage_channel"}

    member = _register_user(client, "participant")
    member_token = _login_user(client, member["login"])

    session = session_factory()
    try:
        session.add(RoomMember(room_id=room["id"], user_id=member["id"], role=RoomRole.MEMBER))
        session.commit()
    finally:
        session.close()

    user_response = client.put(
        f"/api/channels/{channel['id']}/permissions/users/{member['id']}",
        json={
            "allow": ["view", "publish_announcements"],
            "deny": ["send_messages", "create_events"],
        },
        headers=_auth_headers(owner_token),
    )
    assert user_response.status_code == 200, user_response.text
    user_body = user_response.json()
    assert user_body["user_id"] == member["id"]
    assert user_body["login"] == member["login"]
    assert set(user_body["allow"]) == {"view", "publish_announcements"}
    assert set(user_body["deny"]) == {"send_messages", "create_events"}

    listing = client.get(
        f"/api/channels/{channel['id']}/permissions",
        headers=_auth_headers(owner_token),
    )
    assert listing.status_code == 200
    data = listing.json()
    assert len(data["users"]) == 1

    delete_user = client.delete(
        f"/api/channels/{channel['id']}/permissions/users/{member['id']}",
        headers=_auth_headers(owner_token),
    )
    assert delete_user.status_code == 204, delete_user.text

    delete_role = client.delete(
        f"/api/channels/{channel['id']}/permissions/roles/member",
        headers=_auth_headers(owner_token),
    )
    assert delete_role.status_code == 204, delete_role.text

    final_listing = client.get(
        f"/api/channels/{channel['id']}/permissions",
        headers=_auth_headers(owner_token),
    )
    assert final_listing.status_code == 200
    final_data = final_listing.json()
    assert final_data["roles"] == []
    assert final_data["users"] == []

    # Members can read but not modify permissions
    listing_for_member = client.get(
        f"/api/channels/{channel['id']}/permissions",
        headers=_auth_headers(member_token),
    )
    assert listing_for_member.status_code == 200


def test_channel_permission_updates_require_admin(client: TestClient, session_factory) -> None:
    owner = _register_user(client, "boss")
    owner_token = _login_user(client, owner["login"])
    room, channel = _create_room_and_channel(client, owner_token)

    member = _register_user(client, "limited")
    member_token = _login_user(client, member["login"])

    session = session_factory()
    try:
        session.add(RoomMember(room_id=room["id"], user_id=member["id"], role=RoomRole.MEMBER))
        session.commit()
    finally:
        session.close()

    forbidden = client.put(
        f"/api/channels/{channel['id']}/permissions/roles/guest",
        json={"allow": ["view"], "deny": []},
        headers=_auth_headers(member_token),
    )
    assert forbidden.status_code == 403

    get_response = client.get(
        f"/api/channels/{channel['id']}/permissions",
        headers=_auth_headers(member_token),
    )
    assert get_response.status_code == 200
