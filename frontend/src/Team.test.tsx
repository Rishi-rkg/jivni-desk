import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { Role, Session } from './types';
import { clearNotices } from './ui';

const sessionFor = (role: Role, more: Partial<Session> = {}): Session => ({
  user: { id: 'user-id', username: 'owner', name: 'Dr Synthetic', two_step: false },
  clinic_id: 'clinic-id',
  memberships: [
    { clinic_id: 'clinic-id', clinic_name: 'Test clinic', role, time_zone: 'Asia/Kolkata', currency: 'INR' },
  ],
  csrf_token: 'token',
  pending: [],
  ...more,
});
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
function mount(path: string) {
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] })} />);
}
interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}
/** A pretend server. `answer` handles what a test cares about; everything else gets an empty list. */
function mockServer(answer: (call: Call) => Promise<Response> | undefined) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
    const call: Call = {
      path: String(url),
      method: options?.method ?? 'GET',
      body: options?.body ? JSON.parse(String(options.body)) : null,
    };
    calls.push(call);
    return answer(call) ?? response({ count: 0, next: null, previous: null, results: [] });
  });
  return calls;
}
const people = [
  {
    id: 'user-id',
    username: 'owner',
    name: 'Dr Synthetic',
    role: 'owner',
    is_active: true,
    two_step: true,
    two_step_asked: true,
    signed_in: 1,
    last_active: '2026-10-06T04:00:00Z',
    must_change_password: false,
    can_open_records: true,
    you: true,
  },
  {
    id: 'priya-id',
    username: 'priya',
    name: 'Priya Desk',
    role: 'reception',
    is_active: true,
    two_step: false,
    two_step_asked: false,
    signed_in: 0,
    last_active: null,
    must_change_password: true,
    can_open_records: true,
    you: false,
  },
];
const roles = [
  { code: 'owner', label: 'Owner' },
  { code: 'clinician', label: 'Clinician' },
  { code: 'reception', label: 'Reception' },
];

beforeEach(() => {
  vi.restoreAllMocks();
  clearNotices();
});

describe('signing in', () => {
  it('asks for the code from the authenticator app when the server wants one', async () => {
    const calls = mockServer(({ path, body }) => {
      if (path.endsWith('auth/me/')) return response({ detail: 'Authentication required.' }, 401);
      if (path.endsWith('auth/setup/')) return response({ needed: false });
      if (path.endsWith('auth/csrf/')) return response({ csrf_token: 'token' });
      if (path.endsWith('auth/login/'))
        return body!.code === '123456'
          ? response(sessionFor('owner'))
          : response({ detail: 'Enter the 6-digit code from your authenticator app.', two_step: true }, 401);
      return undefined;
    });
    mount('/');
    await userEvent.type(await screen.findByLabelText('Username'), 'owner');
    await userEvent.type(screen.getByLabelText('Password'), 'synthetic-password');
    expect(screen.queryByLabelText(/6-digit code/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    // Being asked is the next step, not an error.
    const code = await screen.findByLabelText('6-digit code from your authenticator app');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.type(code, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('navigation', { name: 'Clinic workspace' })).toBeInTheDocument();
    const sent = calls.filter((call) => call.path.endsWith('auth/login/')).map((call) => call.body);
    expect(sent).toEqual([
      { username: 'owner', password: 'synthetic-password' },
      { username: 'owner', password: 'synthetic-password', code: '123456' },
    ]);
  });

  it('makes someone with a one-time password choose their own before anything opens', async () => {
    let chosen = false;
    const calls = mockServer(({ path, method }) => {
      if (path.endsWith('auth/me/')) return response(sessionFor('reception', { pending: chosen ? [] : ['password'] }));
      if (path.endsWith('auth/password/') && method === 'POST') {
        chosen = true;
        return response({ detail: 'Password changed.', csrf_token: 'next', pending: [] });
      }
      return undefined;
    });
    mount('/patients');
    expect(await screen.findByRole('heading', { name: 'Choose your own password' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Clinic workspace' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('One-time password'), 'K7QM-2XPD-9RWT-HB4N');
    await userEvent.type(screen.getByLabelText('New password'), 'synthetic-chosen-password');
    await userEvent.type(screen.getByLabelText('New password again'), 'synthetic-chosen-passwird');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The two new passwords are not the same.');
    await userEvent.clear(screen.getByLabelText('New password again'));
    await userEvent.type(screen.getByLabelText('New password again'), 'synthetic-chosen-password');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByRole('navigation', { name: 'Clinic workspace' })).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('auth/password/'))!.body).toEqual({
      current_password: 'K7QM-2XPD-9RWT-HB4N',
      new_password: 'synthetic-chosen-password',
    });
  });

  it('sets up two-step sign-in with a code to scan and a code typed back', async () => {
    let done = false;
    const calls = mockServer(({ path }) => {
      if (path.endsWith('auth/me/')) return response(sessionFor('owner', { pending: done ? [] : ['two_step'] }));
      if (path.endsWith('two-step/start/'))
        return response({
          secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
          uri: 'otpauth://totp/Jivni%3Aowner?secret=GEZD',
        });
      if (path.endsWith('two-step/confirm/')) {
        done = true;
        return response(sessionFor('owner'));
      }
      return undefined;
    });
    mount('/');
    expect(await screen.findByRole('heading', { name: 'Set up two-step sign-in' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your password'), 'synthetic-password');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('img', { name: 'Code for the authenticator app' })).toBeInTheDocument();
    expect(screen.getByLabelText('Secret for the authenticator app')).toHaveTextContent(
      'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ',
    );
    const turnOn = screen.getByRole('button', { name: 'Turn on two-step sign-in' });
    expect(turnOn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type the 6-digit code/), '287 082');
    await userEvent.click(turnOn);
    expect(await screen.findByRole('navigation', { name: 'Clinic workspace' })).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('two-step/confirm/'))!.body).toEqual({
      password: 'synthetic-password',
      code: '287 082',
    });
  });

  it('resets the owner’s password with the recovery key and shows the new key once', async () => {
    const calls = mockServer(({ path }) => {
      if (path.endsWith('auth/me/')) return response({ detail: 'Authentication required.' }, 401);
      if (path.endsWith('auth/setup/')) return response({ needed: false });
      if (path.endsWith('auth/csrf/')) return response({ csrf_token: 'token' });
      if (path.endsWith('auth/recover/'))
        return response({
          detail: 'Password reset.',
          recovery_keys: [{ clinic: 'Test clinic', recovery_key: 'NEWK-EY00-0000' }],
        });
      return undefined;
    });
    mount('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Use recovery key' }));
    const window_ = await screen.findByRole('dialog', { name: 'Use the recovery key' });
    await userEvent.type(within(window_).getByLabelText('Owner’s username'), 'owner');
    await userEvent.type(within(window_).getByLabelText('Recovery key'), 'OLDK-EY00-0000');
    await userEvent.type(within(window_).getByLabelText('New password'), 'synthetic-new-password');
    await userEvent.type(within(window_).getByLabelText('New password again'), 'synthetic-new-password');
    await userEvent.click(within(window_).getByRole('button', { name: 'Reset the owner’s password' }));
    const shown = await screen.findByRole('alertdialog', { name: 'Write down the new recovery key' });
    expect(within(shown).getByLabelText('New recovery key')).toHaveTextContent('NEWK-EY00-0000');
    // It cannot be dismissed until the person says they have it.
    const finish = within(shown).getByRole('button', { name: 'Done' });
    expect(finish).toBeDisabled();
    await userEvent.click(within(shown).getByLabelText('I have written it down'));
    await userEvent.click(finish);
    expect(await screen.findByText('Password reset. Sign in with the new password.')).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('auth/recover/'))!.body).toEqual({
      username: 'owner',
      recovery_key: 'OLDK-EY00-0000',
      new_password: 'synthetic-new-password',
    });
  });
});

describe('users, roles and security', () => {
  it('lists the team and shows an invited person’s one-time password once', async () => {
    const calls = mockServer(({ path, method }) => {
      if (path.endsWith('auth/me/')) return response(sessionFor('owner'));
      if (path.endsWith('clinic/users/') && method === 'POST')
        return response(
          {
            ...people[1],
            id: 'arun-id',
            username: 'arun',
            name: 'Arun Synthetic',
            one_time_password: 'K7QM-2XPD-9RWT-HB4N',
          },
          201,
        );
      if (path.endsWith('clinic/users/')) return response({ roles, results: people });
      if (path.endsWith('clinic/users/priya-id/')) return response({ ...people[1], role: 'clinician' });
      return undefined;
    });
    mount('/settings/users');
    const table = await screen.findByRole('table');
    const owner = within(table).getByRole('row', { name: /Dr Synthetic/ });
    expect(within(owner).getByText('Now')).toBeInTheDocument();
    expect(within(owner).getByText('On')).toBeInTheDocument();
    // Nobody changes their own role or switches themselves off.
    expect(within(owner).getByLabelText('Role of Dr Synthetic')).toBeDisabled();
    expect(within(owner).getByRole('switch', { name: 'Dr Synthetic can sign in' })).toBeDisabled();
    const priya = within(table).getByRole('row', { name: /Priya Desk/ });
    expect(within(priya).getByText(/has a one-time password/)).toBeInTheDocument();
    expect(within(priya).getByText('Never')).toBeInTheDocument();
    await userEvent.selectOptions(within(priya).getByLabelText('Role of Priya Desk'), 'clinician');
    await waitFor(() =>
      expect(
        calls.find((call) => call.method === 'PATCH' && call.path.endsWith('clinic/users/priya-id/'))?.body,
      ).toEqual({
        role: 'clinician',
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Invite user' }));
    const window_ = await screen.findByRole('dialog', { name: 'Invite a user' });
    await userEvent.type(within(window_).getByLabelText('Full name'), 'Arun Synthetic');
    await userEvent.type(within(window_).getByLabelText('Username'), 'arun');
    await userEvent.selectOptions(within(window_).getByLabelText('Role'), 'clinician');
    await userEvent.click(within(window_).getByRole('button', { name: 'Create and show one-time password' }));
    const shown = await screen.findByRole('alertdialog', { name: 'One-time password for Arun Synthetic' });
    expect(within(shown).getByLabelText('One-time password')).toHaveTextContent('K7QM-2XPD-9RWT-HB4N');
    expect(calls.find((call) => call.method === 'POST' && call.path.endsWith('clinic/users/'))!.body).toEqual({
      name: 'Arun Synthetic',
      username: 'arun',
      role: 'clinician',
    });
    await userEvent.click(within(shown).getByLabelText('I have given it to them, or written it down'));
    await userEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('K7QM-2XPD-9RWT-HB4N')).not.toBeInTheDocument();
  });

  it('keeps users, security and import for the owner', async () => {
    mockServer(({ path }) => (path.endsWith('auth/me/') ? response(sessionFor('admin')) : undefined));
    mount('/settings/users');
    const sections = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(within(sections).getByRole('link', { name: 'Clinic details' })).toBeInTheDocument();
    expect(within(sections).getByRole('link', { name: 'Print templates' })).toBeInTheDocument();
    for (const name of ['Users and roles', 'Security', 'Backups', 'Import and export', 'Switches'])
      expect(within(sections).queryByRole('link', { name })).not.toBeInTheDocument();
  });

  it('changes the security settings and makes a new recovery key', async () => {
    const calls = mockServer(({ path, method }) => {
      if (path.endsWith('auth/me/')) return response(sessionFor('owner'));
      if (path.endsWith('clinic/security/'))
        return response({
          two_step_asked: false,
          lock_after_minutes: 15,
          recovery_key_created_at: '2026-06-09T04:00:00Z',
          sessions: 3,
        });
      if (path.endsWith('clinic/recovery-key/')) return response({ recovery_key: 'NEWK-EY00-0000' }, 201);
      if (path.endsWith('clinic/') && method === 'PATCH') return response({});
      return undefined;
    });
    mount('/settings/security');
    expect(await screen.findByText('Created 09 Jun 2026. Needed if every password is lost.')).toBeInTheDocument();
    expect(screen.getByText('3 active sessions, counting this one')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Two-step sign-in for owners and doctors' }));
    await userEvent.selectOptions(screen.getByLabelText('Lock after no activity'), '5');
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'PATCH' && call.path.endsWith('clinic/')).map((call) => call.body),
      ).toEqual([{ features: { two_step: true } }, { lock_after_minutes: 5 }]),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Make a new one' }));
    const window_ = await screen.findByRole('dialog', { name: 'Make a new recovery key' });
    await userEvent.type(within(window_).getByLabelText('Your password'), 'synthetic-password');
    await userEvent.click(within(window_).getByRole('button', { name: 'Make a new key' }));
    const shown = await screen.findByRole('alertdialog', { name: 'Write down the new recovery key' });
    expect(within(shown).getByLabelText('New recovery key')).toHaveTextContent('NEWK-EY00-0000');
    expect(calls.find((call) => call.path.endsWith('clinic/recovery-key/'))!.body).toEqual({
      password: 'synthetic-password',
    });
  });
});
