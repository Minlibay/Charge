import { useCallback } from 'react';
import { useSyncExternalStore } from 'react';

import { getApiBase, setApiBase, subscribe } from '../services/storage';

export function useApiBase(): [string, (value: string | null) => void] {
  const apiBase = useSyncExternalStore(subscribe, getApiBase, getApiBase);

  const updateApiBase = useCallback((value: string | null) => {
    setApiBase(value);
  }, []);

  return [apiBase, updateApiBase];
}
