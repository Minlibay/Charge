import clsx from 'clsx';
import type { CSSProperties } from 'react';

import styles from './Skeleton.module.css';

export type SkeletonShape = 'rounded' | 'circle' | 'pill';

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  shape?: SkeletonShape;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

export function Skeleton({
  width = '100%',
  height = '1rem',
  shape,
  className,
  style,
  ariaLabel,
}: SkeletonProps): JSX.Element {
  const mergedStyle: CSSProperties = {
    width,
    height,
    ...style,
  };

  return (
    <span
      className={clsx(styles.skeleton, shape && styles[shape], className)}
      style={mergedStyle}
      role="presentation"
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
    />
  );
}
