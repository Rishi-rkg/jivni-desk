import { FormEvent, useState } from 'react';
import { api, initializeCSRF, setCSRF } from './api';
import { Brand, ErrorMessage } from './components';
import { Session } from './types';
import { Modal } from './ui';

/** Sign in. The password also opens the clinic's encrypted records. */
export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState<'' | 'forgot' | 'recovery'>('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      await initializeCSRF();
      const session = await api<Session>('auth/login/', {
        method: 'POST',
        body: JSON.stringify({
          username: data.get('username'),
          password: data.get('password'),
          ...(data.get('shared_computer') ? { shared_computer: true } : {}),
        }),
      });
      setCSRF(session.csrf_token);
      onLogin(session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">
        <Brand />
      </div>
      <h1>Sign in to your clinic</h1>
      <p>Patient records and clinical history in one place.</p>
      <form onSubmit={submit} className="panel stack">
        <ErrorMessage message={error} />
        <label>
          Username
          <input name="username" autoComplete="username" required maxLength={150} />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <label className="check">
          <input name="shared_computer" type="checkbox" />
          This is a shared computer (lock sooner)
        </label>
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="muted small">
        Your password also unlocks the clinic&apos;s encrypted records.{' '}
        <button type="button" className="link-button" onClick={() => setHelp('forgot')}>
          Forgot password
        </button>{' '}
        ·{' '}
        <button type="button" className="link-button" onClick={() => setHelp('recovery')}>
          Use recovery key
        </button>
      </p>
      {help === 'forgot' && (
        <Modal
          title="Forgot your password?"
          onClose={() => setHelp('')}
          footer={<button onClick={() => setHelp('')}>Close</button>}
        >
          <p>
            Ask the clinic owner to reset it: Settings, then Users and roles, then Manage, then Reset password. You will
            be given a one-time password and asked to choose your own.
          </p>
          <p className="muted">
            If the owner&apos;s own password is lost, the clinic&apos;s recovery key is the only way back in.
          </p>
        </Modal>
      )}
      {help === 'recovery' && (
        <Modal
          title="Using the recovery key"
          onClose={() => setHelp('')}
          footer={<button onClick={() => setHelp('')}>Close</button>}
        >
          <p>
            The recovery key was shown once, when the clinic was set up. With it the owner can set a new password and
            open the records again.
          </p>
          <p className="muted">
            Keep the paper copy to hand and ask whoever looks after the clinic&apos;s computer to run the recovery step
            on it. It asks for the key and a new password.
          </p>
        </Modal>
      )}
    </main>
  );
}
