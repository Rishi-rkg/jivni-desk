import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { looksLikePatientCode } from './Scanner';
import { Session } from './types';

const session: Session = {
  user: { id: 'user-id', username: 'reception', name: '' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role: 'reception' }],
  csrf_token: 'token',
};
const patient = {
  id: 'patient-id',
  identifier: 'PAT-W8KQ3G7DP9',
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
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

function mount(path: string) {
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] })} />);
}

/** A scanner: a key every 5 ms, then Enter. The clock is set by hand so a busy test machine cannot slow it. */
function scan(code: string, target: Element | Window = window) {
  const clock = vi.spyOn(performance, 'now');
  let time = 10_000;
  for (const key of [...code, 'Enter']) {
    clock.mockReturnValue((time += 5));
    fireEvent.keyDown(target, { key });
  }
  clock.mockRestore();
}

/**
 * The workspace is on screen AND React has attached the scanner's key listener. The listener is attached
 * in an effect, which runs just after the screen appears; without this wait a scan can arrive first.
 */
async function workspaceReady() {
  await screen.findByRole('heading', { name: 'More clinic tools' });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mockServer(scanStatus = 200) {
  const requested: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const path = String(url);
    requested.push(path);
    if (path.endsWith('me/')) return response(session);
    if (path.includes('/scan/'))
      return scanStatus === 200
        ? response({ kind: 'patient', patient })
        : response({ kind: 'unknown', detail: 'x' }, 404);
    if (path.includes('patients/patient-id')) return response(patient);
    return response({ count: 0, next: null, previous: null, results: [] });
  });
  return requested;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('barcode scanning', () => {
  it('opens the patient when a card is scanned with no field in use', async () => {
    const requested = mockServer();
    mount('/modules');
    await workspaceReady();
    scan('PAT-W8KQ3G7DP9');
    expect(await screen.findByRole('heading', { name: 'Synthetic Patient' })).toBeInTheDocument();
    expect(requested).toContain('/api/v1/scan/PAT-W8KQ3G7DP9/');
  });

  it('says so when the code matches nothing, and stays on the page', async () => {
    mockServer(404);
    mount('/modules');
    await workspaceReady();
    scan('8901234567890');
    expect(await screen.findByRole('alert')).toHaveTextContent('That code does not match a patient in this clinic.');
    expect(screen.getByRole('heading', { name: 'More clinic tools' })).toBeInTheDocument();
  });

  it('leaves a scan alone when someone is typing in a field', async () => {
    const requested = mockServer();
    mount('/patients');
    const search = await screen.findByLabelText('Search patients');
    scan('PAT-W8KQ3G7DP9', search);
    await waitFor(() => expect(requested.some((path) => path.includes('patients/'))).toBe(true));
    expect(requested.some((path) => path.includes('/scan/'))).toBe(false);
  });

  it('ignores ordinary slow typing and short bursts', async () => {
    const requested = mockServer();
    mount('/modules');
    await workspaceReady();
    scan('abc');
    const clock = vi.spyOn(performance, 'now');
    let time = 1000;
    for (const key of 'PAT-W8KQ3G7DP9') {
      clock.mockReturnValue((time += 200));
      fireEvent.keyDown(window, { key });
    }
    clock.mockReturnValue(time + 200);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(requested.some((path) => path.includes('/scan/'))).toBe(false);
  });

  it('opens the patient when a card code is entered in the dashboard search', async () => {
    const requested = mockServer();
    mount('/dashboard');
    await userEvent.type(await screen.findByLabelText('Name, phone, or patient ID'), 'pat-w8kq3g7dp9{Enter}');
    expect(await screen.findByRole('heading', { name: 'Synthetic Patient' })).toBeInTheDocument();
    expect(requested).toContain('/api/v1/scan/pat-w8kq3g7dp9/');
  });

  it('recognises patient codes and nothing else', () => {
    for (const text of ['PAT-W8KQ3G7DP9', 'pat-w8kq3g7dp9', 'W8KQ3G7DP9', ' PAT-W8KQ3G7DP9 '])
      expect(looksLikePatientCode(text)).toBe(true);
    for (const text of ['Anita Rao', '5550142', 'PAT-W8KQ3G7DP', 'PAT-W8KQ3G7DP0', ''])
      expect(looksLikePatientCode(text)).toBe(false);
  });
});
