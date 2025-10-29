from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Iterable, List

from pydantic import AnyHttpUrl, BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class IceServer(BaseModel):
    """Representation of a WebRTC ICE server configuration."""

    urls: list[str] = Field(default_factory=list, description="ICE server URLs")
    username: str | None = Field(default=None, description="Optional TURN username")
    credential: str | None = Field(default=None, description="Optional TURN credential")

    @field_validator("urls", mode="before")
    @classmethod
    def ensure_list(cls, value: Any) -> list[str]:
        if isinstance(value, str):
            return [value]
        if isinstance(value, (list, tuple, set)):
            return [str(item) for item in value]
        return [] if value in (None, Ellipsis) else [str(value)]


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    app_name: str = Field(default="Charge API", env="APP_NAME", description="Human readable service name")
    environment: str = Field(default="development", env="ENVIRONMENT", description="Deployment environment name")
    debug: bool = Field(default=True, env="DEBUG", description="Enable debug mode")

    cors_origins: Annotated[List[AnyHttpUrl], NoDecode] = Field(
        default_factory=lambda: [
            "http://localhost",
            "http://localhost:3000",
            "http://localhost:8080",
            "http://127.0.0.1",
            "http://127.0.0.1:8080",
        ],
        env="CORS_ORIGINS",
        description="List of allowed CORS origins",
    )

    cors_allow_origin_regex: str | None = Field(
        default=(
            r"^(https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|(\d{1,3}\.){3}\d{1,3})(:\d+)?|"
            r"https?://([a-z0-9-]+\.)?charvi\.ru(:\d+)?)$"
        ),
        env="CORS_ALLOW_ORIGIN_REGEX",
        description="Optional regular expression that matches allowed CORS origins",
    )

    database_user: str = Field(default="charge", env="DB_USER")
    database_password: str = Field(default="charge", env="DB_PASSWORD")
    database_host: str = Field(default="db", env="DB_HOST")
    database_port: int = Field(default=3306, env="DB_PORT")
    database_name: str = Field(default="charge", env="DB_NAME")

    jwt_secret_key: str = Field(default="changeme", env="JWT_SECRET_KEY")
    jwt_algorithm: str = Field(default="HS256", env="JWT_ALGORITHM")
    access_token_expire_minutes: int = Field(default=30, env="ACCESS_TOKEN_EXPIRE_MINUTES")

    chat_history_default_limit: int = Field(default=50, env="CHAT_HISTORY_DEFAULT_LIMIT")
    chat_history_max_limit: int = Field(default=100, env="CHAT_HISTORY_MAX_LIMIT")
    chat_message_max_length: int = Field(default=2000, env="CHAT_MESSAGE_MAX_LENGTH")
    websocket_receive_timeout_seconds: int = Field(
        default=30, env="WEBSOCKET_RECEIVE_TIMEOUT_SECONDS"
    )
    media_root: Path = Field(default=Path("uploads"), env="MEDIA_ROOT")
    media_base_url: str = Field(
        default="/api/channels/attachments", env="MEDIA_BASE_URL"
    )
    avatar_base_url: str = Field(
        default="/api/profile/avatar",
        env="AVATAR_BASE_URL",
        description="Base URL for serving user avatars",
    )
    max_upload_size: int = Field(
        default=10 * 1024 * 1024, env="MAX_UPLOAD_SIZE", description="Maximum upload size in bytes"
    )
    push_notifications_enabled: bool = Field(
        default=False,
        env="PUSH_NOTIFICATIONS_ENABLED",
        description="Toggle push or SSE notifications for offline users.",
    )
    push_provider: str | None = Field(
        default=None,
        env="PUSH_PROVIDER",
        description="Identifier of the push provider (e.g. firebase, webpush)",
    )
    firebase_credentials_path: Path | None = Field(
        default=None,
        env="FIREBASE_CREDENTIALS_PATH",
        description="Filesystem path to Firebase service account credentials.",
    )
    web_push_vapid_public_key: str | None = Field(
        default=None,
        env="WEB_PUSH_VAPID_PUBLIC_KEY",
        description="VAPID public key for Web Push integrations.",
    )
    web_push_vapid_private_key: str | None = Field(
        default=None,
        env="WEB_PUSH_VAPID_PRIVATE_KEY",
        description="VAPID private key for Web Push integrations.",
    )
    sse_base_url: AnyHttpUrl | None = Field(
        default=None,
        env="SSE_BASE_URL",
        description="Optional base URL of an SSE relay for notification fan-out.",
    )

    webrtc_ice_servers: list[IceServer] = Field(
        default_factory=list,
        env="WEBRTC_ICE_SERVERS",
        description="List of ICE (STUN/TURN) servers available to WebRTC peers.",
    )
    webrtc_stun_servers: list[str] = Field(
        default_factory=list,
        env="WEBRTC_STUN_SERVERS",
        description="Additional STUN endpoints exposed to clients.",
    )
    webrtc_turn_servers: list[str] = Field(
        default_factory=list,
        env="WEBRTC_TURN_SERVERS",
        description="TURN endpoints exposed to clients.",
    )
    webrtc_turn_username: str | None = Field(
        default=None,
        env="WEBRTC_TURN_USERNAME",
        description="Optional TURN username shared with clients.",
    )
    webrtc_turn_credential: str | None = Field(
        default=None,
        env="WEBRTC_TURN_CREDENTIAL",
        description="Optional TURN credential shared with clients.",
    )
    webrtc_default_role: str = Field(
        default="listener",
        env="WEBRTC_DEFAULT_ROLE",
        description="Default role assigned to newly joined participants.",
    )
    webrtc_auto_promote_first_speaker: bool = Field(
        default=True,
        env="WEBRTC_AUTO_PROMOTE_FIRST_SPEAKER",
        description="Automatically promote first participant in room to speaker role.",
    )
    webrtc_max_speakers: int = Field(
        default=16,
        env="WEBRTC_MAX_SPEAKERS",
        description="Maximum number of simultaneous speakers in a room.",
    )
    voice_recording_enabled: bool = Field(
        default=False,
        env="VOICE_RECORDING_ENABLED",
        description="Enable server-side recording orchestration hooks.",
    )
    voice_recording_service_url: AnyHttpUrl | None = Field(
        default=None,
        env="VOICE_RECORDING_SERVICE_URL",
        description="Optional external service endpoint for starting/stopping recordings.",
    )
    voice_quality_monitoring_enabled: bool = Field(
        default=False,
        env="VOICE_QUALITY_MONITORING_ENABLED",
        description="Enable forwarding of voice quality telemetry.",
    )
    voice_quality_monitoring_endpoint: AnyHttpUrl | None = Field(
        default=None,
        env="VOICE_QUALITY_MONITORING_ENDPOINT",
        description="Endpoint receiving aggregated quality telemetry reports.",
    )
    voice_quality_poll_interval_seconds: int = Field(
        default=15,
        env="VOICE_QUALITY_POLL_INTERVAL_SECONDS",
        description="Preferred poll interval for clients reporting quality metrics.",
    )

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parents[2] / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def database_url(self) -> str:
        return (
            f"mysql+pymysql://{self.database_user}:{self.database_password}"
            f"@{self.database_host}:{self.database_port}/{self.database_name}"
        )

    @field_validator("cors_origins", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v):  # type: ignore[override]
        if v in (None, "", Ellipsis):
            return v
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        if isinstance(v, (list, tuple, set)):
            return list(v)
        return v

    @field_validator("media_root", mode="before")
    @classmethod
    def resolve_media_root(cls, value: str | Path) -> Path:
        if isinstance(value, Path):
            return value.resolve()
        return Path(value).resolve()

    @field_validator("firebase_credentials_path", mode="before")
    @classmethod
    def resolve_firebase_credentials(
        cls, value: str | Path | None
    ) -> Path | None:
        if value in (None, "", Ellipsis):
            return None
        if isinstance(value, Path):
            return value.resolve()
        return Path(value).resolve()

    @field_validator(
        "webrtc_ice_servers",
        "webrtc_stun_servers",
        "webrtc_turn_servers",
        mode="before",
    )
    @classmethod
    def parse_iterable_field(cls, value: Any) -> list[Any] | Any:
        if value in (None, "", Ellipsis):
            return []
        if isinstance(value, str):
            try:
                import json

                parsed = json.loads(value)
                if isinstance(parsed, (list, tuple, set)):
                    return list(parsed)
            except json.JSONDecodeError:
                return [item.strip() for item in value.split(",") if item.strip()]
            return [str(value)]
        if isinstance(value, (list, tuple, set)):
            return list(value)
        return [value]

    def _aggregate_ice_servers(self) -> list[IceServer]:
        def coerce_server(entry: Any) -> IceServer | None:
            if isinstance(entry, IceServer):
                return entry
            if isinstance(entry, dict):
                return IceServer.model_validate(entry)
            if isinstance(entry, str):
                return IceServer(urls=[entry])
            if isinstance(entry, Iterable):
                return IceServer(urls=[str(item) for item in entry])
            return None

        servers: list[IceServer] = []
        for item in self.webrtc_ice_servers:
            server = coerce_server(item)
            if server is not None:
                servers.append(server)

        if self.webrtc_stun_servers:
            servers.append(IceServer(urls=[str(url) for url in self.webrtc_stun_servers]))

        if self.webrtc_turn_servers:
            servers.append(
                IceServer(
                    urls=[str(url) for url in self.webrtc_turn_servers],
                    username=self.webrtc_turn_username,
                    credential=self.webrtc_turn_credential,
                )
            )

        if not servers:
            servers.append(IceServer(urls=["stun:stun.l.google.com:19302"]))

        return servers

    @property
    def webrtc_ice_servers_payload(self) -> list[dict[str, Any]]:
        return [server.model_dump(mode="json") for server in self._aggregate_ice_servers()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
