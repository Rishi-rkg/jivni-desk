import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { NextAdvised } from './PatientList';
import { cropSquare, parseCsv } from './PatientWindows';
import { Role, Session } from './types';
import { clearNotices } from './ui';

const sessionFor = (role: Role): Session => ({
  user: { id: 'user-id', username: 'doctor', name: '' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role, time_zone: 'Asia/Kolkata' }],
  csrf_token: 'token',
});
const session = sessionFor('clinician');
const patient = {
  id: 'patient-id',
  identifier: 'PAT-W8KQ3G7DP9',
  first_name: 'Synthetic',
  middle_name: '',
  last_name: 'Patient',
  date_of_birth: '1984-03-14',
  gender: 'female',
  phone: '+91 90000 00142',
  whatsapp_number: '+91 90000 00142',
  email: '',
  address: {
    line1: '12 Lake Road',
    line2: '',
    city: 'Pune',
    region: 'Maharashtra',
    postal_code: '411001',
    country: 'IN',
  },
  photos: [],
  archived_at: null,
  created_at: '2026-06-09T05:00:00Z',
  alert: 'Sensitive to camphor',
  last_visit: '2026-10-06',
  next_advised: '2026-10-20',
  balance: '320.00',
  consent: {
    care: { granted: true, at: '2026-06-09T05:00:00Z', by: 'Reception', wording_version: 1 },
    greetings: null,
  },
  family: [{ id: 'link-1', patient: 'child-id', name: 'Sunita Patient', relation: 'daughter' }],
};
const visit = {
  id: 'visit-id',
  patient: 'patient-id',
  clinician_name: 'Dr Synthetic',
  occurred_at: '2026-10-06T04:30:00Z',
  chief_complaint: 'Headache now about once a week.',
  symptoms: '',
  history: '',
  assessment: '',
  internal_notes: '',
  follow_up_date: '2026-10-20',
  visit_type: 'follow_up',
  observations: [{ kind: 'height', value: '162.00', unit: 'cm', measured_at: '2026-10-06T04:30:00Z' }],
  prescriptions: [
    {
      id: 'rx-1',
      instructions: '',
      dosage_line: '4 tabs, twice daily before meals · 14 days',
      items: [
        {
          id: 'i1',
          medicine_name_snapshot: 'Arnica montana',
          potency: '30C',
          dose: '',
          frequency: '',
          duration: '',
          instructions: '',
          quantity: null,
        },
      ],
    },
  ],
  products: [
    {
      id: 'p1',
      price_item_id: null,
      name: 'Vitamin D3 capsules, 60',
      kind: 'supplement',
      quantity: '1.00',
      rate: '450.00',
      gst_rate: '18.00',
      note: '1 capsule daily',
    },
  ],
  amendments: [],
  invoice: { id: 'bill-id', number: 'INV/26-27/1042', state: 'partially_paid' },
};
const feed = {
  more: false,
  items: [
    {
      kind: 'visit',
      id: 'visit-id',
      at: '2026-10-06T04:30:00Z',
      visit_type: 'follow_up',
      clinician_name: 'Dr Synthetic',
      amended_at: null,
      visit,
    },
    {
      kind: 'invoice',
      id: 'bill-id',
      at: '2026-10-06T04:31:00Z',
      number: 'INV/26-27/1042',
      state: 'partially_paid',
      total: '1320.00',
      paid: '1000.00',
      balance: '320.00',
      method: 'upi',
    },
    {
      kind: 'note',
      id: 'note-1',
      at: '2026-08-30T05:00:00Z',
      note_kind: 'general',
      body: 'Prefers morning appointments.',
      author_name: 'Reception',
    },
    {
      kind: 'document',
      id: 'doc-1',
      at: '2026-07-22T05:00:00Z',
      title: 'Blood report',
      mime_type: 'application/pdf',
      byte_size: 1000,
    },
  ],
};
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const page = (results: unknown[], extra = {}) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
  ...extra,
});
function mount(path = '/') {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}
/** A stand-in server for the patient pages. `sent` collects what was posted, by address. */
function server(role: Role = 'clinician', sent: { path: string; method: string; body: unknown }[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
    const path = String(url);
    const method = options?.method ?? 'GET';
    if (path.endsWith('me/')) return response(sessionFor(role));
    if (method !== 'GET') {
      const body = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
      sent.push({ path, method, body });
      if (path.includes('check-duplicates'))
        return response({ matches: [{ ...patient, id: 'other-id', reasons: ['same phone number'] }] });
      if (path.includes('/notes/'))
        return response(
          {
            id: 'new-note',
            kind: body.kind,
            body: body.body,
            author_name: 'Dr Synthetic',
            created_at: '2026-10-06T05:00:00Z',
          },
          201,
        );
      return response({ ...patient, ...(body ?? {}), id: 'patient-id' }, method === 'POST' ? 201 : 200);
    }
    if (path.includes('/feed/')) return response(feed);
    if (path.includes('/documents/')) return response({ results: [] });
    if (path.includes('encounters/')) return response(page([visit]));
    if (/notes|invoices|visit-drafts|prescription-sets/.test(path)) return response(page([]));
    if (path.includes('patients/?')) return response(page([patient], { clinic_total: 312 }));
    return response(patient);
  });
  return sent;
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearNotices();
});

describe('signing in', () => {
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
      return response(page([]));
    });
    mount();
    await userEvent.type(await screen.findByLabelText('Username'), 'doctor');
    await userEvent.type(screen.getByLabelText('Password'), 'synthetic-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), / })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Patients' }));
    expect(await screen.findByText(/No patients found\./)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('the patient list', () => {
  it('shows each patient with age, last visit, next advised date and balance', async () => {
    server('owner');
    mount('/patients?search=Synthetic');
    const row = (await screen.findByRole('link', { name: 'Synthetic Patient' })).closest('tr')!;
    for (const text of ['PAT-W8KQ3G7DP9', '+91 90000 00142', '06 Oct 2026', '₹320.00'])
      expect(within(row).getByText(text)).toBeInTheDocument();
    expect(screen.getByText('1 of 1 match · 312 patients in the clinic')).toBeInTheDocument();
    expect(screen.getByLabelText('Search patients')).toHaveValue('Synthetic');
    await userEvent.click(within(row).getByRole('button', { name: 'Actions for Synthetic Patient' }));
    expect(screen.getByRole('menuitem', { name: 'Start visit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'New invoice' })).toBeInTheDocument();
  });

  it('asks the server for what the chips and the sort order say', async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('reception'));
      asked.push(path);
      return response(page([]));
    });
    mount('/patients');
    await userEvent.click(await screen.findByRole('button', { name: 'Follow-up due' }));
    await userEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'name');
    await waitFor(() => expect(asked.at(-1)).toContain('sort=name'));
    expect(asked.at(-1)).toContain('follow_up=due');
    expect(asked.at(-1)).toContain('archived=true');
    // Reception does not work with balances the same way as billing roles do, but may see them.
    expect(screen.getByRole('button', { name: 'Balance due' })).toBeInTheDocument();
  });

  it('says when a follow-up is due and when it is overdue', () => {
    const { rerender } = render(<NextAdvised day="2026-10-20" today="2026-10-06" />);
    expect(screen.getByText('Due 20 Oct')).toBeInTheDocument();
    rerender(<NextAdvised day="2026-10-02" today="2026-10-06" />);
    expect(screen.getByText('Overdue 4 days')).toBeInTheDocument();
    rerender(<NextAdvised day={null} today="2026-10-06" />);
    expect(screen.getByText('None')).toBeInTheDocument();
  });
});

describe('registering and editing a patient', () => {
  it('shows validation errors and does not navigate after a failed save', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(session);
      if (path.includes('check-duplicates')) return response({ matches: [] });
      if (options?.method === 'POST') return response({ date_of_birth: ['Date cannot be in the future.'] }, 400);
      return response(page([]));
    });
    mount('/patients/new');
    await userEvent.type(await screen.findByLabelText('First name'), 'Synthetic');
    await userEvent.type(screen.getByLabelText('Date of birth'), '2000-01-01');
    await userEvent.click(screen.getByRole('button', { name: 'Save patient' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Date cannot be in the future.');
    expect(screen.getByRole('heading', { name: 'Register a patient' })).toBeInTheDocument();
  });

  it('registers with contact details, consent and a warning about a possible duplicate', async () => {
    const sent = server('reception');
    const router = mount('/patients/new');
    await userEvent.type(await screen.findByLabelText('First name'), 'Anita');
    await userEvent.type(screen.getByLabelText('Last name'), 'Rao');
    await userEvent.type(screen.getByLabelText('Date of birth'), '1984-03-14');
    expect(screen.getByLabelText('Age')).toHaveValue('42 years');
    await userEvent.selectOptions(screen.getByLabelText('Sex'), 'female');
    await userEvent.type(screen.getByLabelText('Phone'), '9000000142');
    await userEvent.tab();
    // The warning is advice: the name and phone were sent in the request body, never the address.
    expect(await screen.findByText(/Possible duplicate\./)).toBeInTheDocument();
    expect(sent[0].path).toBe('/api/v1/patients/check-duplicates/');
    expect(screen.getByLabelText('WhatsApp number')).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Address'), '12 Lake Road');
    await userEvent.type(screen.getByLabelText('City'), 'Pune');
    await userEvent.click(screen.getByRole('switch', { name: 'Care messages' }));
    await userEvent.click(screen.getByLabelText('Print card after saving'));
    // Reception registers and books; starting a visit is for doctors.
    expect(screen.queryByRole('button', { name: 'Save and start visit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and book appointment' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save patient' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/patients/patient-id'));
    const saved = sent.find((call) => call.path === '/api/v1/patients/')!.body as Record<string, unknown>;
    expect(saved).toMatchObject({
      first_name: 'Anita',
      last_name: 'Rao',
      date_of_birth: '1984-03-14',
      gender: 'female',
      phone: '9000000142',
      whatsapp_number: '9000000142',
      consent: { care: true, greetings: false },
      address: { line1: '12 Lake Road', city: 'Pune', country: 'IN' },
    });
  });

  it('edits the same form and removes the address when its first line is cleared', async () => {
    const sent = server('reception');
    mount('/patients/patient-id/edit');
    expect(await screen.findByRole('heading', { name: 'Edit patient details' })).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Synthetic');
    expect(screen.getByRole('switch', { name: 'Care messages' })).toBeChecked();
    expect(screen.getByText('PAT-W8KQ3G7DP9')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Address'));
    await userEvent.type(screen.getByLabelText('Old file number'), 'F-221');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent.some((call) => call.method === 'PATCH')).toBe(true));
    expect(sent.find((call) => call.method === 'PATCH')!.body).toMatchObject({
      old_file_number: 'F-221',
      address: null,
    });
  });
});

describe('the patient record', () => {
  it('shows the banner, the details panel and one timeline of everything', async () => {
    server('owner');
    mount('/patients/patient-id');
    expect(await screen.findByRole('heading', { name: 'Synthetic Patient' })).toBeInTheDocument();
    expect(screen.getByText(/Female · 42 years · \+91 90000 00142/)).toBeInTheDocument();
    expect(screen.getByText('Balance due ₹320.00')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp consent: care')).toBeInTheDocument();
    expect(screen.getByText('Sensitive to camphor')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sunita Patient' })).toHaveAttribute('href', '/patients/child-id');
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(4);
    expect(within(timeline).getByText('Headache now about once a week.')).toBeInTheDocument();
    expect(within(timeline).getByText('Envelope 1 · Arnica montana 30C')).toBeInTheDocument();
    expect(within(timeline).getByText('On bill')).toBeInTheDocument();
    expect(within(timeline).getByText(/₹1,000\.00 received by UPI/)).toBeInTheDocument();
    expect(within(timeline).getByText('Prefers morning appointments.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Billing' }));
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Prescriptions' }));
    expect(within(timeline).getByText('Envelope 1 · Arnica montana 30C')).toBeInTheDocument();
    // The More menu holds the rarer actions.
    await userEvent.click(screen.getByRole('button', { name: 'More ▾' }));
    for (const item of [
      'Edit details',
      'Print patient card',
      'Replace lost card',
      'Message consent…',
      'Change history',
      'Archive patient',
    ])
      expect(screen.getByRole('menuitem', { name: item })).toBeInTheDocument();
  });

  it('reception sees demographics and bills without requesting clinical records', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('reception'));
      if (path.includes('/feed/'))
        return response({
          more: false,
          items: [
            {
              kind: 'visit',
              id: 'visit-id',
              at: '2026-10-06T04:30:00Z',
              visit_type: 'follow_up',
              clinician_name: 'Dr Synthetic',
              amended_at: null,
            },
          ],
        });
      if (/notes|invoices/.test(path)) return response(page([]));
      return response({ ...patient, alert: undefined });
    });
    mount('/patients/patient-id');
    expect(await screen.findByRole('heading', { name: 'Synthetic Patient' })).toBeInTheDocument();
    expect(await screen.findByText('Clinical details are visible to doctors only.')).toBeInTheDocument();
    expect(screen.queryByText('New visit')).not.toBeInTheDocument();
    expect(screen.queryByText(/Remember about/)).not.toBeInTheDocument();
    const tabs = within(screen.getByRole('navigation', { name: 'Patient record' }));
    expect(tabs.queryByRole('link', { name: 'Visits' })).not.toBeInTheDocument();
    expect(tabs.getByRole('link', { name: 'Billing' })).toBeInTheDocument();
    await waitFor(() =>
      expect(mock.mock.calls.every(([url]) => !/encounters|documents|measurements/.test(String(url)))).toBe(true),
    );
  });

  it('adds a general note from the front desk and a clinical one from a doctor', async () => {
    const sent = server('clinician');
    mount('/patients/patient-id?tab=notes');
    await userEvent.click(await screen.findByRole('button', { name: 'Add note' }));
    const window_ = screen.getByRole('dialog', { name: 'Add note' });
    expect(within(window_).getByLabelText('Kind of note')).toHaveValue('clinical');
    await userEvent.selectOptions(within(window_).getByLabelText('Kind of note'), 'general');
    await userEvent.type(within(window_).getByLabelText('Note'), 'Prefers mornings');
    await userEvent.click(within(window_).getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Prefers mornings')).toBeInTheDocument();
    expect(sent.at(-1)).toMatchObject({
      path: '/api/v1/notes/',
      body: { patient: 'patient-id', kind: 'general', body: 'Prefers mornings' },
    });
  });

  it('preserves the patient search when returning from a record', async () => {
    server('clinician');
    mount('/patients?search=Synthetic');
    await userEvent.click(await screen.findByRole('link', { name: 'Synthetic Patient' }));
    await userEvent.click(await screen.findByRole('link', { name: /Patient list/ }));
    expect(await screen.findByLabelText('Search patients')).toHaveValue('Synthetic');
  });

  it('warns before unsaved work is left and before signing out', async () => {
    server('clinician');
    mount('/patients/patient-id/edit');
    await userEvent.type(await screen.findByLabelText('Old file number'), 'F-9');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(screen.getByRole('button', { name: /^Account:/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Sign out without saving?'));
    await userEvent.click(screen.getByRole('link', { name: /Patient record/ }));
    const warning = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    await userEvent.click(within(warning).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Old file number')).toHaveValue('F-9');
  });
});

describe('small helpers of the patient windows', () => {
  it('reads spreadsheet text with quotes, commas and blank lines', () => {
    expect(parseCsv('First name,Phone\r\n"Rao, Anita","90000 ""00142"""\n\nVikram;5550143\n')).toEqual([
      ['First name', 'Phone'],
      ['Rao, Anita', '90000 "00142"'],
      ['Vikram', '5550143'],
    ]);
  });

  it('crops a photo around the face when one was found, and around the middle when not', () => {
    const face = cropSquare(1280, 960, { x: 500, y: 200, width: 200, height: 240 });
    expect(face.width).toBe(480);
    expect(face.x + face.width / 2).toBeCloseTo(600);
    expect(cropSquare(1280, 960, null)).toEqual({ x: 256, y: 48, width: 768, height: 768 });
    // The square never leaves the picture, however close the face is to an edge.
    const edge = cropSquare(640, 480, { x: 0, y: 0, width: 300, height: 300 });
    expect(edge.x).toBe(0);
    expect(edge.y).toBe(0);
    expect(edge.width).toBeLessThanOrEqual(480);
  });
});
