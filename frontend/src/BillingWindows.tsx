/** Floating windows used by the billing screens: record a payment, add a product, correct a bill, edit a price. */
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import {
  GST_RATES,
  Invoice,
  ItemKind,
  KINDS,
  KIND_LABELS,
  METHODS,
  PayMethod,
  PriceItem,
  STATE_LABELS,
  gstLabel,
} from './billing';
import { ErrorMessage } from './components';
import { isoDay, money, shortDate } from './format';
import { ChoiceStrip, Modal, notify } from './ui';

type PayTarget = { id: string; number: string; balance: string; name: string };

/** W3: record a payment against an issued bill. */
export function RecordPayment({
  bill,
  onClose,
  onSaved,
}: {
  bill: PayTarget;
  onClose: () => void;
  onSaved: (invoice: Invoice, printReceipt: boolean) => void;
}) {
  const [amount, setAmount] = useState(Number(bill.balance).toFixed(2));
  const [method, setMethod] = useState<PayMethod>('cash');
  const [reference, setReference] = useState('');
  const [printReceipt, setPrintReceipt] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const invoice = await api<Invoice>(`invoices/${bill.id}/payments/`, {
        method: 'POST',
        body: JSON.stringify({ amount, method, reference }),
      });
      notify(`Payment of ${money(amount)} recorded. Invoice is now ${STATE_LABELS[invoice.state]}.`);
      onSaved(invoice, printReceipt);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Record payment · ${bill.number}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="payment-form" disabled={busy}>
            {busy ? 'Saving…' : 'Save payment'}
          </button>
        </>
      }
    >
      <form id="payment-form" onSubmit={submit}>
        <p>
          {bill.name || 'Walk-in customer'} · balance due <strong>{money(bill.balance)}</strong>
        </p>
        <ErrorMessage message={error} />
        <div className="form-grid two">
          <label>
            Amount (₹)
            <input
              data-autofocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              required
              pattern="[0-9]+(\.[0-9]{1,2})?"
            />
          </label>
          <label>
            Date
            <input value={shortDate(isoDay())} disabled readOnly />
          </label>
          <div className="span-all">
            <span className="field-label">Method</span>
            <ChoiceStrip label="Method" value={method} options={METHODS} onChange={setMethod} />
          </div>
          <label className="span-all">
            Reference
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={100}
              placeholder="UPI or card reference, optional"
            />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={printReceipt} onChange={(e) => setPrintReceipt(e.target.checked)} />
          Print receipt
        </label>
      </form>
    </Modal>
  );
}

/** W4b: pick something from the price list to put on a bill or a visit. */
export function AddFromPriceList({
  productsOnly,
  title,
  onPick,
  onClose,
}: {
  productsOnly: boolean;
  title: string;
  onPick: (item: PriceItem) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<PriceItem[] | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<PriceItem[]>(`price-items/?active=true${productsOnly ? '&group=products' : ''}`, { signal: controller.signal })
      .then(setItems)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [productsOnly]);
  const matches = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return (items ?? []).filter((item) => words.every((word) => item.name.toLowerCase().includes(word)));
  }, [items, text]);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <input
        data-autofocus
        type="search"
        aria-label="Search the price list"
        placeholder={
          productsOnly ? 'Search products, supplements and consumables' : 'Search services, medicines and products'
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <ErrorMessage message={error} />
      <div className="menu flat pick-list" role="listbox" aria-label="Price list">
        {!items && !error && <div className="hd">Loading the price list…</div>}
        {items && !matches.length && (
          <div className="hd">
            {items.length ? 'Nothing in the price list matches.' : 'The price list has no items of this kind yet.'}
          </div>
        )}
        {matches.map((item) => (
          <button type="button" role="option" aria-selected={false} key={item.id} onClick={() => onPick(item)}>
            <span>
              {item.name} <span className="muted small">· {KIND_LABELS[item.kind]}</span>
            </span>
            <span>{money(item.rate)}</span>
          </button>
        ))}
      </div>
      <p className="small muted">
        Items come from the price list. A barcode scan on a pack adds it directly, without opening this window.
      </p>
    </Modal>
  );
}

/** W8: make a bill void, take an amount off it with a credit note, or give money back. */
export function CorrectBill({
  bill,
  mode,
  onClose,
  onSaved,
}: {
  bill: Invoice;
  mode: 'void' | 'credit' | 'refund';
  onClose: () => void;
  onSaved: (invoice: Invoice) => void;
}) {
  const remaining = Number(bill.total) - Number(bill.credited);
  const [amount, setAmount] = useState(mode === 'refund' ? Number(bill.paid).toFixed(2) : remaining.toFixed(2));
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<PayMethod>('cash');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A credit that leaves the customer having paid too much means money goes back to them.
  const overpaid = mode === 'credit' ? Number(bill.paid) - (remaining - (Number(amount) || 0)) : 0;
  const titles = {
    void: `Void invoice ${bill.number}`,
    credit: `Credit note for ${bill.number}`,
    refund: `Refund on ${bill.number}`,
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const path = { void: 'void', credit: 'credit-note', refund: 'refund' }[mode];
    const body =
      mode === 'void'
        ? { reason }
        : mode === 'refund'
          ? { amount, method, reason }
          : { amount, reason, ...(overpaid > 0 ? { refund_method: method } : {}) };
    try {
      const invoice = await api<Invoice>(`invoices/${bill.id}/${path}/`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      notify({ void: 'Invoice made void.', credit: 'Credit note issued.', refund: 'Refund recorded.' }[mode]);
      onSaved(invoice);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={titles[mode]}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            {mode === 'void' ? 'Keep invoice' : 'Cancel'}
          </button>
          <button form="correct-form" className={mode === 'void' ? 'danger' : undefined} disabled={busy}>
            {{ void: 'Void invoice', credit: 'Issue credit note', refund: 'Record refund' }[mode]}
          </button>
        </>
      }
    >
      <form id="correct-form" className="stack" onSubmit={submit}>
        {mode === 'void' && <p>The invoice stays in the list marked Void. Its number is not reused.</p>}
        {mode === 'credit' && (
          <p>The invoice stays as it was printed. The credit note takes an amount off it and gets its own number.</p>
        )}
        {mode === 'refund' && <p>Record money given back to the customer. {money(bill.paid)} has been paid.</p>}
        <ErrorMessage message={error} />
        {mode !== 'void' && (
          <label>
            Amount (₹)
            <input
              data-autofocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              required
              pattern="[0-9]+(\.[0-9]{1,2})?"
            />
          </label>
        )}
        {(mode === 'refund' || overpaid > 0) && (
          <div>
            <span className="field-label">
              {mode === 'refund' ? 'Given back by' : `Give ${money(overpaid)} back by`}
            </span>
            <ChoiceStrip label="Refund method" value={method} options={METHODS} onChange={setMethod} />
          </div>
        )}
        <label>
          Reason
          <input
            data-autofocus={mode === 'void' ? true : undefined}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            maxLength={300}
          />
        </label>
      </form>
    </Modal>
  );
}

/** W29: add or change one item of the price list. */
export function EditPriceItem({
  item,
  barcode,
  onClose,
  onSaved,
}: {
  item: PriceItem | null;
  /** A code that was just scanned and is not in the list yet. */
  barcode?: string;
  onClose: () => void;
  onSaved: (item: PriceItem) => void;
}) {
  const [kind, setKind] = useState<ItemKind>(item?.kind ?? (barcode ? 'supplement' : 'service'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isProduct = !['service', 'prescribed'].includes(kind);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const body = {
      name: String(data.get('name') || '').trim(),
      kind,
      rate: String(data.get('rate') || '0'),
      gst_rate: String(data.get('gst_rate') || '0'),
      barcode: isProduct ? String(data.get('barcode') || '').trim() : '',
    };
    try {
      const saved = await api<PriceItem>(item ? `price-items/${item.id}/` : 'price-items/', {
        method: item ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      notify(item ? 'Price saved.' : 'Item added to the price list.');
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={item ? 'Price list item' : 'Add to the price list'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="price-form" disabled={busy}>
            {busy ? 'Saving…' : 'Save item'}
          </button>
        </>
      }
    >
      <form id="price-form" onSubmit={submit}>
        <ErrorMessage message={error} />
        <div className="form-grid two">
          <label className="span-all">
            Item
            <input name="name" defaultValue={item?.name} required maxLength={200} data-autofocus />
          </label>
          <label>
            Kind
            <select
              aria-label="Kind"
              value={kind}
              disabled={!!item?.role}
              onChange={(e) => setKind(e.target.value as ItemKind)}
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {KIND_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            GST
            <select name="gst_rate" aria-label="GST" defaultValue={String(Number(item?.gst_rate ?? 0))}>
              {GST_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {gstLabel(rate)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rate (₹), GST included
            <input
              name="rate"
              defaultValue={item ? Number(item.rate).toFixed(2) : ''}
              inputMode="decimal"
              required
              pattern="[0-9]+(\.[0-9]{1,2})?"
            />
          </label>
          {isProduct && (
            <label>
              Barcode on the pack
              <input
                name="barcode"
                defaultValue={item?.barcode ?? barcode ?? ''}
                maxLength={64}
                placeholder="Optional"
              />
            </label>
          )}
        </div>
        {item?.role && (
          <p className="info small">
            This item is used when a bill is made from a visit. Set its rate; its kind stays as it is.
          </p>
        )}
      </form>
    </Modal>
  );
}
