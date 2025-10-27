import { apiFetch, ApiError } from './api';
import type { TokenResponse } from './session';
import { storeTokenResponse } from './session';
import type { RoomDetail, User } from '../types';

export interface LoginPayload {
  login: string;
  password: string;
}

export interface RegisterPayload extends LoginPayload {
  display_name?: string | null;
}

export async function login(credentials: LoginPayload): Promise<void> {
  const token = await apiFetch<TokenResponse>('/api/auth/login', {
    method: 'POST',
    json: credentials,
  });
  storeTokenResponse(token);
}

export async function register(payload: RegisterPayload): Promise<User> {
  return apiFetch<User>('/api/auth/register', {
    method: 'POST',
    json: payload,
  });
}

export async function loginAfterRegister(payload: RegisterPayload): Promise<void> {
  try {
    await login({ login: payload.login, password: payload.password });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError('Registration succeeded but automatic login failed', error.status);
    }
    throw error;
  }
}

export async function joinRoomByInvite(code: string): Promise<RoomDetail> {
  return apiFetch<RoomDetail>(`/api/invites/${encodeURIComponent(code)}`, {
    method: 'POST',
  });
}
