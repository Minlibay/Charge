import { useEffect, useRef } from 'react';

import type { FriendUser } from '../types';
import { buildWebsocketUrl } from '../services/api';
import { getToken } from '../services/storage';
import { createJsonWebSocket } from '../services/websocket';
import { useFriendsStore } from '../state/friendsStore';

type PresenceSnapshotPayload = {
  type: 'status_snapshot';
  users: FriendUser[];
};

type PresenceUpdatePayload = {
  type: 'status';
  user: FriendUser;
};

type PresenceEvent = PresenceSnapshotPayload | PresenceUpdatePayload;

export function usePresenceSocket(enabled: boolean): void {
  const socketRef = useRef<WebSocket | null>(null);
  const ingestSnapshot = useFriendsStore((state) => state.ingestStatusSnapshot);
  const ingestUpdate = useFriendsStore((state) => state.ingestStatusUpdate);

  useEffect(() => {
    if (!enabled) {
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.close();
      }
      socketRef.current = null;
      return;
    }

    const token = getToken();
    if (!token) {
      return;
    }

    const url = new URL(buildWebsocketUrl('/ws/presence'));
    url.searchParams.set('token', token);

    const socket = createJsonWebSocket<PresenceEvent>(url.toString(), {
      onMessage: (payload) => {
        switch (payload.type) {
          case 'status_snapshot':
            ingestSnapshot(payload.users);
            break;
          case 'status':
            ingestUpdate(payload.user);
            break;
          default:
            break;
        }
      },
      onClose: () => {
        socketRef.current = null;
      },
      onError: () => {
        socketRef.current = null;
      },
    });

    socketRef.current = socket;

    return () => {
      if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
      socketRef.current = null;
    };
  }, [enabled, ingestSnapshot, ingestUpdate]);
}
