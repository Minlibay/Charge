import { logger } from '../services/logger';

export interface MediaDeviceLists {
  microphones: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

export async function listMediaDevices(): Promise<MediaDeviceLists> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { microphones: [], speakers: [], cameras: [] };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === 'audioinput');
  const speakers = devices.filter((device) => device.kind === 'audiooutput');
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  return { microphones, speakers, cameras };
}

export async function requestMediaStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Media devices are not available in this environment');
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function isSetSinkIdSupported(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const audio = document.createElement('audio') as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  return typeof audio.setSinkId === 'function';
}

export async function applyOutputDevice(
  element: HTMLMediaElement,
  deviceId: string | null,
): Promise<void> {
  const audioElement = element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (!audioElement.setSinkId) {
    return;
  }
  try {
    await audioElement.setSinkId(deviceId ?? 'default');
  } catch (error) {
    logger.warn('Failed to apply output device', undefined, error instanceof Error ? error : new Error(String(error)));
  }
}
