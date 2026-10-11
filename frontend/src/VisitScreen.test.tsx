import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { dosageLine } from './VisitScreen';
import { Session } from './types';

const session: Session = {
  user: { id: 'user-id', username: 'doctor', name: '' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role: 'clinician' }],
  csrf_token: 'token',
};
const patient = {
  id: 'patient-id',
  first_name: 'Anita',
  middle_name: '',
  last_name: 'Synthetic',
  date_of_birth: '1990-01-01',
  gender: 'other',
  phone: '',
  email: '',
  address: null,
  photos: [],
  archived_at: null,
  created_at: '',
};
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const envelope = {
  medicines: [],
  amount: '4',
  unit: 'tabs',
  frequency: 'twice daily',
  timing: '',
  length: '',
  period: 'days',
};

beforeEach(() => {
  vi.restoreAllMocks();
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
  });
});

describe('recording a visit', () => {
  it('saves envelopes with their mix and dosage line, and remember notes on their own', async () => {
    const posted: Record<string, { [key: string]: unknown }> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(session);
      if (options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        posted[path.includes('notes') ? 'note' : 'visit'] = body;
        return response({ id: 'new-id', ...body, author_name: '', amends: null, created_at: '' }, 201);
      }
      if (path.includes('kind=remember'))
        return response({
          count: 1,
          next: null,
          previous: null,
          results: [{ id: 'n1', body: 'Daughter is also a patient' }],
        });
      if (/encounters|notes|library/.test(path)) return response({ count: 0, next: null, previous: null, results: [] });
      return response(patient);
    });
    render(
      <RouterProvider
        router={createMemoryRouter([{ path: '*', element: <App /> }], {
          initialEntries: ['/patients/patient-id/encounters/new'],
        })}
      />,
    );
    const remember = await screen.findByRole('region', { name: 'Remember about Anita' });
    expect(await within(remember).findByText('Daughter is also a patient')).toBeInTheDocument();
    await userEvent.type(within(remember).getByLabelText('Add something to remember'), 'Teaches dance');
    await userEvent.click(within(remember).getByRole('button', { name: 'Add' }));
    expect(await within(remember).findByText('Teaches dance')).toBeInTheDocument();
    expect(posted.note).toEqual({ patient: 'patient-id', kind: 'remember', body: 'Teaches dance' });

    await userEvent.type(screen.getByLabelText("Complaint, in the patient's words"), 'Synthetic complaint');
    await userEvent.click(screen.getByRole('button', { name: 'Add an envelope' }));
    const first = screen.getByRole('region', { name: 'Envelope 1' });
    await userEvent.type(within(first).getByLabelText('Medicine name'), 'Remedy A');
    await userEvent.type(within(first).getByLabelText('Potency'), '30C');
    await userEvent.type(within(first).getByLabelText('Amount'), '4');
    await userEvent.selectOptions(within(first).getByLabelText('When'), 'before meals');
    expect(within(first).getByText('4 tabs, twice daily before meals')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add another envelope' }));
    const second = screen.getByRole('region', { name: 'Envelope 2' });
    await userEvent.type(within(second).getByLabelText('Medicine name'), 'Remedy B');
    await userEvent.type(within(second).getByLabelText('Amount'), '5');
    await userEvent.selectOptions(within(second).getByLabelText('Unit'), 'drops');
    await userEvent.click(screen.getByRole('button', { name: 'Save visit' }));

    expect(await screen.findByText('Visit saved.')).toBeInTheDocument();
    expect(posted.visit).toMatchObject({
      patient: 'patient-id',
      visit_type: 'follow_up',
      chief_complaint: 'Synthetic complaint',
      prescriptions: [
        {
          dosage_line: '4 tabs, twice daily before meals',
          items: [{ medicine_name_snapshot: 'Remedy A', potency: '30C' }],
        },
        { dosage_line: '5 drops, twice daily', items: [{ medicine_name_snapshot: 'Remedy B', potency: '' }] },
      ],
    });
  });
});
