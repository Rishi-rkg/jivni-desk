/** One bill: the editable draft (also the walk-in "new bill") and the read-only issued view. */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import {
  GROUP_LABELS,
  GST_RATES,
  HISTORY_LABELS,
  Invoice,
  ItemKind,
  KINDS,
  KIND_LABELS,
  METHODS,
  METHOD_LABELS,
  PayMethod,
  PriceItem,
  STATE_LABELS,
  STATE_TONES,
  draftTotals,
  groupOf,
  gstLabel,
  lineAmount,
} from './billing';
import { AddFromPriceList, CorrectBill, RecordPayment } from './BillingWindows';
import { WriteMessage } from './MessageWindows';
import { ErrorMessage } from './components';
import { amount, clock, dateTime, money, shortDate } from './format';
import { Product, useProductScans } from './Scanner';
import { Features, Page, Patient, Role, canTakePayments, displayName } from './types';
import { ChoiceStrip, Menu, MenuItem, StatusLabel, notify, useLoad, useShortcut } from './ui';
import { useUnsavedChanges } from './useUnsavedChanges';

interface DraftLine {
  key: number;
  price_item: string | null;
  kind: ItemKind;
  description: string;
  quantity: string;
  rate: string;
  gst_rate: string;
  source: string;
}
let nextKey = 1;
const fromItem = (
  item: { id: string; name: string; kind: string; rate: string; gst_rate: string },
  source = '',
): DraftLine => ({
  key: nextKey++,
  price_item: item.id,
  kind: item.kind as ItemKind,
  description: item.name,
  quantity: '1',
  rate: String(Number(item.rate)),
  gst_rate: String(Number(item.gst_rate)),
  source,
});
const SOURCE_HINTS: Record<string, string> = { scan: '(scanned)', visit: '(from the visit)' };

export function InvoiceScreen({
  role,
  features,
  messagesOn = false,
}: {
  role: Role;
  features?: Partial<Features>;
  messagesOn?: boolean;
}) {
  const { id } = useParams();
  const { data, setData, error, loading } = useLoad((signal) => api<Invoice>(`invoices/${id}/`, { signal }), [id]);
  if (loading && !data) return <p role="status">Loading the bill…</p>;
  if (!data)
    return (
      <>
        <Link to="/billing">← Billing</Link>
        <ErrorMessage message={error || 'That bill was not found.'} />
      </>
    );
  return data.status === 'draft' ? (
    <InvoiceEditor key={data.id} bill={data} features={features} onSaved={setData} />
  ) : (
    <InvoiceView bill={data} role={role} messagesOn={messagesOn} onChanged={setData} />
  );
}

export function NewBill({ features }: { features?: Partial<Features> }) {
  return <InvoiceEditor bill={null} features={features} onSaved={() => {}} />;
}

function PatientPicker({ onPick }: { onPick: (patient: { id: string; name: string }) => void }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<Patient[]>([]);
  const query = text.trim();
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<Page<Patient>>(`patients/?search=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((page) => setResults(page.results.slice(0, 5)))
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return (
    <>
      <label>
        Find the patient
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Name, phone or patient ID"
          autoComplete="off"
        />
      </label>
      {results.map((patient) => (
        <button
          type="button"
          className="pick"
          key={patient.id}
          onClick={() => onPick({ id: patient.id, name: displayName(patient) })}
        >
          <span>
            <strong>{displayName(patient)}</strong>
          </span>
          <span className="mono muted">{patient.identifier}</span>
        </button>
      ))}
      {query.length >= 2 && !results.length && <p className="muted small">No patients match.</p>}
    </>
  );
}

function InvoiceEditor({
  bill,
  features,
  onSaved,
}: {
  bill: Invoice | null;
  features?: Partial<Features>;
  onSaved: (bill: Invoice) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const start = location.state as { product?: Product; patient?: { id: string; name: string } } | null;
  const productsAllowed = features?.product_sales !== false;
  const [savedId, setSavedId] = useState(bill?.id ?? '');
  const [lines, setLines] = useState<DraftLine[]>(() =>
    bill
      ? bill.lines.map((line) => ({
          key: nextKey++,
          price_item: line.price_item,
          kind: line.kind,
          description: line.description,
          quantity: String(Number(line.quantity)),
          rate: String(Number(line.rate)),
          gst_rate: String(Number(line.gst_rate)),
          source: line.source,
        }))
      : start?.product
        ? [fromItem(start.product, 'scan')]
        : [],
  );
  const [discount, setDiscount] = useState(bill ? String(Number(bill.discount)) : '0');
  const [discountReason, setDiscountReason] = useState(bill?.discount_reason ?? '');
  const [note, setNote] = useState(bill?.note ?? '');
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(
    bill?.patient ? { id: bill.patient.id, name: bill.patient.name } : (start?.patient ?? null),
  );
  const [who, setWho] = useState<'walk_in' | 'patient'>(bill?.patient || start?.patient ? 'patient' : 'walk_in');
  const [buyerName, setBuyerName] = useState(bill?.buyer_name ?? '');
  const [buyerPhone, setBuyerPhone] = useState(bill?.buyer_phone ?? '');
  const [method, setMethod] = useState<PayMethod>('cash');
  const [printBill, setPrintBill] = useState(true);
  const [adding, setAdding] = useState<'' | 'list' | 'products'>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(!bill && !!start?.product);
  const { allowNavigation, prompt } = useUnsavedChanges(dirty);
  const figures = useMemo(() => draftTotals(lines, discount), [lines, discount]);
  const fromVisit = !!bill?.encounter;

  const change = (key: number, patch: Partial<DraftLine>) => {
    setDirty(true);
    setLines((old) => old.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };
  /** A second pack of something already on the bill raises its quantity instead of adding a line. */
  function addItem(item: { id: string; name: string; kind: string; rate: string; gst_rate: string }, source = '') {
    setDirty(true);
    setLines((old) => {
      const same = old.find((line) => line.price_item === item.id);
      if (same)
        return old.map((line) =>
          line === same ? { ...line, quantity: String((Number(line.quantity) || 0) + 1) } : line,
        );
      return [...old, fromItem(item, source)];
    });
  }
  // A product scanned while this bill is open goes straight onto it.
  useProductScans((product) => {
    if (!productsAllowed) return notify('Product sales are switched off for this clinic.', { kind: 'failed' });
    addItem(product, 'scan');
    notify(`${product.name} added.`);
  });

  function body() {
    return {
      patient_id: who === 'patient' ? (patient?.id ?? null) : null,
      buyer_name: who === 'walk_in' ? buyerName.trim() : '',
      buyer_phone: who === 'walk_in' ? buyerPhone.trim() : '',
      discount: discount || '0',
      discount_reason: discountReason.trim(),
      note: note.trim(),
      lines: lines.map((line) => ({
        price_item: line.price_item,
        kind: line.kind,
        description: line.description.trim(),
        quantity: line.quantity || '0',
        rate: line.rate || '0',
        gst_rate: line.gst_rate || '0',
        source: line.source,
      })),
    };
  }
  async function save(): Promise<Invoice> {
    if (who === 'patient' && !patient) throw new Error('Choose the patient this bill is for, or switch to walk-in.');
    const saved = await api<Invoice>(savedId ? `invoices/${savedId}/` : 'invoices/', {
      method: savedId ? 'PATCH' : 'POST',
      body: JSON.stringify(body()),
    });
    setSavedId(saved.id);
    setDirty(false);
    return saved;
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const saveDraft = () =>
    run(async () => {
      const saved = await save();
      notify('Draft saved.');
      allowNavigation.current = true;
      if (!bill) navigate(`/billing/invoices/${saved.id}`, { replace: true });
      else onSaved(saved);
    });
  const issue = (takePayment: boolean) =>
    run(async () => {
      const saved = await save();
      const issued = await api<Invoice>(`invoices/${saved.id}/issue/`, {
        method: 'POST',
        body: JSON.stringify(takePayment ? { payment: { method } } : {}),
      });
      notify(`Invoice issued as ${issued.number}.`);
      allowNavigation.current = true;
      if (printBill) navigate(`/print/invoice/${issued.id}?auto=1`);
      else if (bill) onSaved(issued);
      else navigate(`/billing/invoices/${issued.id}`, { replace: true });
    });
  const remove = () =>
    run(async () => {
      if (savedId) await api(`invoices/${savedId}/`, { method: 'DELETE' });
      notify('Draft deleted.');
      allowNavigation.current = true;
      navigate('/billing');
    });
  useShortcut('s', saveDraft, { ctrl: true, active: !busy });

  const groups = (['care', 'products'] as const).filter(
    (group) => group === 'care' || productsAllowed || lines.some((line) => groupOf(line.kind) === group),
  );
  return (
    <>
      {prompt}
      <p>
        <Link to="/billing">← Billing</Link>
      </p>
      <div className="heading">
        <div>
          <h1>
            {bill ? 'Draft invoice' : 'New bill'} <StatusLabel tone="grey">Draft</StatusLabel>
          </h1>
          <p className="muted">
            {fromVisit
              ? 'Filled in from the visit. The number is given when the bill is issued.'
              : 'Scan a pack to add it; each scan adds a line. The number is given when the bill is issued.'}
          </p>
        </div>
      </div>
      <ErrorMessage message={error} />
      <div className="cols cols-2">
        <section className="panel flush">
          <div className="table-scroll">
            <table className="bill-lines">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Rate (₹)</th>
                  <th>GST</th>
                  <th className="num">Amount (₹)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <GroupRows
                    key={group}
                    title={GROUP_LABELS[group]}
                    lines={lines.filter((line) => groupOf(line.kind) === group)}
                    change={change}
                    remove={(key) => {
                      setDirty(true);
                      setLines((old) => old.filter((line) => line.key !== key));
                    }}
                  />
                ))}
                {!lines.length && (
                  <tr>
                    <td colSpan={6} className="empty">
                      Nothing on this bill yet. Add from the price list, or scan a pack.
                    </td>
                  </tr>
                )}
                <tr>
                  <td colSpan={6}>
                    <button type="button" className="link-button" onClick={() => setAdding('list')}>
                      + Add from the price list
                    </button>
                    {productsAllowed && (
                      <>
                        {' · '}
                        <button type="button" className="link-button" onClick={() => setAdding('products')}>
                          + Add product
                        </button>
                      </>
                    )}
                    {' · '}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        setDirty(true);
                        setLines((old) => [
                          ...old,
                          {
                            key: nextKey++,
                            price_item: null,
                            kind: 'service',
                            description: '',
                            quantity: '1',
                            rate: '',
                            gst_rate: '0',
                            source: '',
                          },
                        ]);
                      }}
                    >
                      + Add custom line
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="form-grid four bill-foot">
            <label>
              Discount (₹)
              <input
                value={discount}
                inputMode="decimal"
                onChange={(e) => {
                  setDirty(true);
                  setDiscount(e.target.value);
                }}
              />
            </label>
            <label>
              Discount reason
              <input
                value={discountReason}
                maxLength={200}
                onChange={(e) => {
                  setDirty(true);
                  setDiscountReason(e.target.value);
                }}
              />
            </label>
            <label>
              Note on the bill
              <input
                value={note}
                maxLength={300}
                placeholder="Optional"
                onChange={(e) => {
                  setDirty(true);
                  setNote(e.target.value);
                }}
              />
            </label>
            <label>
              Total (₹)
              <input className="bill-total" value={amount(figures.total)} disabled readOnly />
            </label>
          </div>
        </section>

        <div>
          <section className="panel">
            <h2>Who is this for?</h2>
            <ChoiceStrip
              label="Who is this for?"
              value={who}
              disabled={fromVisit}
              options={[
                ['walk_in', 'Walk-in customer'],
                ['patient', 'Patient on record'],
              ]}
              onChange={(value) => {
                setDirty(true);
                setWho(value);
              }}
            />
            {who === 'walk_in' ? (
              <>
                <div className="form-grid two who-fields">
                  <label>
                    Name
                    <input
                      value={buyerName}
                      maxLength={200}
                      placeholder="Optional"
                      onChange={(e) => {
                        setDirty(true);
                        setBuyerName(e.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Phone
                    <input
                      value={buyerPhone}
                      maxLength={40}
                      placeholder="Optional"
                      onChange={(e) => {
                        setDirty(true);
                        setBuyerPhone(e.target.value);
                      }}
                    />
                  </label>
                </div>
                <p className="small muted">
                  A walk-in bill needs no patient record and prints without a patient barcode.
                </p>
              </>
            ) : patient ? (
              <p className="who-fields">
                <Link to={`/patients/${patient.id}`}>
                  <strong>{patient.name}</strong>
                </Link>{' '}
                {!fromVisit && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setDirty(true);
                      setPatient(null);
                    }}
                  >
                    Change
                  </button>
                )}
              </p>
            ) : (
              <div className="who-fields">
                <PatientPicker
                  onPick={(picked) => {
                    setDirty(true);
                    setPatient(picked);
                  }}
                />
              </div>
            )}
          </section>
          <section className="panel">
            <h2>Payment</h2>
            <ChoiceStrip label="Payment method" value={method} options={METHODS} onChange={setMethod} />
            <label className="check who-fields">
              <input type="checkbox" checked={printBill} onChange={(e) => setPrintBill(e.target.checked)} />
              Print the bill
            </label>
            <p className="small muted">Used by “Issue and take payment”, which records the whole total as paid.</p>
          </section>
        </div>
      </div>
      <div className="save-bar">
        <span className="muted">
          Draft · not yet numbered · total {money(figures.total)}
          {dirty && ' · unsaved changes'}
        </span>
        <div className="actions">
          <button type="button" className="danger" disabled={busy} onClick={remove}>
            Delete draft
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={saveDraft}>
            Save draft
          </button>
          <button type="button" className="secondary" disabled={busy || !lines.length} onClick={() => issue(false)}>
            Issue
          </button>
          <button type="button" disabled={busy || !lines.length} onClick={() => issue(true)}>
            Issue and take payment
          </button>
        </div>
      </div>
      {adding && (
        <AddFromPriceList
          productsOnly={adding === 'products'}
          title={adding === 'products' ? 'Add a product to the bill' : 'Add from the price list'}
          onClose={() => setAdding('')}
          onPick={(item: PriceItem) => {
            addItem(item);
            setAdding('');
            notify(`${item.name} added.`);
          }}
        />
      )}
    </>
  );
}

function GroupRows({
  title,
  lines,
  change,
  remove,
}: {
  title: string;
  lines: DraftLine[];
  change: (key: number, patch: Partial<DraftLine>) => void;
  remove: (key: number) => void;
}) {
  if (!lines.length) return null;
  return (
    <>
      <tr className="group-row">
        <td colSpan={6}>{title}</td>
      </tr>
      {lines.map((line) => {
        const label = line.description || 'this line';
        return (
          <tr key={line.key}>
            <td>
              {line.price_item ? (
                <>
                  {line.description} <span className="muted small">{SOURCE_HINTS[line.source]}</span>
                </>
              ) : (
                <span className="custom-line">
                  <input
                    aria-label="Description"
                    value={line.description}
                    maxLength={200}
                    placeholder="What is being charged"
                    onChange={(e) => change(line.key, { description: e.target.value })}
                  />
                  <select
                    aria-label={`Kind of ${label}`}
                    value={line.kind}
                    onChange={(e) => change(line.key, { kind: e.target.value as ItemKind })}
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </span>
              )}
            </td>
            <td>
              <input
                className="num"
                aria-label={`Quantity of ${label}`}
                value={line.quantity}
                inputMode="decimal"
                onChange={(e) => change(line.key, { quantity: e.target.value })}
              />
            </td>
            <td>
              <input
                className="num"
                aria-label={`Rate of ${label}`}
                value={line.rate}
                inputMode="decimal"
                onChange={(e) => change(line.key, { rate: e.target.value })}
              />
            </td>
            <td>
              {line.price_item ? (
                gstLabel(line.gst_rate)
              ) : (
                <select
                  aria-label={`GST on ${label}`}
                  value={line.gst_rate}
                  onChange={(e) => change(line.key, { gst_rate: e.target.value })}
                >
                  {GST_RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {gstLabel(rate)}
                    </option>
                  ))}
                </select>
              )}
            </td>
            <td className="num">{amount(lineAmount(line))}</td>
            <td>
              <button type="button" className="x" aria-label={`Remove ${label}`} onClick={() => remove(line.key)}>
                ✕
              </button>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function InvoiceView({
  bill,
  role,
  messagesOn,
  onChanged,
}: {
  bill: Invoice;
  role: Role;
  messagesOn: boolean;
  onChanged: (bill: Invoice) => void;
}) {
  const [messaging, setMessaging] = useState(false);
  const navigate = useNavigate();
  const [paying, setPaying] = useState(false);
  const [correcting, setCorrecting] = useState<'' | 'void' | 'credit' | 'refund'>('');
  const mayCorrect = role === 'owner' || role === 'billing';
  const due = Number(bill.balance);
  const customer = bill.patient?.name || bill.buyer_name || 'Walk-in customer';
  const lastPayment = [...bill.payments].reverse().find((payment) => payment.kind === 'payment');
  const care = bill.lines.filter((line) => line.group === 'care');
  const products = bill.lines.filter((line) => line.group === 'products');
  const more: MenuItem[] = [
    ...(lastPayment ? [{ label: 'Print receipt', to: `/print/receipt/${bill.id}/${lastPayment.id}` }] : []),
    { label: 'Download PDF', to: `/print/invoice/${bill.id}?pdf=1` },
    ...(messagesOn && bill.patient && bill.status === 'issued'
      ? [{ label: 'WhatsApp message about this bill', onSelect: () => setMessaging(true) }]
      : []),
    ...(mayCorrect && bill.status === 'issued'
      ? ([
          { label: 'Issue credit note', onSelect: () => setCorrecting('credit') },
          ...(Number(bill.paid) > 0 ? [{ label: 'Refund payment', onSelect: () => setCorrecting('refund') }] : []),
          'sep',
          { label: 'Void invoice', danger: true, onSelect: () => setCorrecting('void') },
        ] as MenuItem[])
      : []),
  ];
  return (
    <>
      <p>
        <Link to="/billing">← Billing</Link>
        {bill.patient && (
          <>
            {' · '}
            <Link to={`/patients/${bill.patient.id}?tab=billing`}>{bill.patient.name}</Link>
          </>
        )}
      </p>
      <div className="heading">
        <div>
          <h1>
            Invoice {bill.number} <StatusLabel tone={STATE_TONES[bill.state]}>{STATE_LABELS[bill.state]}</StatusLabel>
          </h1>
          <p className="muted small">
            Issued {shortDate(bill.issued_at)} by {bill.issued_by_name || 'the clinic'}
            {bill.snapshot.visit && `, from the visit on ${shortDate(bill.snapshot.visit.date)}`} · {customer}. An
            issued invoice cannot be edited; corrections are credit notes.
          </p>
        </div>
        <div className="actions">
          {bill.status === 'issued' && due > 0 && canTakePayments(role) && (
            <button type="button" onClick={() => setPaying(true)}>
              Record payment
            </button>
          )}
          <Link className="button secondary" to={`/print/invoice/${bill.id}`}>
            Print
          </Link>
          <Menu label="More ▾" items={more} />
        </div>
      </div>
      {bill.status === 'void' && (
        <p className="warning">
          Void since {shortDate(bill.voided_at)}: {bill.void_reason}
        </p>
      )}
      <div className="cols cols-2">
        <section className="panel flush">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Rate (₹)</th>
                  {bill.snapshot.show_gst && <th className="num">GST</th>}
                  <th className="num">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['care', care],
                    ['products', products],
                  ] as const
                ).map(
                  ([group, rows]) =>
                    !!rows.length && (
                      <ViewRows key={group} title={GROUP_LABELS[group]} lines={rows} gst={bill.snapshot.show_gst} />
                    ),
                )}
                <TotalRow gst={bill.snapshot.show_gst} label="Subtotal" value={amount(bill.subtotal)} muted />
                {Number(bill.discount) > 0 && (
                  <TotalRow
                    gst={bill.snapshot.show_gst}
                    label={`Discount${bill.discount_reason ? ` · ${bill.discount_reason}` : ''}`}
                    value={`−${amount(bill.discount)}`}
                    muted
                  />
                )}
                <TotalRow
                  gst={bill.snapshot.show_gst}
                  label={
                    bill.snapshot.show_gst && Number(bill.tax_total) > 0
                      ? `Total (GST included: ${amount(bill.tax_total)})`
                      : 'Total'
                  }
                  value={amount(bill.total)}
                  strong
                />
                {Number(bill.credited) > 0 && (
                  <TotalRow
                    gst={bill.snapshot.show_gst}
                    label="Credit notes"
                    value={`−${amount(bill.credited)}`}
                    muted
                  />
                )}
                <TotalRow gst={bill.snapshot.show_gst} label="Paid" value={amount(bill.paid)} muted />
                <TotalRow gst={bill.snapshot.show_gst} label="Balance due" value={amount(bill.balance)} strong />
              </tbody>
            </table>
          </div>
          {bill.note && <p className="bill-note muted">Note: {bill.note}</p>}
        </section>

        <div>
          <section className="panel">
            <h2>Payments</h2>
            {!bill.payments.length && <p className="muted">No payment has been recorded.</p>}
            {bill.payments.map((payment) => (
              <div className="row" key={payment.id}>
                <span>
                  <strong>
                    {payment.kind === 'refund' ? 'Refund ' : ''}
                    {money(payment.amount)} · {METHOD_LABELS[payment.method]}
                  </strong>
                  <span className="muted">
                    {dateTime(payment.received_at)} · {payment.received_by_name} ·{' '}
                    {payment.kind === 'refund' ? 'Voucher' : 'Receipt'} {payment.receipt_number}
                    {payment.note && ` · ${payment.note}`}
                  </span>
                </span>
                {payment.kind === 'payment' && <Link to={`/print/receipt/${bill.id}/${payment.id}`}>Receipt</Link>}
              </div>
            ))}
            {bill.status === 'issued' && due > 0 && canTakePayments(role) && (
              <p className="panel-action">
                <button type="button" className="secondary" onClick={() => setPaying(true)}>
                  Record payment
                </button>
              </p>
            )}
          </section>
          {!!bill.credit_notes.length && (
            <section className="panel">
              <h2>Credit notes</h2>
              {bill.credit_notes.map((note) => (
                <div className="row" key={note.id}>
                  <span>
                    <strong>
                      {note.number} · {money(note.amount)}
                    </strong>
                    <span className="muted">
                      {shortDate(note.created_at)} · {note.created_by_name} · {note.reason}
                    </span>
                  </span>
                </div>
              ))}
            </section>
          )}
          <section className="panel">
            <h2>History</h2>
            <p className="small history">
              {bill.history.map((event) => (
                <span key={event.id}>
                  {shortDate(event.created_at).slice(0, 6)} {clock(event.created_at)} ·{' '}
                  {HISTORY_LABELS[event.action] ?? event.action}
                  {event.actor_name && ` · ${event.actor_name}`}
                </span>
              ))}
            </p>
          </section>
        </div>
      </div>
      {paying && (
        <RecordPayment
          bill={{ id: bill.id, number: bill.number, balance: bill.balance, name: customer }}
          onClose={() => setPaying(false)}
          onSaved={(updated, printReceipt) => {
            setPaying(false);
            onChanged(updated);
            const payment = updated.payments[updated.payments.length - 1];
            if (printReceipt && payment) navigate(`/print/receipt/${updated.id}/${payment.id}?auto=1`);
          }}
        />
      )}
      {correcting && (
        <CorrectBill
          bill={bill}
          mode={correcting}
          onClose={() => setCorrecting('')}
          onSaved={(updated) => {
            setCorrecting('');
            onChanged(updated);
          }}
        />
      )}
      {messaging && bill.patient && (
        <WriteMessage
          role={role}
          patient={bill.patient}
          invoice={bill.id}
          templateKey="invoice"
          onClose={() => setMessaging(false)}
          onDone={() => setMessaging(false)}
        />
      )}
    </>
  );
}

function ViewRows({ title, lines, gst }: { title: string; lines: Invoice['lines']; gst: boolean }) {
  return (
    <>
      <tr className="group-row">
        <td colSpan={gst ? 5 : 4}>{title}</td>
      </tr>
      {lines.map((line) => (
        <tr key={line.id}>
          <td>{line.description}</td>
          <td className="num">{Number(line.quantity)}</td>
          <td className="num">{amount(line.rate)}</td>
          {gst && <td className="num">{gstLabel(line.gst_rate)}</td>}
          <td className="num">{amount(line.amount)}</td>
        </tr>
      ))}
    </>
  );
}

function TotalRow({
  label,
  value,
  gst,
  strong,
  muted,
}: {
  label: string;
  value: string;
  gst: boolean;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <tr className="total-row">
      <td colSpan={gst ? 4 : 3} className={`num ${muted ? 'muted' : ''}`}>
        {strong ? <strong>{label}</strong> : label}
      </td>
      <td className="num">{strong ? <strong>{value}</strong> : value}</td>
    </tr>
  );
}
