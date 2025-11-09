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

function getPathFromLocation(): string {
  if (typeof window === 'undefined') {
    return '/';
  }
  // Support hash routing: #/path -> /path
  const hash = window.location.hash;
  if (hash && hash.startsWith('#/')) {
    return normalizePath(hash.slice(1));
  }
  return normalizePath(window.location.pathname);
}

export function Router({ children }: PropsWithChildren): JSX.Element {
  const [path, setPath] = useState<string>(getPathFromLocation);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handlePopState = () => {
      setPath(getPathFromLocation());
    };
    const handleHashChange = () => {
      setPath(getPathFromLocation());
    };
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

  const navigate = useCallback<RouterValue['navigate']>((nextPath, options) => {
    const target = normalizePath(nextPath);
    if (typeof window === 'undefined') {
      setPath(target);
      return;
    }
    // Use hash routing for all paths
    const hashPath = `#${target}`;
    if (options?.replace) {
      window.history.replaceState(null, '', hashPath);
    } else {
      window.history.pushState(null, '', hashPath);
    }
    setPath(target);
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

export function useRouteMatch(pattern: RegExp): RegExpMatchArray | null {
  const pathname = usePathname();
  return useMemo(() => pathname.match(pattern), [pathname, pattern]);
}
