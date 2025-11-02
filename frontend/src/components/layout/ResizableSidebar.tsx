import clsx from 'clsx';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
  type KeyboardEvent,
} from 'react';

import { getStoredSidebarWidth, setStoredSidebarWidth } from '../../services/storage';
import styles from './ResizableSidebar.module.css';

interface ResizableSidebarProps {
  storageKey: string;
  children: ReactNode;
  position?: 'left' | 'right';
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  className?: string;
  ariaLabel?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ResizableSidebar({
  storageKey,
  children,
  position = 'left',
  minWidth = 200,
  maxWidth = 420,
  defaultWidth = 260,
  className,
  ariaLabel,
}: ResizableSidebarProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(defaultWidth);
  const draggingRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pointerTargetRef = useRef<
    (EventTarget & { releasePointerCapture: (pointerId: number) => void }) | null
  >(null);
  const [width, setWidth] = useState(() => {
    const stored = getStoredSidebarWidth(storageKey);
    if (stored != null) {
      return clamp(stored, minWidth, maxWidth);
    }
    return clamp(defaultWidth, minWidth, maxWidth);
  });

  useEffect(() => {
    return () => {
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setStoredSidebarWidth(storageKey, Math.round(width));
  }, [storageKey, width]);

  const updateWidth = useCallback(
    (next: number) => {
      const value = clamp(next, minWidth, maxWidth);
      setWidth((current) => {
        if (Math.abs(current - value) < 0.5) {
          return current;
        }
        return value;
      });
    },
    [maxWidth, minWidth],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent | globalThis.PointerEvent) => {
      if (!draggingRef.current) {
        return;
      }
      const delta = event.clientX - startXRef.current;
      const direction = position === 'left' ? delta : -delta;
      const nextWidth = startWidthRef.current + direction;
      frameRef.current = requestAnimationFrame(() => {
        updateWidth(nextWidth);
      });
      event.preventDefault();
    },
    [position, updateWidth],
  );

  const stopDragging = useCallback(
    (event: globalThis.PointerEvent) => {
      if (!draggingRef.current) {
        return;
      }
      draggingRef.current = false;
      pointerTargetRef.current?.releasePointerCapture(event.pointerId);
      pointerTargetRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove as any);
      window.removeEventListener('pointerup', stopDragging as any);
      window.removeEventListener('pointercancel', stopDragging as any);
    },
    [handlePointerMove],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      const container = containerRef.current;
      if (!container) {
        return;
      }
      draggingRef.current = true;
      startXRef.current = event.clientX;
      startWidthRef.current = container.getBoundingClientRect().width;
      pointerTargetRef.current = event.currentTarget;
      event.currentTarget.setPointerCapture(event.pointerId);
      window.addEventListener('pointermove', handlePointerMove as any);
      window.addEventListener('pointerup', stopDragging as any);
      window.addEventListener('pointercancel', stopDragging as any);
      event.preventDefault();
    },
    [handlePointerMove, stopDragging],
  );

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handlePointerMove as any);
      window.removeEventListener('pointerup', stopDragging as any);
      window.removeEventListener('pointercancel', stopDragging as any);
    };
  }, [handlePointerMove, stopDragging]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 40 : 20;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        const delta = position === 'left' ? -step : step;
        updateWidth(width + delta);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        const delta = position === 'left' ? step : -step;
        updateWidth(width + delta);
      } else if (event.key === 'Home') {
        event.preventDefault();
        updateWidth(minWidth);
      } else if (event.key === 'End') {
        event.preventDefault();
        updateWidth(maxWidth);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        updateWidth(defaultWidth);
      }
    },
    [defaultWidth, maxWidth, minWidth, position, updateWidth, width],
  );

  const handleDoubleClick = useCallback(() => {
    updateWidth(defaultWidth);
  }, [defaultWidth, updateWidth]);

  const style = useMemo(
    () => ({
      width,
      flexBasis: width,
      minWidth,
      maxWidth,
    }),
    [maxWidth, minWidth, width],
  );

  const handleClassName = position === 'left' ? styles.handleRight : styles.handleLeft;

  return (
    <div ref={containerRef} className={clsx(styles.container, className)} style={style}>
      {children}
      <div
        role="separator"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.round(width)}
        className={clsx(styles.handle, handleClassName)}
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
