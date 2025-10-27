import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface DraggableLocation {
  droppableId: string;
  index: number;
}

export interface DropResult {
  draggableId: string;
  type: string;
  source: DraggableLocation;
  destination: DraggableLocation | null;
  reason: 'DROP' | 'CANCEL';
  combine: null;
  mode: 'FLUID';
}

export interface ResponderProvided {
  announce: (message: string) => void;
}

interface ActiveDrag {
  draggableId: string;
  droppableId: string;
  index: number;
  type: string;
}

interface DragDropManagerValue {
  activeDrag: ActiveDrag | null;
  beginDrag: (drag: ActiveDrag) => void;
  completeDrop: (destination: DraggableLocation) => void;
  cancelDrag: () => void;
}

const DragDropManagerContext = createContext<DragDropManagerValue | null>(null);

function useDragDropManager(): DragDropManagerValue {
  const value = useContext(DragDropManagerContext);
  if (!value) {
    throw new Error('DragDrop components must be used within a DragDropContext');
  }
  return value;
}

const noOpResponder: ResponderProvided = {
  announce: () => undefined,
};

export interface DragDropContextProps {
  children?: ReactNode;
  onDragEnd: (result: DropResult, provided: ResponderProvided) => void;
}

export function DragDropContext({ children, onDragEnd }: DragDropContextProps): JSX.Element {
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);

  const fireResult = useCallback(
    (destination: DraggableLocation | null) => {
      const drag = activeDragRef.current;
      if (!drag) {
        return;
      }
      const result: DropResult = {
        draggableId: drag.draggableId,
        type: drag.type,
        source: { droppableId: drag.droppableId, index: drag.index },
        destination,
        reason: destination ? 'DROP' : 'CANCEL',
        combine: null,
        mode: 'FLUID',
      };
      activeDragRef.current = null;
      setActiveDrag(null);
      onDragEnd(result, noOpResponder);
    },
    [onDragEnd],
  );

  const beginDrag = useCallback((drag: ActiveDrag) => {
    activeDragRef.current = drag;
    setActiveDrag(drag);
  }, []);

  const completeDrop = useCallback(
    (destination: DraggableLocation) => {
      fireResult(destination);
    },
    [fireResult],
  );

  const cancelDrag = useCallback(() => {
    fireResult(null);
  }, [fireResult]);

  const value = useMemo<DragDropManagerValue>(() => ({
    activeDrag,
    beginDrag,
    completeDrop,
    cancelDrag,
  }), [activeDrag, beginDrag, completeDrop, cancelDrag]);

  return (
    <DragDropManagerContext.Provider value={value}>{children}</DragDropManagerContext.Provider>
  );
}

interface DroppableContextValue {
  droppableId: string;
  type: string;
  direction: 'vertical' | 'horizontal';
}

const DroppableContext = createContext<DroppableContextValue | null>(null);

function useDroppable(): DroppableContextValue {
  const value = useContext(DroppableContext);
  if (!value) {
    throw new Error('Draggable components must be rendered within a Droppable');
  }
  return value;
}

export interface DroppableProvided {
  innerRef: (element: HTMLElement | null) => void;
  droppableProps: Record<string, unknown>;
  placeholder: ReactNode;
}

export interface DroppableStateSnapshot {
  isDraggingOver: boolean;
  draggingFromThisWith?: string | null;
  draggingOverWith?: string | null;
}

export interface DroppableProps {
  droppableId: string;
  type?: string;
  direction?: 'vertical' | 'horizontal';
  isDropDisabled?: boolean;
  children: (provided: DroppableProvided, snapshot: DroppableStateSnapshot) => ReactNode;
}

function computeInsertIndex(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  axis: 'vertical' | 'horizontal',
): number {
  const items = Array.from(
    container.querySelectorAll<HTMLElement>('[data-simple-dnd-draggable="true"]'),
  ).filter((item) => item.dataset.droppableId === container.dataset.droppableId);

  if (items.length === 0) {
    return 0;
  }

  for (let index = 0; index < items.length; index += 1) {
    const element = items[index];
    const rect = element.getBoundingClientRect();
    if (axis === 'vertical') {
      if (clientY < rect.top + rect.height / 2) {
        return index;
      }
    } else if (clientX < rect.left + rect.width / 2) {
      return index;
    }
  }

  return items.length;
}

export function Droppable({
  droppableId,
  type = 'DEFAULT',
  direction = 'vertical',
  isDropDisabled = false,
  children,
}: DroppableProps): JSX.Element {
  const manager = useDragDropManager();
  const containerRef = useRef<HTMLElement | null>(null);
  const [isDraggingOver, setDraggingOver] = useState(false);

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (isDropDisabled || !manager.activeDrag || manager.activeDrag.type !== type) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    [isDropDisabled, manager.activeDrag, type],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (isDropDisabled || !manager.activeDrag || manager.activeDrag.type !== type) {
        return;
      }
      event.preventDefault();
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const index = computeInsertIndex(container, event.clientX, event.clientY, direction);
      manager.completeDrop({ droppableId, index });
      setDraggingOver(false);
    },
    [direction, droppableId, isDropDisabled, manager, type],
  );

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (isDropDisabled || !manager.activeDrag || manager.activeDrag.type !== type) {
        return;
      }
      if (event.currentTarget === event.target) {
        setDraggingOver(true);
      }
    },
    [isDropDisabled, manager.activeDrag, type],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!containerRef.current) {
      return;
    }
    if (event.currentTarget.contains(event.relatedTarget as Node)) {
      return;
    }
    setDraggingOver(false);
  }, []);

  useEffect(() => {
    if (!manager.activeDrag) {
      setDraggingOver(false);
    }
  }, [manager.activeDrag]);

  const setRef = useCallback(
    (element: HTMLElement | null) => {
      containerRef.current = element;
      if (element) {
        element.setAttribute('data-simple-dnd-droppable', 'true');
        element.dataset.droppableId = droppableId;
        element.dataset.dndDirection = direction;
      }
    },
    [direction, droppableId],
  );

  const provided: DroppableProvided = useMemo(
    () => ({
      innerRef: setRef,
      droppableProps: {
        onDragOver: handleDragOver,
        onDrop: handleDrop,
        onDragEnter: handleDragEnter,
        onDragLeave: handleDragLeave,
      },
      placeholder: null,
    }),
    [handleDragEnter, handleDragLeave, handleDragOver, handleDrop, setRef],
  );

  const snapshot: DroppableStateSnapshot = useMemo(
    () => ({
      isDraggingOver,
      draggingFromThisWith:
        manager.activeDrag?.droppableId === droppableId ? manager.activeDrag?.draggableId : undefined,
      draggingOverWith: manager.activeDrag?.draggableId,
    }),
    [isDraggingOver, manager.activeDrag, droppableId],
  );

  const contextValue = useMemo(
    () => ({ droppableId, type, direction }),
    [direction, droppableId, type],
  );

  return (
    <DroppableContext.Provider value={contextValue}>
      {children(provided, snapshot)}
    </DroppableContext.Provider>
  );
}

export interface DraggableProvided {
  innerRef: (element: HTMLElement | null) => void;
  draggableProps: Record<string, unknown>;
  dragHandleProps: Record<string, unknown>;
}

export interface DraggableStateSnapshot {
  isDragging: boolean;
  isDropAnimating: boolean;
}

export interface DraggableProps {
  draggableId: string;
  index: number;
  isDragDisabled?: boolean;
  children: (provided: DraggableProvided, snapshot: DraggableStateSnapshot) => ReactNode;
}

export function Draggable({
  draggableId,
  index,
  isDragDisabled = false,
  children,
}: DraggableProps): JSX.Element {
  const manager = useDragDropManager();
  const droppable = useDroppable();
  const nodeRef = useRef<HTMLElement | null>(null);

  const setRef = useCallback(
    (element: HTMLElement | null) => {
      nodeRef.current = element;
      if (element) {
        element.setAttribute('data-simple-dnd-draggable', 'true');
        element.dataset.draggableId = draggableId;
        element.dataset.droppableId = droppable.droppableId;
      }
    },
    [draggableId, droppable.droppableId],
  );

  useEffect(() => {
    if (nodeRef.current) {
      nodeRef.current.dataset.droppableId = droppable.droppableId;
    }
  }, [droppable.droppableId]);

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (isDragDisabled) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      event.dataTransfer.effectAllowed = 'move';
      manager.beginDrag({
        draggableId,
        droppableId: droppable.droppableId,
        index,
        type: droppable.type,
      });
    },
    [draggableId, droppable.droppableId, droppable.type, index, isDragDisabled, manager],
  );

  const handleDragEnd = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      event.stopPropagation();
      manager.cancelDrag();
    },
    [manager],
  );

  const draggableProps = useMemo(
    () => ({
      draggable: !isDragDisabled,
      onDragStart: handleDragStart,
      onDragEnd: handleDragEnd,
    }),
    [handleDragEnd, handleDragStart, isDragDisabled],
  );

  const provided: DraggableProvided = useMemo(
    () => ({
      innerRef: setRef,
      draggableProps,
      dragHandleProps: draggableProps,
    }),
    [draggableProps, setRef],
  );

  const snapshot: DraggableStateSnapshot = useMemo(
    () => ({
      isDragging: manager.activeDrag?.draggableId === draggableId,
      isDropAnimating: false,
    }),
    [draggableId, manager.activeDrag],
  );

  return <>{children(provided, snapshot)}</>;
}
