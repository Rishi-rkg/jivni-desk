import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { Session } from './types';

const KEY = 'RWBE-R65Z-3CFB-9G6W-XGHN-8KWM-2B9Z-AVKX-N46X-1YMT';
const session: Session = {
  user: { id: 'user-id', username: 'owner', name: 'Dr Synthetic' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Synthetic Clinic', role: 'owner', records_unlocked: true }],
  csrf_token: 'token',
};
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

function mount() {
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: ['/'] })} />);
}

async function fill(password: string, again = password) {
  await userEvent.type(await screen.findByLabelText('Clinic name'), 'Synthetic Clinic');
  await userEvent.type(screen.getByLabelText('Your name'), 'Dr Synthetic');
  await userEvent.type(screen.getByLabelText('Username'), 'owner');
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.type(screen.getByLabelText('Password again'), again);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('first-time setup', () => {
  it('creates the clinic, shows the recovery key once and only then opens the workspace', async () => {
    let posted: Record<string, string> | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response({ detail: 'Authentication required.' }, 401);
      if (path.endsWith('csrf/')) return response({ csrf_token: 'fresh' });
      if (path.endsWith('setup/') && options?.method === 'POST') {
        posted = JSON.parse(String(options.body));
        return response({ ...session, recovery_key: KEY }, 201);
      }
      if (path.endsWith('setup/')) return response({ needed: true });
      return response({ count: 0, next: null, previous: null, results: [] });
    });
    mount();
    expect(await screen.findByRole('heading', { name: 'Set up your clinic' })).toBeInTheDocument();
    await fill('synthetic-setup-password');
    await userEvent.click(screen.getByRole('button', { name: 'Create clinic' }));

    expect(await screen.findByRole('heading', { name: 'Write down your recovery key' })).toBeInTheDocument();
    expect(screen.getByLabelText('Recovery key')).toHaveTextContent(KEY);
    expect(posted).toMatchObject({ clinic_name: 'Synthetic Clinic', username: 'owner', full_name: 'Dr Synthetic' });
    expect(posted).not.toHaveProperty('password_again');
    const proceed = screen.getByRole('button', { name: 'Continue to the clinic' });
    expect(proceed).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/I have written the recovery key down/));
    await userEvent.click(proceed);

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByText(KEY)).not.toBeInTheDocument();
  });

  it('stops mismatched passwords before anything is sent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('me/')) return response({ detail: 'Authentication required.' }, 401);
      return response({ needed: true });
    });
    mount();
    await fill('synthetic-setup-password', 'synthetic-setup-passwore');
    await userEvent.click(screen.getByRole('button', { name: 'Create clinic' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The two passwords are not the same.');
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('shows the ordinary sign-in when the installation is already set up', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('me/')) return response({ detail: 'Authentication required.' }, 401);
      return response({ needed: false });
    });
    mount();
    expect(await screen.findByRole('heading', { name: 'Sign in to your clinic' })).toBeInTheDocument();
  });
});
