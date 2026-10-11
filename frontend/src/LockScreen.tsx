import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, initializeCSRF, msSinceServerContact, setCSRF } from './api';
import { Brand, ErrorMessage } from './components';
import { Session } from './types';

const CHECK_EVERY_MS = 15_000;
const KEEP_ALIVE_AFTER_MS = 4 * 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Locks the workspace after a period without keyboard or pointer activity. While the user is
 * working (for example typing a long case), it keeps the server session alive, because typing
 * alone sends no requests.
 */
export function useIdleLock(active: boolean, timeoutSeconds: number | undefined, lock: () => void) {
  const lastActivity = useRef(Date.now());
  useEffect(() => {
    if (!active || !timeoutSeconds) return;
    lastActivity.current = Date.now();
    const touch = () => {
      lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, touch, { passive: true }));
    const timer = window.setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= timeoutSeconds * 1000) lock();
      else if (idle < CHECK_EVERY_MS * 2 && msSinceServerContact() > KEEP_ALIVE_AFTER_MS)
        api('auth/me/').catch(() => {});
    }, CHECK_EVERY_MS);
    return () => {
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, touch));
      window.clearInterval(timer);
    };
  }, [active, timeoutSeconds, lock]);
}

/** Signs the same user back in without unmounting the workspace, so drafts in memory survive. */
export function LockScreen({
  session,
  onUnlocked,
  onSwitchUser,
}: {
  session: Session;
  onUnlocked: (s: Session) => void;
  onSwitchUser: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const password = String(new FormData(event.currentTarget).get('password') || '');
    try {
      await initializeCSRF();
      let next = await api<Session>('auth/login/', {
        method: 'POST',
        body: JSON.stringify({ username: session.user.username, password }),
      });
      setCSRF(next.csrf_token);
      // Signing in selects the first clinic; return to the one that was open so drafts stay valid.
      if (next.clinic_id !== session.clinic_id && next.memberships.some((m) => m.clinic_id === session.clinic_id)) {
        next = await api<Session>('auth/clinic/', {
          method: 'POST',
          body: JSON.stringify({ clinic_id: session.clinic_id }),
        });
        setCSRF(next.csrf_token);
      }
      onUnlocked(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login lock-screen">
      <div className="brand">
        <Brand />
      </div>
      <h1>Workspace locked</h1>
      <p>
        Signed in as <strong>{session.user.name || session.user.username}</strong>. Enter your password to continue
        where you left off.
      </p>
      <form onSubmit={submit} className="panel stack">
        <ErrorMessage message={error} />
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required autoFocus />
        </label>
        <button disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      </form>
      <p className="muted">Unsaved work on the open screen is kept until you unlock or switch user.</p>
      <button type="button" className="secondary" onClick={onSwitchUser}>
        Sign in as a different user
      </button>
    </main>
  );
}
