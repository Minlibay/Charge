import clsx from 'clsx';
import type { LabelHTMLAttributes } from 'react';

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {}

export function Label({ className, children, ...props }: LabelProps): JSX.Element {
  return (
    <label
      className={clsx(className)}
      style={{
        fontSize: '0.875rem',
        fontWeight: 500,
        color: 'var(--color-text)',
        marginBottom: 'var(--space-1)',
        display: 'block',
        ...(props.style || {}),
      }}
      {...props}
    >
      {children}
    </label>
  );
}

