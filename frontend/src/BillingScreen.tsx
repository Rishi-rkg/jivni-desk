/** The Billing tab: bills, payments, who owes what, the day-end report and the price list. */
import { FormEvent, useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api';
import {
  BillingSummary,
  DayEnd,
  Invoice,
  InvoiceRow,
  InvoiceState,
  KIND_LABELS,
  METHODS,
  METHOD_LABELS,
  PaymentRow,
  PriceItem,
  STATE_LABELS,
  STATE_TONES,
  gstLabel,
} from './billing';
import { EditPriceItem, RecordPayment } from './BillingWindows';
import { ErrorMessage } from './components';
import { addDays, amount, dateTime, isoDay, money, shortDate } from './format';
import { Page, Role, canTakePayments } from './types';
import { Chip, Menu, Modal, StatusLabel, Switch, notify, useLoad } from './ui';

const TABS = [
  ['invoices', 'Invoices'],
  ['payments', 'Payments'],
  ['outstanding', 'Outstanding'],
  ['day-end', 'Day-end report'],
  ['prices', 'Price list'],
] as const;
type Tab = (typeof TABS)[number][0];

const RANGES = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['all', 'All dates'],
  ['custom', 'Custom dates…'],
] as const;
type Range = (typeof RANGES)[number][0];

/** First and last day of a named range, in the clinic's calendar. The week starts on Monday. */
export function rangeDays(range: Range, today = isoDay()): { from?: string; to?: string } {
  if (range === 'today') return { from: today, to: today };
  if (range === 'yesterday') return { from: addDays(today, -1), to: addDays(today, -1) };
  if (range === 'week') {
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    return { from: addDays(today, -weekday), to: today };
  }
  if (range === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return {};
}

const STATES: InvoiceState[] = ['draft', 'issued', 'partially_paid', 'paid', 'void', 'refunded'];
const canCloseDay = (role: Role) => role === 'owner' || role === 'billing';
const canKeepPrices = (role: Role) => role === 'owner' || role === 'admin';

export function BillingScreen({ role }: { role: Role }) {
  const { tab: tabParam } = useParams();
  const tab: Tab = TABS.some(([key]) => key === tabParam) ? (tabParam as Tab) : 'invoices';
  const [turn, setTurn] = useState(0);
  const refresh = () => setTurn((value) => value + 1);
  const { data: summary } = useLoad((signal) => api<BillingSummary>('billing/summary/', { signal }), [turn]);
  const [closing, setClosing] = useState(false);
  const month = rangeDays('month');
  const exportLink = (kind: string) => `/api/v1/billing/export/?kind=${kind}&from=${month.from}&to=${month.to}`;
  return (
    <>
      <div className="heading">
        <h1>Billing</h1>
        <div className="actions">
          <Link className="button" to="/billing/new">
            New invoice
          </Link>
          {canCloseDay(role) && (
            <button type="button" className="secondary" onClick={() => setClosing(true)}>
              Close the day
            </button>
          )}
          {canCloseDay(role) && (
            <Menu
              label="Export ▾"
              items={[
                { heading: 'This month, as a spreadsheet (CSV)' },
                { label: 'Invoices', onSelect: () => window.location.assign(exportLink('invoices')) },
                { label: 'Payments', onSelect: () => window.location.assign(exportLink('payments')) },
                {
                  label: 'Accountant export: GST by rate',
                  onSelect: () => window.location.assign(exportLink('accountant')),
                },
                'sep',
                { label: 'Print this page, or save it as a PDF', onSelect: () => window.print() },
              ]}
            />
          )}
        </div>
      </div>
      <nav className="sub-tabs" aria-label="Billing sections">
        {TABS.map(([key, label]) => (
          <NavLink key={key} to={key === 'invoices' ? '/billing' : `/billing/${key}`} end>
            {label}
            {key === 'outstanding' && !!summary?.outstanding_count && (
              <span className="count">{summary.outstanding_count}</span>
            )}
          </NavLink>
        ))}
      </nav>
      {(tab === 'invoices' || tab === 'outstanding') && (
        <>
          <div className="metrics" aria-label="Today in figures">
            <div>
              <strong>{summary ? money(summary.billed_today) : '…'}</strong>
              <span>
                billed today · {summary?.invoices_today ?? 0} invoice{summary?.invoices_today === 1 ? '' : 's'}
              </span>
            </div>
            <div>
              <strong>{summary ? money(summary.collected_today) : '…'}</strong>
              <span>collected today</span>
            </div>
            <div>
              <strong>{summary ? money(summary.outstanding) : '…'}</strong>
              <span>
                outstanding · {summary?.outstanding_count ?? 0} invoice{summary?.outstanding_count === 1 ? '' : 's'}
              </span>
            </div>
            <div>
              <strong>{summary?.drafts ?? '…'}</strong>
              <span>draft{summary?.drafts === 1 ? '' : 's'} not yet issued</span>
            </div>
          </div>
          <InvoiceList key={tab} role={role} outstanding={tab === 'outstanding'} turn={turn} onChanged={refresh} />
        </>
      )}
      {tab === 'payments' && <Payments />}
      {tab === 'day-end' && <DayEndReport role={role} turn={turn} onClose={() => setClosing(true)} />}
      {tab === 'prices' && <PriceList editable={canKeepPrices(role)} />}
      {closing && (
        <CloseDay
          onClose={() => setClosing(false)}
          onSaved={() => {
            setClosing(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

function InvoiceList({
  role,
  outstanding,
  turn,
  onChanged,
}: {
  role: Role;
  outstanding: boolean;
  turn: number;
  onChanged: () => void;
}) {
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<Range>(outstanding ? 'all' : 'today');
  const [custom, setCustom] = useState({ from: isoDay(), to: isoDay() });
  const [state, setState] = useState<InvoiceState | ''>('');
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState<InvoiceRow | null>(null);
  const [data, setData] = useState<Page<InvoiceRow> | null>(null);
  const [error, setError] = useState('');
  const days = range === 'custom' ? custom : rangeDays(range);
  const filter = JSON.stringify({ search: search.trim(), state: outstanding ? 'outstanding' : state, ...days });
  useEffect(() => setPage(1), [filter]);
  useEffect(() => {
    const controller = new AbortController();
    // Sent in the request body, never the address, because a search may hold a patient's name.
    const timer = setTimeout(() => {
      api<Page<InvoiceRow>>(`invoices/find/?page=${page}`, { method: 'POST', body: filter, signal: controller.signal })
        .then((result) => {
          setData(result);
          setError('');
        })
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filter, page, turn]);
  return (
    <>
      <div className="toolbar">
        <input
          type="search"
          aria-label="Search invoices"
          className="wide-search"
          placeholder="Invoice number or patient"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="Dates" value={range} onChange={(e) => setRange(e.target.value as Range)}>
          {RANGES.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        {range === 'custom' && (
          <>
            <input
              type="date"
              aria-label="From"
              value={custom.from}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
            />
            <input
              type="date"
              aria-label="To"
              value={custom.to}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
            />
          </>
        )}
        {!outstanding && (
          <>
            <Chip on={state === ''} onClick={() => setState('')}>
              All
            </Chip>
            {STATES.map((value) => (
              <Chip key={value} on={state === value} onClick={() => setState(value)}>
                {STATE_LABELS[value]}
              </Chip>
            ))}
          </>
        )}
      </div>
      <ErrorMessage message={error} />
      <section className="panel flush">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Patient</th>
                <th>Status</th>
                <th className="num">Total (₹)</th>
                <th className="num">Paid (₹)</th>
                <th className="num">Balance (₹)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data?.results.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.status === 'draft' ? (
                      <span className="muted">Draft</span>
                    ) : (
                      <Link to={`/billing/invoices/${row.id}`}>{row.number}</Link>
                    )}
                  </td>
                  <td>{shortDate(row.date).slice(0, 6)}</td>
                  <td>
                    {row.patient ? (
                      <Link to={`/patients/${row.patient.id}`}>{row.patient.name}</Link>
                    ) : (
                      row.buyer_name || <span className="muted">Walk-in customer</span>
                    )}
                  </td>
                  <td>
                    <StatusLabel tone={STATE_TONES[row.state]}>{STATE_LABELS[row.state]}</StatusLabel>
                  </td>
                  <td className={`num ${row.state === 'void' ? 'muted' : ''}`}>{amount(row.total)}</td>
                  <td className="num">{amount(row.paid)}</td>
                  <td className="num">{amount(row.balance)}</td>
                  <td className="right">
                    {row.state === 'draft' && <Link to={`/billing/invoices/${row.id}`}>Continue</Link>}
                    {(row.state === 'issued' || row.state === 'partially_paid') &&
                      (canTakePayments(role) ? (
                        <button type="button" className="link-button" onClick={() => setPaying(row)}>
                          Record payment
                        </button>
                      ) : (
                        <Link to={`/billing/invoices/${row.id}`}>Open</Link>
                      ))}
                    {row.state === 'paid' && <Link to={`/print/invoice/${row.id}`}>Print</Link>}
                    {row.state === 'void' && <Link to={`/billing/invoices/${row.id}`}>View</Link>}
                    {row.state === 'refunded' && <Link to={`/billing/invoices/${row.id}`}>Credit note</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data && !error && <p role="status">Loading invoices…</p>}
        {data && !data.results.length && (
          <p className="empty">
            {outstanding
              ? 'Nobody owes the clinic anything.'
              : 'No invoices match. Bills appear here as they are made; “New invoice” starts one.'}
          </p>
        )}
        {data && (
          <div className="pagination">
            <span className="muted">
              {data.count} invoice{data.count === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="secondary btn-sm"
              disabled={!data.previous}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <button type="button" className="secondary btn-sm" disabled={!data.next} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        )}
      </section>
      {paying && (
        <PayFromList
          row={paying}
          onClose={() => setPaying(null)}
          onSaved={() => {
            setPaying(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function PayFromList({ row, onClose, onSaved }: { row: InvoiceRow; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate();
  return (
    <RecordPayment
      bill={{
        id: row.id,
        number: row.number,
        balance: row.balance,
        name: row.patient?.name || row.buyer_name,
      }}
      onClose={onClose}
      onSaved={(updated: Invoice, printReceipt) => {
        const payment = updated.payments[updated.payments.length - 1];
        if (printReceipt && payment) navigate(`/print/receipt/${updated.id}/${payment.id}?auto=1`);
        else onSaved();
      }}
    />
  );
}

function Payments() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { data, error, loading } = useLoad(
    (signal) => api<Page<PaymentRow>>(`payments/?page=${page}`, { signal }),
    [page],
  );
  return (
    <section className="panel flush">
      <div className="heading">
        <h2>Payments received</h2>
      </div>
      <ErrorMessage message={error} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Receipt</th>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Method</th>
              <th className="num">Amount (₹)</th>
              <th>Taken by</th>
            </tr>
          </thead>
          <tbody>
            {data?.results.map((payment) => (
              <tr key={payment.id}>
                <td>{dateTime(payment.received_at)}</td>
                <td>
                  {payment.kind === 'payment' ? (
                    <Link to={`/print/receipt/${payment.invoice}/${payment.id}`}>{payment.receipt_number}</Link>
                  ) : (
                    payment.receipt_number
                  )}
                </td>
                <td>
                  <Link to={`/billing/invoices/${payment.invoice}`}>{payment.invoice_number}</Link>
                </td>
                <td>{payment.patient || <span className="muted">Walk-in customer</span>}</td>
                <td>
                  {METHOD_LABELS[payment.method]}
                  {payment.kind === 'refund' && <StatusLabel tone="grey">Refund</StatusLabel>}
                </td>
                <td className="num">
                  {payment.kind === 'refund' ? '−' : ''}
                  {amount(payment.amount)}
                </td>
                <td>{payment.received_by_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && !data && <p role="status">Loading payments…</p>}
      {data && !data.results.length && <p className="empty">No payments yet. They appear here as they are recorded.</p>}
      {data && (
        <div className="pagination">
          <span className="muted">
            {data.count} payment{data.count === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            className="secondary btn-sm"
            disabled={!data.previous}
            onClick={() => setParams({ page: String(page - 1) })}
          >
            Previous
          </button>
          <button
            type="button"
            className="secondary btn-sm"
            disabled={!data.next}
            onClick={() => setParams({ page: String(page + 1) })}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

function DayEndReport({ role, turn, onClose }: { role: Role; turn: number; onClose: () => void }) {
  const [day, setDay] = useState(isoDay());
  const { data, error } = useLoad((signal) => api<DayEnd>(`billing/day-end/?day=${day}`, { signal }), [day, turn]);
  return (
    <section className="panel day-end">
      <div className="heading">
        <h2>Day-end report · {shortDate(day)}</h2>
        <div className="actions">
          <input type="date" aria-label="Day" value={day} max={isoDay()} onChange={(e) => setDay(e.target.value)} />
          <Link className="button secondary btn-sm" to={`/print/day-end/${day}`}>
            Print
          </Link>
        </div>
      </div>
      <ErrorMessage message={error} />
      {data && (
        <>
          <table className="small">
            <tbody>
              {METHODS.map(([method, label]) => (
                <tr key={method}>
                  <td>{label}</td>
                  <td className="num">{amount(data.methods[method])}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Collected</strong>
                </td>
                <td className="num">
                  <strong>{amount(data.collected)}</strong>
                </td>
              </tr>
              <tr>
                <td>Billed · {data.invoices} invoices</td>
                <td className="num">{amount(data.billed)}</td>
              </tr>
              <tr>
                <td>Cash counted in drawer</td>
                <td className="num">{data.closed ? amount(data.closed.cash_counted) : 'Not counted yet'}</td>
              </tr>
              {data.closed && (
                <tr>
                  <td>Difference</td>
                  <td className="num">
                    <StatusLabel tone={Number(data.closed.difference) === 0 ? 'green' : 'amber'}>
                      {amount(data.closed.difference)}
                    </StatusLabel>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {data.closed ? (
            <p className="muted small">
              Closed by {data.closed.closed_by_name} at {dateTime(data.closed.closed_at)}
              {data.closed.note && ` · ${data.closed.note}`}
            </p>
          ) : (
            <p className="muted small">The day has not been closed.</p>
          )}
          {canCloseDay(role) && day === isoDay() && (
            <button type="button" className="secondary" onClick={onClose}>
              {data.closed ? 'Count the cash again' : 'Close the day'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** W31: count the cash and close the day. */
function CloseDay({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { data, error: loadError } = useLoad((signal) => api<DayEnd>('billing/day-end/', { signal }), []);
  const [counted, setCounted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const expected = Number(data?.methods.cash ?? 0);
  const difference = counted === '' ? null : (Number(counted) || 0) - expected;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('billing/day-end/', {
        method: 'POST',
        body: JSON.stringify({
          cash_counted: counted,
          note: String(new FormData(event.currentTarget).get('note') || ''),
        }),
      });
      notify('Day closed.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Close the day · ${shortDate(isoDay())}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="close-day" disabled={busy || !data}>
            Close the day
          </button>
        </>
      }
    >
      <form id="close-day" className="stack" onSubmit={submit}>
        <ErrorMessage message={error || loadError} />
        <p>
          Cash taken today according to the bills: <strong>{data ? money(expected) : '…'}</strong>
        </p>
        <label>
          Cash counted in the drawer (₹)
          <input
            data-autofocus
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            inputMode="decimal"
            required
            pattern="[0-9]+(\.[0-9]{1,2})?"
          />
        </label>
        {difference !== null && (
          <p>
            Difference:{' '}
            <StatusLabel tone={difference === 0 ? 'green' : 'amber'}>
              {difference > 0 ? '+' : ''}
              {amount(difference)}
            </StatusLabel>
          </p>
        )}
        <label>
          Note
          <input name="note" maxLength={300} placeholder="Optional, for example why the cash is short" />
        </label>
      </form>
    </Modal>
  );
}

export function PriceList({ editable }: { editable: boolean }) {
  const [params] = useSearchParams();
  const scanned = params.get('barcode') ?? '';
  const { data, setData, error, loading } = useLoad((signal) => api<PriceItem[]>('price-items/', { signal }), []);
  const [editing, setEditing] = useState<PriceItem | 'new' | null>(scanned && editable ? 'new' : null);
  const [failure, setFailure] = useState('');
  async function setActive(item: PriceItem, active: boolean) {
    setFailure('');
    try {
      const saved = await api<PriceItem>(`price-items/${item.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      });
      setData((old) => (old ?? []).map((row) => (row.id === saved.id ? saved : row)));
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  const unset = (data ?? []).filter((item) => item.role && Number(item.rate) === 0);
  return (
    <section className="panel flush">
      <div className="heading">
        <h2>Price list</h2>
        {editable && (
          <button type="button" className="secondary btn-sm" onClick={() => setEditing('new')}>
            Add item
          </button>
        )}
      </div>
      <ErrorMessage message={error || failure} />
      {!!unset.length && (
        <p className="warning inset">
          {editable ? 'Set the rate for' : 'The owner has not yet set the rate for'}:{' '}
          {unset.map((item) => item.name).join('; ')}. A bill made from a visit uses these.
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Kind</th>
              <th className="num">Rate (₹)</th>
              <th className="num">GST</th>
              <th>Barcode</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((item) => (
              <tr key={item.id}>
                <td>
                  {editable ? (
                    <button type="button" className="link-button" onClick={() => setEditing(item)}>
                      {item.name}
                    </button>
                  ) : (
                    item.name
                  )}
                </td>
                <td>{KIND_LABELS[item.kind]}</td>
                <td className="num">{amount(item.rate)}</td>
                <td className="num">{gstLabel(item.gst_rate)}</td>
                <td className="mono">{item.barcode}</td>
                <td>
                  <Switch
                    label={`${item.name} is active`}
                    checked={item.active}
                    disabled={!editable}
                    onChange={(active) => setActive(item, active)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && !data && <p role="status">Loading the price list…</p>}
      <p className="muted small inset">
        Rates include GST. The GST rates are the clinic&apos;s own to set once the accountant confirms them. An item
        that is switched off stays on old bills and is no longer offered for new ones.
      </p>
      {editing && (
        <EditPriceItem
          item={editing === 'new' ? null : editing}
          barcode={editing === 'new' ? scanned : undefined}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setData((old) => {
              const rows = old ?? [];
              return rows.some((row) => row.id === saved.id)
                ? rows.map((row) => (row.id === saved.id ? saved : row))
                : [...rows, saved];
            });
          }}
        />
      )}
    </section>
  );
}

/** A patient's own bills and what they owe, for the Billing tab of the patient record. */
export function PatientBilling({
  patientId,
  patientName,
  role,
}: {
  patientId: string;
  patientName: string;
  role: Role;
}) {
  const [turn, setTurn] = useState(0);
  const [paying, setPaying] = useState<InvoiceRow | null>(null);
  const { data, error, loading } = useLoad(
    (signal) => api<Page<InvoiceRow>>(`invoices/?patient=${patientId}`, { signal }),
    [patientId, turn],
  );
  const owed = (data?.results ?? [])
    .filter((row) => row.status === 'issued')
    .reduce((sum, row) => sum + Math.max(Number(row.balance), 0), 0);
  return (
    <>
      <div className="heading">
        <div>
          <h2>Billing for {patientName}</h2>
          {data && (
            <p className="muted">
              {owed > 0 ? <StatusLabel tone="amber">Balance due {money(owed)}</StatusLabel> : 'Nothing is owed.'}
            </p>
          )}
        </div>
        <Link className="button secondary" to="/billing/new" state={{ patient: { id: patientId, name: patientName } }}>
          New invoice
        </Link>
      </div>
      <ErrorMessage message={error} />
      {loading && !data && <p role="status">Loading invoices…</p>}
      {data && !data.results.length && <p className="panel muted">No bills yet for this patient.</p>}
      {!!data?.results.length && (
        <section className="panel flush">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th className="num">Total (₹)</th>
                  <th className="num">Paid (₹)</th>
                  <th className="num">Balance (₹)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link to={`/billing/invoices/${row.id}`}>{row.status === 'draft' ? 'Draft' : row.number}</Link>
                    </td>
                    <td>{shortDate(row.date)}</td>
                    <td>
                      <StatusLabel tone={STATE_TONES[row.state]}>{STATE_LABELS[row.state]}</StatusLabel>
                    </td>
                    <td className="num">{amount(row.total)}</td>
                    <td className="num">{amount(row.paid)}</td>
                    <td className="num">{amount(row.balance)}</td>
                    <td className="right">
                      {(row.state === 'issued' || row.state === 'partially_paid') && canTakePayments(role) ? (
                        <button type="button" className="link-button" onClick={() => setPaying(row)}>
                          Record payment
                        </button>
                      ) : row.status === 'draft' ? (
                        <Link to={`/billing/invoices/${row.id}`}>Continue</Link>
                      ) : (
                        <Link to={`/print/invoice/${row.id}`}>Print</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {paying && (
        <PayFromList
          row={paying}
          onClose={() => setPaying(null)}
          onSaved={() => {
            setPaying(null);
            setTurn((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
