import clsx from 'clsx';
import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import styles from './Toast.module.css';

export type ToastType = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface ToastOptions {
  id?: string;
  title?: string;
  description?: string;
  type?: ToastType;
  duration?: number;
  action?: ToastAction;
}

interface ToastEntry extends ToastOptions {
  id: string;
  type: ToastType;
}

interface ToastContextValue {
  pushToast: (options: ToastOptions) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 4000;

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export function ToastProvider({ children }: PropsWithChildren): JSX.Element {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const dismissToast = useCallback((id: string) => {
    timersRef.current.get(id) && window.clearTimeout(timersRef.current.get(id));
    timersRef.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const scheduleRemoval = useCallback(
    (id: string, duration: number | undefined) => {
      if (duration === Infinity || duration === 0) {
        return;
      }
      const timeout = window.setTimeout(() => {
        dismissToast(id);
      }, duration ?? DEFAULT_DURATION);
      timersRef.current.set(id, timeout);
    },
    [dismissToast],
  );

  const pushToast = useCallback(
    (options: ToastOptions) => {
      const id = options.id ?? generateId();
      const existingTimer = timersRef.current.get(id);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
        timersRef.current.delete(id);
      }
      setToasts((current) => {
        const entry: ToastEntry = {
          ...options,
          id,
          type: options.type ?? 'info',
        };
        return [...current.filter((toast) => toast.id !== id), entry];
      });
      if (typeof window !== 'undefined') {
        scheduleRemoval(id, options.duration ?? DEFAULT_DURATION);
      }
      return id;
    },
    [scheduleRemoval],
  );

  const clearToasts = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current.clear();
    setToasts([]);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      pushToast,
      dismissToast,
      clearToasts,
    }),
    [clearToasts, dismissToast, pushToast],
  );

  const viewport = mounted
    ? createPortal(
        <div className={styles.viewport} aria-live="polite" aria-atomic="true">
          {toasts.map((toast) => (
            <div key={toast.id} className={clsx(styles.toast)} data-type={toast.type} role="status">
              {toast.title && <div className={styles.title}>{toast.title}</div>}
              {toast.description && <div className={styles.description}>{toast.description}</div>}
              <div className={styles.actions}>
                {toast.action && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      toast.action?.onPress();
                      dismissToast(toast.id);
                    }}
                  >
                    {toast.action.label}
                  </button>
                )}
                <button
                  type="button"
                  className={clsx('ghost', styles.closeButton)}
                  onClick={() => dismissToast(toast.id)}
                  aria-label="Dismiss notification"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )
    : null;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {viewport}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}
