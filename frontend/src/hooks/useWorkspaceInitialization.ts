import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useDirectStore } from '../stores/directStore';
import { initializeSession } from '../services/session';
import { requestNotificationPermission } from '../utils/notifications';
import { logger } from '../services/logger';

export function useWorkspaceInitialization(token: string | null) {
  const { t } = useTranslation();
  const initialize = useWorkspaceStore((state) => state.initialize);
  const resetStore = useWorkspaceStore((state) => state.reset);
  const clearFriends = useDirectStore((state) => state.clear);
  const setError = useWorkspaceStore((state) => state.setError);
  const previousTokenRef = useRef<string | null>(null);

  useEffect(() => {
    void initializeSession().catch((err) => {
      logger.warn('Failed to initialize session', undefined, err instanceof Error ? err : new Error(String(err)));
    });
  }, []);

  useEffect(() => {
    if (token) {
      if (previousTokenRef.current !== token) {
        previousTokenRef.current = token;
        initialize().catch((err) => {
          const message = err instanceof Error ? err.message : t('errors.loadRooms');
          setError(message);
          logger.error('Failed to initialize workspace', err instanceof Error ? err : new Error(String(err)), {
            action: 'initialize',
          });
        });
      }
    } else {
      previousTokenRef.current = null;
      resetStore();
      clearFriends();
    }
  }, [clearFriends, initialize, resetStore, setError, t, token]);

  useEffect(() => {
    if (!token) {
      return;
    }
    void requestNotificationPermission().catch((error) => {
      logger.warn('Notification permission request failed', undefined, error instanceof Error ? error : new Error(String(error)));
    });
  }, [token]);
}

