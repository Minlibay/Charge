import { useEffect, useRef } from 'react';

import type { DirectEvent } from '../types';
import { buildWebsocketUrl } from '../services/api';
import { getToken } from '../services/storage';
import { createJsonWebSocket } from '../services/websocket';
import { useDirectStore } from '../stores/directStore';

export function useDirectSocket(enabled: boolean): void {
  const socketRef = useRef<WebSocket | null>(null);
  const ingestEvent = useDirectStore((state) => state.ingestDirectEvent);

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

    const url = new URL(buildWebsocketUrl('/ws/direct'));
    url.searchParams.set('token', token);

    const socket = createJsonWebSocket<DirectEvent | { type: string }>(url.toString(), {
      onMessage: (payload) => {
        if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
          return;
        }
        switch (payload.type) {
          case 'direct_snapshot':
          case 'message':
          case 'conversation_refresh':
          case 'note_updated':
            ingestEvent(payload as DirectEvent);
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
  }, [enabled, ingestEvent]);
}
