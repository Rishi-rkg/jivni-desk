/** What can stand between a password and the workspace: a one-time password to replace, two-step sign-in, the recovery key. */
import { FormEvent, ReactNode, useState } from 'react';
import { ApiError, api, initializeCSRF, setCSRF } from './api';
import { QrCode } from './codes';
import { Brand, ErrorMessage } from './components';
import { Session } from './types';
import { Modal, notify } from './ui';

/** True when the server answered a sign-in by asking for the code from the authenticator app. */
export const asksForCode = (error: unknown) =>
  error instanceof ApiError && !!(error.data as { two_step?: boolean } | undefined)?.two_step;

/** W11: something secret that is shown this one time, such as a recovery key or a one-time password. */
export function ShowOnce({
  title,
  label,
  value,
  confirm = 'I have written it down',
  children,
  onClose,
}: {
  title: string;
  label: string;
  value: string;
  confirm?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const [kept, setKept] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      notify('Copied. Paste it somewhere safe, then clear the clipboard.');
    } catch {
      notify('Copying is not allowed here. Write it down instead.', { kind: 'failed' });
    }
  }
  return (
    <Modal
      title={title}
      alert
      onClose={() => kept && onClose()}
      footer={
        <>
          <button type="button" className="secondary" onClick={copy}>
            Copy
          </button>
          <button type="button" disabled={!kept} onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="stack">
        {children}
        <p className="recovery-key" aria-label={label}>
          {value}
        </p>
        <p className="small muted">
          This is the only time it is shown. It is not kept anywhere it could be read again.
        </p>
        <label className="check">
          <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
          {confirm}
        </label>
      </div>
    </Modal>
  );
}

/** Sets up an authenticator app: the password again, a QR code to scan, and a first code typed back. */
export function TwoStepSetup({ onDone, onCancel }: { onDone: (session: Session) => void; onCancel?: () => void }) {
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!setup)
        setSetup(
          await api<{ secret: string; uri: string }>('auth/two-step/start/', {
            method: 'POST',
            body: JSON.stringify({ password }),
          }),
        );
      else {
        const session = await api<Session>('auth/two-step/confirm/', {
          method: 'POST',
          body: JSON.stringify({ password, code }),
        });
        notify('Two-step sign-in is on.');
        onDone(session);
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  return (
    <form className="stack" onSubmit={submit}>
      <ErrorMessage message={error} />
      {!setup ? (
        <>
          <p>
            After your password, sign-in will ask for a 6-digit code from an authenticator app on your phone, such as
            Google Authenticator, Microsoft Authenticator or Aegis. Someone who learns your password still cannot sign
            in without your phone.
          </p>
          <label>
            Your password
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <p>
            <strong>1.</strong> Open the authenticator app and scan this code, or type the letters under it.
          </p>
          <div className="two-step-code">
            <QrCode text={setup.uri} className="qr" label="Code for the authenticator app" />
            <p className="mono" aria-label="Secret for the authenticator app">
              {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
            </p>
          </div>
          <label>
            <span>
              <strong>2.</strong> Type the 6-digit code the app now shows
            </span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        </>
      )}
      <div className="actions">
        <button disabled={busy || (setup ? code.replace(/\D/g, '').length !== 6 : !password)}>
          {setup ? 'Turn on two-step sign-in' : 'Continue'}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Shown instead of the workspace until every step the server is waiting for has been finished. */
export function FinishSignIn({
  session,
  onDone,
  onSignOut,
}: {
  session: Session;
  onDone: (session: Session) => void;
  onSignOut: () => void;
}) {
  const step = session.pending?.[0];
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function choosePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError('');
    if (data.get('new_password') !== data.get('new_password_again'))
      return setError('The two new passwords are not the same.');
    setBusy(true);
    try {
      const result = await api<{ csrf_token: string }>('auth/password/', {
        method: 'POST',
        body: JSON.stringify({
          current_password: data.get('current_password'),
          new_password: data.get('new_password'),
        }),
      });
      setCSRF(result.csrf_token);
      notify('Password chosen.');
      onDone(await api<Session>('auth/me/'));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">
        <Brand />
      </div>
      {step === 'password' ? (
        <>
          <h1>Choose your own password</h1>
          <p>
            You signed in with a one-time password. Choose your own before anything else opens. It also unlocks the
            clinic’s records, so make it long and keep it to yourself.
          </p>
          <form className="panel stack" onSubmit={choosePassword}>
            <ErrorMessage message={error} />
            <label>
              One-time password
              <input name="current_password" type="password" autoComplete="current-password" required autoFocus />
            </label>
            <label>
              New password
              <input name="new_password" type="password" autoComplete="new-password" required minLength={12} />
            </label>
            <label>
              New password again
              <input name="new_password_again" type="password" autoComplete="new-password" required minLength={12} />
            </label>
            <p className="small muted">At least 12 characters. A few unrelated words work well.</p>
            <button disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</button>
          </form>
        </>
      ) : (
        <>
          <h1>Set up two-step sign-in</h1>
          <p>Your clinic asks owners and doctors to use two-step sign-in. It takes a minute and is done once.</p>
          <div className="panel">
            <TwoStepSetup onDone={onDone} />
          </div>
        </>
      )}
      <p className="muted small">
        Signed in as {session.user.name || session.user.username}.{' '}
        <button type="button" className="link-button" onClick={onSignOut}>
          Sign out
        </button>
      </p>
    </main>
  );
}

/** "Use recovery key" on the sign-in page: the owner sets a new password with the key written down at setup. */
export function UseRecoveryKey({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ clinic: string; recovery_key: string }[] | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError('');
    if (data.get('new_password') !== data.get('new_password_again'))
      return setError('The two new passwords are not the same.');
    setBusy(true);
    try {
      await initializeCSRF();
      const result = await api<{ recovery_keys: { clinic: string; recovery_key: string }[] }>('auth/recover/', {
        method: 'POST',
        body: JSON.stringify({
          username: data.get('username'),
          recovery_key: data.get('recovery_key'),
          new_password: data.get('new_password'),
        }),
      });
      setFresh(result.recovery_keys);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  if (fresh)
    return (
      <ShowOnce
        title="Write down the new recovery key"
        label="New recovery key"
        value={fresh.map((item) => item.recovery_key).join('\n')}
        onClose={() => {
          notify('Password reset. Sign in with the new password.');
          onClose();
        }}
      >
        <p>
          The password is reset. The recovery key you just used is spent, so here is the new one for{' '}
          {fresh.map((item) => item.clinic).join(' and ')}. Write it down and keep it where the old one was.
        </p>
      </ShowOnce>
    );
  return (
    <Modal
      title="Use the recovery key"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="recover-form" disabled={busy}>
            {busy ? 'Checking…' : 'Reset the owner’s password'}
          </button>
        </>
      }
    >
      <form id="recover-form" className="stack" onSubmit={submit}>
        <p>
          For a clinic owner whose password is lost. The recovery key was shown once, when the clinic was set up or the
          key was last replaced. It sets a new password and opens the records again.
        </p>
        <ErrorMessage message={error} />
        <label>
          Owner’s username
          <input name="username" autoComplete="username" required maxLength={150} data-autofocus />
        </label>
        <label>
          Recovery key
          <input name="recovery_key" required autoComplete="off" spellCheck={false} placeholder="Ten groups of four" />
        </label>
        <label>
          New password
          <input name="new_password" type="password" autoComplete="new-password" required minLength={12} />
        </label>
        <label>
          New password again
          <input name="new_password_again" type="password" autoComplete="new-password" required minLength={12} />
        </label>
        <p className="small muted">
          Afterwards the owner is signed out everywhere, two-step sign-in is set up again, and a new recovery key
          replaces this one.
        </p>
      </form>
    </Modal>
  );
}
