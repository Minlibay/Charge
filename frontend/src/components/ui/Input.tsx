import clsx from 'clsx';
import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export function Input({ className, ...props }: InputProps): JSX.Element {
  return (
    <input
      className={clsx(className)}
      style={{
        padding: 'var(--space-2) var(--space-3)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface)',
        color: 'var(--color-text)',
        fontSize: '0.875rem',
        fontFamily: 'inherit',
        transition: 'all var(--transition-smooth)',
        ...(props.style || {}),
      }}
      onFocus={(e) => {
        e.target.style.outline = 'none';
        e.target.style.borderColor = 'var(--color-primary)';
        e.target.style.boxShadow = 'var(--focus-ring)';
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        e.target.style.borderColor = 'var(--color-border)';
        e.target.style.boxShadow = 'none';
        props.onBlur?.(e);
      }}
      {...props}
    />
  );
}

