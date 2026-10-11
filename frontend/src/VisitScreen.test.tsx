import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { dosageHalves, dosageLine, envelopesOf } from './VisitScreen';
import { Encounter, Role, Session } from './types';
import { clearNotices } from './ui';

const sessionFor = (role: Role, features = {}): Session => ({
  user: { id: 'user-id', username: 'doctor', name: 'Dr Synthetic' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role, features, time_zone: 'Asia/Kolkata' }],
  csrf_token: 'token',
});
const patient = {
  id: 'patient-id',
  identifier: 'PAT-W8KQ3G7DP9',
  first_name: 'Anita',
  middle_name: '',
  last_name: 'Synthetic',
  date_of_birth: '1990-01-01',
  gender: 'female',
  phone: '5550100',
  email: '',
  address: null,
  photos: [],
  archived_at: null,
  created_at: '',
};
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const page = (results: unknown[]) => ({ count: results.length, next: null, previous: null, results });
const envelope = {
  medicines: [],
  amount: '4',
  unit: 'tabs',
  frequency: 'twice daily',
  timing: '',
  length: '',
  period: 'days',
};
const lastVisit: Encounter = {
  id: 'last-visit',
  patient: 'patient-id',
  clinician_name: 'Dr Synthetic',
  occurred_at: '2026-08-06T05:00:00Z',
  chief_complaint: 'Right-sided headache, worse in sunlight.',
  symptoms: '',
  history: '',
  assessment: '',
  internal_notes: 'Synthetic earlier note',
  follow_up_date: null,
  visit_type: 'first',
  observations: [
    { kind: 'height', value: '162.00', unit: 'cm' },
    { kind: 'systolic', value: '118.00', unit: 'mmHg' },
    { kind: 'diastolic', value: '76.00', unit: 'mmHg' },
  ],
  prescriptions: [
    {
      id: 'rx-1',
      instructions: '',
      dosage_line: '4 tabs, twice daily · 14 days',
      dosage: { amount: '4', unit: 'tabs', frequency: 'twice daily', timing: '', length: '14', period: 'days' },
      items: [
        {
          medicine_name_snapshot: 'Remedy A',
          potency: '30C',
          dose: '',
          frequency: '',
          duration: '',
          instructions: '',
          quantity: null,
        },
        {
          medicine_name_snapshot: 'Remedy B',
          potency: '200C',
          dose: '',
          frequency: '',
          duration: '',
          instructions: '',
          quantity: null,
        },
      ],
    },
  ],
};
const product = {
  id: 'item-d3',
  name: 'Vitamin D3 capsules, 60',
  kind: 'supplement',
  rate: '450.00',
  gst_rate: '18.00',
};

interface Calls {
  [key: string]: { method: string; body: Record<string, unknown> }[];
}
/** A stand-in server that keeps what was sent, by kind of request. */
function server(options: { role?: Role; visits?: Encounter[]; drafts?: unknown[]; features?: object } = {}) {
  const calls: Calls = {};
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (path.endsWith('me/')) return response(sessionFor(options.role ?? 'clinician', options.features));
    const kind = ['visit-drafts', 'encounters', 'notes', 'invoices', 'prescription-sets', 'scan', 'print-data'].find(
      (name) => path.includes(`/${name}/`),
    );
    if (kind && method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      (calls[kind] ??= []).push({ method, body });
      if (kind === 'visit-drafts')
        return response(
          {
            id: 'draft-id',
            mine: true,
            author_name: 'Dr Synthetic',
            data: body.data,
            updated_at: '2026-10-06T04:11:00Z',
          },
          201,
        );
      return response({ id: `new-${kind}`, ...body, author_name: '', amends: null, created_at: '' }, 201);
    }
    if (path.includes('/scan/')) return response({ kind: 'product', product });
    if (path.includes('kind=remember')) return response(page([{ id: 'n1', body: 'Daughter is also a patient' }]));
    if (path.includes('visit-drafts/')) return response(options.drafts ?? []);
    if (path.includes('prescription-sets/'))
      return response([
        {
          id: 'set-1',
          name: 'Teething',
          envelopes: [{ ...envelope, medicines: [{ name: 'Set remedy', potency: '6C' }] }],
        },
      ]);
    if (path.includes('knowledge/medicines/'))
      return response([{ id: 'nux-vomica', name: 'Nux vomica', abbreviation: 'Nux-v.' }]);
    if (path.includes('print-data/')) return response({ envelopes: [], settings: {}, patient: {}, clinic: {} });
    if (path.includes('encounters/')) return response(page(options.visits ?? []));
    if (/notes|invoices|price-items/.test(path)) return response(page([]));
    return response(patient);
  });
  return calls;
}
function mount(path = '/patients/patient-id/encounters/new') {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearNotices();
});

describe('the dosage line', () => {
  it('reads the way it will be printed', () => {
    expect(dosageLine(envelope)).toBe('4 tabs, twice daily');
    expect(dosageLine({ ...envelope, timing: 'before meals', length: '14' })).toBe(
      '4 tabs, twice daily before meals · 14 days',
    );
    expect(
      dosageLine({ ...envelope, amount: '5', unit: 'drops', frequency: 'at bedtime', length: '2', period: 'weeks' }),
    ).toBe('5 drops, at bedtime · 2 weeks');
    expect(dosageLine({ ...envelope, amount: ' ' })).toBe('twice daily');
    expect(dosageHalves({ ...envelope, timing: 'before meals', length: '14' })).toEqual([
      '4 tabs, twice daily',
      'before meals · 14 days',
    ]);
  });

  it('turns a saved visit back into envelopes that can be edited', () => {
    expect(envelopesOf(lastVisit)).toEqual([
      {
        medicines: [
          { name: 'Remedy A', potency: '30C' },
          { name: 'Remedy B', potency: '200C' },
        ],
        amount: '4',
        unit: 'tabs',
        frequency: 'twice daily',
        timing: '',
        length: '14',
        period: 'days',
      },
    ]);
  });
});

describe('writing a visit', () => {
  it('finalises a visit with envelopes, measurements and a remember note, after asking once', async () => {
    const calls = server();
    mount();
    const remember = await screen.findByRole('region', { name: 'Remember about Anita' });
    expect(await within(remember).findByText('Daughter is also a patient')).toBeInTheDocument();
    await userEvent.click(within(remember).getByRole('button', { name: '+ Add' }));
    await userEvent.type(within(remember).getByLabelText('Add something to remember'), 'Teaches dance');
    await userEvent.click(within(remember).getByRole('button', { name: 'Add' }));
    expect(await within(remember).findByText('Teaches dance')).toBeInTheDocument();
    expect(calls.notes[0].body).toEqual({ patient: 'patient-id', kind: 'remember', body: 'Teaches dance' });
    // No earlier visit: this is a first visit, and there is no "Last visit" to open.
    expect(screen.getByRole('radio', { name: 'First visit' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Last visit ▸' })).not.toBeInTheDocument();

    // Finalising without a complaint is refused in plain words.
    await userEvent.click(screen.getByRole('button', { name: 'Finalise visit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write the complaint');
    await userEvent.type(screen.getByLabelText("Complaint, in the patient's words"), 'Synthetic complaint');
    await userEvent.click(screen.getByRole('radio', { name: 'Better' }));
    await userEvent.click(screen.getByText('Measurements (optional)'));
    await userEvent.type(screen.getByLabelText('Weight kg'), '64.5');
    await userEvent.type(screen.getByLabelText('BP'), '118/76');
    await userEvent.type(screen.getByLabelText('Pulse'), '72');

    await userEvent.click(screen.getByRole('button', { name: '+ Add an envelope' }));
    const first = screen.getByRole('region', { name: 'Envelope 1' });
    await userEvent.type(within(first).getByLabelText('Medicine name'), 'Remedy A');
    await userEvent.type(within(first).getByLabelText('Potency'), '30C');
    await userEvent.type(within(first).getByLabelText('Amount'), '4');
    await userEvent.selectOptions(within(first).getByLabelText('When'), 'before meals');
    expect(within(first).getByLabelText('Label will read: 4 tabs, twice daily before meals')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '+ Add another envelope' }));
    const second = screen.getByRole('region', { name: 'Envelope 2' });
    await userEvent.type(within(second).getByLabelText('Medicine name'), 'Remedy B');
    await userEvent.type(within(second).getByLabelText('Amount'), '5');
    await userEvent.selectOptions(within(second).getByLabelText('Unit'), 'drops');
    await userEvent.click(screen.getByRole('radio', { name: '2 wk' }));

    await userEvent.click(screen.getByRole('button', { name: 'Finalise visit' }));
    const question = await screen.findByRole('alertdialog', { name: 'Finalise this visit?' });
    expect(calls.encounters).toBeUndefined();
    await userEvent.click(within(question).getByRole('button', { name: 'Finalise' }));

    expect(await screen.findByText('Visit finalised. A draft bill is waiting in Billing.')).toBeInTheDocument();
    expect(calls.invoices[0].body).toEqual({ encounter: 'new-encounters' });
    const sent = calls.encounters[0].body;
    expect(sent).toMatchObject({
      patient: 'patient-id',
      visit_type: 'first',
      progress: 'better',
      chief_complaint: 'Synthetic complaint',
      prescriptions: [
        {
          dosage_line: '4 tabs, twice daily before meals',
          items: [{ medicine_name_snapshot: 'Remedy A', potency: '30C' }],
        },
        { dosage_line: '5 drops, twice daily', items: [{ medicine_name_snapshot: 'Remedy B', potency: '' }] },
      ],
      products: [],
    });
    expect(
      (sent.observations as { kind: string; value: string; unit: string }[]).map((o) => [o.kind, o.value, o.unit]),
    ).toEqual([
      ['weight', '64.5', 'kg'],
      ['systolic', '118', 'mmHg'],
      ['diastolic', '76', 'mmHg'],
      ['pulse', '72', 'bpm'],
    ]);
    expect(String(sent.follow_up_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // "Print envelope label" was ticked, so the label window opens on the patient's page.
    expect(await screen.findByRole('dialog', { name: 'Print envelope labels' })).toBeInTheDocument();
  });

  it('keeps the visit as a draft that saves itself and opens again later', async () => {
    const calls = server({
      drafts: [
        {
          id: 'draft-id',
          mine: true,
          author_name: 'Dr Synthetic',
          updated_at: '2026-10-06T04:11:00Z',
          data: {
            complaint: 'Half written yesterday',
            envelopes: [{ ...envelope, medicines: [{ name: 'Remedy A', potency: '30C' }] }],
          },
        },
        { id: 'other', mine: false, author_name: 'Dr Colleague', updated_at: '2026-10-06T04:00:00Z', data: {} },
      ],
    });
    mount();
    expect(await screen.findByLabelText("Complaint, in the patient's words")).toHaveValue('Half written yesterday');
    expect(within(screen.getByRole('region', { name: 'Envelope 1' })).getByLabelText('Medicine name')).toHaveValue(
      'Remedy A',
    );
    expect(screen.getByText(/Draft saved 09:41\./)).toBeInTheDocument();
    expect(screen.getByText(/Dr Colleague also has a draft open/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Doctor's notes for this visit"), 'More today');
    expect(screen.getByText(/Saving the draft as you write\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(calls['visit-drafts'][0]).toMatchObject({
      method: 'PATCH',
      body: { data: { complaint: 'Half written yesterday', notes: 'More today' } },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(await screen.findByText('Draft discarded.')).toBeInTheDocument();
    expect(calls['visit-drafts'].at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('offers the last visit beside the new one, to read and to repeat', async () => {
    server({ visits: [lastVisit] });
    mount();
    expect(
      await screen.findByText(/Right-sided headache, worse in sunlight\. Envelope: 4 tabs, twice daily · 14 days\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Follow-up' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Last visit ▸' }));
    const panel = screen.getByRole('complementary', { name: 'Last visit' });
    expect(within(panel).getByText('Remedy A 30C + Remedy B 200C · 4 tabs, twice daily · 14 days')).toBeInTheDocument();
    expect(within(panel).getByText('162 cm · BP 118/76')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Copy prescription' }));
    const copied = screen.getByRole('region', { name: 'Envelope 1' });
    expect(
      within(copied)
        .getAllByLabelText('Medicine name')
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(['Remedy A', 'Remedy B']);
    expect(within(copied).getByLabelText('For')).toHaveValue('14');

    await userEvent.click(screen.getByRole('button', { name: 'Repeat last' }));
    expect(screen.getByRole('region', { name: 'Envelope 2' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'From a set ▾' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Teething' }));
    expect(within(screen.getByRole('region', { name: 'Envelope 3' })).getByLabelText('Medicine name')).toHaveValue(
      'Set remedy',
    );
  });

  it('asks who a scanned product is for while a visit is open, and bills it with the visit', async () => {
    const calls = server({ role: 'owner', visits: [lastVisit] });
    mount();
    await userEvent.type(await screen.findByLabelText("Complaint, in the patient's words"), 'Synthetic complaint');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    (document.activeElement as HTMLElement | null)?.blur();
    const clock = vi.spyOn(performance, 'now');
    let time = 90_000;
    for (const key of [...'8901234567890', 'Enter']) {
      clock.mockReturnValue((time += 5));
      fireEvent.keyDown(window, { key });
    }
    clock.mockRestore();
    const asked = await screen.findByRole('dialog', { name: 'Product scanned' });
    expect(asked).toHaveTextContent('Vitamin D3 capsules, 60 · ₹450.00');
    expect(asked).toHaveTextContent('A visit for Anita Synthetic is open. Who is this for?');
    expect(within(asked).getByRole('button', { name: 'New bill for someone else' })).toBeInTheDocument();
    await userEvent.click(within(asked).getByRole('button', { name: "Add to Anita's visit" }));
    expect(screen.getByLabelText('Quantity of Vitamin D3 capsules, 60')).toHaveValue('1');
    await userEvent.type(screen.getByLabelText('Note for Vitamin D3 capsules, 60'), 'One a day');

    await userEvent.click(screen.getByLabelText('Print envelope label'));
    await userEvent.click(screen.getByRole('button', { name: 'Finalise visit' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Finalise' }));
    expect(await screen.findByText('Visit finalised. A draft bill is waiting in Billing.')).toBeInTheDocument();
    expect(calls.encounters[0].body.products).toEqual([
      {
        price_item_id: 'item-d3',
        name: 'Vitamin D3 capsules, 60',
        kind: 'supplement',
        quantity: '1',
        rate: '450',
        gst_rate: '18',
        note: 'One a day',
      },
    ]);
    expect(calls.invoices[0].body).toEqual({ encounter: 'new-encounters' });
    expect(screen.queryByRole('dialog', { name: 'Print envelope labels' })).not.toBeInTheDocument();
  });

  it('is for doctors: an assistant is sent back to the patient record', async () => {
    server({ role: 'assistant' });
    const router = mount();
    await waitFor(() => expect(router.state.location.pathname).toBe('/patients/patient-id'));
    expect(screen.queryByText('Finalise visit')).not.toBeInTheDocument();
  });

  it('adds an amendment beside a finalised visit', async () => {
    const calls = server({ visits: [lastVisit] });
    mount('/patients/patient-id?tab=visits');
    await userEvent.click(await screen.findByRole('button', { name: 'Amend' }));
    const window_ = screen.getByRole('dialog', { name: 'Amend visit · 06 Aug 2026' });
    expect(within(window_).getByRole('button', { name: 'Add amendment' })).toBeDisabled();
    await userEvent.type(within(window_).getByLabelText('Correction'), 'Potency should read 30C.');
    await userEvent.type(within(window_).getByLabelText('Reason'), 'Typing mistake');
    await userEvent.click(within(window_).getByRole('button', { name: 'Add amendment' }));
    expect(await screen.findByText('Amendment added.')).toBeInTheDocument();
    expect(calls.encounters[0].body).toEqual({
      section: 'prescription',
      correction: 'Potency should read 30C.',
      reason: 'Typing mistake',
    });
  });
});
