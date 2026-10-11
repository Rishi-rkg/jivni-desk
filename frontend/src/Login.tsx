import { FormEvent, useState } from 'react';
import { api, initializeCSRF, setCSRF } from './api';
import { Brand, ErrorMessage } from './components';
import { UseRecoveryKey, asksForCode } from './SignInSteps';
import { Session } from './types';
import { Modal } from './ui';

/** Sign in. The password also opens the clinic's encrypted records. */
export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Set once the server has asked for the code from the authenticator app.
  const [needsCode, setNeedsCode] = useState(false);
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
          ...(data.get('code') ? { code: data.get('code') } : {}),
          ...(data.get('shared_computer') ? { shared_computer: true } : {}),
        }),
      });
      setCSRF(session.csrf_token);
      onLogin(session);
    } catch (e) {
      // The first time a code is asked for is a next step, not a mistake.
      if (asksForCode(e) && !needsCode) setNeedsCode(true);
      else setError((e as Error).message);
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
        {needsCode && (
          <label>
            6-digit code from your authenticator app
            <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required autoFocus />
          </label>
        )}
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
            Lost the phone with your authenticator app? The owner can take two-step sign-in off for you in the same
            place. If the owner&apos;s own password is lost, “Use recovery key” is the only way back in.
          </p>
        </Modal>
      )}
      {help === 'recovery' && <UseRecoveryKey onClose={() => setHelp('')} />}
    </main>
  );
}
