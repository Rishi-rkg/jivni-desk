import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, initializeCSRF, msSinceServerContact, setCSRF } from './api';
import { Brand, ErrorMessage } from './components';
import { Session } from './types';
import { Avatar } from './ui';

const CHECK_EVERY_MS = 15_000;
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
    // The server ends an untouched session by the same clock, so it hears from us well inside that time.
    const keepAliveAfter = Math.min(4 * 60_000, (timeoutSeconds * 1000) / 2);
    const touch = () => {
      lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, touch, { passive: true }));
    const timer = window.setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= timeoutSeconds * 1000) lock();
      else if (idle < CHECK_EVERY_MS * 2 && msSinceServerContact() > keepAliveAfter) api('auth/me/').catch(() => {});
    }, CHECK_EVERY_MS);
    return () => {
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, touch));
      window.clearInterval(timer);
    };
  }, [active, timeoutSeconds, lock]);
}

function minutes(seconds: number | undefined) {
  const count = Math.max(1, Math.round((seconds ?? 0) / 60));
  return `${count} minute${count === 1 ? '' : 's'}`;
}

/** Signs the same user back in without unmounting the workspace, so drafts in memory survive. */
export function LockScreen({
  session,
  clinicName,
  reason,
  onUnlocked,
  onSwitchUser,
}: {
  session: Session;
  clinicName: string;
  reason: 'idle' | 'manual';
  onUnlocked: (s: Session) => void;
  onSwitchUser: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const name = session.user.name || session.user.username;

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
    <main className="login lock-screen locked">
      <div className="brand">
        <Brand />
      </div>
      <div>
        <Avatar name={name} large />
      </div>
      <h1>Locked</h1>
      <p>
        <strong>{name}</strong> · {clinicName}
        <br />
        <span className="muted">
          {reason === 'manual'
            ? 'Locked. Your open work is kept.'
            : `Locked after ${minutes(session.idle_timeout_seconds)} without activity. Your open work is kept.`}
        </span>
      </p>
      <form onSubmit={submit} className="panel stack">
        <ErrorMessage message={error} />
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required autoFocus />
        </label>
        <button disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <button type="button" className="secondary" onClick={onSwitchUser}>
          Sign in as someone else
        </button>
      </form>
    </main>
  );
}
