from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import AnyHttpUrl, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    app_name: str = Field(default="Charge API", env="APP_NAME", description="Human readable service name")
    environment: str = Field(default="development", env="ENVIRONMENT", description="Deployment environment name")
    debug: bool = Field(default=True, env="DEBUG", description="Enable debug mode")

    cors_origins: List[AnyHttpUrl] = Field(
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
        default=r"https?://(localhost|127\.0\.0\.1)(:\d+)?$",
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


@lru_cache
def get_settings() -> Settings:
    return Settings()
