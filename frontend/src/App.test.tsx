import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { Session } from './types';

const session: Session = { user: { id: 'user-id', username: 'doctor', name: '' }, clinic_id: 'clinic-id', memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role: 'clinician' }], csrf_token: 'token' };
const response = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
beforeEach(() => { vi.restoreAllMocks(); });

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
    render(<MemoryRouter><App/></MemoryRouter>);
    await userEvent.type(await screen.findByLabelText('Username'), 'doctor');
    await userEvent.type(screen.getByLabelText('Password'), 'synthetic-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Patients' })).toBeInTheDocument();
    expect(await screen.findByText('No patients found.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('shows validation errors and does not navigate after a failed patient save', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (String(url).endsWith('me/')) return response(session);
      if (options?.method === 'POST') return response({ date_of_birth: ['Date cannot be in the future.'] }, 400);
      return response({ count: 0, next: null, previous: null, results: [] });
    });
    render(<MemoryRouter initialEntries={['/patients/new']}><App/></MemoryRouter>);
    await userEvent.type(await screen.findByLabelText('First name'), 'Synthetic');
    await userEvent.type(screen.getByLabelText('Date of birth'), '2000-01-01');
    await userEvent.click(screen.getByRole('button', { name: 'Save patient' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Date cannot be in the future.');
    expect(screen.getByRole('heading', { name: 'New patient' })).toBeInTheDocument();
  });

  it('reception sees demographics without requesting clinical records', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (String(url).endsWith('me/')) return response({ ...session, memberships: [{ ...session.memberships[0], role: 'reception' }] });
      return response({ id: 'patient-id', first_name: 'Synthetic', middle_name: '', last_name: 'Patient', date_of_birth: '1990-01-01', gender: 'other', phone: '', email: '', address: null, photos: [], archived_at: null, created_at: '' });
    });
    render(<MemoryRouter initialEntries={['/patients/patient-id']}><App/></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Synthetic Patient' })).toBeInTheDocument();
    expect(screen.queryByText('New encounter')).not.toBeInTheDocument();
    await waitFor(() => expect(mock.mock.calls.every(([url]) => !/encounters|notes/.test(String(url)))).toBe(true));
  });
});
