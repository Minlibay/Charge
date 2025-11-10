import { createPortal } from 'react-dom';
import { useEffect } from 'react';
import clsx from 'clsx';

interface DialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange?.(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onOpenChange]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="modal-overlay" role="presentation" onClick={() => onOpenChange?.(false)}>
      <div className="modal-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface DialogContentProps {
  className?: string;
  children: React.ReactNode;
}

export function DialogContent({ className, children }: DialogContentProps): JSX.Element {
  return <div className={clsx(className)} style={{ padding: 'var(--space-4) var(--space-5) var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', overflowY: 'auto' }}>{children}</div>;
}

interface DialogHeaderProps {
  children: React.ReactNode;
}

export function DialogHeader({ children }: DialogHeaderProps): JSX.Element {
  return (
    <header
      className="modal-header"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        padding: 'var(--space-5) var(--space-5) var(--space-3)',
        borderBottom: '1px solid color-mix(in srgb, var(--color-border) 80%, transparent)',
      }}
    >
      {children}
    </header>
  );
}

interface DialogTitleProps {
  children: React.ReactNode;
  id?: string;
}

export function DialogTitle({ children, id }: DialogTitleProps): JSX.Element {
  return (
    <h2
      id={id}
      className="modal-title"
      style={{
        margin: 0,
        fontSize: '1.35rem',
        fontWeight: 700,
      }}
    >
      {children}
    </h2>
  );
}

interface DialogFooterProps {
  children: React.ReactNode;
}

export function DialogFooter({ children }: DialogFooterProps): JSX.Element {
  return (
    <div
      className="modal-footer"
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 'var(--space-3)',
        paddingTop: 'var(--space-2)',
      }}
    >
      {children}
    </div>
  );
}

