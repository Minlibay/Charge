import { useCallback } from 'react';
import { useSyncExternalStore } from 'react';

import { getToken, setToken, subscribe } from '../services/storage';

export function useToken(): [string | null, (value: string | null) => void] {
  const token = useSyncExternalStore(subscribe, getToken, getToken);

  const updateToken = useCallback((value: string | null) => {
    setToken(value);
  }, []);

  return [token, updateToken];
}
