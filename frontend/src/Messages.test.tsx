import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { Message, statusOfMessage } from './messages';
import { Role, Session } from './types';
import { clearNotices } from './ui';

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
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] })} />);
}
const waiting: Message = {
  id: 'm1',
  status: 'waiting',
  source: 'rule',
  kind: 'care',
  title: '30 day check-in',
  body: 'Hello Vikram,\n\nWe hope you are doing well.',
  patient: { id: 'patient-id', name: 'Vikram Synthetic', archived: false },
  to: '+91 90000 00143',
  context: 'Rule: 30 day check-in',
  template: { name: 'Follow-up 30 days', version: 3 },
  blocked: '',
  consent: { kind: 'care', granted: true, recorded_at: '2026-06-12T10:00:00Z' },
  send_after: null,
  created_at: '2026-10-06T04:00:00Z',
  created_by_name: '',
  approved_at: null,
  approved_by_name: '',
  sent_at: null,
  sent_by_name: '',
  failed_reason: '',
};
const blocked: Message = {
  ...waiting,
  id: 'm2',
  title: '90 day follow-up',
  patient: { id: 'other-id', name: 'Mary Synthetic', archived: false },
  blocked: 'No care-message consent.',
  consent: { kind: 'care', granted: false, recorded_at: null },
};
const approved: Message = {
  ...waiting,
  id: 'm3',
  status: 'approved',
  title: 'Appointment reminder',
  approved_by_name: 'Dr Synthetic',
};
const templates = {
  fields: [
    { name: 'first_name', label: 'first name' },
    { name: 'clinic_name', label: 'clinic name' },
  ],
  rule: 'Messages never contain a diagnosis, symptoms or medicine names.',
  results: [
    {
      id: 't1',
      key: 'check_in_30',
      name: 'Follow-up 30 days',
      kind: 'care',
      body: 'Hello {first_name}',
      version: 3,
      approved: true,
      standard: true,
      uses: ['first name'],
      in_rules: true,
    },
    {
      id: 't2',
      key: '',
      name: 'Festival greeting',
      kind: 'greetings',
      body: 'Happy Diwali',
      version: 1,
      approved: false,
      standard: false,
      uses: [],
      in_rules: false,
    },
  ],
};
const rules = {
  without_approval: false,
  results: [
    {
      id: 'r1',
      name: '90 day follow-up',
      trigger: 'after_last_visit',
      days: 90,
      only_if_not_booked: true,
      template: { id: 't1', name: 'Follow-up 30 days', approved: true },
      enabled: false,
      needs_approval: true,
      words: 'Switched off',
    },
  ],
};

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}
function mockServer(role: Role, queue: Message[] = [waiting, blocked]) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
    const call: Call = {
      path: String(url),
      method: options?.method ?? 'GET',
      body: options?.body ? JSON.parse(String(options.body)) : null,
    };
    calls.push(call);
    const { path, method } = call;
    if (path.endsWith('me/')) return response(sessionFor(role));
    if (path.includes('messages/counts/')) return response({ waiting: queue.length, replies: 1, failed: 0 });
    if (path.includes('message-templates/')) return response(method === 'GET' ? templates : templates.results[0]);
    if (path.includes('message-rules/'))
      return response(method === 'GET' ? rules : { ...rules.results[0], enabled: true });
    if (path.includes('message-campaigns/'))
      return response({ audiences: [{ name: 'everyone', label: 'Every patient' }], results: [] });
    if (path.includes('messages/preview/'))
      return response({
        title: call.body!.template ? 'Follow-up 30 days' : 'Message',
        kind: 'care',
        body: call.body!.template ? 'Hello Vikram, how are you?' : '',
        missing: [],
        values: [{ label: 'first name', value: 'Vikram' }],
        to: '+91 90000 00143',
        blocked: { care: '', greetings: 'No consent to greetings and clinic news.' },
      });
    if (path.endsWith('/send/'))
      return response({ ...waiting, status: 'sent', link: 'https://wa.me/919000000143?text=Hello%20Vikram' });
    if (path.endsWith('/messages/') && method === 'POST')
      return response({ ...waiting, id: 'm9', source: 'template' }, 201);
    if (path.includes('messages/?patient=')) return response({ today: '2026-10-06', results: [] });
    if (path.includes('messages/?box=waiting')) return response({ today: '2026-10-06', results: queue });
    if (path.includes('patients/?search='))
      return response({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 'patient-id',
            identifier: 'PAT-W8KQ3G7DP9',
            first_name: 'Vikram',
            middle_name: '',
            last_name: 'Synthetic',
          },
        ],
      });
    return response({ count: 0, next: null, previous: null, results: [] });
  });
  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearNotices();
});

describe('messages', () => {
  it('words the status of a message', () => {
    expect(statusOfMessage(waiting)).toEqual(['amber', 'Waiting for approval']);
    expect(statusOfMessage(blocked)).toEqual(['red', 'Blocked']);
    expect(statusOfMessage(approved)).toEqual(['blue', 'Ready to send']);
    expect(statusOfMessage({ status: 'sent', blocked: '' })).toEqual(['green', 'Sent by staff']);
  });

  it('shows the queue with a preview, and hands an approved message to WhatsApp', async () => {
    const calls = mockServer('owner');
    const opened = vi.spyOn(window, 'open').mockReturnValue({ opener: window } as unknown as Window);
    mount('/messages');
    const queue = await screen.findByRole('region', { name: 'Messages waiting' });
    expect(within(queue).getByText('Rule: 30 day check-in')).toBeInTheDocument();
    expect(within(queue).getByText('Not sendable: No care-message consent.')).toBeInTheDocument();
    expect(within(queue).getByText('Blocked')).toBeInTheDocument();
    // The count sits beside the tab on every page.
    const tab = within(screen.getByRole('navigation', { name: 'Clinic workspace' })).getByRole('link', {
      name: /Messages/,
    });
    expect(await within(tab).findByLabelText('2 waiting for approval')).toBeInTheDocument();

    const preview = screen.getByRole('region', { name: 'Message' });
    expect(within(preview).getByRole('heading', { name: 'Vikram Synthetic · 30 day check-in' })).toBeInTheDocument();
    expect(
      within(preview).getByText(
        /^To \+91 90000 00143 on WhatsApp · Consent: care messages, recorded 12 Jun 2026 · Template “Follow-up 30 days” v3$/,
      ),
    ).toBeInTheDocument();
    expect(within(preview).getByText(/We hope you are doing well\./)).toBeInTheDocument();
    await userEvent.click(within(preview).getByRole('button', { name: 'Approve and send' }));
    await waitFor(() =>
      expect(opened).toHaveBeenCalledWith('https://wa.me/919000000143?text=Hello%20Vikram', '_blank'),
    );
    expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('messages/m1/send/'))).toBe(true);
    expect(
      await screen.findByText('WhatsApp is opening with the message ready. Press Send there.'),
    ).toBeInTheDocument();

    // A message nobody has agreed to receive cannot be approved or sent.
    await userEvent.click(within(queue).getByRole('button', { name: /Mary Synthetic/ }));
    const second = screen.getByRole('region', { name: 'Message' });
    expect(within(second).getByRole('button', { name: 'Approve and send' })).toBeDisabled();
    expect(within(second).getByText(/No consent to care messages/)).toBeInTheDocument();
  });

  it('offers the link by hand when the browser stops the new window', async () => {
    mockServer('owner');
    vi.spyOn(window, 'open').mockReturnValue(null);
    mount('/messages');
    const preview = await screen.findByRole('region', { name: 'Message' });
    await userEvent.click(within(preview).getByRole('button', { name: 'Approve and send' }));
    expect(await screen.findByText('The browser stopped WhatsApp from opening.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open WhatsApp' })).toBeInTheDocument();
  });

  it('lets the front desk send what was approved, but not approve', async () => {
    mockServer('reception', [waiting, approved]);
    mount('/messages');
    const preview = await screen.findByRole('region', { name: 'Message' });
    expect(within(preview).getByText('Waiting for a doctor or the owner to approve the wording.')).toBeInTheDocument();
    expect(within(preview).queryByRole('button', { name: 'Approve and send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve selected' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New campaign' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Appointment reminder/ }));
    const ready = screen.getByRole('region', { name: 'Message' });
    expect(within(ready).getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(within(ready).getByText('Approved by Dr Synthetic.')).toBeInTheDocument();
  });

  it('writes a new message from a template for a chosen patient', async () => {
    const calls = mockServer('owner');
    vi.spyOn(window, 'open').mockReturnValue({ opener: window } as unknown as Window);
    mount('/messages');
    await userEvent.click(await screen.findByRole('button', { name: 'New message' }));
    const window_ = await screen.findByRole('dialog', { name: 'New WhatsApp message' });
    await userEvent.type(within(window_).getByLabelText('Find the patient'), 'Vik');
    await userEvent.click(await within(window_).findByRole('button', { name: /Vikram Synthetic/ }));
    const writing = await screen.findByRole('dialog', { name: 'WhatsApp message to Vikram Synthetic' });
    // Only approved templates are offered.
    const select = within(writing).getByLabelText('Template');
    expect(within(select).queryByRole('option', { name: 'Festival greeting' })).not.toBeInTheDocument();
    await userEvent.selectOptions(select, 'Follow-up 30 days');
    const box = within(writing).getByLabelText('Message');
    await waitFor(() => expect(box).toHaveValue('Hello Vikram, how are you?'));
    expect(within(writing).getByText(/Goes to \+91 90000 00143 on WhatsApp\./)).toBeInTheDocument();
    await userEvent.click(within(writing).getByRole('button', { name: 'Approve and send' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('messages/m9/send/'))).toBe(true));
    const made = calls.find((call) => call.method === 'POST' && call.path.endsWith('/messages/'))!;
    expect(made.body).toEqual({ patient: 'patient-id', body: 'Hello Vikram, how are you?', template: 't1' });
    // The patient's name was searched for by the picker; the message itself never travels in an address.
    expect(calls.some((call) => call.path.includes('Hello'))).toBe(false);
  });

  it('switches a rule on and edits a template with insertable fields', async () => {
    const calls = mockServer('owner');
    mount('/messages/rules');
    await userEvent.click(await screen.findByRole('switch', { name: '90 day follow-up' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH' && call.path.endsWith('message-rules/r1/'))?.body).toEqual({
        enabled: true,
      }),
    );

    await userEvent.click(screen.getByRole('link', { name: 'Templates' }));
    expect(await screen.findByText('v3 · care message · uses first name')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit the template Follow-up 30 days' }));
    const window_ = await screen.findByRole('dialog', { name: 'Template: Follow-up 30 days' });
    const wording = within(window_).getByLabelText('Wording');
    await userEvent.clear(wording);
    await userEvent.type(wording, 'Hello from ');
    await userEvent.click(within(window_).getByRole('button', { name: 'clinic name' }));
    expect(wording).toHaveValue('Hello from {clinic_name}');
    await userEvent.click(within(window_).getByRole('button', { name: 'Save template' }));
    await waitFor(() =>
      expect(
        calls.find((call) => call.method === 'PATCH' && call.path.endsWith('message-templates/t1/'))?.body,
      ).toEqual({
        name: 'Follow-up 30 days',
        kind: 'care',
        body: 'Hello from {clinic_name}',
        approved: true,
      }),
    );
  });
});
