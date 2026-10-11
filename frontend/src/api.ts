let csrfToken = '';
export const setCSRF = (token: string) => {
  csrfToken = token;
};

// Called when the server says nobody is signed in, so the workspace can lock instead of losing work.
let unauthorizedHandler: (() => void) | null = null;
export const setUnauthorizedHandler = (handler: (() => void) | null) => {
  unauthorizedHandler = handler;
};

let lastContact = Date.now();
export const msSinceServerContact = () => Date.now() - lastContact;

export const LOCKED_MESSAGE =
  'Not saved because the workspace was locked. Your work is still here; try again after unlocking.';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** What the server sent, for the few callers that need more than the sentence. */
    public data?: unknown,
  ) {
    super(message);
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(describe).join(' ');
  if (value && typeof value === 'object' && typeof (value as { detail?: unknown }).detail === 'string')
    return (value as { detail: string }).detail;
  if (value && typeof value === 'object')
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${describe(item)}`)
      .join(' · ');
  return 'The request could not be completed.';
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'X-CSRFToken': csrfToken,
      ...options.headers,
    },
  });
  const data: unknown = await response.json().catch(() => ({
    detail: 'The server could not complete the request. Refresh and sign in again if your session expired.',
  }));
  if (response.status === 401 && !path.startsWith('auth/')) {
    unauthorizedHandler?.();
    throw new ApiError(401, LOCKED_MESSAGE);
  }
  // The server slows down anything that asks far faster than a person at a desk would.
  if (response.status === 429 && !path.startsWith('auth/'))
    throw new ApiError(429, 'Too much at once for the clinic computer. Wait a few seconds, then try again.', data);
  if (!response.ok) throw new ApiError(response.status, describe(data), data);
  lastContact = Date.now();
  return data as T;
}

export async function initializeCSRF() {
  const data = await api<{ csrf_token: string }>('auth/csrf/');
  setCSRF(data.csrf_token);
}
