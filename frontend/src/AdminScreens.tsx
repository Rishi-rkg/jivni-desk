import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ErrorMessage } from './components';
import { dateTime, initials, isoDay } from './format';
import { AuditEvent, ClinicSettings, Page, Role, canAdministerClinic } from './types';
import { useUnsavedChanges } from './useUnsavedChanges';

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** 26-27 for a day in the financial year that runs from April 2026 to March 2027. */
export function financialYear(day: string) {
  const [year, month] = day.split('-').map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function ClinicDetails({ role, onSaved }: { role: Role; onSaved: () => void }) {
  const [settings, setSettings] = useState<ClinicSettings | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [logoVersion, setLogoVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const { prompt } = useUnsavedChanges(dirty);
  const zones = useMemo(timeZones, []);
  const editable = canAdministerClinic(role);

  useEffect(() => {
    const controller = new AbortController();
    api<ClinicSettings>('clinic/', { signal: controller.signal })
      .then((data) => {
        setSettings(data);
        setPrefix(data.invoice_prefix ?? 'INV');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSuccess('');
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(
      [
        'name',
        'time_zone',
        'address',
        'phone',
        'email',
        'tax_identifier',
        'currency',
        'registration_number',
        'upi_id',
        'invoice_prefix',
      ].map((key) => [key, String(form.get(key) || '').trim()]),
    );
    try {
      const saved = await api<ClinicSettings>('clinic/', { method: 'PATCH', body: JSON.stringify(body) });
      setSettings(saved);
      setPrefix(saved.invoice_prefix ?? 'INV');
      setDirty(false);
      setSuccess('Clinic settings saved.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changeLogo(file: File | null) {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const body = new FormData();
      if (file) body.append('logo', file);
      const saved = await api<ClinicSettings>('clinic/logo/', file ? { method: 'POST', body } : { method: 'DELETE' });
      setSettings((old) => (old ? { ...old, has_logo: saved.has_logo } : old));
      setLogoVersion((value) => value + 1);
      setSuccess(file ? 'Logo saved.' : 'Logo removed.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <section className="panel">
      {prompt}
      <h2>Clinic details</h2>
      <p className="muted">These details appear on printed documents and decide what the clinic calls “today”.</p>
      <ErrorMessage message={error} />
      {success && (
        <p className="success" role="status">
          {success}
        </p>
      )}
      {!settings && !error && <p role="status">Loading settings…</p>}
      {settings && (
        <form className="stack settings-form" onChangeCapture={() => setDirty(true)} onSubmit={submit}>
          <fieldset disabled={!editable || busy}>
            <div className="form-grid">
              <label>
                Clinic name
                <input name="name" defaultValue={settings.name} required maxLength={200} />
              </label>
              <label>
                Phone
                <input name="phone" type="tel" defaultValue={settings.phone} maxLength={40} />
              </label>
              <label>
                Email
                <input name="email" type="email" defaultValue={settings.email} />
              </label>
              <label className="span-2">
                Address
                <textarea name="address" defaultValue={settings.address} rows={2} maxLength={500} />
              </label>
              <label>
                GSTIN
                <input
                  name="tax_identifier"
                  defaultValue={settings.tax_identifier}
                  maxLength={60}
                  placeholder="If empty, GST is not printed"
                />
              </label>
              <label>
                Doctor registration no.
                <input
                  name="registration_number"
                  defaultValue={settings.registration_number}
                  maxLength={60}
                  placeholder="Printed on bills and prescriptions"
                />
              </label>
              <label>
                UPI ID for payments
                <input
                  name="upi_id"
                  defaultValue={settings.upi_id}
                  maxLength={80}
                  placeholder="clinicname@bank, for the scan-to-pay code"
                />
              </label>
              <label>
                Invoice number starts with
                <input
                  name="invoice_prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                  required
                  maxLength={8}
                  pattern="[A-Za-z0-9]+"
                  aria-describedby="invoice-style"
                />
              </label>
              <label>
                Time zone
                <input
                  name="time_zone"
                  defaultValue={settings.time_zone}
                  required
                  list="time-zones"
                  placeholder="Asia/Kolkata"
                />
              </label>
              <label>
                Currency code
                <input
                  name="currency"
                  defaultValue={settings.currency}
                  maxLength={3}
                  pattern="[A-Za-z]{3}"
                  placeholder="INR"
                />
              </label>
              <label>
                Financial year
                <input value="1 April to 31 March" disabled readOnly />
              </label>
              <label>
                Language
                <select defaultValue="en" aria-label="Language">
                  <option value="en">English</option>
                </select>
              </label>
            </div>
            <p className="muted" id="invoice-style">
              Bills are numbered like {prefix || 'INV'}/{financialYear(isoDay())}/0001 and start again from 0001 every 1
              April.
            </p>
            <datalist id="time-zones">
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </fieldset>
          <div className="setting">
            {settings.has_logo ? (
              <img className="logo-preview" alt="Clinic logo" src={`/api/v1/clinic/logo/?v=${logoVersion}`} />
            ) : (
              <span className="logo-preview" aria-hidden="true">
                {initials(settings.name)}
              </span>
            )}
            <div>
              <strong>Logo</strong>
              <span className="muted">
                Printed on bills, envelope labels and patient cards. JPEG or PNG, up to 1 MiB.
              </span>
            </div>
            {editable && (
              <span className="actions">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png"
                  aria-label="Logo file"
                  hidden
                  onChange={(e) => changeLogo(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  className="secondary btn-sm"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  {settings.has_logo ? 'Change' : 'Add logo'}
                </button>
                {settings.has_logo && (
                  <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => changeLogo(null)}>
                    Remove
                  </button>
                )}
              </span>
            )}
          </div>
          {editable ? (
            <div className="actions">
              <button disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
              {dirty && <span className="muted">Unsaved changes</span>}
            </div>
          ) : (
            <p className="muted">Only the clinic owner or an administrator can change these settings.</p>
          )}
        </form>
      )}
    </section>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_failed': 'Failed sign-in',
  'auth.login_denied': 'Sign-in refused: no active membership',
  'auth.select_clinic': 'Switched clinic',
  'auth.idle_timeout': 'Signed out after inactivity',
  'access.denied': 'Access refused',
  'patient.list': 'Listed patients',
  'patient.view': 'Opened patient',
  'patient.create': 'Registered patient',
  'patient.update': 'Edited patient details',
  'patient.archive': 'Archived patient',
  'patient.restore': 'Restored patient',
  'patient.timeline': 'Opened patient timeline',
  'photo.create': 'Added patient photo',
  'photo.view': 'Viewed patient photo',
  'note.list': 'Listed notes',
  'note.create': 'Added note',
  'encounter.list': 'Listed visits',
  'encounter.view': 'Opened visit',
  'encounter.create': 'Recorded visit',
  'audit.list': 'Viewed activity log',
  'clinic.update': 'Changed clinic settings',
  'clinic.switches': 'Changed a switch',
  'clinic.logo': 'Changed the clinic logo',
  'clinic.setup': 'Set up the clinic',
  'auth.account_update': 'Changed own name',
  'auth.password_changed': 'Changed own password',
  'auth.password_change_failed': 'Failed password change',
  'patient.scan': 'Scanned a patient card',
  'scan.unknown': 'Scanned an unknown code',
  'patient.duplicate_check': 'Checked for duplicate patients',
  'patient.revisions': 'Viewed change history',
  'patient.reissue_code': 'Replaced a patient card',
  'patient.consent': 'Recorded message consent',
  'patient.family_link': 'Linked a family member',
  'patient.family_unlink': 'Removed a family link',
  'patient.measurements': 'Viewed measurements',
  'patient.import': 'Imported patients',
  'patient.export': 'Exported patients',
  'document.create': 'Added a document',
  'document.list': 'Listed documents',
  'document.view': 'Viewed a document',
  'encounter.amend': 'Amended a visit',
  'visit_draft.list': 'Listed visit drafts',
  'visit_draft.save': 'Saved a visit draft',
  'visit_draft.discard': 'Discarded a visit draft',
  'prescription_set.create': 'Saved a prescription set',
  'prescription_set.delete': 'Removed a prescription set',
  'scan.product': 'Scanned a product',
  'price_item.create': 'Added a price list item',
  'price_item.update': 'Changed a price list item',
  'invoice.list': 'Listed bills',
  'invoice.view': 'Opened a bill',
  'invoice.create': 'Started a bill',
  'invoice.update': 'Edited a draft bill',
  'invoice.delete_draft': 'Deleted a draft bill',
  'invoice.issue': 'Issued a bill',
  'invoice.payment': 'Recorded a payment',
  'invoice.refund': 'Recorded a refund',
  'invoice.credit_note': 'Issued a credit note',
  'invoice.void': 'Made a bill void',
  'invoice.print': 'Printed a bill',
  'payment.list': 'Listed payments',
  'billing.summary': 'Viewed billing figures',
  'billing.day_end': 'Viewed the day-end report',
  'billing.day_close': 'Closed the day',
  'billing.export': 'Exported billing figures',
  'print_template.save': 'Changed a print layout',
  'print_job.list': 'Viewed the print queue',
  'print_job.create': 'Printed a document',
  'print.label_data': 'Prepared labels',
  'print.prescription_data': 'Prepared a prescription',
  'print.card_data': 'Prepared a patient card',
};

export function ActivityLog() {
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<AuditEvent> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<Page<AuditEvent>>(`audit-events/?page=${page}${outcome ? `&outcome=${outcome}` : ''}`, {
      signal: controller.signal,
    })
      .then(setData)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [outcome, page]);

  return (
    <>
      <div className="heading">
        <div>
          <h2>Activity log</h2>
          <p className="muted">Who opened or changed what, newest first. Record contents are never stored here.</p>
        </div>
        <label>
          Show
          <select
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All activity</option>
            <option value="failed">Failed sign-ins</option>
            <option value="denied">Refused access</option>
            <option value="success">Successful actions</option>
          </select>
        </label>
      </div>
      <ErrorMessage message={error} />
      {!data && !error && <p role="status">Loading activity log…</p>}
      {data && (
        <>
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Result</th>
                  <th>Record</th>
                  <th>From</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <time>{dateTime(event.occurred_at)}</time>
                    </td>
                    <td>{event.actor_username || '—'}</td>
                    <td>{ACTION_LABELS[event.action] || event.action}</td>
                    <td>
                      <span className={`badge outcome-${event.outcome}`}>{event.outcome}</span>
                    </td>
                    <td className="identifier">
                      {event.resource_id ? `${event.resource_type} ${event.resource_id.slice(0, 8)}` : '—'}
                    </td>
                    <td className="identifier">{event.source_ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.results.length && <p className="empty">No activity to show.</p>}
          </div>
          <div className="pagination">
            <button className="secondary" disabled={!data.previous} onClick={() => setPage(page - 1)}>
              Newer
            </button>
            <span>Page {page}</span>
            <button className="secondary" disabled={!data.next} onClick={() => setPage(page + 1)}>
              Older
            </button>
          </div>
        </>
      )}
    </>
  );
}
