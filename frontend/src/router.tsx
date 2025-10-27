import type { PropsWithChildren } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

interface RouterValue {
  path: string;
  navigate: (path: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | undefined>(undefined);

function normalizePath(path: string): string {
  if (!path) {
    return '/';
  }
  return path.startsWith('/') ? path : `/${path}`;
}

export function Router({ children }: PropsWithChildren): JSX.Element {
  const [path, setPath] = useState<string>(() => {
    if (typeof window === 'undefined') {
      return '/';
    }
    return normalizePath(window.location.pathname);
  });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handlePopState = () => {
      setPath(normalizePath(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback<RouterValue['navigate']>((nextPath, options) => {
    const target = normalizePath(nextPath);
    if (typeof window === 'undefined') {
      setPath(target);
      return;
    }
    if (options?.replace) {
      window.history.replaceState(null, '', target);
    } else {
      window.history.pushState(null, '', target);
    }
    setPath(normalizePath(window.location.pathname));
  }, []);

  const value = useMemo<RouterValue>(() => ({ path, navigate }), [navigate, path]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useRouter must be used within Router');
  }
  return context;
}

export function useNavigate(): RouterValue['navigate'] {
  return useRouter().navigate;
}

export function usePathname(): string {
  return useRouter().path;
}
