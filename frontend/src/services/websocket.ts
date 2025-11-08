import { logger } from './logger';

export interface JsonWebSocketHandlers<TMessage = unknown> {
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  onMessage?: (message: TMessage, rawEvent: MessageEvent) => void;
}

export function createJsonWebSocket<TMessage = unknown>(
  url: string,
  handlers: JsonWebSocketHandlers<TMessage> = {},
): WebSocket {
  const socket = new WebSocket(url);

  if (handlers.onOpen) {
    socket.addEventListener('open', handlers.onOpen);
  }
  if (handlers.onClose) {
    socket.addEventListener('close', handlers.onClose);
  }
  if (handlers.onError) {
    socket.addEventListener('error', handlers.onError);
  }
  if (handlers.onMessage) {
    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as TMessage;
        handlers.onMessage?.(data, event);
      } catch (error) {
        logger.error('Failed to parse WebSocket message', error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return socket;
}

export function sendJson(socket: WebSocket | null | undefined, payload: Record<string, unknown>): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket is not ready');
  }
  socket.send(JSON.stringify(payload));
}
