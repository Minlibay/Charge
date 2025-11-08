import { logger } from '../services/logger';

let pendingPermission: Promise<NotificationPermission> | null = null;
let sharedAudioContext: AudioContext | null = null;

function resolveAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return ctor ?? null;
}

async function ensureAudioContext(): Promise<AudioContext | null> {
  const ctor = resolveAudioContextConstructor();
  if (!ctor) {
    return null;
  }
  if (!sharedAudioContext) {
    sharedAudioContext = new ctor();
  }
  if (sharedAudioContext.state === 'suspended') {
    try {
      await sharedAudioContext.resume();
    } catch (error) {
      logger.warn('Failed to resume audio context', undefined, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }
  return sharedAudioContext;
}

export function canUseNotifications(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!canUseNotifications()) {
    return 'denied';
  }
  if (Notification.permission !== 'default') {
    return Notification.permission;
  }
  if (!pendingPermission) {
    try {
      pendingPermission = Notification.requestPermission().finally(() => {
        pendingPermission = null;
      });
    } catch (error) {
      logger.warn('Failed to request notification permission', undefined, error instanceof Error ? error : new Error(String(error)));
      return Notification.permission;
    }
  }
  return pendingPermission;
}

export async function showBrowserNotification(
  title: string,
  options?: NotificationOptions,
): Promise<Notification | null> {
  if (!canUseNotifications()) {
    return null;
  }
  const permission = await requestNotificationPermission();
  if (permission !== 'granted') {
    return null;
  }
  try {
    return new Notification(title, options);
  } catch (error) {
    logger.warn('Failed to show notification', undefined, error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

export async function playNotificationSound(options: { type?: 'message' | 'mention' } = {}): Promise<void> {
  const context = await ensureAudioContext();
  if (!context) {
    return;
  }
  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const type = options.type ?? 'message';

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(type === 'mention' ? 880 : 660, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.4);
}
