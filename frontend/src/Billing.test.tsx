import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { rangeDays } from './BillingScreen';
import { draftTotals, gstLabel, rupeesInWords, upiLink } from './billing';
import { barcodeText, code128Values, code128Widths } from './codes';
import { addDays, age, amount, initials, money, phoneTail, shortDate } from './format';
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
const page = (results: unknown[]) => ({ count: results.length, next: null, previous: null, results });
function mount(path: string) {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}
const summary = {
  day: '2026-10-06',
  billed_today: '1320.00',
  invoices_today: 1,
  collected_today: '1000.00',
  outstanding: '320.00',
  outstanding_count: 1,
  drafts: 0,
};
const snapshot = {
  clinic: {
    name: 'Test clinic',
    address: '4 Garden Street\nPune 411001',
    phone: '+91 90000 00100',
    email: '',
    gstin: '27ABCDE1234F1Z5',
    registration_number: 'MH-12345',
    upi_id: 'testclinic@okbank',
  },
  show_gst: true,
  issued_by: 'Dr Synthetic',
  patient: { name: 'Synthetic Patient', phone: '5550100', address: '', code: 'PAT-W8KQ3G7DP9' },
  visit: { date: '2026-10-06', doctor: 'Dr Synthetic', type: 'Follow-up', next_visit: '2026-10-20' },
};
const issued = {
  id: 'bill-id',
  number: 'INV/26-27/1042',
  status: 'issued',
  state: 'partially_paid',
  date: '2026-10-06',
  patient: { id: 'patient-id', name: 'Synthetic Patient', archived: false },
  buyer_name: '',
  buyer_phone: '',
  total: '1320.00',
  paid: '1000.00',
  credited: '0.00',
  balance: '320.00',
  encounter: null,
  discount: '50.00',
  discount_reason: 'Returning patient',
  note: '',
  subtotal: '1370.00',
  tax_total: '101.24',
  tax_summary: [
    { rate: '5', taxable: '285.71', cgst: '7.15', sgst: '7.14' },
    { rate: '18', taxable: '483.05', cgst: '43.48', sgst: '43.47' },
  ],
  lines: [
    {
      id: 'l1',
      kind: 'service',
      group: 'care',
      description: 'Consultation, follow-up',
      quantity: '1.00',
      rate: '500.00',
      gst_rate: '0.00',
      amount: '500.00',
      price_item: null,
      source: '',
    },
    {
      id: 'l2',
      kind: 'prescribed',
      group: 'care',
      description: 'Prescribed medicines, 14 days',
      quantity: '1.00',
      rate: '300.00',
      gst_rate: '5.00',
      amount: '300.00',
      price_item: null,
      source: '',
    },
    {
      id: 'l3',
      kind: 'supplement',
      group: 'products',
      description: 'Vitamin D3 capsules, 60',
      quantity: '1.00',
      rate: '450.00',
      gst_rate: '18.00',
      amount: '450.00',
      price_item: null,
      source: '',
    },
    {
      id: 'l4',
      kind: 'shelf',
      group: 'products',
      description: 'Calendula cream 30 g',
      quantity: '1.00',
      rate: '120.00',
      gst_rate: '18.00',
      amount: '120.00',
      price_item: null,
      source: '',
    },
  ],
  payments: [
    {
      id: 'pay-1',
      kind: 'payment',
      amount: '1000.00',
      method: 'upi',
      reference: '',
      note: '',
      received_at: '2026-10-06T04:32:00Z',
      received_by_name: 'Reception',
      receipt_number: 'R/26-27/0871',
    },
  ],
  credit_notes: [],
  history: [
    {
      id: 'h1',
      action: 'payment',
      detail: 'R/26-27/0871',
      actor_name: 'Reception',
      created_at: '2026-10-06T04:32:00Z',
    },
    { id: 'h2', action: 'issued', detail: '', actor_name: 'Reception', created_at: '2026-10-06T04:31:00Z' },
  ],
  snapshot,
  created_at: '2026-10-06T04:28:00Z',
  created_by_name: 'Dr Synthetic',
  issued_at: '2026-10-06T04:31:00Z',
  issued_by_name: 'Reception',
  voided_at: null,
  void_reason: '',
};
const product = {
  id: 'item-d3',
  name: 'Vitamin D3 capsules, 60',
  kind: 'supplement',
  rate: '450.00',
  gst_rate: '18.00',
};

beforeEach(() => {
  vi.restoreAllMocks();
  clearNotices();
});

describe('how money, dates and codes are written', () => {
  it('writes rupees the Indian way, in figures and in words', () => {
    expect(money('1320')).toBe('₹1,320.00');
    expect(money(123456.5)).toBe('₹1,23,456.50');
    expect(amount('-50')).toBe('-50.00');
    expect(rupeesInWords(1320)).toBe('Rupees one thousand three hundred twenty only');
    expect(rupeesInWords('450.50')).toBe('Rupees four hundred fifty and fifty paise only');
    expect(rupeesInWords(12345678)).toBe(
      'Rupees one crore twenty-three lakh forty-five thousand six hundred seventy-eight only',
    );
    expect(rupeesInWords(0)).toBe('Rupees zero only');
    expect(gstLabel('0.00')).toBe('Exempt');
    expect(gstLabel('18.00')).toBe('18%');
  });

  it('adds a draft up as the person types and never below zero', () => {
    const lines = [
      { quantity: '2', rate: '450' },
      { quantity: '1', rate: '120.50' },
      { quantity: '', rate: 'x' },
    ];
    expect(draftTotals(lines, '20.5')).toEqual({ subtotal: 1020.5, discount: 20.5, total: 1000 });
    expect(draftTotals(lines, '5000').total).toBe(0);
  });

  it('writes dates, ages and names the clinic way', () => {
    expect(shortDate('2026-10-06')).toBe('06 Oct 2026');
    expect(addDays('2026-10-06', 14)).toBe('2026-10-20');
    expect(age('1984-10-07', '2026-10-06')).toBe(41);
    expect(age('1984-10-06', '2026-10-06')).toBe(42);
    expect(initials('Dr. R. Patel')).toBe('RP');
    expect(phoneTail('+91 90000 00142')).toBe('…00142');
  });

  it('works out date ranges from the clinic day, with the week starting on Monday', () => {
    expect(rangeDays('today', '2026-10-06')).toEqual({ from: '2026-10-06', to: '2026-10-06' });
    expect(rangeDays('yesterday', '2026-10-01')).toEqual({ from: '2026-09-30', to: '2026-09-30' });
    expect(rangeDays('week', '2026-10-06')).toEqual({ from: '2026-10-05', to: '2026-10-06' });
    expect(rangeDays('week', '2026-10-11')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(rangeDays('month', '2026-10-06')).toEqual({ from: '2026-10-01', to: '2026-10-06' });
    expect(rangeDays('all', '2026-10-06')).toEqual({});
  });

  it('draws a Code 128 barcode with a correct check value', () => {
    // The textbook example "PJJ123C": start B (104), then each character's value times its position,
    // 104 + 48 + 84 + 126 + 68 + 90 + 114 + 245 = 879, and 879 mod 103 = 55.
    expect(code128Values('PJJ123C')).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
    const widths = code128Widths('W8KQ3G7DP9');
    // Every character is 11 modules wide, the stop pattern 13.
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(11 * 12 + 13);
    expect(widths.length % 2).toBe(1);
    expect(barcodeText('PAT-w8kq3g7dp9')).toBe('W8KQ3G7DP9');
    expect(() => code128Values('₹')).toThrow();
  });

  it('builds the UPI link a payment app reads', () => {
    expect(upiLink('testclinic@okbank', 'Test clinic', '320', 'INV/26-27/1042')).toBe(
      'upi://pay?pa=testclinic%40okbank&pn=Test+clinic&am=320.00&cu=INR&tn=INV%2F26-27%2F1042',
    );
  });
});

describe('billing screens', () => {
  it('lists bills with the day in figures and searches without putting a name in the address', async () => {
    const found: { url: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('owner'));
      if (path.includes('billing/summary')) return response(summary);
      if (path.includes('invoices/find/')) {
        found.push({ url: path, body: JSON.parse(options?.body as string) });
        return response(page([issued]));
      }
      return response(page([]));
    });
    mount('/billing');
    expect(await screen.findByRole('link', { name: 'INV/26-27/1042' })).toBeInTheDocument();
    const figures = screen.getByLabelText('Today in figures');
    expect(within(figures).getByText('₹1,320.00')).toBeInTheDocument();
    expect(within(figures).getByText('billed today · 1 invoice')).toBeInTheDocument();
    const row = screen.getByRole('link', { name: 'INV/26-27/1042' }).closest('tr')!;
    expect(within(row).getByText('Partially paid')).toBeInTheDocument();
    expect(within(row).getByText('320.00')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Record payment' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Billing sections' })).getByText('1')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Search invoices'), 'Synthetic');
    await userEvent.click(screen.getByRole('button', { name: 'Paid' }));
    await waitFor(() => expect(found.at(-1)!.body).toMatchObject({ search: 'Synthetic', state: 'paid' }));
    expect(found.every((request) => !request.url.includes('Synthetic'))).toBe(true);
  });

  it('shows an issued bill grouped as on paper and records a payment', async () => {
    const sent: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('reception'));
      if (path.endsWith('payments/') && options?.method === 'POST') {
        sent.push(JSON.parse(options.body as string));
        return response({ ...issued, state: 'paid', paid: '1320.00', balance: '0.00' }, 201);
      }
      return response(issued);
    });
    mount('/billing/invoices/bill-id');
    expect(await screen.findByRole('heading', { name: /Invoice INV\/26-27\/1042/ })).toBeInTheDocument();
    expect(screen.getByText('Consultation and prescribed medicines')).toBeInTheDocument();
    expect(screen.getByText('Products and supplements')).toBeInTheDocument();
    expect(screen.getByText('Total (GST included: 101.24)')).toBeInTheDocument();
    expect(screen.getByText('₹1,000.00 · UPI')).toBeInTheDocument();
    // Reception takes payments but does not void or credit.
    await userEvent.click(screen.getByRole('button', { name: 'More ▾' }));
    expect(screen.queryByRole('menuitem', { name: 'Void invoice' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Print receipt' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getAllByRole('button', { name: 'Record payment' })[0]);
    const window_ = await screen.findByRole('dialog', { name: 'Record payment · INV/26-27/1042' });
    expect(within(window_).getByLabelText('Amount (₹)')).toHaveValue('320.00');
    await userEvent.click(within(window_).getByRole('radio', { name: 'Card' }));
    await userEvent.click(within(window_).getByLabelText('Print receipt'));
    await userEvent.click(within(window_).getByRole('button', { name: 'Save payment' }));
    expect(await screen.findByText('Payment of ₹320.00 recorded. Invoice is now Paid.')).toBeInTheDocument();
    expect(sent).toEqual([{ amount: '320.00', method: 'card', reference: '' }]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts a new bill from a scanned pack, adds a second scan to it, and issues it as a walk-in sale', async () => {
    const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('billing'));
      if (path.includes('/scan/')) return response({ kind: 'product', product });
      if (options?.method === 'POST' || options?.method === 'PATCH') {
        calls.push({ path, method: options.method, body: JSON.parse((options.body as string) || '{}') });
        return response({
          ...issued,
          id: 'new-id',
          status: path.endsWith('issue/') ? 'issued' : 'draft',
          number: 'INV/26-27/1043',
        });
      }
      return response(page([]));
    });
    const router = mount('/printing');
    await screen.findByRole('heading', { name: 'Printing' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const scan = () => {
      const clock = vi.spyOn(performance, 'now');
      let time = 50_000;
      for (const key of [...'8901234567890', 'Enter']) {
        clock.mockReturnValue((time += 5));
        fireEvent.keyDown(window, { key });
      }
      clock.mockRestore();
    };
    scan();
    expect(await screen.findByRole('heading', { name: /New bill/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity of Vitamin D3 capsules, 60')).toHaveValue('1');
    expect(screen.getByText('(scanned)')).toBeInTheDocument();
    // A bill is open now, so the next scan of the same pack adds to it instead of starting another bill.
    scan();
    await waitFor(() => expect(screen.getByLabelText('Quantity of Vitamin D3 capsules, 60')).toHaveValue('2'));
    expect(screen.getByLabelText('Total (₹)')).toHaveValue('900.00');

    await userEvent.type(screen.getByLabelText('Name'), 'Walk-in buyer');
    await userEvent.click(screen.getByRole('radio', { name: 'UPI' }));
    await userEvent.click(screen.getByLabelText('Print the bill'));
    await userEvent.click(screen.getByRole('button', { name: 'Issue and take payment' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/billing/invoices/new-id'));
    expect(calls[0]).toMatchObject({ path: '/api/v1/invoices/', method: 'POST' });
    expect(calls[0].body).toMatchObject({
      patient_id: null,
      buyer_name: 'Walk-in buyer',
      lines: [{ price_item: 'item-d3', quantity: '2', rate: '450', source: 'scan' }],
    });
    expect(calls[1]).toMatchObject({ path: '/api/v1/invoices/new-id/issue/', body: { payment: { method: 'upi' } } });
  });

  it('prints an issued bill with the patient barcode, GST table, amount in words and a UPI code for the balance', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).endsWith('me/') ? response(sessionFor('owner')) : response(issued),
    );
    mount('/print/invoice/bill-id');
    const sheet = await screen.findByLabelText('Invoice INV/26-27/1042');
    expect(within(sheet).getByText('PARTIALLY PAID')).toBeInTheDocument();
    expect(within(sheet).getByText(/GSTIN 27ABCDE1234F1Z5/)).toBeInTheDocument();
    expect(within(sheet).getByText('PAT-W8KQ3G7DP9')).toBeInTheDocument();
    expect(within(sheet).getByRole('img', { name: 'Patient barcode' })).toBeInTheDocument();
    expect(within(sheet).getByText('285.71')).toBeInTheDocument();
    expect(within(sheet).getByText(/Rupees one thousand three hundred twenty only/)).toBeInTheDocument();
    expect(within(sheet).getByRole('img', { name: 'Scan to pay by UPI' })).toBeInTheDocument();
    expect(within(sheet).getByText('20 Oct 2026')).toBeInTheDocument();
    // The tabs and header are not part of a printed page.
    expect(screen.queryByRole('navigation', { name: 'Clinic workspace' })).not.toBeInTheDocument();
  });

  it('leaves GST and the UPI code off when the bill has none', async () => {
    const plain = {
      ...issued,
      state: 'paid',
      paid: '1320.00',
      balance: '0.00',
      patient: null,
      buyer_name: 'Walk-in buyer',
      snapshot: { ...snapshot, show_gst: false, patient: null, visit: null },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).endsWith('me/') ? response(sessionFor('owner')) : response(plain),
    );
    mount('/print/invoice/bill-id');
    const sheet = await screen.findByLabelText('Invoice INV/26-27/1042');
    expect(within(sheet).getByText('Walk-in buyer')).toBeInTheDocument();
    expect(within(sheet).queryByText(/GSTIN/)).not.toBeInTheDocument();
    expect(within(sheet).queryByText('GST')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('285.71')).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('img', { name: 'Patient barcode' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('img', { name: 'Scan to pay by UPI' })).not.toBeInTheDocument();
  });
});
