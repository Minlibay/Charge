from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import get_settings


def test_webrtc_config_hides_turn_secret_from_turn_block(client: TestClient) -> None:
    settings = get_settings()
    original_servers = settings.webrtc_turn_servers
    original_username = settings.webrtc_turn_username
    original_credential = settings.webrtc_turn_credential
    settings.webrtc_turn_servers = ["turn:voice.example:3478"]
    settings.webrtc_turn_username = "voice-user"
    settings.webrtc_turn_credential = "temporary-secret"
    try:
        response = client.get("/api/config/webrtc")
    finally:
        settings.webrtc_turn_servers = original_servers
        settings.webrtc_turn_username = original_username
        settings.webrtc_turn_credential = original_credential

    assert response.status_code == 200, response.text
    payload = response.json()

    turn_block = payload["turn"]
    assert "credential" not in turn_block

    ice_servers = payload["iceServers"]
    assert any(
        isinstance(entry, dict)
        and entry.get("credential") == "temporary-secret"
        for entry in ice_servers
    ), "ICE servers should still receive the TURN credential"


def test_webrtc_config_preserves_explicit_sfu_port(client: TestClient) -> None:
    settings = get_settings()
    original_ws_url = settings.sfu_ws_url
    settings.sfu_ws_url = "ws://sfu:3001"
    try:
        response = client.get(
            "/api/config/webrtc",
            headers={
                "x-forwarded-host": "voice.example:8443",
                "x-forwarded-proto": "https",
            },
        )
    finally:
        settings.sfu_ws_url = original_ws_url

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["sfu"]["wsUrl"] == "wss://voice.example:3001/ws"


def test_webrtc_config_drops_internal_port_when_not_forwarded(client: TestClient) -> None:
    settings = get_settings()
    original_ws_url = settings.sfu_ws_url
    settings.sfu_ws_url = "ws://sfu:3001"
    try:
        response = client.get(
            "/api/config/webrtc",
            headers={
                "x-forwarded-host": "voice.example",
                "x-forwarded-proto": "https",
            },
        )
    finally:
        settings.sfu_ws_url = original_ws_url

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["sfu"]["wsUrl"] == "wss://voice.example/ws"
