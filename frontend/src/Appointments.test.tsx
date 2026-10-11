import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { Appointment, addMonths, monthCells, monthName, statusOf } from './AppointmentsScreen';
import { isoDay, setClinicLocale, weekdayDate } from './format';
import { Role, Session } from './types';
import { clearNotices } from './ui';
import { greeting } from './WorkspaceScreens';

const sessionFor = (role: Role): Session => ({
  user: { id: 'user-id', username: 'owner', name: 'Dr Synthetic' },
  clinic_id: 'clinic-id',
  memberships: [
    { clinic_id: 'clinic-id', clinic_name: 'Test clinic', role, time_zone: 'Asia/Kolkata', currency: 'INR' },
  ],
  csrf_token: 'token',
});
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
function mount(path: string) {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}
// The clinic's own date, as the screens use it. Without this the test's "today" is the computer's, which differs
// from the clinic's for part of every day.
setClinicLocale('Asia/Kolkata', 'INR');
const today = isoDay();
const booked: Appointment = {
  id: 'a1',
  day: today,
  time: '10:00',
  duration_minutes: 15,
  visit_type: 'follow_up',
  reason: '',
  status: 'booked',
  walk_in: false,
  arrived_at: null,
  waiting_minutes: null,
  billed: false,
  remind: true,
  reminder_at: null,
  cancel_reason: '',
  patient: { id: 'patient-id', name: 'Synthetic Patient', code: 'PAT-W8KQ3G7DP9', phone: '5550100' },
  doctor: { id: 'user-id', name: 'Dr Synthetic' },
};
const slots = {
  day: today,
  sessions: [
    ['09:30', '13:00'],
    ['17:00', '20:00'],
  ],
  slots: [
    { time: '09:30', free: true },
    { time: '09:45', free: true },
    { time: '10:00', free: false },
    { time: '17:00', free: true },
  ],
};
const usual = [
  ['09:30', '13:00'],
  ['17:00', '20:00'],
];
const month = today.slice(0, 7);
const dates = monthCells(month).filter((date): date is string => !!date);
const workDays = Object.fromEntries(
  dates.filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() !== 0).map((date) => [date, usual]),
);

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}
/** A pretend server for the diary. Every call is kept, so a test can check what was sent and where. */
function mockServer(role: Role, more: (call: Call) => unknown = () => undefined) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
    const call: Call = {
      path: String(url),
      method: options?.method ?? 'GET',
      body: options?.body ? JSON.parse(String(options.body)) : null,
    };
    calls.push(call);
    const { path, method } = call;
    const special = more(call);
    if (special !== undefined) return response(special);
    if (path.endsWith('me/')) return response(sessionFor(role));
    if (path.includes('appointments/doctors/')) return response([{ id: 'user-id', name: 'Dr Synthetic' }]);
    if (path.includes('appointments/slots/')) return response(slots);
    if (path.includes('appointments/follow-ups/')) return response({ count: 0, results: [] });
    if (path.includes('appointments/by-phone/'))
      return response({
        patients: [
          {
            id: 'patient-id',
            name: 'Synthetic Patient',
            date_of_birth: '1990-01-01',
            gender: 'female',
            code: 'PAT-W8KQ3G7DP9',
          },
        ],
      });
    if (path.includes('work-days/templates/'))
      return response([1, 2, 3, 4].map((slot) => ({ slot, name: '', hours: null })));
    if (path.includes('work-days/'))
      return response({ month, saved: true, days: method === 'POST' ? call.body!.days : workDays });
    if (path.endsWith('appointments/') && method === 'POST')
      return response({ ...booked, id: 'a2', time: call.body!.time });
    if (path.includes('appointments/')) return response({ results: [booked] });
    return response({ count: 0, next: null, previous: null, results: [] });
  });
  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearNotices();
});

describe('diary helpers', () => {
  it('greets by the time of day', () => {
    expect(greeting(8)).toBe('Good morning');
    expect(greeting(12)).toBe('Good afternoon');
    expect(greeting(17)).toBe('Good evening');
  });

  it('lays a month out from Monday, and steps across a year end', () => {
    // 1 October 2026 is a Thursday: three blanks, then the 31 days.
    const cells = monthCells('2026-10');
    expect(cells.slice(0, 4)).toEqual([null, null, null, '2026-10-01']);
    expect(cells).toHaveLength(34);
    expect(monthCells('2028-02').filter(Boolean)).toHaveLength(29);
    expect(monthName('2026-10')).toBe('October 2026');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('words the status of an appointment', () => {
    expect(statusOf(booked)).toEqual(['grey', 'Booked']);
    expect(statusOf({ ...booked, reminder_at: '2026-10-05T10:00:00Z' })).toEqual([
      'grey',
      'Booked · reminder prepared',
    ]);
    expect(statusOf({ ...booked, status: 'arrived', waiting_minutes: 0 })).toEqual(['blue', 'Arrived']);
    expect(statusOf({ ...booked, status: 'arrived', waiting_minutes: 12 })).toEqual(['amber', 'Waiting 12 min']);
    expect(statusOf({ ...booked, status: 'seen', billed: true })).toEqual(['green', 'Seen · billed']);
    expect(statusOf({ ...booked, status: 'cancelled', cancel_reason: 'Unwell' })).toEqual([
      'red',
      'Cancelled · Unwell',
    ]);
    expect(statusOf({ ...booked, status: 'no_show' })).toEqual(['red', 'No-show']);
  });
});

describe('dashboard', () => {
  const dashboard = {
    day: today,
    appointments: { total: 3, seen: 1 },
    follow_ups_due: 2,
    unpaid: { count: 1, total: '320.00' },
    queue: [booked],
    attention: [{ kind: 'drafts', count: 1 }],
    recent: [{ id: 'patient-id', name: 'Synthetic Patient', last_visit: null }],
  };

  it('shows the day at a glance and marks someone arrived', async () => {
    const calls = mockServer('owner', ({ path }) => (path.includes('dashboard/') ? dashboard : undefined));
    mount('/dashboard');
    expect(
      await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), Dr Synthetic$/ }),
    ).toBeVisible();
    expect(await screen.findByRole('link', { name: /3\s*appointments today · 1 seen/ })).toHaveAttribute(
      'href',
      '/appointments',
    );
    expect(screen.getByRole('link', { name: /2\s*patients due for their next visit/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /1\s*unpaid invoice · ₹\s?320/ })).toHaveAttribute(
      'href',
      '/billing/outstanding',
    );
    expect(screen.getByText('1 visit left as a draft')).toBeInTheDocument();
    expect(screen.getByText('No visit yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark arrived' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('appointments/a1/arrive/'))).toBe(true),
    );
  });

  it('leaves out the diary and the money for someone who does not work with them', async () => {
    mockServer('billing', ({ path }) =>
      path.includes('dashboard/')
        ? { ...dashboard, appointments: null, follow_ups_due: null, queue: [], attention: [], recent: [] }
        : undefined,
    );
    mount('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Where to start' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New appointment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Today.s queue$/ })).not.toBeInTheDocument();
  });
});

describe('appointments', () => {
  it('shows the day with its free times and the closed hours between sessions', async () => {
    mockServer('reception');
    mount('/appointments');
    const day = await screen.findByRole('region', { name: 'Day' });
    expect(await within(day).findByRole('link', { name: 'Synthetic Patient' })).toBeInTheDocument();
    expect(within(day).getByText('Booked')).toBeInTheDocument();
    expect(within(day).getAllByRole('button', { name: 'Free · click to book' })).toHaveLength(3);
    expect(within(day).getByText('Clinic closed 13:00 to 17:00')).toBeInTheDocument();
    // Reception marks arrivals but does not start visits.
    expect(within(day).getByRole('button', { name: 'Mark arrived' })).toBeInTheDocument();
    expect(screen.getByText('Nobody is waiting.')).toBeInTheDocument();
  });

  it('books from a phone number, a tapped day and a tapped time, keeping the number out of addresses', async () => {
    const calls = mockServer('reception');
    mount('/appointments');
    const day = await screen.findByRole('region', { name: 'Day' });
    await userEvent.click((await within(day).findAllByRole('button', { name: 'Free · click to book' }))[0]);
    const window_ = await screen.findByRole('dialog', { name: 'New appointment' });
    const book = within(window_).getByRole('button', { name: 'Book appointment' });
    expect(book).toBeDisabled();
    expect(within(window_).getByText(`Choose the patient · ${weekdayDate(today)} · 09:30`)).toBeInTheDocument();

    await userEvent.type(within(window_).getByLabelText('Phone number'), '98200 00101');
    await userEvent.click(await within(window_).findByRole('button', { name: /Synthetic Patient/ }));
    // A first visit needs 45 minutes, so 09:45 no longer fits before the 10:00 booking.
    await userEvent.click(within(window_).getByRole('radio', { name: 'First visit · 45 min' }));
    expect(within(window_).getByRole('button', { name: '09:45' })).toBeDisabled();
    await userEvent.click(within(window_).getByRole('radio', { name: 'Follow-up · 15 min' }));
    expect(within(window_).getByRole('button', { name: '10:00' })).toBeDisabled();
    await userEvent.click(within(window_).getByRole('button', { name: '09:45' }));
    await userEvent.click(book);

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/appointments/'))).toBe(true),
    );
    const sent = calls.find((call) => call.method === 'POST' && call.path.endsWith('/appointments/'))!;
    expect(sent.body).toEqual({
      patient: 'patient-id',
      day: today,
      time: '09:45',
      visit_type: 'follow_up',
      doctor: 'user-id',
      remind: true,
    });
    expect(calls.find((call) => call.path.includes('by-phone/'))!.body).toEqual({ phone: '98200 00101' });
    expect(calls.some((call) => /9820|0101/.test(call.path))).toBe(false);
    expect(await screen.findByText('Appointment booked.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New appointment' })).not.toBeInTheDocument();
  });

  it('asks for a reason before cancelling', async () => {
    const calls = mockServer('reception');
    mount('/appointments');
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Synthetic Patient' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Cancel appointment' }));
    const window_ = await screen.findByRole('dialog', { name: "Cancel Synthetic Patient's appointment?" });
    const reason = within(window_).getByLabelText('Reason');
    await userEvent.clear(reason);
    await userEvent.type(reason, 'Travelling');
    await userEvent.click(within(window_).getByRole('button', { name: 'Cancel appointment' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('appointments/a1/cancel/'))).toBe(true));
    expect(calls.find((call) => call.path.endsWith('appointments/a1/cancel/'))!.body).toEqual({ reason: 'Travelling' });
  });
});

describe('work week', () => {
  it('closes a tapped date and saves the month without it', async () => {
    const calls = mockServer('owner');
    mount('/settings/work-week');
    const first = Object.keys(workDays)[0];
    const label = `${Number(first.slice(8))} ${monthName(month)}`;
    const date = await screen.findByRole('button', { name: `${label}: working` });
    const working = Object.keys(workDays).length;
    expect(screen.getByText(`${working} working days in ${monthName(month)}.`)).toBeInTheDocument();
    expect(screen.getByText('0 of 4 used')).toBeInTheDocument();
    await userEvent.click(date);
    expect(screen.getByRole('button', { name: `${label}: closed` })).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('work-days/'))).toBe(true),
    );
    const sent = calls.find((call) => call.method === 'POST' && call.path.endsWith('work-days/'))!.body as {
      month: string;
      days: Record<string, string[][]>;
    };
    expect(sent.month).toBe(month);
    expect(Object.keys(sent.days)).toHaveLength(working - 1);
    expect(sent.days[first]).toBeUndefined();
    expect(Object.values(sent.days)[0]).toEqual(usual);
    expect(await screen.findByText('Work week saved.')).toBeInTheDocument();
  });
});
