"""Utilities for broadcasting presence updates to connected clients."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Dict, Iterable, Set

from fastapi.websockets import WebSocket, WebSocketState


class PresenceNotificationHub:
    """Keeps track of WebSocket connections interested in presence changes."""

    def __init__(self) -> None:
        self._connections: Dict[int, Set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections[user_id].add(websocket)

    async def disconnect(self, user_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            sockets = self._connections.get(user_id)
            if not sockets:
                return
            sockets.discard(websocket)
            if not sockets:
                self._connections.pop(user_id, None)

    async def broadcast(self, payload: dict, recipients: Iterable[int]) -> None:
        unique_recipients = set(recipients)
        if not unique_recipients:
            return
        async with self._lock:
            targets = [
                list(self._connections.get(recipient_id, set()))
                for recipient_id in unique_recipients
            ]
        for sockets in targets:
            for socket in sockets:
                if socket.application_state != WebSocketState.CONNECTED:
                    continue
                try:
                    await socket.send_json(payload)
                except RuntimeError:
                    continue


presence_hub = PresenceNotificationHub()
"""Singleton presence hub shared across modules."""
