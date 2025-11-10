import { useEffect, useRef } from 'react';
import { fetchVoiceParticipants } from '../services/api';
import { useWorkspaceStore } from '../state/workspaceStore';
import { logger } from '../services/logger';

const POLL_INTERVAL = 5000; // 5 seconds
const POLL_INTERVAL_WHEN_CONNECTED = 10000; // 10 seconds when connected (less frequent)

/**
 * Hook to fetch and update voice room participants periodically.
 * This allows users to see who is in voice channels before connecting.
 */
export function useVoiceParticipants(): void {
  const roomSlug = useWorkspaceStore((state) => state.selectedRoomSlug);
  const connectionStatus = useWorkspaceStore((state) => state.voiceConnectionStatus);
  const setVoiceParticipants = useWorkspaceStore((state) => state.setVoiceParticipants);
  const setVoiceStats = useWorkspaceStore((state) => state.setVoiceStats);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!roomSlug) {
      // Clear interval if no room is selected
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Fetch participants immediately
    const fetchParticipants = async () => {
      try {
        const response = await fetchVoiceParticipants(roomSlug);
        setVoiceParticipants(roomSlug, response.participants);
        setVoiceStats(roomSlug, response.stats);
      } catch (error) {
        // Silently fail - user might not have permission or room might not exist
        // Only log in development
        if (import.meta.env?.DEV) {
          logger.debug('Failed to fetch voice participants', {
            roomSlug,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    // Fetch immediately
    void fetchParticipants();

    // Set up polling interval
    // Use longer interval when connected (WebSocket will update in real-time anyway)
    const interval = connectionStatus === 'connected' 
      ? POLL_INTERVAL_WHEN_CONNECTED 
      : POLL_INTERVAL;

    intervalRef.current = window.setInterval(() => {
      void fetchParticipants();
    }, interval);

    // Cleanup on unmount or room change
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [roomSlug, connectionStatus, setVoiceParticipants, setVoiceStats]);
}

