import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../services/api';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useToast } from '../components/ui';
import type { Message, MessageComposerPayload } from '../components/ChatView';
import {
  addMessageReaction as apiAddMessageReaction,
  createMessage as apiCreateMessage,
  deleteMessage as apiDeleteMessage,
  moderateMessage as apiModerateMessage,
  removeMessageReaction as apiRemoveMessageReaction,
  updateMessage as apiUpdateMessage,
} from '../services/api';
import { handleError } from '../utils/errorHandler';
import { logger } from '../services/logger';

export function useWorkspaceHandlers() {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const ingestMessage = useWorkspaceStore((state) => state.ingestMessage);
  const setError = useWorkspaceStore((state) => state.setError);
  const selectedTextChannelId = useWorkspaceStore((state) => {
    const id = state.selectedChannelId;
    if (!id) {
      return null;
    }
    const slug = state.channelRoomById[id];
    if (!slug) {
      return null;
    }
    const channel = state.channelsByRoom[slug]?.find((item) => item.id === id);
    if (!channel) {
      return null;
    }
    return ['text', 'announcements', 'forums', 'events'].includes(channel.type) ? id : null;
  });

  const handleSendMessage = useCallback(
    async (draft: MessageComposerPayload) => {
      if (!selectedTextChannelId) {
        return;
      }
      setError(undefined);
      try {
        const created = await apiCreateMessage({
          channelId: selectedTextChannelId,
          content: draft.content,
          parentId: draft.parentId ?? null,
          files: draft.files,
        });
        ingestMessage(selectedTextChannelId, created);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : t('chat.sendError', { defaultValue: 'Не удалось отправить сообщение' });
        setError(message);
        handleError(err, { action: 'sendMessage', channelId: selectedTextChannelId });
        throw err;
      }
    },
    [selectedTextChannelId, ingestMessage, setError, t],
  );

  const handleEditMessage = useCallback(
    async (target: Message, content: string) => {
      try {
        const updated = await apiUpdateMessage(target.id, content);
        ingestMessage(updated.channel_id, updated);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : t('chat.editError', { defaultValue: 'Не удалось обновить сообщение' });
        setError(message);
        handleError(err, { action: 'editMessage', messageId: target.id });
        throw err;
      }
    },
    [ingestMessage, setError, t],
  );

  const handleDeleteMessage = useCallback(
    async (target: Message) => {
      try {
        const updated = await apiDeleteMessage(target.id);
        ingestMessage(updated.channel_id, updated);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : t('chat.deleteError', { defaultValue: 'Не удалось удалить сообщение' });
        setError(message);
        handleError(err, { action: 'deleteMessage', messageId: target.id });
        throw err;
      }
    },
    [ingestMessage, setError, t],
  );

  const handleModerateMessage = useCallback(
    async (target: Message, action: 'suppress' | 'restore', note?: string) => {
      try {
        const updated = await apiModerateMessage(target.id, { action, note });
        ingestMessage(updated.channel_id, updated);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : t('chat.moderateError', { defaultValue: 'Не удалось модерировать сообщение' });
        setError(message);
        handleError(err, { action: 'moderateMessage', messageId: target.id, actionType: action });
        throw err;
      }
    },
    [ingestMessage, setError, t],
  );

  const handleAddReaction = useCallback(
    async (target: Message, emoji: string) => {
      try {
        const updated = await apiAddMessageReaction(target.channel_id, target.id, emoji);
        ingestMessage(updated.channel_id, updated);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : t('chat.reactionError', { defaultValue: 'Не удалось обновить реакцию' });
        setError(message);
        handleError(err, { action: 'addReaction', messageId: target.id, emoji });
        throw err;
      }
    },
    [ingestMessage, setError, t],
  );

  const handleRemoveReaction = useCallback(
    async (target: Message, emoji: string) => {
      try {
        const updated = await apiRemoveMessageReaction(target.channel_id, target.id, emoji);
        ingestMessage(updated.channel_id, updated);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : t('chat.reactionError', { defaultValue: 'Не удалось обновить реакцию' });
        setError(message);
        handleError(err, { action: 'removeReaction', messageId: target.id, emoji });
        throw err;
      }
    },
    [ingestMessage, setError, t],
  );

  return {
    handleSendMessage,
    handleEditMessage,
    handleDeleteMessage,
    handleModerateMessage,
    handleAddReaction,
    handleRemoveReaction,
  };
}

