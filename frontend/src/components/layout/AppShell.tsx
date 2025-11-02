import clsx from 'clsx';
import type { HTMLAttributes, PropsWithChildren, ReactNode } from 'react';

import styles from './AppShell.module.css';

interface AppShellProps {
  header?: ReactNode;
  primarySidebar?: ReactNode;
  secondarySidebar?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  mainProps?: HTMLAttributes<HTMLElement>;
}

export function AppShell({
  header,
  primarySidebar,
  secondarySidebar,
  aside,
  children,
  className,
  mainProps,
}: PropsWithChildren<AppShellProps>): JSX.Element {
  return (
    <div className={clsx(styles.appShell, className)}>
      {header && <div className={styles.header}>{header}</div>}
      <div className={styles.layout}>
        {primarySidebar && <div className={styles.sidebar}>{primarySidebar}</div>}
        {secondarySidebar && (
          <div className={clsx(styles.sidebar, styles.secondarySidebar)}>{secondarySidebar}</div>
        )}
        <main className={styles.main} {...mainProps}>
          {children}
        </main>
        {aside && <aside className={styles.aside}>{aside}</aside>}
      </div>
    </div>
  );
}
