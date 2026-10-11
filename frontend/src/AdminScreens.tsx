import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { ErrorMessage } from './components';
import { AuditEvent, ClinicSettings, Page, Role, canAdministerClinic } from './types';
import { useUnsavedChanges } from './useUnsavedChanges';

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

export function ClinicSettingsScreen({ role, onSaved }: { role: Role; onSaved: () => void }) {
  const [settings, setSettings] = useState<ClinicSettings | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { prompt } = useUnsavedChanges(dirty);
  const zones = useMemo(timeZones, []);
  const editable = canAdministerClinic(role);

  useEffect(() => {
    const controller = new AbortController();
    api<ClinicSettings>('clinic/', { signal: controller.signal })
      .then(setSettings)
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
      ['name', 'time_zone', 'address', 'phone', 'email', 'tax_identifier', 'currency'].map((key) => [
        key,
        String(form.get(key) || '').trim(),
      ]),
    );
    try {
      setSettings(await api<ClinicSettings>('clinic/', { method: 'PATCH', body: JSON.stringify(body) }));
      setDirty(false);
      setSuccess('Clinic settings saved.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {prompt}
      <h1>Clinic settings</h1>
      <p className="muted">These details appear on printed documents and decide what the clinic calls “today”.</p>
      <ErrorMessage message={error} />
      {success && (
        <p className="success" role="status">
          {success}
        </p>
      )}
      {!settings && !error && <p role="status">Loading settings…</p>}
      {settings && (
        <form className="panel stack settings-form" onChangeCapture={() => setDirty(true)} onSubmit={submit}>
          <fieldset disabled={!editable || busy}>
            <div className="form-grid">
              <label>
                Clinic name
                <input name="name" defaultValue={settings.name} required maxLength={200} />
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
                Phone
                <input name="phone" type="tel" defaultValue={settings.phone} maxLength={40} />
              </label>
              <label>
                Email
                <input name="email" type="email" defaultValue={settings.email} />
              </label>
              <label>
                Tax identifier
                <input name="tax_identifier" defaultValue={settings.tax_identifier} maxLength={60} />
              </label>
            </div>
            <label className="settings-address">
              Address
              <textarea name="address" defaultValue={settings.address} rows={3} maxLength={500} />
            </label>
            <datalist id="time-zones">
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </fieldset>
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
    </>
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
  'audit.list': 'Viewed audit log',
  'clinic.update': 'Changed clinic settings',
};

export function AuditLogScreen() {
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
          <h1>Audit log</h1>
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
      {!data && !error && <p role="status">Loading audit log…</p>}
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
                      <time>{new Date(event.occurred_at).toLocaleString()}</time>
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
