let csrfToken = '';
export const setCSRF = (token: string) => { csrfToken = token; };

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(describe).join(' ');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${describe(item)}`).join(' · ');
  return 'The request could not be completed.';
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    ...options, credentials: 'same-origin',
    headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'X-CSRFToken': csrfToken, ...options.headers },
  });
  const data: unknown = await response.json().catch(() => ({ detail: 'The server could not complete the request. Refresh and sign in again if your session expired.' }));
  if (!response.ok) throw new ApiError(response.status, describe(data));
  return data as T;
}

export async function initializeCSRF() {
  const data = await api<{ csrf_token: string }>('auth/csrf/');
  setCSRF(data.csrf_token);
}
