import { useCallback, useEffect, useRef, useState } from 'react';

import { buildWebsocketUrl } from '../services/api';
import { getToken } from '../services/storage';
import { createJsonWebSocket, sendJson } from '../services/websocket';
import { useWorkspaceStore } from '../state/workspaceStore';
import type { Message, PresenceUser, TypingUser } from '../types';

interface HistoryPayload {
  type: 'history';
  messages: Message[];
}

interface MessagePayload {
  type: 'message' | 'reaction';
  message: Message;
}

interface PresencePayload {
  type: 'presence';
  channel_id: number;
  online: PresenceUser[];
}

interface TypingPayload {
  type: 'typing';
  channel_id: number;
  users: TypingUser[];
  expires_in?: number;
}

interface ErrorPayload {
  type: 'error';
  detail?: string;
}

type ChannelEvent = HistoryPayload | MessagePayload | PresencePayload | TypingPayload | ErrorPayload;

export type ChannelSocketStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface UseChannelSocketResult {
  status: ChannelSocketStatus;
  sendMessage: (content: string, options?: { attachments?: number[]; parentId?: number | null }) => void;
  sendTyping: (isTyping: boolean) => void;
}

export function useChannelSocket(channelId: number | null | undefined): UseChannelSocketResult {
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ChannelSocketStatus>('idle');

  const ingestHistory = useWorkspaceStore((state) => state.ingestHistory);
  const ingestMessage = useWorkspaceStore((state) => state.ingestMessage);
  const setPresenceSnapshot = useWorkspaceStore((state) => state.setPresenceSnapshot);
  const setTypingSnapshot = useWorkspaceStore((state) => state.setTypingSnapshot);
  const setError = useWorkspaceStore((state) => state.setError);

  useEffect(() => {
    if (!channelId) {
      setStatus('idle');
      return;
    }

    const token = getToken();
    if (!token) {
      setStatus('error');
      setError('Требуется авторизация для подключения к каналу');
      return;
    }

    const url = new URL(buildWebsocketUrl(`/ws/text/${channelId}`));
    url.searchParams.set('token', token);

    setStatus('connecting');

    const socket = createJsonWebSocket<ChannelEvent>(url.toString(), {
      onOpen: () => {
        setStatus('connected');
        setError(undefined);
      },
      onClose: () => {
        setStatus('idle');
        socketRef.current = null;
      },
      onError: () => {
        setStatus('error');
        setError('Не удалось подключиться к текстовому каналу');
      },
      onMessage: (payload) => {
        switch (payload.type) {
          case 'history':
            ingestHistory(channelId, payload.messages);
            break;
          case 'message':
          case 'reaction':
            ingestMessage(channelId, payload.message);
            break;
          case 'presence':
            setPresenceSnapshot(payload.channel_id, payload.online);
            break;
          case 'typing':
            setTypingSnapshot(payload.channel_id, payload.users);
            break;
          case 'error':
            if (payload.detail) {
              setError(payload.detail);
            }
            break;
          default:
            break;
        }
      },
    });

    socketRef.current = socket;

    return () => {
      if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
      socketRef.current = null;
      setTypingSnapshot(channelId, []);
      setPresenceSnapshot(channelId, []);
    };
  }, [channelId, ingestHistory, ingestMessage, setError, setPresenceSnapshot, setTypingSnapshot]);

  const sendMessage = useCallback(
    (content: string, options: { attachments?: number[]; parentId?: number | null } = {}) => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        setError('Сообщение не отправлено: соединение неактивно');
        return;
      }
      const payload = {
        type: 'message',
        content,
        attachments: options.attachments ?? [],
        parent_id: options.parentId ?? null,
      };
      try {
        sendJson(socketRef.current, payload);
      } catch (error) {
        setError('Не удалось отправить сообщение');
      }
    },
    [setError],
  );

  const sendTyping = useCallback(
    (isTyping: boolean) => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        sendJson(socketRef.current, { type: 'typing', is_typing: isTyping });
      } catch (error) {
        // ignore typing errors
      }
    },
    [],
  );

  return { status, sendMessage, sendTyping };
}
