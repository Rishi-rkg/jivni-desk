/**
 * Pages made for paper. Each one shows the sheet as it will print, with Print and Back above it.
 * Printing goes through the browser's own print window, where "Save as PDF" gives a PDF.
 */
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api';
import {
  DayEnd,
  GROUP_LABELS,
  Invoice,
  METHODS,
  METHOD_LABELS,
  STATE_LABELS,
  gstLabel,
  rupeesInWords,
  upiLink,
} from './billing';
import { Barcode, QrCode, barcodeText } from './codes';
import { ErrorMessage } from './components';
import { amount, dateTime, initials, money, shortDate } from './format';
import { useLoad } from './ui';
import './print.css';

/** Sets the paper size for as long as a print page is open. */
export function usePaper(size: string) {
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `@page { size: ${size}; margin: 0; }`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [size]);
}

/** Opens the print window once, when the page was reached with "?auto=1" and the sheet is ready. */
function useAutoPrint(ready: boolean, onPrint?: () => void) {
  const [params] = useSearchParams();
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || params.get('auto') !== '1') return;
    done.current = true;
    const timer = window.setTimeout(() => {
      onPrint?.();
      window.print();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [ready, params, onPrint]);
}

function PrintPage({
  title,
  hint,
  back,
  backLabel,
  onPrint,
  children,
}: {
  title: string;
  hint: string;
  back: string;
  backLabel: string;
  onPrint?: () => void;
  children: ReactNode;
}) {
  const [params] = useSearchParams();
  return (
    <div className="print-desk">
      <div className="print-bar screen-only">
        <div>
          <h1>{title}</h1>
          <p className="muted">
            {params.get('pdf') === '1' ? 'To keep a PDF, press Print and choose “Save as PDF” as the printer.' : hint}
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              onPrint?.();
              window.print();
            }}
          >
            Print
          </button>
          <Link className="button secondary" to={back}>
            {backLabel}
          </Link>
        </div>
      </div>
      {children}
    </div>
  );
}

function Logo({ name }: { name: string }) {
  const [missing, setMissing] = useState(false);
  return missing ? (
    <span className="b-logo">{initials(name)}</span>
  ) : (
    <img className="b-logo" alt="" src="/api/v1/clinic/logo/" onError={() => setMissing(true)} />
  );
}

function ClinicHead({ clinic, doctor, gst }: { clinic: Invoice['snapshot']['clinic']; doctor?: string; gst: boolean }) {
  const line = [
    doctor,
    clinic.registration_number && `Reg. no. ${clinic.registration_number}`,
    gst && clinic.gstin && `GSTIN ${clinic.gstin}`,
  ].filter(Boolean);
  return (
    <div className="b-clinic">
      <Logo name={clinic.name} />
      <div>
        <h1>{clinic.name}</h1>
        <span className="muted address">
          {[clinic.address, [clinic.phone, clinic.email].filter(Boolean).join(' · '), line.join(' · ')]
            .filter(Boolean)
            .join('\n')}
        </span>
      </div>
    </div>
  );
}

function PatientCode({ code }: { code: string }) {
  if (!code) return null;
  return (
    <>
      <Barcode className="b-code" value={barcodeText(code)} />
      <span className="b-codetext">{code}</span>
    </>
  );
}

const printedNow = () => dateTime(new Date());

export function PrintInvoice() {
  const { id } = useParams();
  usePaper('A4');
  const { data: bill, error } = useLoad((signal) => api<Invoice>(`invoices/${id}/`, { signal }), [id]);
  const noted = useRef(false);
  const note = () => {
    // The bill's history says it was printed; once per visit to this page is enough.
    if (noted.current || !bill || bill.status === 'draft') return;
    noted.current = true;
    api(`invoices/${bill.id}/printed/`, { method: 'POST', body: '{}' }).catch(() => {});
  };
  useAutoPrint(!!bill && bill.status !== 'draft', note);
  if (error) return <ErrorMessage message={error} />;
  if (!bill) return <p role="status">Preparing the bill…</p>;
  if (bill.status === 'draft')
    return (
      <div className="content">
        <p className="warning">This bill is still a draft. Issue it before printing.</p>
        <Link to={`/billing/invoices/${bill.id}`}>← Back to the draft</Link>
      </div>
    );
  const { clinic, patient, visit, show_gst: gst } = bill.snapshot;
  const due = Number(bill.balance);
  const care = bill.lines.filter((line) => line.group === 'care');
  const products = bill.lines.filter((line) => line.group === 'products');
  const columns = gst ? 6 : 5;
  let counter = 0;
  const rows = (title: string, lines: Invoice['lines']) =>
    !!lines.length && (
      <>
        <tr className="group">
          <td colSpan={columns}>{title}</td>
        </tr>
        {lines.map((line) => (
          <tr key={line.id}>
            <td>{(counter += 1)}</td>
            <td>{line.description}</td>
            <td className="num">{Number(line.quantity)}</td>
            <td className="num">{amount(line.rate)}</td>
            {gst && <td className="num">{gstLabel(line.gst_rate)}</td>}
            <td className="num">{amount(line.amount)}</td>
          </tr>
        ))}
      </>
    );
  const payUpi = bill.status === 'issued' && due > 0 && !!clinic.upi_id;
  return (
    <PrintPage
      title="Bill · A4"
      hint="Prints on any A4 printer through the browser’s print window."
      back={`/billing/invoices/${bill.id}`}
      backLabel="Back to the invoice"
      onPrint={note}
    >
      <div className="sheet" aria-label={`Invoice ${bill.number}`}>
        <div className="b-head">
          <ClinicHead clinic={clinic} doctor={visit?.doctor} gst={gst} />
          <div className="b-title">
            <h2>INVOICE</h2>
            <strong>{bill.number}</strong>
            <br />
            <span className="muted">Date {shortDate(bill.date)}</span>
            <br />
            <span className="b-status">{STATE_LABELS[bill.state].toUpperCase()}</span>
          </div>
        </div>

        <div className="b-meta">
          <div>
            <p className="cap">Billed to</p>
            <strong>{patient?.name || bill.buyer_name || 'Walk-in customer'}</strong>
            {patient?.address && (
              <>
                <br />
                <span className="address">{patient.address}</span>
              </>
            )}
            {(patient?.phone || bill.buyer_phone) && (
              <>
                <br />
                <span className="muted">{patient?.phone || bill.buyer_phone}</span>
              </>
            )}
            {patient && <PatientCode code={patient.code} />}
          </div>
          <div>
            {visit && (
              <>
                <p className="cap">Visit</p>
                {shortDate(visit.date)}
                <br />
                {visit.doctor}
                {visit.type && (
                  <>
                    <br />
                    <span className="muted">{visit.type}</span>
                  </>
                )}
              </>
            )}
          </div>
          <div>
            {visit && (
              <>
                <p className="cap">Next visit advised</p>
                {visit.next_visit ? shortDate(visit.next_visit) : 'As needed'}
              </>
            )}
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th style={{ width: '9mm' }}>#</th>
              <th>Description</th>
              <th className="num" style={{ width: '14mm' }}>
                Qty
              </th>
              <th className="num" style={{ width: '24mm' }}>
                Rate (₹)
              </th>
              {gst && (
                <th className="num" style={{ width: '16mm' }}>
                  GST
                </th>
              )}
              <th className="num" style={{ width: '28mm' }}>
                Amount (₹)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows(GROUP_LABELS.care, care)}
            {rows(GROUP_LABELS.products, products)}
          </tbody>
        </table>

        <div className="b-totals">
          <div>
            {!!bill.payments.length && (
              <>
                <p className="cap">Payments received</p>
                <table>
                  <tbody>
                    {bill.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td style={{ paddingLeft: 0 }}>{shortDate(payment.received_at)}</td>
                        <td>
                          {payment.kind === 'refund' ? 'Refund, ' : ''}
                          {METHOD_LABELS[payment.method]}
                        </td>
                        <td>
                          {payment.kind === 'refund' ? 'Voucher' : 'Receipt'} {payment.receipt_number}
                        </td>
                        <td className="num">
                          {payment.kind === 'refund' ? '−' : ''}
                          {amount(payment.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {gst && !!bill.tax_summary.length && (
              <>
                <p className="cap" style={{ marginTop: '5mm' }}>
                  GST included in the amounts above
                </p>
                <table className="b-gst">
                  <thead>
                    <tr>
                      <th>Rate</th>
                      <th className="num">Taxable value</th>
                      <th className="num">CGST</th>
                      <th className="num">SGST</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bill.tax_summary.map((row) => (
                      <tr key={row.rate}>
                        <td>{gstLabel(row.rate)}</td>
                        <td className="num">{amount(row.taxable)}</td>
                        <td className="num">{amount(row.cgst)}</td>
                        <td className="num">{amount(row.sgst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {bill.note && <p style={{ marginTop: '4mm' }}>{bill.note}</p>}
            {bill.status === 'void' && <p className="b-void">VOID · {bill.void_reason}</p>}
          </div>
          <div>
            <table>
              <tbody>
                <tr>
                  <td>Subtotal</td>
                  <td className="num">{amount(bill.subtotal)}</td>
                </tr>
                {Number(bill.discount) > 0 && (
                  <tr>
                    <td>Discount{bill.discount_reason && ` · ${bill.discount_reason}`}</td>
                    <td className="num">−{amount(bill.discount)}</td>
                  </tr>
                )}
                <tr className="grand">
                  <td>Total</td>
                  <td className="num">{money(bill.total)}</td>
                </tr>
                {bill.credit_notes.map((creditNote) => (
                  <tr key={creditNote.id}>
                    <td>Credit note {creditNote.number}</td>
                    <td className="num">−{amount(creditNote.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td>Paid</td>
                  <td className="num">{amount(bill.paid)}</td>
                </tr>
                <tr className="due">
                  <td>Balance due</td>
                  <td className="num">{money(bill.balance)}</td>
                </tr>
              </tbody>
            </table>
            <p className="muted b-words">
              {rupeesInWords(bill.total)}.{gst && Number(bill.tax_total) > 0 && ' All prices include GST.'}
            </p>
          </div>
        </div>

        <div className={`b-foot ${payUpi ? '' : 'no-qr'}`}>
          {payUpi && (
            <QrCode
              className="b-qr"
              label="Scan to pay by UPI"
              text={upiLink(clinic.upi_id, clinic.name, bill.balance, bill.number)}
            />
          )}
          <div className="muted">
            {bill.status === 'issued' && due > 0 && (
              <>
                <strong style={{ color: '#111' }}>Pay the balance</strong>
                <br />
                {payUpi ? `Scan to pay ${money(bill.balance)} by UPI, or pay` : `Pay ${money(bill.balance)}`} at the
                front desk by cash or card. Please mention the invoice number.
                <br />
                <br />
              </>
            )}
            Thank you for visiting {clinic.name}.
          </div>
          <div className="b-sign">For {clinic.name}</div>
        </div>
        <div className="b-small">
          <span>Computer-generated bill</span>
          <span>Printed {printedNow()}</span>
        </div>
      </div>
    </PrintPage>
  );
}

export function PrintReceipt() {
  const { id, paymentId } = useParams();
  usePaper('A4');
  const { data: bill, error } = useLoad((signal) => api<Invoice>(`invoices/${id}/`, { signal }), [id]);
  const payment = bill?.payments.find((item) => item.id === paymentId);
  useAutoPrint(!!payment);
  if (error) return <ErrorMessage message={error} />;
  if (!bill) return <p role="status">Preparing the receipt…</p>;
  if (!payment)
    return (
      <div className="content">
        <p className="warning">That receipt was not found on this bill.</p>
        <Link to={`/billing/invoices/${bill.id}`}>← Back to the invoice</Link>
      </div>
    );
  const { clinic, patient, show_gst: gst } = bill.snapshot;
  return (
    <PrintPage
      title="Receipt"
      hint="Half an A4 sheet, through the browser’s print window."
      back={`/billing/invoices/${bill.id}`}
      backLabel="Back to the invoice"
    >
      <div className="sheet half" aria-label={`Receipt ${payment.receipt_number}`}>
        <div className="b-head">
          <ClinicHead clinic={clinic} gst={gst} />
          <div className="b-title">
            <h2>RECEIPT</h2>
            <strong>{payment.receipt_number}</strong>
            <br />
            <span className="muted">Date {shortDate(payment.received_at)}</span>
          </div>
        </div>
        <div className="r-grid">
          <div>
            <p className="cap">Received from</p>
            <strong>{patient?.name || bill.buyer_name || 'Walk-in customer'}</strong>
            {patient && <PatientCode code={patient.code} />}
          </div>
          <div>
            <p className="cap">Amount</p>
            <p className="r-amount">{money(payment.amount)}</p>
            <span className="muted">{rupeesInWords(payment.amount)}</span>
          </div>
          <div>
            <p className="cap">Paid by</p>
            {METHOD_LABELS[payment.method]}
            {payment.reference && (
              <>
                <br />
                <span className="muted">Reference {payment.reference}</span>
              </>
            )}
          </div>
          <div>
            <p className="cap">Against</p>
            Invoice {bill.number} of {shortDate(bill.date)}
            <br />
            <span className="muted">
              Bill total {money(bill.total)} · balance now {money(bill.balance)}
            </span>
          </div>
        </div>
        <div className="b-foot no-qr">
          <div className="muted">Received by {payment.received_by_name}. Thank you.</div>
          <div className="b-sign">For {clinic.name}</div>
        </div>
        <div className="b-small">
          <span>Computer-generated receipt</span>
          <span>Printed {printedNow()}</span>
        </div>
      </div>
    </PrintPage>
  );
}

export function PrintDayEnd() {
  const { day } = useParams();
  usePaper('A4');
  const { data, error } = useLoad((signal) => api<DayEnd>(`billing/day-end/?day=${day}`, { signal }), [day]);
  const { data: clinic } = useLoad((signal) => api<{ name: string }>('clinic/', { signal }), []);
  useAutoPrint(!!data && !!clinic);
  if (error) return <ErrorMessage message={error} />;
  if (!data || !clinic) return <p role="status">Preparing the report…</p>;
  return (
    <PrintPage
      title="Day-end report"
      hint="Prints on any A4 printer through the browser’s print window."
      back="/billing/day-end"
      backLabel="Back to billing"
    >
      <div className="sheet half" aria-label="Day-end report">
        <div className="b-head">
          <div className="b-clinic">
            <div>
              <h1>{clinic.name}</h1>
            </div>
          </div>
          <div className="b-title">
            <h2>DAY-END</h2>
            <strong>{shortDate(data.day)}</strong>
          </div>
        </div>
        <table style={{ marginTop: '6mm' }}>
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
              <td className="num">{data.closed ? amount(data.closed.cash_counted) : 'Not counted'}</td>
            </tr>
            {data.closed && (
              <tr>
                <td>Difference{data.closed.note && ` · ${data.closed.note}`}</td>
                <td className="num">{amount(data.closed.difference)}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="b-foot no-qr">
          <div className="muted">
            {data.closed
              ? `Closed by ${data.closed.closed_by_name} at ${dateTime(data.closed.closed_at)}.`
              : 'The day has not been closed.'}
          </div>
          <div className="b-sign">Signature</div>
        </div>
        <div className="b-small">
          <span>Computer-generated report</span>
          <span>Printed {printedNow()}</span>
        </div>
      </div>
    </PrintPage>
  );
}

/** Every print page. Shown without the tabs and header, so the paper holds only the document. */
export function PrintRoutes() {
  return (
    <Routes>
      <Route path="/print/invoice/:id" element={<PrintInvoice />} />
      <Route path="/print/receipt/:id/:paymentId" element={<PrintReceipt />} />
      <Route path="/print/day-end/:day" element={<PrintDayEnd />} />
      <Route
        path="*"
        element={
          <div className="content">
            <p className="warning">There is nothing to print at this address.</p>
            <Link to="/dashboard">← Dashboard</Link>
          </div>
        }
      />
    </Routes>
  );
}
