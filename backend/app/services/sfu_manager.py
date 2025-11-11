"""SFU Manager service for interacting with SFU server."""

from __future__ import annotations

import httpx
from typing import Optional
from app.config import get_settings

settings = get_settings()


class SFUManager:
    """Manages communication with SFU server."""

    def __init__(self):
        self.base_url = settings.sfu_server_url
        self.api_key = settings.sfu_api_key
        self.timeout = 10.0

    def _get_headers(self) -> dict[str, str]:
        """Get headers for API requests."""
        return {
            "X-API-Key": self.api_key,
            "Content-Type": "application/json",
        }

    async def create_room(self, room_slug: str) -> dict:
        """
        Create a room in SFU server.

        Args:
            room_slug: Room identifier

        Returns:
            Room information

        Raises:
            httpx.HTTPError: If request fails
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.base_url}/api/rooms/{room_slug}",
                headers=self._get_headers(),
            )
            response.raise_for_status()
            return response.json()

    async def delete_room(self, room_slug: str) -> dict:
        """
        Delete a room from SFU server.

        Args:
            room_slug: Room identifier

        Returns:
            Success status

        Raises:
            httpx.HTTPError: If request fails
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.delete(
                f"{self.base_url}/api/rooms/{room_slug}",
                headers=self._get_headers(),
            )
            response.raise_for_status()
            return response.json()

    async def get_room_status(self, room_slug: str) -> Optional[dict]:
        """
        Get room status from SFU server.

        Args:
            room_slug: Room identifier

        Returns:
            Room status or None if room doesn't exist

        Raises:
            httpx.HTTPError: If request fails
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{self.base_url}/api/rooms/{room_slug}",
                headers=self._get_headers(),
            )
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()

    async def list_rooms(self) -> dict:
        """
        List all rooms in SFU server.

        Returns:
            List of rooms

        Raises:
            httpx.HTTPError: If request fails
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{self.base_url}/api/rooms",
                headers=self._get_headers(),
            )
            response.raise_for_status()
            return response.json()

    async def health_check(self) -> bool:
        """
        Check if SFU server is healthy.

        Returns:
            True if server is healthy, False otherwise
        """
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.base_url}/health")
                return response.status_code == 200
        except Exception:
            return False


# Global instance
sfu_manager = SFUManager()

