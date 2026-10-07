import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError, setCSRF } from './api';
afterEach(() => vi.restoreAllMocks());

it('sends session cookies and CSRF while keeping multipart boundaries intact', async () => {
  const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 201 }));
  setCSRF('test-token');
  const form = new FormData(); form.append('photo', new Blob(['synthetic']), 'test.png');
  await api('patients/patient-id/photos/', { method: 'POST', body: form });
  const options = mock.mock.calls[0][1]!;
  expect(options.credentials).toBe('same-origin');
  expect(options.headers).toHaveProperty('X-CSRFToken', 'test-token');
  expect(options.headers).not.toHaveProperty('Content-Type');
});

it('preserves HTTP status and field errors for failed saves', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ value: ['Must be positive.'] }), { status: 400 }));
  await expect(api('encounters/', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 400, message: 'value: Must be positive.' } satisfies Partial<ApiError>);
});
