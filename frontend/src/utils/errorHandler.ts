import { ApiError } from '../services/api';
import { logger } from '../services/logger';

export interface ErrorContext {
  action?: string;
  component?: string;
  userId?: number;
  channelId?: number;
  roomSlug?: string;
  [key: string]: unknown;
}

export function handleError(error: unknown, context?: ErrorContext): string {
  let message = 'An unexpected error occurred';
  
  if (error instanceof ApiError) {
    message = error.message;
    logger.warn('API error occurred', context, error);
  } else if (error instanceof Error) {
    message = error.message;
    logger.error('Error occurred', error, context);
  } else if (typeof error === 'string') {
    message = error;
    logger.error('String error occurred', undefined, { ...context, error });
  } else {
    logger.error('Unknown error occurred', undefined, { ...context, error });
  }

  return message;
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 0 || error.status >= 500;
  }
  if (error instanceof Error) {
    return error.message.includes('fetch') || error.message.includes('network');
  }
  return false;
}

export function shouldRetry(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status >= 500 || error.status === 429;
  }
  return isNetworkError(error);
}

