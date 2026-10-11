/** Types and small helpers shared by the billing screens and the printed bill. */
import { Tone } from './ui';

export type ItemKind = 'service' | 'prescribed' | 'supplement' | 'shelf' | 'consumable';
export type PayMethod = 'cash' | 'upi' | 'card' | 'bank';
export type InvoiceState = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void' | 'refunded';

export interface PriceItem {
  id: string;
  name: string;
  kind: ItemKind;
  role: string;
  rate: string;
  gst_rate: string;
  barcode: string;
  active: boolean;
}
export interface InvoiceLine {
  id?: string;
  kind: ItemKind;
  group?: 'care' | 'products';
  description: string;
  quantity: string;
  rate: string;
  gst_rate: string;
  amount?: string;
  price_item: string | null;
  source: string;
}
export interface Payment {
  id: string;
  kind: 'payment' | 'refund';
  amount: string;
  method: PayMethod;
  reference: string;
  note: string;
  received_at: string;
  received_by_name: string;
  receipt_number: string;
}
export interface PaymentRow extends Payment {
  invoice: string;
  invoice_number: string;
  patient: string;
}
export interface CreditNote {
  id: string;
  number: string;
  amount: string;
  reason: string;
  created_by_name: string;
  created_at: string;
}
export interface InvoiceEvent {
  id: string;
  action: string;
  detail: string;
  actor_name: string;
  created_at: string;
}
export interface InvoiceRow {
  id: string;
  number: string;
  status: 'draft' | 'issued' | 'void';
  state: InvoiceState;
  date: string;
  patient: { id: string; name: string; archived: boolean } | null;
  buyer_name: string;
  total: string;
  paid: string;
  credited: string;
  balance: string;
  encounter: string | null;
}
export interface Snapshot {
  clinic: {
    name: string;
    address: string;
    phone: string;
    email: string;
    gstin: string;
    registration_number: string;
    upi_id: string;
  };
  show_gst: boolean;
  issued_by: string;
  patient: { name: string; phone: string; address: string; code: string } | null;
  visit: { date: string; doctor: string; type: string; next_visit: string } | null;
}
export interface Invoice extends InvoiceRow {
  buyer_phone: string;
  discount: string;
  discount_reason: string;
  note: string;
  subtotal: string;
  tax_total: string;
  tax_summary: { rate: string; taxable: string; cgst: string; sgst: string }[];
  lines: InvoiceLine[];
  payments: Payment[];
  credit_notes: CreditNote[];
  history: InvoiceEvent[];
  snapshot: Snapshot;
  created_at: string;
  created_by_name: string;
  issued_at: string | null;
  issued_by_name: string;
  voided_at: string | null;
  void_reason: string;
}
export interface BillingSummary {
  day: string;
  billed_today: string;
  invoices_today: number;
  collected_today: string;
  outstanding: string;
  outstanding_count: number;
  drafts: number;
}
export interface DayEnd {
  day: string;
  methods: Record<PayMethod, string>;
  collected: string;
  billed: string;
  invoices: number;
  closed: {
    cash_counted: string;
    expected_cash: string;
    difference: string;
    note: string;
    closed_by_name: string;
    closed_at: string;
  } | null;
}

export const KIND_LABELS: Record<ItemKind, string> = {
  service: 'Service',
  prescribed: 'Prescribed',
  supplement: 'Supplement',
  shelf: 'Shelf medicine',
  consumable: 'Consumable',
};
export const KINDS = Object.keys(KIND_LABELS) as ItemKind[];
export const CARE_KINDS: ItemKind[] = ['service', 'prescribed'];
export const groupOf = (kind: ItemKind) => (CARE_KINDS.includes(kind) ? 'care' : 'products');
export const GROUP_LABELS = {
  care: 'Consultation and prescribed medicines',
  products: 'Products and supplements',
} as const;

export const METHOD_LABELS: Record<PayMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  bank: 'Bank transfer',
};
export const METHODS = [
  ['cash', 'Cash'],
  ['upi', 'UPI'],
  ['card', 'Card'],
  ['bank', 'Bank transfer'],
] as const;

export const STATE_LABELS: Record<InvoiceState, string> = {
  draft: 'Draft',
  issued: 'Issued',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  void: 'Void',
  refunded: 'Refunded',
};
export const STATE_TONES: Record<InvoiceState, Tone> = {
  draft: 'grey',
  issued: 'blue',
  partially_paid: 'amber',
  paid: 'green',
  void: 'red',
  refunded: 'grey',
};

export const GST_RATES = ['0', '5', '12', '18', '28'];
/** "Exempt" or "18%". */
export function gstLabel(rate: string | number) {
  const value = Number(rate);
  return value > 0 ? `${Number.isInteger(value) ? value : value.toFixed(2)}%` : 'Exempt';
}

const paisa = (value: number) => Math.round(value * 100) / 100;
export const lineAmount = (line: { quantity: string; rate: string }) =>
  paisa((Number(line.quantity) || 0) * (Number(line.rate) || 0));

/** A draft's figures as the person types. The server works out the real ones, tax included, when it saves. */
export function draftTotals(lines: { quantity: string; rate: string }[], discount: string) {
  const subtotal = paisa(lines.reduce((sum, line) => sum + lineAmount(line), 0));
  const off = Math.min(Math.max(Number(discount) || 0, 0), subtotal);
  return { subtotal, discount: off, total: paisa(subtotal - off) };
}

export const HISTORY_LABELS: Record<string, string> = {
  created: 'Draft created',
  created_from_visit: 'Draft created from visit',
  issued: 'Issued',
  payment: 'Payment recorded',
  refund: 'Refund recorded',
  credit_note: 'Credit note issued',
  void: 'Made void',
  printed: 'Printed',
  sent: 'Sent on WhatsApp',
};

const ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function belowThousand(n: number): string {
  const words: string[] = [];
  if (n >= 100) {
    words.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    words.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
  } else if (n > 0) words.push(ONES[n]);
  return words.join(' ');
}

/** "Rupees one thousand three hundred twenty only", counted the Indian way (thousand, lakh, crore). */
export function rupeesInWords(value: number | string) {
  const paise = Math.round((Number(value) || 0) * 100);
  let rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10000000);
  rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000);
  rupees %= 100000;
  const thousand = Math.floor(rupees / 1000);
  rupees %= 1000;
  if (crore) parts.push(`${belowThousand(crore)} crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} thousand`);
  if (rupees) parts.push(belowThousand(rupees));
  const whole = parts.length ? parts.join(' ') : 'zero';
  return `Rupees ${whole}${rest ? ` and ${belowThousand(rest)} paise` : ''} only`;
}

/** What a UPI app reads from the "scan to pay" code on a bill. */
export function upiLink(upiId: string, payee: string, amountDue: string | number, reference: string) {
  const query = new URLSearchParams({
    pa: upiId,
    pn: payee,
    am: Number(amountDue).toFixed(2),
    cu: 'INR',
    tn: reference,
  });
  return `upi://pay?${query.toString()}`;
}
