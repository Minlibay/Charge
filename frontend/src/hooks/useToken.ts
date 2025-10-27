import { useCallback } from 'react';
import { useSyncExternalStore } from 'react';

import { getAccessToken, setAccessToken, subscribe } from '../services/session';

export function useToken(): [string | null, (value: string | null) => void] {
  const token = useSyncExternalStore(subscribe, getAccessToken, getAccessToken);

  const updateToken = useCallback((value: string | null) => {
    setAccessToken(value);
  }, []);

  return [token, updateToken];
}
