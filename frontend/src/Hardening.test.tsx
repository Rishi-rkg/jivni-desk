import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { Role, Session } from './types';

const sessionFor = (role: Role): Session => ({
  user: { id: 'user-id', username: 'doctor', name: '' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role }],
  csrf_token: 'token',
  idle_timeout_seconds: 900,
});
const patient = {
  id: 'patient-id',
  first_name: 'Synthetic',
  middle_name: '',
  last_name: 'Patient',
  date_of_birth: '1990-01-01',
  gender: 'other',
  phone: '',
  email: '',
  address: null,
  photos: [],
  archived_at: null,
  created_at: '',
};
const empty = { count: 0, next: null, previous: null, results: [] };
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
function mount(path: string) {
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] })} />);
}
beforeEach(() => {
  vi.restoreAllMocks();
});

describe('workspace lock', () => {
  it('locks on an expired session, keeps the unsaved note and unlocks with the password', async () => {
    let signedIn = false;
    const logins: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('clinician'));
      if (path.endsWith('csrf/')) return response({ csrf_token: 'fresh-token' });
      if (path.endsWith('login/')) {
        signedIn = true;
        logins.push(JSON.parse(options?.body as string));
        return response({ ...sessionFor('clinician'), csrf_token: 'new-token' });
      }
      if (path.endsWith('notes/') && options?.method === 'POST')
        return signedIn
          ? response(
              {
                id: 'note-id',
                patient: 'patient-id',
                body: 'Kept through the lock',
                author_name: '',
                amends: null,
                created_at: '2026-01-01T00:00:00Z',
              },
              201,
            )
          : response({ detail: 'Authentication credentials were not provided.' }, 401);
      if (/encounters|notes/.test(path)) return response(empty);
      return response(patient);
    });
    mount('/patients/patient-id?tab=notes');
    await userEvent.type(await screen.findByLabelText('Add patient note'), 'Kept through the lock');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));

    expect(await screen.findByRole('heading', { name: 'Locked' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Synthetic Patient' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Password'), 'synthetic-password');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    const draft = await screen.findByLabelText('Add patient note');
    expect(draft).toHaveValue('Kept through the lock');
    expect(logins).toEqual([{ username: 'doctor', password: 'synthetic-password' }]);
    expect(screen.queryByRole('heading', { name: 'Locked' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Note saved.')).toBeInTheDocument();
  });
});

describe('archive and restore', () => {
  it('archives through the dedicated action after confirmation', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('clinician'));
      if (options?.method === 'POST') {
        calls.push(path);
        return response({ ...patient, archived_at: path.endsWith('archive/') ? '2026-01-02T00:00:00Z' : null });
      }
      if (/encounters|notes/.test(path)) return response(empty);
      return response(patient);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount('/patients/patient-id');
    await userEvent.click(await screen.findByRole('button', { name: 'Archive patient' }));
    expect(await screen.findByText('Patient archived.')).toBeInTheDocument();
    expect(screen.queryByText('New visit')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore patient' }));
    expect(await screen.findByText('Patient restored.')).toBeInTheDocument();
    expect(calls).toEqual(['/api/v1/patients/patient-id/archive/', '/api/v1/patients/patient-id/restore/']);
  });

  it('does not offer archiving to reception', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).endsWith('me/') ? response(sessionFor('reception')) : response(patient),
    );
    mount('/patients/patient-id');
    expect(await screen.findByRole('heading', { name: 'Synthetic Patient' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive patient' })).not.toBeInTheDocument();
  });
});

describe('clinic administration', () => {
  const settings = {
    id: 'clinic-id',
    name: 'Test clinic',
    time_zone: 'UTC',
    address: '',
    phone: '',
    email: '',
    tax_identifier: '',
    currency: '',
  };

  it('lets the owner save clinic settings', async () => {
    let saved: Record<string, string> | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (String(url).endsWith('me/')) return response(sessionFor('owner'));
      if (options?.method === 'PATCH') {
        saved = JSON.parse(options.body as string);
        return response({ ...settings, ...saved });
      }
      return response(settings);
    });
    mount('/settings');
    const zone = await screen.findByLabelText('Time zone');
    await userEvent.clear(zone);
    await userEvent.type(zone, 'Asia/Kolkata');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Clinic settings saved.')).toBeInTheDocument();
    expect(saved).toMatchObject({ name: 'Test clinic', time_zone: 'Asia/Kolkata' });
  });

  it('keeps settings away from roles that do not run the clinic', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).endsWith('me/') ? response(sessionFor('clinician')) : response(empty),
    );
    mount('/settings');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Clinic name')).not.toBeInTheDocument();
  });

  it('shows an administrator the clinic details but not the owner-only sections', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).endsWith('me/') ? response(sessionFor('admin')) : response(settings),
    );
    mount('/settings/switches');
    expect(await screen.findByLabelText('Clinic name')).toBeEnabled();
    const sections = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(sections).getByRole('link', { name: 'Activity log' })).toBeInTheDocument();
    expect(within(sections).queryByRole('link', { name: 'Switches' })).not.toBeInTheDocument();
    expect(within(sections).queryByRole('link', { name: 'Backups' })).not.toBeInTheDocument();
  });

  it('lets the owner turn a part of the application off, which removes its tab', async () => {
    const features = { appointments: true, billing: true, messages: true, library: true, product_sales: true };
    let billing = true;
    const sent: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (String(url).endsWith('me/')) {
        const s = sessionFor('owner');
        return response({ ...s, memberships: [{ ...s.memberships[0], features: { ...features, billing } }] });
      }
      if (options?.method === 'PATCH') {
        sent.push(JSON.parse(options.body as string));
        billing = false;
      }
      return response({ ...settings, features: { ...features, billing, stock_control: false, ai_drafting: false } });
    });
    mount('/settings/switches');
    const tabs = await screen.findByRole('navigation', { name: 'Clinic workspace' });
    expect(within(tabs).getByRole('link', { name: 'Billing' })).toBeInTheDocument();
    const billingSwitch = await screen.findByRole('switch', { name: 'Billing' });
    expect(billingSwitch).toBeChecked();
    expect(screen.getByRole('switch', { name: 'AI drafting' })).toBeDisabled();
    await userEvent.click(billingSwitch);
    await waitFor(() => expect(within(tabs).queryByRole('link', { name: 'Billing' })).not.toBeInTheDocument());
    expect(sent).toEqual([{ features: { billing: false } }]);
    expect(screen.getByRole('switch', { name: 'Billing' })).not.toBeChecked();
  });

  it('shows the owner failed sign-ins in plain words', async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('owner'));
      requested.push(path);
      return response({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 'event-id',
            actor: null,
            actor_username: '',
            action: 'auth.login_failed',
            outcome: 'failed',
            resource_type: 'User',
            resource_id: '12345678-aaaa-bbbb-cccc-000000000000',
            source_ip: '127.0.0.1',
            request_id: null,
            occurred_at: '2026-01-01T00:00:00Z',
          },
        ],
      });
    });
    mount('/audit');
    const row = (await screen.findByText('Failed sign-in')).closest('tr')!;
    expect(within(row).getByText('failed')).toBeInTheDocument();
    expect(within(row).getByText('User 12345678')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'failed');
    expect(requested.at(-1)).toContain('outcome=failed');
  });
});
