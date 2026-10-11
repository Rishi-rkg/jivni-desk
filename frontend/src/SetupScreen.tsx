import { FormEvent, useState } from 'react';
import { api, initializeCSRF, setCSRF } from './api';
import { ErrorMessage } from './components';
import { Session } from './types';

type SetupResult = Session & { recovery_key: string };

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

/**
 * First run of a new installation: name the clinic, create the owner, and receive the recovery key.
 * Encryption is switched on as part of this; there is nothing to choose.
 */
export function SetupScreen({ onDone }: { onDone: (session: Session) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [written, setWritten] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) || '');
    if (text('password') !== text('password_again')) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await initializeCSRF();
      const created = await api<SetupResult>('auth/setup/', {
        method: 'POST',
        body: JSON.stringify({
          clinic_name: text('clinic_name'),
          full_name: text('full_name'),
          username: text('username'),
          password: text('password'),
          time_zone: text('time_zone'),
        }),
      });
      setCSRF(created.csrf_token);
      setResult(created);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    // Kept in memory only for as long as this screen is open; it is not stored and cannot be shown again.
    const { recovery_key: recoveryKey, ...session } = result;
    return (
      <main className="login setup">
        <div className="brand">CLINIC RECORDS</div>
        <h1>Write down your recovery key</h1>
        <p>
          Your clinic&apos;s records are now encrypted. They open with a staff password. If every password is ever lost,
          this key is the only way back in.
        </p>
        <p className="recovery-key" aria-label="Recovery key">
          {recoveryKey}
        </p>
        <ul className="setup-points">
          <li>Write it on paper and keep it somewhere safe, such as a locked drawer or a safe.</li>
          <li>Do not keep it on this computer or with your backup drives.</li>
          <li>It is shown only now. Nobody, including the makers of this application, can show it again.</li>
          <li>Anyone who has it can open the clinic&apos;s records.</li>
        </ul>
        <button type="button" className="secondary" onClick={() => window.print()}>
          Print this page
        </button>
        <label className="check">
          <input type="checkbox" checked={written} onChange={(e) => setWritten(e.target.checked)} />I have written the
          recovery key down and put it somewhere safe
        </label>
        <button disabled={!written} onClick={() => onDone(session)}>
          Continue to the clinic
        </button>
      </main>
    );
  }

  return (
    <main className="login setup">
      <div className="brand">CLINIC RECORDS</div>
      <h1>Set up your clinic</h1>
      <p>This is a new installation. Create the clinic and its owner account. Records are encrypted from the start.</p>
      <form onSubmit={submit} className="panel stack">
        <ErrorMessage message={error} />
        <label>
          Clinic name
          <input name="clinic_name" required maxLength={200} autoFocus />
        </label>
        <label>
          Your name
          <input name="full_name" maxLength={150} autoComplete="name" />
        </label>
        <label>
          Username
          <input name="username" required maxLength={150} autoComplete="username" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            aria-describedby="password-hint"
          />
        </label>
        <p className="muted" id="password-hint">
          At least 12 characters. This password also unlocks the clinic&apos;s records.
        </p>
        <label>
          Password again
          <input name="password_again" type="password" required minLength={12} autoComplete="new-password" />
        </label>
        <label>
          Time zone
          <input name="time_zone" required defaultValue={browserTimeZone()} />
        </label>
        <button disabled={busy}>{busy ? 'Setting up…' : 'Create clinic'}</button>
      </form>
    </main>
  );
}
