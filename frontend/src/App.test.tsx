import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { Session } from './types';

const session: Session = {
  user: { id: 'user-id', username: 'doctor', name: '' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role: 'clinician' }],
  csrf_token: 'token',
};
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
function mount(path = '/') {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => {
  vi.restoreAllMocks();
});

describe('clinic workflows', () => {
  it('logs in with a CSRF token and shows the patient list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response({ detail: 'Authentication required.' }, 401);
      if (path.endsWith('csrf/')) return response({ csrf_token: 'initial-token' });
      if (path.endsWith('login/')) {
        expect((options?.headers as Record<string, string>)['X-CSRFToken']).toBe('initial-token');
        expect(JSON.parse(options?.body as string)).toEqual({ username: 'doctor', password: 'synthetic-password' });
        return response(session);
      }
      return response({ count: 0, next: null, previous: null, results: [] });
    });
    mount();
    await userEvent.type(await screen.findByLabelText('Username'), 'doctor');
    await userEvent.type(screen.getByLabelText('Password'), 'synthetic-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Patients' }));
    expect(await screen.findByText('No patients found.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('shows validation errors and does not navigate after a failed patient save', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (String(url).endsWith('me/')) return response(session);
      if (options?.method === 'POST') return response({ date_of_birth: ['Date cannot be in the future.'] }, 400);
      return response({ count: 0, next: null, previous: null, results: [] });
    });
    mount('/patients/new');
    await userEvent.type(await screen.findByLabelText('First name'), 'Synthetic');
    await userEvent.type(screen.getByLabelText('Date of birth'), '2000-01-01');
    await userEvent.click(screen.getByRole('button', { name: 'Save patient' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Date cannot be in the future.');
    expect(screen.getByRole('heading', { name: 'New patient' })).toBeInTheDocument();
  });

  it('reception sees demographics without requesting clinical records', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).endsWith('me/'))
        return response({ ...session, memberships: [{ ...session.memberships[0], role: 'reception' }] });
      return response({
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
      });
    });
    mount('/patients/patient-id');
    expect(await screen.findByRole('heading', { name: 'Synthetic Patient' })).toBeInTheDocument();
    expect(screen.queryByText('New visit')).not.toBeInTheDocument();
    await waitFor(() => expect(mock.mock.calls.every(([url]) => !/encounters|notes/.test(String(url)))).toBe(true));
  });

  it('keeps patient context and an unsaved note while switching patient tabs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(session);
      if (/encounters|notes|invoices/.test(path))
        return response({ count: 0, next: null, previous: null, results: [] });
      return response({
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
      });
    });
    mount('/patients/patient-id?tab=notes');
    await userEvent.type(await screen.findByLabelText('Add patient note'), 'Unsaved context');
    const patientNavigation = screen.getByRole('navigation', { name: 'Patient record' });
    await userEvent.click(within(patientNavigation).getByRole('link', { name: /Billing/ }));
    expect(await screen.findByRole('heading', { name: 'Billing for Synthetic Patient' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Notes' }));
    expect(screen.getByLabelText('Add patient note')).toHaveValue('Unsaved context');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(screen.getByRole('button', { name: /^Account:/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Sign out without saving?'));
    expect(screen.getByLabelText('Add patient note')).toHaveValue('Unsaved context');
    await userEvent.click(screen.getByRole('link', { name: /Patient list/ }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Add patient note')).toHaveValue('Unsaved context');
  });

  it('preserves the patient search when returning from a record', async () => {
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
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(session);
      if (path.includes('patients/?')) return response({ count: 1, next: null, previous: null, results: [patient] });
      if (/encounters|notes/.test(path)) return response({ count: 0, next: null, previous: null, results: [] });
      return response(patient);
    });
    mount('/patients?search=Synthetic');
    await userEvent.click(await screen.findByRole('link', { name: 'Synthetic Patient' }));
    await userEvent.click(await screen.findByRole('link', { name: /Patient list/ }));
    expect(await screen.findByLabelText('Search patients')).toHaveValue('Synthetic');
  });
});
