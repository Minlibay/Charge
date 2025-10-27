export type ChannelType = 'text' | 'voice';
export type RoomRole = 'owner' | 'admin' | 'member' | 'guest';

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
  letter: string;
  created_at: string;
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
}

export interface RoomMemberSummary {
  id: number;
  user_id: number;
  role: RoomRole;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface PresenceUser {
  id: number;
  display_name: string;
}

export interface TypingUser {
  id: number;
  display_name: string;
}

export interface VoiceParticipant {
  id: number;
  displayName: string;
  role: string;
  muted: boolean;
  deafened: boolean;
  videoEnabled: boolean;
}
