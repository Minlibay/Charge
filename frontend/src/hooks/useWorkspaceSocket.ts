import { useEffect, useRef } from 'react';

import type { Channel, ChannelCategory, RoomMemberSummary } from '../types';
import { buildWebsocketUrl } from '../services/api';
import { getToken } from '../services/storage';
import { createJsonWebSocket } from '../services/websocket';
import { useWorkspaceStore } from '../state/workspaceStore';

interface ChannelEvent {
  type: 'channel_created' | 'channel_updated';
  room: string;
  channel: Channel;
}

interface ChannelDeletedEvent {
  type: 'channel_deleted';
  room: string;
  channel_id: number;
}

interface ChannelsReorderedEvent {
  type: 'channels_reordered';
  room: string;
  channels: Channel[];
}

interface CategoryEvent {
  type: 'category_created' | 'category_updated' | 'category_deleted' | 'categories_reordered';
  room: string;
  categories: ChannelCategory[];
  channels?: Channel[];
}

interface MemberEvent {
  type: 'member_joined' | 'member_updated' | 'member_left';
  room: string;
  members: RoomMemberSummary[];
}

interface SnapshotEvent {
  type: 'workspace_snapshot';
  room: string;
  channels?: Channel[];
  categories?: ChannelCategory[];
  members?: RoomMemberSummary[];
}

interface PongEvent {
  type: 'pong';
}

interface ErrorEvent {
  type: 'error';
  detail?: string;
}

type WorkspaceEvent =
  | ChannelEvent
  | ChannelDeletedEvent
  | ChannelsReorderedEvent
  | CategoryEvent
  | MemberEvent
  | SnapshotEvent
  | PongEvent
  | ErrorEvent;

export function useWorkspaceSocket(roomSlug: string | null | undefined): void {
  const socketRef = useRef<WebSocket | null>(null);
  const setChannelsByRoom = useWorkspaceStore((state) => state.setChannelsByRoom);
  const updateChannel = useWorkspaceStore((state) => state.updateChannel);
  const setCategoriesByRoom = useWorkspaceStore((state) => state.setCategoriesByRoom);
  const setMembersByRoom = useWorkspaceStore((state) => state.setMembersByRoom);

  useEffect(() => {
    if (!roomSlug) {
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

    const url = new URL(buildWebsocketUrl(`/ws/rooms/${encodeURIComponent(roomSlug)}`));
    url.searchParams.set('token', token);

    const socket = createJsonWebSocket<WorkspaceEvent>(url.toString(), {
      onMessage: (payload) => {
        switch (payload.type) {
          case 'channel_created':
          case 'channel_updated':
            updateChannel(payload.room, payload.channel);
            break;
          case 'channel_deleted': {
            const state = useWorkspaceStore.getState();
            const existing = state.channelsByRoom[payload.room] ?? [];
            const next = existing.filter((channel) => channel.id !== payload.channel_id);
            setChannelsByRoom(payload.room, next);
            break;
          }
          case 'channels_reordered':
            setChannelsByRoom(payload.room, payload.channels);
            break;
          case 'category_created':
          case 'category_updated':
          case 'category_deleted':
          case 'categories_reordered':
            setCategoriesByRoom(payload.room, payload.categories);
            if (payload.channels) {
              setChannelsByRoom(payload.room, payload.channels);
            }
            break;
          case 'member_joined':
          case 'member_updated':
          case 'member_left':
            setMembersByRoom(payload.room, payload.members);
            break;
          case 'workspace_snapshot':
            if (payload.channels) {
              setChannelsByRoom(payload.room, payload.channels);
            }
            if (payload.categories) {
              setCategoriesByRoom(payload.room, payload.categories);
            }
            if (payload.members) {
              setMembersByRoom(payload.room, payload.members);
            }
            break;
          case 'error':
            console.error('Workspace socket error', payload.detail);
            break;
          case 'pong':
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
  }, [roomSlug, setChannelsByRoom, setCategoriesByRoom, setMembersByRoom, updateChannel]);
}
