import { useCallback, useEffect, useRef, useState } from 'react';

import { buildWebsocketUrl } from '../services/api';
import { getToken } from '../services/storage';
import { getCurrentUserId } from '../services/session';
import { createJsonWebSocket, sendJson } from '../services/websocket';
import { useWorkspaceStore } from '../state/workspaceStore';
import type { Message, PresenceUser, TypingUser } from '../types';
import { messageMentionsLogin } from '../utils/mentions';
import { playNotificationSound, showBrowserNotification } from '../utils/notifications';

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

interface PongPayload {
  type: 'pong';
}

type ChannelEvent =
  | HistoryPayload
  | MessagePayload
  | PresencePayload
  | TypingPayload
  | ErrorPayload
  | PongPayload;

export type ChannelSocketStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface UseChannelSocketResult {
  status: ChannelSocketStatus;
  sendMessage: (content: string, options?: { attachments?: number[]; parentId?: number | null }) => void;
  sendTyping: (isTyping: boolean) => void;
}

export function useChannelSocket(channelId: number | null | undefined): UseChannelSocketResult {
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ChannelSocketStatus>('idle');
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const keepAliveIntervalRef = useRef<number | null>(null);
  const channelIdRef = useRef<number | null>(channelId ?? null);
  const shouldReconnectRef = useRef(false);

  const ingestHistory = useWorkspaceStore((state) => state.ingestHistory);
  const ingestMessage = useWorkspaceStore((state) => state.ingestMessage);
  const setPresenceSnapshot = useWorkspaceStore((state) => state.setPresenceSnapshot);
  const setTypingSnapshot = useWorkspaceStore((state) => state.setTypingSnapshot);
  const setError = useWorkspaceStore((state) => state.setError);

  const notifyAboutMessage = useCallback(
    (incoming: Message) => {
      const currentUserId = getCurrentUserId();
      if (incoming.author_id && currentUserId !== null && incoming.author_id === currentUserId) {
        return;
      }
      if (incoming.deleted_at) {
        return;
      }
      if (incoming.updated_at && incoming.updated_at !== incoming.created_at) {
        return;
      }
      const state = useWorkspaceStore.getState();
      const roomSlug = state.channelRoomById[channelId ?? -1];
      const members = roomSlug ? state.membersByRoom[roomSlug] ?? [] : [];
      const channels = roomSlug ? state.channelsByRoom[roomSlug] ?? [] : [];
      const selfLogin = currentUserId
        ? members.find((member) => member.user_id === currentUserId)?.login ?? null
        : null;
      const mention = Boolean(selfLogin && messageMentionsLogin(incoming.content ?? '', selfLogin));
      void playNotificationSound({ type: mention ? 'mention' : 'message' });

      const doc = typeof document !== 'undefined' ? document : null;
      const hidden = doc ? doc.visibilityState === 'hidden' : false;
      const unfocused = doc && typeof doc.hasFocus === 'function' ? !doc.hasFocus() : false;
      if (!hidden && !unfocused && !mention) {
        return;
      }

      const authorName = incoming.author?.display_name || incoming.author?.login || 'System';
      const roomTitle = roomSlug ? state.roomDetails[roomSlug]?.title ?? roomSlug : undefined;
      const channelName = channels.find((channel) => channel.id === incoming.channel_id)?.name;
      const titleParts = [] as string[];
      if (roomTitle) {
        titleParts.push(roomTitle);
      }
      if (channelName) {
        titleParts.push(`#${channelName}`);
      }
      const title = titleParts.length > 0 ? titleParts.join(' • ') : 'Charge';
      const trimmedContent = incoming.content?.trim() ?? '';
      const attachmentNote = incoming.attachments.length > 0 ? ` 📎 ${incoming.attachments[0]?.file_name ?? ''}` : '';
      const body = `${authorName}: ${trimmedContent || attachmentNote || 'New message'}`;

      void showBrowserNotification(title, {
        body,
        tag: `channel-${incoming.channel_id}`,
        badge: incoming.author?.avatar_url ?? undefined,
        icon: incoming.author?.avatar_url ?? undefined,
      });
    },
    [channelId],
  );

  useEffect(() => {
    channelIdRef.current = channelId ?? null;
    shouldReconnectRef.current = true;
    return () => {
      shouldReconnectRef.current = false;
    };
  }, [channelId]);

  useEffect(() => {
    setConnectionAttempt(0);
  }, [channelId]);

  const clearReconnectTimeout = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const stopKeepAlive = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (keepAliveIntervalRef.current !== null) {
      window.clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
    }
  }, []);

  const startKeepAlive = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    stopKeepAlive();
    keepAliveIntervalRef.current = window.setInterval(() => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        sendJson(socketRef.current, { type: 'ping' });
      } catch (error) {
        // ignore ping errors
      }
    }, 20_000);
  }, [stopKeepAlive]);

  const scheduleReconnect = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (reconnectTimeoutRef.current !== null) {
      return;
    }
    if (!shouldReconnectRef.current || channelIdRef.current === null) {
      return;
    }
    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectTimeoutRef.current = null;
      if (!shouldReconnectRef.current || channelIdRef.current === null) {
        return;
      }
      setConnectionAttempt((attempt) => attempt + 1);
    }, 3_000);
  }, []);

  useEffect(
    () => () => {
      stopKeepAlive();
      clearReconnectTimeout();
    },
    [clearReconnectTimeout, stopKeepAlive],
  );

  useEffect(() => {
    if (!channelId) {
      setStatus('idle');
      stopKeepAlive();
      clearReconnectTimeout();
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.close();
      }
      socketRef.current = null;
      return () => {};
    }

    const token = getToken();
    if (!token) {
      setStatus('error');
      setError('Требуется авторизация для подключения к каналу');
      return () => {};
    }

    const url = new URL(buildWebsocketUrl(`/ws/text/${channelId}`));
    url.searchParams.set('token', token);

    setStatus('connecting');

    const socket = createJsonWebSocket<ChannelEvent>(url.toString(), {
      onOpen: () => {
        clearReconnectTimeout();
        startKeepAlive();
        setStatus('connected');
        setError(undefined);
      },
      onClose: () => {
        stopKeepAlive();
        setStatus('idle');
        socketRef.current = null;
        scheduleReconnect();
      },
      onError: () => {
        stopKeepAlive();
        setStatus('error');
        setError('Не удалось подключиться к текстовому каналу');
        scheduleReconnect();
      },
      onMessage: (payload) => {
        switch (payload.type) {
          case 'history':
            ingestHistory(channelId, payload.messages);
            break;
          case 'message':
          case 'reaction':
            ingestMessage(channelId, payload.message);
            if (payload.type === 'message') {
              notifyAboutMessage(payload.message);
            }
            break;
          case 'presence':
            setPresenceSnapshot(payload.channel_id, payload.online);
            break;
          case 'typing':
            setTypingSnapshot(payload.channel_id, payload.users);
            break;
          case 'error':
            if (payload.detail && payload.detail !== 'Connection timed out due to inactivity') {
              setError(payload.detail);
            }
            break;
          case 'pong':
            break;
          default:
            break;
        }
      },
    });

    socketRef.current = socket;

    return () => {
      stopKeepAlive();
      clearReconnectTimeout();
      if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      setTypingSnapshot(channelId, []);
      setPresenceSnapshot(channelId, []);
    };
  }, [
    channelId,
    clearReconnectTimeout,
    connectionAttempt,
    ingestHistory,
    ingestMessage,
    notifyAboutMessage,
    scheduleReconnect,
    setError,
    setPresenceSnapshot,
    setTypingSnapshot,
    startKeepAlive,
    stopKeepAlive,
  ]);

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
