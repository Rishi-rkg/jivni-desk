import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { ErrorMessage } from './components';
import { BackupOverview, BackupPlace, BackupRun } from './types';

const KIND_LABELS: Record<BackupPlace['kind'], string> = {
  local: 'Local or USB folder',
  nas: 'Network storage',
  cloud: 'Cloud drive folder',
};

function size(bytes: number | null) {
  if (bytes === null) return '';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : 'Never');

function placeStatus(place: BackupPlace) {
  if (!place.reachable) return 'Not reachable from this computer';
  if (place.last_error) return `Last attempt failed: ${place.last_error}`;
  return `OK · ${size(place.free_bytes)} free`;
}

function CheckCell({ run, busy, onCheck }: { run: BackupRun; busy: boolean; onCheck: () => void }) {
  if (!run.ok) return <span className="badge outcome-failed">Not saved</span>;
  return (
    <>
      {run.verified_ok === true && <span className="badge">Verified {when(run.verified_at)}</span>}
      {run.verified_ok === false && <span className="badge outcome-failed">Check failed</span>}{' '}
      <button type="button" className="secondary" disabled={busy} onClick={onCheck}>
        {run.verified_at ? 'Check again' : 'Check'}
      </button>
    </>
  );
}

export function BackupScreen() {
  const [data, setData] = useState<BackupOverview | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<BackupOverview>('backups/')
        .then(setData)
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function act(work: () => Promise<string>) {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      setSuccess(await work());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await load();
      setBusy(false);
    }
  }

  const backUpNow = () =>
    act(async () => {
      const run = await api<BackupRun>('backups/run/', { method: 'POST', body: '{}' });
      const saved = run.places.filter((place) => place.ok).length;
      return `Backup saved to ${saved} of ${run.places.length} place${run.places.length === 1 ? '' : 's'}.`;
    });

  const check = (run: BackupRun) =>
    act(async () => {
      const result = await api<{ run: BackupRun; counts: Record<string, number> | null; detail: string }>(
        `backups/runs/${run.id}/verify/`,
        { method: 'POST', body: '{}' },
      );
      if (!result.run.verified_ok) throw new Error(`This backup did not read back correctly. ${result.detail}`);
      const counts = result.counts!;
      return `The backup reads back in full: ${counts.patients} patients, ${counts.visits} visits, ${counts.files} files.`;
    });

  function addPlace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    act(async () => {
      await api('backups/places/', { method: 'POST', body: JSON.stringify(body) });
      form.reset();
      return 'Backup place added. A test file was written and read back.';
    });
  }

  const removePlace = (place: BackupPlace) => {
    if (!window.confirm(`Stop saving backups to "${place.name}"? Backup files already there are not deleted.`)) return;
    act(async () => {
      await api(`backups/places/${place.id}/`, { method: 'DELETE' });
      return 'Backup place removed.';
    });
  };

  function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      automatic: form.get('automatic') === 'on',
      frequency: form.get('frequency'),
      at: form.get('at'),
      keep_daily_days: Number(form.get('keep_daily_days')),
      keep_monthly_months: Number(form.get('keep_monthly_months')),
      warn_after_days: Number(form.get('warn_after_days')),
    };
    act(async () => {
      await api('backups/policy/', { method: 'PATCH', body: JSON.stringify(body) });
      return 'Schedule saved.';
    });
  }

  if (!data)
    return (
      <>
        <h1>Backups</h1>
        <ErrorMessage message={error} />
        {!error && <p role="status">Loading backups…</p>}
      </>
    );

  const { status, policy, places, runs } = data;
  return (
    <>
      <div className="heading">
        <div>
          <h1>Backups</h1>
          <p className="muted">
            A backup is one encrypted file holding the database and stored files. It is always encrypted with the clinic
            key, the same as the records.
          </p>
        </div>
        <button disabled={busy || !places.length} onClick={backUpNow}>
          {busy ? 'Working…' : 'Back up now'}
        </button>
      </div>
      <ErrorMessage message={error || status.problem} />
      {success && (
        <p className="success" role="status">
          {success}
        </p>
      )}
      <p className={status.overdue ? 'error' : 'muted'} role={status.overdue ? 'alert' : undefined}>
        Last successful backup: {when(status.last_ok_at)}.
        {status.overdue && ` No backup has succeeded in the last ${policy.warn_after_days} days.`}
      </p>

      <section className="panel">
        <h2>Where backups are saved</h2>
        {!places.length && <p className="muted">No place yet. Add a folder below to start backing up.</p>}
        {places.map((place) => (
          <div className="directory-row" key={place.id}>
            <span>
              <strong>{place.name}</strong>
              <span className="muted">
                {KIND_LABELS[place.kind]} · <span className="identifier">{place.folder}</span>
              </span>
              <span className={place.reachable && !place.last_error ? 'muted' : 'backup-problem'}>
                {placeStatus(place)}
              </span>
            </span>
            <button type="button" className="secondary" disabled={busy} onClick={() => removePlace(place)}>
              Remove {place.name}
            </button>
          </div>
        ))}
        <form className="stack backup-add" onSubmit={addPlace}>
          <div className="form-grid">
            <label>
              Kind
              <select name="kind" defaultValue="local">
                {Object.entries(KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input name="name" required maxLength={80} placeholder="Clinic NAS" />
            </label>
            <label>
              Folder
              <input name="folder" required maxLength={500} placeholder="D:\Jivni-Backups" />
            </label>
          </div>
          <div className="actions">
            <button className="secondary" disabled={busy}>
              Add a place
            </button>
            <span className="muted">
              Any folder this computer can open works: a local or USB drive, a NAS share, or a cloud drive that appears
              as a folder. Keep at least one place that is not this computer.
            </span>
          </div>
        </form>
      </section>

      <section className="panel table-wrap">
        <h2 className="table-title">Backups made</h2>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>Size</th>
              <th>Saved to</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{when(run.finished_at || run.started_at)}</td>
                <td>{run.kind === 'automatic' ? 'Automatic' : 'Manual'}</td>
                <td>{run.ok ? size(run.byte_size) : '—'}</td>
                <td>
                  {run.places.map((place) => (
                    <div key={place.place} className={place.ok ? '' : 'backup-problem'}>
                      {place.name}
                      {!place.ok && ' (missed)'}
                    </div>
                  ))}
                </td>
                <td>
                  <CheckCell run={run} busy={busy} onCheck={() => check(run)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!runs.length && <p className="empty">No backups yet.</p>}
      </section>

      <form className="panel stack" onSubmit={savePolicy} key={JSON.stringify(policy)}>
        <h2>Schedule</h2>
        <label className="check">
          <input type="checkbox" name="automatic" defaultChecked={policy.automatic} />
          Back up automatically
        </label>
        <div className="form-grid">
          <label>
            How often
            <select name="frequency" defaultValue={policy.frequency}>
              <option value="daily">Every day</option>
              <option value="twice_daily">Twice a day</option>
              <option value="weekly">Every week</option>
            </select>
          </label>
          <label>
            At
            <input name="at" type="time" defaultValue={policy.at.slice(0, 5)} required />
          </label>
          <label>
            Keep daily backups for
            <select name="keep_daily_days" defaultValue={policy.keep_daily_days}>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
          <label>
            Keep monthly backups for
            <select name="keep_monthly_months" defaultValue={policy.keep_monthly_months}>
              <option value="12">12 months</option>
              <option value="0">Forever</option>
            </select>
          </label>
          <label>
            Warn when no backup has succeeded for
            <select name="warn_after_days" defaultValue={policy.warn_after_days}>
              <option value="1">1 day</option>
              <option value="2">2 days</option>
              <option value="7">7 days</option>
            </select>
          </label>
        </div>
        <div className="actions">
          <button disabled={busy}>Save schedule</button>
          <span className="muted">
            Automatic backups run while the application is running. Until the installer is built, they are started by
            the computer&apos;s own scheduler.
          </span>
        </div>
      </form>

      <section className="panel">
        <h2>Restoring</h2>
        <p>
          To restore on a new computer you need a backup file and an owner or staff password, or the recovery key.
          Without one of those the backup cannot be opened by anyone.
        </p>
        <p className="muted">
          Restoring is done into a new, empty installation. Use “Check” above at any time to prove a backup reads back
          in full; it changes nothing.
        </p>
      </section>
    </>
  );
}
