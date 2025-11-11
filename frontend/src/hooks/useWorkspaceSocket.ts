import { useEffect, useRef } from 'react';

import type { Channel, ChannelCategory, CustomRole, RoomInvitation, RoomMemberSummary } from '../types';
import { buildWebsocketUrl } from '../services/api';
import { getToken } from '../services/storage';
import { createJsonWebSocket } from '../services/websocket';
import { useWorkspaceStore } from '../state/workspaceStore';
import { logger } from '../services/logger';

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
  type: 'channels_reordered' | 'channel_reordered';
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

interface InvitationCreatedEvent {
  type: 'invite_created';
  room: string;
  invitation: RoomInvitation;
}

interface InvitationDeletedEvent {
  type: 'invite_deleted';
  room: string;
  invitation_id: number;
}

interface RoomUpdatedEvent {
  type: 'room_updated';
  room: string;
  room_data: {
    id: number;
    title: string;
    slug: string;
    created_at: string;
    updated_at: string;
  };
}

interface SnapshotEvent {
  type: 'workspace_snapshot';
  room: string;
  channels?: Channel[];
  categories?: ChannelCategory[];
  members?: RoomMemberSummary[];
  invitations?: RoomInvitation[];
}

interface PongEvent {
  type: 'pong';
}

interface ErrorEvent {
  type: 'error';
  detail?: string;
}

interface RoleCreatedEvent {
  type: 'role_created';
  room: string;
  role: CustomRole;
}

interface RoleUpdatedEvent {
  type: 'role_updated';
  room: string;
  role: CustomRole;
}

interface RoleDeletedEvent {
  type: 'role_deleted';
  room: string;
  role_id: number;
}

interface RolesReorderedEvent {
  type: 'roles_reordered';
  room: string;
  roles: CustomRole[];
}

interface UserRoleAssignedEvent {
  type: 'user_role_assigned';
  room: string;
  user_id: number;
  role_id: number;
}

interface UserRoleRemovedEvent {
  type: 'user_role_removed';
  room: string;
  user_id: number;
  role_id: number;
}

interface AnnouncementCreatedEvent {
  type: 'announcement_created';
  room: string;
  channel_id: number;
  announcement: unknown; // Message data
}

interface AnnouncementCrossPostedEvent {
  type: 'announcement_cross_posted';
  room: string;
  channel_id: number;
  original_message_id: number;
  cross_posts: unknown[]; // CrossPostRead data
}

interface ForumPostCreatedEvent {
  type: 'forum_post_created';
  room: string;
  channel_id: number;
  post: unknown; // ForumPost data
}

interface ForumPostUpdatedEvent {
  type: 'forum_post_updated';
  room: string;
  channel_id: number;
  post: unknown; // ForumPost data
}

interface ForumPostDeletedEvent {
  type: 'forum_post_deleted';
  room: string;
  channel_id: number;
  post_id: number;
}

interface EventCreatedEvent {
  type: 'event_created';
  room: string;
  channel_id: number;
  event: unknown; // Event data
}

interface EventUpdatedEvent {
  type: 'event_updated';
  room: string;
  channel_id: number;
  event: unknown; // Event data
}

interface EventDeletedEvent {
  type: 'event_deleted';
  room: string;
  channel_id: number;
  event_id: number;
}

interface EventRSVPChangedEvent {
  type: 'event_rsvp_changed';
  room: string;
  channel_id: number;
  event_id: number;
  user_id: number;
  rsvp_status: string;
}

type WorkspaceEvent =
  | ChannelEvent
  | ChannelDeletedEvent
  | ChannelsReorderedEvent
  | CategoryEvent
  | MemberEvent
  | InvitationCreatedEvent
  | InvitationDeletedEvent
  | RoleCreatedEvent
  | RoleUpdatedEvent
  | RoleDeletedEvent
  | RolesReorderedEvent
  | UserRoleAssignedEvent
  | UserRoleRemovedEvent
  | RoomUpdatedEvent
  | AnnouncementCreatedEvent
  | AnnouncementCrossPostedEvent
  | ForumPostCreatedEvent
  | ForumPostUpdatedEvent
  | ForumPostDeletedEvent
  | EventCreatedEvent
  | EventUpdatedEvent
  | EventDeletedEvent
  | EventRSVPChangedEvent
  | SnapshotEvent
  | PongEvent
  | ErrorEvent;

export function useWorkspaceSocket(roomSlug: string | null | undefined): void {
  const socketRef = useRef<WebSocket | null>(null);
  const setChannelsByRoom = useWorkspaceStore((state) => state.setChannelsByRoom);
  const updateChannel = useWorkspaceStore((state) => state.updateChannel);
  const setCategoriesByRoom = useWorkspaceStore((state) => state.setCategoriesByRoom);
  const setMembersByRoom = useWorkspaceStore((state) => state.setMembersByRoom);
  const setInvitationsByRoom = useWorkspaceStore((state) => state.setInvitationsByRoom);
  const upsertInvitation = useWorkspaceStore((state) => state.upsertInvitation);
  const removeInvitation = useWorkspaceStore((state) => state.removeInvitation);
  const upsertCustomRole = useWorkspaceStore((state) => state.upsertCustomRole);
  const removeCustomRole = useWorkspaceStore((state) => state.removeCustomRole);
  const setCustomRolesByRoom = useWorkspaceStore((state) => state.setCustomRolesByRoom);
  const getUserRoles = useWorkspaceStore((state) => state.getUserRoles);
  const loadRoom = useWorkspaceStore((state) => state.loadRoom);

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
          case 'channel_reordered':
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
          case 'invite_created':
            upsertInvitation(payload.room, payload.invitation);
            break;
          case 'invite_deleted':
            removeInvitation(payload.room, payload.invitation_id);
            break;
          case 'room_updated':
            // Reload room to get updated data
            void loadRoom(payload.room_data.slug);
            break;
          case 'role_created':
          case 'role_updated':
            upsertCustomRole(payload.room, payload.role);
            break;
          case 'role_deleted':
            removeCustomRole(payload.room, payload.role_id);
            break;
          case 'roles_reordered':
            setCustomRolesByRoom(payload.room, payload.roles);
            break;
          case 'user_role_assigned':
          case 'user_role_removed': {
            // Reload user roles and update member
            const state = useWorkspaceStore.getState();
            const members = state.membersByRoom[payload.room] ?? [];
            const memberIndex = members.findIndex((m) => m.user_id === payload.user_id);
            if (memberIndex >= 0) {
              // Reload user roles asynchronously
              getUserRoles(payload.room, payload.user_id).then((roles) => {
                const updatedMembers = [...members];
                updatedMembers[memberIndex] = {
                  ...updatedMembers[memberIndex],
                  custom_roles: roles,
                };
                setMembersByRoom(payload.room, updatedMembers);
              });
            }
            break;
          }
          case 'announcement_created':
          case 'announcement_cross_posted':
            // Announcements are handled via message events in channel socket
            // These events are informational and can be used for notifications or UI updates
            logger.debug('Announcement event received', undefined, {
              type: payload.type,
              channel_id: payload.channel_id,
            });
            break;
          case 'forum_post_created':
          case 'forum_post_updated':
          case 'forum_post_deleted':
            // Forum post events are handled by ForumPostList component
            // These events can trigger a refresh of the post list if needed
            logger.debug('Forum post event received', undefined, {
              type: payload.type,
              channel_id: payload.channel_id,
            });
            // Dispatch a custom event that ForumPostList can listen to
            window.dispatchEvent(
              new CustomEvent('forum_post_event', {
                detail: {
                  type: payload.type,
                  channel_id: payload.channel_id,
                  post: 'post' in payload ? payload.post : undefined,
                  post_id: 'post_id' in payload ? payload.post_id : undefined,
                },
              }),
            );
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
            if (payload.invitations) {
              setInvitationsByRoom(payload.room, payload.invitations);
            }
            break;
          case 'error':
            logger.error('Workspace socket error', undefined, { detail: payload.detail });
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
  }, [
    roomSlug,
    setChannelsByRoom,
    setCategoriesByRoom,
    setMembersByRoom,
    setInvitationsByRoom,
    upsertInvitation,
    removeInvitation,
    updateChannel,
    upsertCustomRole,
    removeCustomRole,
    setCustomRolesByRoom,
    getUserRoles,
    loadRoom,
  ]);
}
