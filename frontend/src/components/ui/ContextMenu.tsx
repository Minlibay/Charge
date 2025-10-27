import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  cloneElement,
  isValidElement,
  forwardRef,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefCallback,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

interface Point {
  x: number;
  y: number;
}

interface ContextMenuContextValue {
  open: boolean;
  position: Point | null;
  handleTriggerContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  handleKeyboardOpen: (target: HTMLElement) => void;
  closeMenu: () => void;
  registerTrigger: (node: HTMLElement | null) => void;
  menuRef: MutableRefObject<HTMLDivElement | null>;
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

function useContextMenu(): ContextMenuContextValue {
  const context = useContext(ContextMenuContext);
  if (!context) {
    throw new Error('ContextMenu components must be used within a ContextMenu.Root');
  }
  return context;
}

function composeEventHandlers<E extends { defaultPrevented?: boolean }>(
  originalHandler: ((event: E) => void) | undefined,
  ourHandler: (event: E) => void,
): (event: E) => void {
  return (event) => {
    originalHandler?.(event);
    if (!event.defaultPrevented) {
      ourHandler(event);
    }
  };
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      if (!ref) {
        continue;
      }
      if (typeof ref === 'function') {
        ref(value);
      } else {
        (ref as MutableRefObject<T | null>).current = value;
      }
    }
  };
}

function focusNextItem(menu: HTMLElement, current: HTMLElement, direction: 1 | -1) {
  const items = Array.from(
    menu.querySelectorAll<HTMLElement>('[data-context-menu-item]:not([disabled="true"])'),
  ).filter((element) => !element.hasAttribute('disabled'));
  if (items.length === 0) {
    return;
  }
  const currentIndex = items.indexOf(current);
  const nextIndex = currentIndex === -1
    ? direction === 1
      ? 0
      : items.length - 1
    : (currentIndex + direction + items.length) % items.length;
  items[nextIndex]?.focus();
}

export interface RootProps {
  children: ReactNode;
}

export function Root({ children }: RootProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Point | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const openAt = useCallback((point: Point) => {
    setPosition(point);
    setOpen(true);
  }, []);

  const handleTriggerContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      openAt({ x: event.clientX, y: event.clientY });
    },
    [openAt],
  );

  const handleKeyboardOpen = useCallback(
    (target: HTMLElement) => {
      const rect = target.getBoundingClientRect();
      openAt({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    },
    [openAt],
  );

  const closeMenu = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => {
      triggerRef.current?.focus?.();
    });
  }, []);

  const registerTrigger = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointer = (event: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(event.target as Node)) {
        return;
      }
      closeMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    };

    const handleWindowBlur = () => closeMenu();

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('contextmenu', handlePointer);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('contextmenu', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [closeMenu, open]);

  const value = useMemo(
    () => ({
      open,
      position,
      handleTriggerContextMenu,
      handleKeyboardOpen,
      closeMenu,
      registerTrigger,
      menuRef,
    }),
    [closeMenu, handleKeyboardOpen, handleTriggerContextMenu, open, position, registerTrigger],
  );

  return createElement(ContextMenuContext.Provider, { value }, children);
}

interface TriggerProps extends React.HTMLAttributes<HTMLElement> {
  asChild?: boolean;
  children: ReactNode;
}

export const Trigger = forwardRef<HTMLElement, TriggerProps>(function ContextMenuTrigger(
  { asChild = false, children, ...rest },
  forwardedRef,
) {
  const context = useContextMenu();

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        context.handleKeyboardOpen(event.currentTarget as HTMLElement);
      } else if (event.key === 'Escape') {
        context.closeMenu();
      }
    },
    [context],
  );

  if (asChild) {
    if (!isValidElement(children)) {
      throw new Error('ContextMenu.Trigger with asChild expects a single React element child');
    }
    const child = children as ReactElement;
    const composedRef = mergeRefs<HTMLElement>(
      (child as any).ref,
      forwardedRef,
      (node) => context.registerTrigger(node),
    );
    return cloneElement(child, {
      ...rest,
      onContextMenu: composeEventHandlers(child.props.onContextMenu, context.handleTriggerContextMenu),
      onKeyDown: composeEventHandlers(child.props.onKeyDown, handleKeyDown),
      ref: composedRef,
    });
  }

  const composedRef = mergeRefs<HTMLElement>(forwardedRef, (node) => context.registerTrigger(node));

  return createElement('button', {
    type: 'button',
    ...rest,
    onContextMenu: composeEventHandlers(rest.onContextMenu, context.handleTriggerContextMenu),
    onKeyDown: composeEventHandlers(rest.onKeyDown, handleKeyDown),
    ref: composedRef,
  }, children);
});

interface ContentProps extends React.HTMLAttributes<HTMLDivElement> {
  sideOffset?: number;
  align?: 'start' | 'center' | 'end';
}

export const Content = forwardRef<HTMLDivElement, ContentProps>(function ContextMenuContent(
  { children, className, style, sideOffset = 0, align = 'start', ...rest },
  forwardedRef,
) {
  const context = useContextMenu();
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [computedStyle, setComputedStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node;
      context.menuRef.current = node;
      mergeRefs<HTMLDivElement>(forwardedRef)(node);
    },
    [context.menuRef, forwardedRef],
  );

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!context.open || !context.position || !node) {
      return;
    }

    const { x, y } = context.position;
    const rect = node.getBoundingClientRect();
    const margin = 8;
    let top = y + sideOffset;
    let left = x;

    if (align === 'center') {
      left = x - rect.width / 2;
    } else if (align === 'end') {
      left = x - rect.width;
    }

    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (left < margin) {
      left = margin;
    }
    if (top < margin) {
      top = margin;
    }

    setComputedStyle({
      position: 'fixed',
      top,
      left,
      zIndex: 1000,
      visibility: 'visible',
      ...style,
    });

    const frame = requestAnimationFrame(() => {
      const firstFocusable = node.querySelector<HTMLElement>(
        '[data-context-menu-item]:not([disabled])',
      );
      firstFocusable?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [align, context.open, context.position, sideOffset, style]);

  useEffect(() => {
    return () => {
      if (context.menuRef.current === nodeRef.current) {
        context.menuRef.current = null;
      }
    };
  }, [context.menuRef]);

  if (!context.open || !context.position) {
    return null;
  }

  return createPortal(
    createElement(
      'div',
      {
        role: 'menu',
        tabIndex: -1,
        className,
        ref: setRefs,
        style: computedStyle,
        ...rest,
      },
      children,
    ),
    document.body,
  );
});

interface ItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  onSelect?: () => void;
}

export const Item = forwardRef<HTMLButtonElement, ItemProps>(function ContextMenuItem(
  { children, className, onSelect, disabled, onKeyDown, onMouseEnter, ...rest },
  forwardedRef,
) {
  const context = useContextMenu();

  const handleSelect = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (disabled) {
        return;
      }
      onSelect?.();
      context.closeMenu();
    },
    [context, disabled, onSelect],
  );

  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) {
        if (event.key === 'Escape') {
          context.closeMenu();
        }
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect?.();
        context.closeMenu();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        context.closeMenu();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const menuNode = context.menuRef.current;
        if (menuNode) {
          focusNextItem(menuNode, event.currentTarget, direction);
        }
      }
    },
    [context, disabled, onSelect],
  );

  const handleMouseEnter = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (disabled) {
        return;
      }
      event.currentTarget.focus();
    },
    [disabled],
  );

  return createElement(
    'button',
    {
      type: 'button',
      role: 'menuitem',
      tabIndex: -1,
      className,
      'data-context-menu-item': '',
      disabled,
      'aria-disabled': disabled || undefined,
      ref: mergeRefs(forwardedRef),
      onClick: handleSelect,
      onKeyDown: composeEventHandlers(onKeyDown, handleKey),
      onMouseEnter: composeEventHandlers(onMouseEnter, handleMouseEnter),
      ...rest,
    },
    children,
  );
});

export function Separator({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return createElement('div', { role: 'separator', 'aria-orientation': 'horizontal', className, ...rest });
}

export function Label({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return createElement('div', { className, ...rest }, children);
}

export function Portal({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}
