"""Configuration endpoints for exposing runtime options to the frontend."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Request

from app.config import get_settings

router = APIRouter(prefix="/config", tags=["config"])


def _normalize_ws_url(ws_source: str | None, prefer_secure: bool) -> str | None:
    """Normalize HTTP/WS URLs and enforce secure scheme when required."""

    if not ws_source:
        return None

    normalized = ws_source
    if normalized.startswith("http://"):
        normalized = "ws://" + normalized.removeprefix("http://")
    elif normalized.startswith("https://"):
        normalized = "wss://" + normalized.removeprefix("https://")
    elif normalized.startswith("//"):
        normalized = ("wss" if prefer_secure else "ws") + ":" + normalized

    if prefer_secure and normalized.startswith("ws://"):
        normalized = "wss://" + normalized.removeprefix("ws://")

    return normalized


def _is_secure_request(request: Request) -> bool:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    if forwarded_proto:
        return forwarded_proto.lower() == "https"

    return request.url.scheme == "https"


@router.get("/webrtc")
def read_webrtc_config(request: Request) -> dict[str, object]:
    """Expose WebRTC ICE configuration and feature toggles."""

    settings = get_settings()
    sfu_server_url = settings.sfu_server_url
    prefer_secure = _is_secure_request(request)
    try:
        ws_source = settings.sfu_ws_url or settings.sfu_server_url
        sfu_ws_url = _normalize_ws_url(ws_source, prefer_secure)
    except Exception:
        sfu_ws_url = _normalize_ws_url(settings.sfu_ws_url or settings.sfu_server_url, prefer_secure)
    return {
        "iceServers": settings.webrtc_ice_servers_payload,
        "stun": [str(url) for url in settings.webrtc_stun_servers],
        "turn": {
            "urls": [str(url) for url in settings.webrtc_turn_servers],
            "realm": settings.webrtc_turn_realm,
            "username": settings.webrtc_turn_username,
            "fallbackServers": settings.webrtc_turn_fallback_payload,
        },
        "defaults": {
            "role": settings.webrtc_default_role,
            "autoPromoteFirstSpeaker": settings.webrtc_auto_promote_first_speaker,
            "maxSpeakers": settings.webrtc_max_speakers,
        },
        "recording": {
            "enabled": settings.voice_recording_enabled,
            "serviceUrl": str(settings.voice_recording_service_url)
            if settings.voice_recording_service_url
            else None,
        },
        "monitoring": {
            "enabled": settings.voice_quality_monitoring_enabled,
            "endpoint": str(settings.voice_quality_monitoring_endpoint)
            if settings.voice_quality_monitoring_endpoint
            else None,
            "pollInterval": settings.voice_quality_poll_interval_seconds,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
        "sfu": {
            "enabled": settings.sfu_enabled,
            "serverUrl": sfu_server_url,
            "wsUrl": sfu_ws_url,
            "featureFlagEnabled": settings.sfu_feature_flag_enabled,
        },
    }
