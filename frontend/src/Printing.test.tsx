import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { EnvelopeLabel, LabelData, dosageParts, labelSize } from './Labels';
import { reprintLink } from './PrintingScreen';
import { Role, Session } from './types';
import { clearNotices } from './ui';

const sessionFor = (role: Role): Session => ({
  user: { id: 'user-id', username: 'owner', name: 'Dr Synthetic' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role, time_zone: 'Asia/Kolkata' }],
  csrf_token: 'token',
});
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
function mount(path: string) {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}
const settings = {
  size: '2x2in',
  width_mm: 50.8,
  height_mm: 50.8,
  dosage_size: 'large',
  show_logo: true,
  show_address: true,
  show_phone: true,
  show_barcode: true,
  show_next_visit: true,
  show_medicines: false,
} as const;
const label: LabelData = {
  clinic: {
    name: 'Test clinic',
    address: '4 Garden Street\nPune 411001',
    phone: '+91 90000 00100',
    email: '',
    registration_number: '',
    has_logo: false,
  },
  patient: { id: 'patient-id', name: 'Synthetic Patient', code: 'PAT-W8KQ3G7DP9' },
  date: '2026-10-06',
  next_visit: '2026-10-20',
  envelopes: [
    {
      number: 1,
      dosage_line: '4 tabs, twice daily before meals · 14 days',
      dosage: {
        amount: '4',
        unit: 'tabs',
        frequency: 'twice daily',
        timing: 'before meals',
        length: '14',
        period: 'days',
      },
      medicines: [],
    },
    { number: 2, dosage_line: '1 powder at bedtime, once a week', dosage: {}, medicines: [] },
  ],
  settings,
};
const templates = [
  {
    kind: 'label',
    title: 'Envelope label',
    version: 2,
    settings,
    saved_by_name: 'Dr Synthetic',
    saved_at: '2026-10-01T05:00:00Z',
  },
  {
    kind: 'invoice',
    title: 'Invoice',
    version: 0,
    settings: { show_upi: true, footer_note: '' },
    saved_by_name: '',
    saved_at: null,
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
  clearNotices();
});

describe('the envelope label', () => {
  it('splits the dosage for a small label and falls back to the whole sentence', () => {
    expect(dosageParts(label.envelopes[0])).toEqual(['4 tabs, twice daily', 'before meals · 14 days']);
    expect(dosageParts(label.envelopes[1])).toEqual(['1 powder at bedtime, once a week', '']);
    expect(labelSize(settings)).toEqual([50.8, 50.8]);
    expect(labelSize({ size: 'custom', width_mm: 62, height_mm: 29 })).toEqual([62, 29]);
  });

  it('prints the clinic, the patient, the dosage, both dates, the barcode and a counter', () => {
    render(<EnvelopeLabel data={label} envelope={label.envelopes[1]} />);
    const printed = screen.getByRole('img', { name: 'Label for envelope 2' });
    expect(printed).toHaveStyle({ width: '50.8mm', height: '50.8mm' });
    for (const text of [
      'Test clinic',
      '4 Garden Street, Pune 411001',
      'Synthetic Patient',
      '06 Oct 2026',
      '20 Oct 2026',
      '2 of 2',
    ])
      expect(within(printed).getByText(text)).toBeInTheDocument();
    expect(within(printed).getByText('PAT-W8KQ3G7DP9')).toBeInTheDocument();
    expect(within(printed).getByRole('img', { name: 'Patient barcode' })).toBeInTheDocument();
  });

  it('follows the layout: no counter for one envelope, "As needed", hidden parts, and names only when chosen', () => {
    const one: LabelData = {
      ...label,
      next_visit: '',
      envelopes: [{ ...label.envelopes[0], medicines: ['Synthetic remedy 30C'] }],
      settings: { ...settings, show_barcode: false, show_phone: false },
    };
    render(<EnvelopeLabel data={one} envelope={one.envelopes[0]} />);
    const printed = screen.getByRole('img', { name: 'Label for envelope 1' });
    expect(within(printed).getByText('As needed')).toBeInTheDocument();
    expect(within(printed).queryByText(/of 1/)).not.toBeInTheDocument();
    expect(within(printed).queryByRole('img', { name: 'Patient barcode' })).not.toBeInTheDocument();
    expect(within(printed).queryByText('+91 90000 00100')).not.toBeInTheDocument();
    // The server only sends medicine names when the clinic's layout prints them.
    expect(within(printed).getByText('Synthetic remedy 30C')).toBeInTheDocument();
  });
});

describe('the printing screens', () => {
  it('prints the chosen envelopes with the chosen copies and tells the print queue', async () => {
    const jobs: unknown[] = [];
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('assistant'));
      if (path.includes('print-jobs/')) {
        jobs.push(JSON.parse(options?.body as string));
        return response({}, 201);
      }
      return response(label);
    });
    mount('/print/labels/visit-id?e=2,1&c=2,1');
    expect(await screen.findAllByRole('img', { name: 'Label for envelope 2' })).toHaveLength(2);
    expect(screen.getAllByRole('img', { name: 'Label for envelope 1' })).toHaveLength(1);
    expect(screen.getByText(/3 labels, each 50.8 × 50.8 mm/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(jobs).toEqual([{ kind: 'label', encounter: 'visit-id', envelopes: [2, 1], copies: 3 }]);
  });

  it('lets the owner change the label layout with a live preview and save a new version', async () => {
    const saved: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('owner'));
      if (path.includes('print-templates/') && options?.method === 'POST') {
        const body = JSON.parse(options.body as string);
        saved.push(body);
        return response({ ...templates[0], version: 3, settings: body.settings }, 201);
      }
      if (path.includes('print-templates/')) return response(templates);
      return response(label);
    });
    mount('/printing/label');
    expect(await screen.findByText('Version 2 · in use')).toBeInTheDocument();
    const preview = await screen.findByRole('img', { name: 'Label for envelope 1' });
    expect(within(preview).getByText('+91 90000 00100')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as version 3' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Print medicine names' })).not.toBeChecked();

    await userEvent.click(screen.getByRole('switch', { name: 'Show clinic phone' }));
    await userEvent.selectOptions(screen.getByLabelText('Label size'), '50x25mm');
    await waitFor(() => expect(within(preview).queryByText('+91 90000 00100')).not.toBeInTheDocument());
    expect(screen.getByText(/Actual size 50 × 25 mm\. Not saved yet\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save as version 3' }));
    expect(await screen.findByText('Saved as version 3.')).toBeInTheDocument();
    expect(saved).toEqual([{ kind: 'label', settings: { ...settings, show_phone: false, size: '50x25mm' } }]);
    expect(screen.getByText('Version 3 · in use')).toBeInTheDocument();
  });

  it('shows layouts read-only to everyone else', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('reception'));
      if (path.includes('print-templates/')) return response(templates);
      return response(label);
    });
    mount('/printing/label');
    expect(await screen.findByRole('switch', { name: 'Show clinic phone' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save as version/ })).not.toBeInTheDocument();
    expect(screen.getByText('Only the owner or an administrator changes a layout.')).toBeInTheDocument();
  });

  it('lists what was printed today with a way to print it again', async () => {
    const job = {
      id: 'job-1',
      kind: 'label',
      title: 'Envelope label × 2',
      patient: 'Synthetic Patient',
      patient_id: 'patient-id',
      encounter: 'visit-id',
      invoice: null,
      copies: 2,
      printer: "This computer's print window",
      envelopes: [1, 2],
      created_by_name: 'Arun',
      created_at: '2026-10-06T04:28:00Z',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).endsWith('me/') ? response(sessionFor('assistant')) : response({ day: '2026-10-06', results: [job] }),
    );
    mount('/printing');
    const row = (await screen.findByText('Envelope label × 2')).closest('tr')!;
    expect(within(row).getByText('09:58')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Reprint' })).toHaveAttribute('href', '/print/labels/visit-id?e=1,2');
    expect(reprintLink({ ...job, kind: 'card', encounter: null })).toBe('/print/card/patient-id');
    expect(reprintLink({ ...job, kind: 'invoice', invoice: 'bill-id' })).toBe('/print/invoice/bill-id');
    await userEvent.click(screen.getByRole('button', { name: 'Cards' }));
    expect(screen.queryByText('Envelope label × 2')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing has been printed today/)).toBeInTheDocument();
  });
});
