"""Configuration endpoints for exposing runtime options to the frontend."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter

from app.config import get_settings

router = APIRouter(prefix="/config", tags=["config"])


@router.get("/webrtc")
def read_webrtc_config() -> dict[str, object]:
    """Expose WebRTC ICE configuration and feature toggles."""

    settings = get_settings()
    sfu_server_url = settings.sfu_server_url
    try:
        # Derive a websocket URL from the HTTP(S) SFU URL
        parsed = settings.sfu_server_url
        if parsed.startswith("http://"):
            sfu_ws_url = "ws://" + parsed.removeprefix("http://")
        elif parsed.startswith("https://"):
            sfu_ws_url = "wss://" + parsed.removeprefix("https://")
        else:
            sfu_ws_url = parsed
    except Exception:
        sfu_ws_url = settings.sfu_server_url
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
