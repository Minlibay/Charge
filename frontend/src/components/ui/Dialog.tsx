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
  return <div className={clsx('modal-content', className)}>{children}</div>;
}

interface DialogHeaderProps {
  children: React.ReactNode;
}

export function DialogHeader({ children }: DialogHeaderProps): JSX.Element {
  return (
    <header className="modal-header">
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
    <h2 id={id} className="modal-title">
      {children}
    </h2>
  );
}

interface DialogFooterProps {
  children: React.ReactNode;
}

export function DialogFooter({ children }: DialogFooterProps): JSX.Element {
  return (
    <div className="modal-footer">
      {children}
    </div>
  );
}

