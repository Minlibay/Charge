"""Backward compatible accessor for the global settings object."""

from app.config import Settings, get_settings

__all__ = ["Settings", "get_settings"]

