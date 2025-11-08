import { useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../state/workspaceStore';
import { getCurrentUserId } from '../services/session';
import { updateMessageReceipt as apiUpdateMessageReceipt } from '../services/api';
import { TEXT_CHANNEL_TYPES } from '../types';
import { logger } from '../services/logger';

export function useMessageAcknowledgement(
  selectedChannelId: number | null | undefined,
  currentChannelType: string | null,
  messages: Array<{ id: number; read_at: string | null; author_id: number | null }>,
) {
  const ingestMessage = useWorkspaceStore((state) => state.ingestMessage);
  const ackPendingRef = useRef<Set<number>>(new Set());
  const currentUserId = getCurrentUserId();

  useEffect(() => {
    if (
      !selectedChannelId ||
      currentChannelType === null ||
      !TEXT_CHANNEL_TYPES.includes(currentChannelType as any)
    ) {
      return;
    }
    if (messages.length === 0) {
      return;
    }
    const pending = ackPendingRef.current;
    const targets = messages.filter((message) => {
      if (message.read_at) {
        return false;
      }
      if (message.author_id !== null && message.author_id === currentUserId) {
        return false;
      }
      return !pending.has(message.id);
    });
    if (targets.length === 0) {
      return;
    }

    let cancelled = false;

    const acknowledge = async () => {
      for (const message of targets) {
        if (cancelled) {
          break;
        }
        pending.add(message.id);
        try {
          const updated = await apiUpdateMessageReceipt(selectedChannelId, message.id, {
            delivered: true,
            read: true,
          });
          if (!cancelled) {
            ingestMessage(selectedChannelId, updated);
          }
        } catch (error) {
          logger.warn('Failed to acknowledge message', { messageId: message.id }, error instanceof Error ? error : new Error(String(error)));
        } finally {
          pending.delete(message.id);
        }
      }
    };

    void acknowledge();

    return () => {
      cancelled = true;
    };
  }, [currentChannelType, currentUserId, ingestMessage, messages, selectedChannelId]);
}

