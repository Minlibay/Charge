export const CHANNEL_TYPES = [
  'text',
  'voice',
  'stage',
  'announcements',
  'forums',
  'events',
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const TEXT_CHANNEL_TYPES = ['text', 'announcements', 'forums', 'events'] as const;
export const VOICE_CHANNEL_TYPES = ['voice', 'stage'] as const;
export type RoomRole = 'owner' | 'admin' | 'member' | 'guest';
export type PresenceStatus = 'online' | 'idle' | 'dnd';
export const CHANNEL_PERMISSIONS = [
  'view',
  'send_messages',
  'manage_messages',
  'connect',
  'speak',
  'manage_channel',
  'manage_permissions',
  'start_stage',
  'manage_stage',
  'publish_announcements',
  'create_forum_posts',
  'moderate_forum_posts',
  'create_events',
  'manage_events',
] as const;
export type ChannelPermission = (typeof CHANNEL_PERMISSIONS)[number];

export const ROOM_PERMISSIONS = [
  'manage_roles',
  'manage_room',
  'kick_members',
  'ban_members',
  'manage_invites',
  'view_audit_log',
] as const;
export type RoomPermission = (typeof ROOM_PERMISSIONS)[number];

export interface CustomRole {
  id: number;
  room_id: number;
  name: string;
  color: string; // HEX color
  icon: string | null;
  position: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: RoomPermission[];
  created_at: string;
  updated_at: string;
}

export interface CustomRoleWithMemberCount extends CustomRole {
  member_count: number;
}

export interface CustomRoleCreate {
  name: string;
  color?: string;
  icon?: string | null;
  position?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: RoomPermission[];
}

export interface CustomRoleUpdate {
  name?: string;
  color?: string;
  icon?: string | null;
  position?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: RoomPermission[];
}

export interface CustomRoleReorderEntry {
  id: number;
  position: number;
}

export interface RoomSummary {
  id: number;
  slug: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChannelCategory {
  id: number;
  name: string;
  position: number;
  created_at: string;
}

export interface Channel {
    id: number;
    name: string;
    type: ChannelType;
    category_id: number | null;
    position: number;
    letter: string;
    topic: string | null;
    slowmode_seconds: number;
    is_nsfw: boolean;
    is_private: boolean;
    is_archived: boolean;
    archived_at: string | null;
    archived_by_id: number | null;
    created_at: string;
}

export interface CrossPostRequest {
  target_channel_ids: number[];
}

export interface CrossPostRead {
  target_channel_id: number;
  cross_posted_message_id: number;
  created_at: string;
}

export interface ForumPost {
  id: number;
  channel_id: number;
  message_id: number;
  title: string;
  author_id: number;
  is_pinned: boolean;
  is_archived: boolean;
  is_locked: boolean;
  reply_count: number;
  last_reply_at: string | null;
  last_reply_by_id: number | null;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface ForumPostDetail extends ForumPost {
  message: Message;
  author: MessageAuthor;
  last_reply_by: MessageAuthor | null;
}

export interface ForumPostListPage {
  items: ForumPost[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface ForumChannelTag {
  id: number;
  channel_id: number;
  name: string;
  color: string;
  emoji: string | null;
  created_at: string;
}

export interface ChannelPermissionOverwrite {
  allow: ChannelPermission[];
  deny: ChannelPermission[];
}

export interface ChannelRolePermissionOverwrite extends ChannelPermissionOverwrite {
  role: RoomRole;
}

export interface ChannelUserPermissionOverwrite extends ChannelPermissionOverwrite {
  user_id: number;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  status: PresenceStatus;
}

export interface ChannelPermissionSummary {
  channel_id: number;
  roles: ChannelRolePermissionOverwrite[];
  users: ChannelUserPermissionOverwrite[];
}

export interface RoomInvitation {
  id: number;
  code: string;
  role: RoomRole;
  expires_at: string | null;
  created_at: string;
  created_by_id: number | null;
}

export interface User {
  id: number;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  status: PresenceStatus;
  created_at: string;
  updated_at: string;
}

export interface RoomRoleLevel {
  role: RoomRole;
  level: number;
}

export interface RoomDetail extends RoomSummary {
  channels: Channel[];
  categories: ChannelCategory[];
  invitations: RoomInvitation[];
  role_hierarchy: RoomRoleLevel[];
  current_role: RoomRole | null;
  members: RoomMemberSummary[];
}

export interface MessageReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
  user_ids: number[];
}

export interface MessageAuthor {
  id: number;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  status: PresenceStatus;
}

export interface MessageAttachment {
  id: number;
  channel_id: number;
  message_id: number | null;
  file_name: string;
  content_type: string | null;
  file_size: number;
  download_url: string;
  preview_url: string | null;
  uploaded_by: number | null;
  created_at: string;
}

export interface Message {
  id: number;
  channel_id: number;
  author_id: number | null;
  author: MessageAuthor | null;
  content: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  moderated_at: string | null;
  moderation_note: string | null;
  moderated_by: MessageAuthor | null;
  parent_id: number | null;
  thread_root_id: number | null;
  reply_count: number;
  thread_reply_count: number;
  attachments: MessageAttachment[];
  reactions: MessageReactionSummary[];
  delivered_count: number;
  read_count: number;
  delivered_at: string | null;
  read_at: string | null;
  pinned_at: string | null;
  pinned_by: MessageAuthor | null;
}

export interface RoomMemberSummary {
  id: number;
  user_id: number;
  role: RoomRole;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  status: PresenceStatus;
  custom_roles?: CustomRole[]; // Custom roles assigned to this member
}

export interface PresenceUser {
  id: number;
  display_name: string;
  avatar_url: string | null;
  status: PresenceStatus;
  custom_roles?: CustomRole[]; // Custom roles assigned to this user
}

export interface TypingUser {
  id: number;
  display_name: string;
}

export interface MessageHistoryPage {
  items: Message[];
  next_cursor: string | null;
  prev_cursor: string | null;
  has_more_backward: boolean;
  has_more_forward: boolean;
}

export interface PinnedMessage {
  id: number;
  channel_id: number;
  message_id: number;
  message: Message;
  pinned_at: string;
  pinned_by: MessageAuthor | null;
  note: string | null;
}

export interface FriendUser {
  id: number;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  status: PresenceStatus;
}

export interface FriendRequest {
  id: number;
  requester: FriendUser;
  addressee: FriendUser;
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
  responded_at: string | null;
}

export interface FriendRequestList {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export interface DirectMessage {
  id: number;
  conversation_id: number;
  sender_id: number;
  recipient_id: number | null;
  content: string;
  created_at: string;
  read_at: string | null;
  sender: FriendUser;
}

export interface DirectConversationParticipant {
  user: FriendUser;
  nickname: string | null;
  note: string | null;
  joined_at: string;
  last_read_at: string | null;
}

export interface DirectConversation {
  id: number;
  title: string | null;
  is_group: boolean;
  participants: DirectConversationParticipant[];
  last_message: DirectMessage | null;
  unread_count: number;
}

export interface DirectConversationCreatePayload {
  participant_ids: number[];
  title?: string | null;
}

export type DirectEvent =
  | {
      type: 'direct_snapshot';
      conversations: DirectConversation[];
    }
  | {
      type: 'message';
      conversation_id: number;
      message: DirectMessage;
    }
  | {
      type: 'conversation_refresh';
      conversation_id: number;
    }
  | {
      type: 'note_updated';
      conversation_id: number;
      user_id: number;
      note: string | null;
    };

export interface UserProfile extends User {}

export interface ProfileUpdatePayload {
  display_name?: string | null;
  status?: PresenceStatus;
}

export type VoiceStageStatus =
  | 'listener'
  | 'invited'
  | 'requesting'
  | 'backstage'
  | 'live'
  | 'muted';

export interface VoiceQualityMetrics {
  mos?: number;
  score?: number;
  jitter?: number;
  rtt?: number;
  bitrate?: number;
  packetLoss?: number;
  [key: string]: number | string | boolean | null | undefined;
}

export type VoiceQualityByTrack = Record<string, VoiceQualityMetrics>;

export interface VoiceParticipant {
  id: number;
  displayName: string;
  role: string;
  muted: boolean;
  deafened: boolean;
  videoEnabled: boolean;
  stageStatus?: VoiceStageStatus;
  handRaised?: boolean;
  quality?: VoiceQualityByTrack | null;
}

export interface VoiceRoomStats {
  total: number;
  speakers: number;
  listeners: number;
  activeSpeakers: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface VoiceFeatureFlags {
  recording: boolean;
  qualityMonitoring: boolean;
}

export type ScreenShareQuality = 'low' | 'medium' | 'high';
