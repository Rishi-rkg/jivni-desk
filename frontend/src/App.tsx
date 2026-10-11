import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, initializeCSRF, setCSRF, setUnauthorizedHandler } from './api';
import {
  Membership,
  Page,
  Patient,
  Role,
  Session,
  canAdministerClinic,
  canWriteDemographics,
  displayName,
} from './types';
import { NewPatient, PatientProfile, NewEncounter } from './PatientScreens';
import { ErrorMessage } from './components';
import { Dashboard, BillingPlaceholder } from './WorkspaceScreens';
import { DraftStateContext } from './useUnsavedChanges';
import { AuditLogScreen, ClinicSettingsScreen } from './AdminScreens';
import { LockScreen, useIdleLock } from './LockScreen';

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      await initializeCSRF();
      const session = await api<Session>('auth/login/', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(data)),
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
      <div className="brand">CLINIC RECORDS</div>
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
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="muted">An administrator must create your account and clinic membership.</p>
    </main>
  );
}

function PatientList({ role }: { role: Role }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const search = params.get('search') || '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  function setPage(value: number) {
    setParams({ ...(search ? { search } : {}), page: String(value) });
  }
  const [data, setData] = useState<Page<Patient> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const timer = setTimeout(() => {
      api<Page<Patient>>(`patients/?search=${encodeURIComponent(search)}&page=${page}`, { signal: controller.signal })
        .then(setData)
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, page]);
  return (
    <>
      <div className="heading">
        <div>
          <h1>Patients</h1>
          <p className="muted">Find a record or register a new patient.</p>
        </div>
        {canWriteDemographics(role) && (
          <Link className="button" to="/patients/new">
            New patient
          </Link>
        )}
      </div>
      <label className="search">
        Search patients
        <input
          type="search"
          value={search}
          onChange={(e) => setParams(e.target.value ? { search: e.target.value } : {}, { replace: true })}
          placeholder="Name, phone, or patient ID"
        />
      </label>
      <ErrorMessage message={error} />
      {busy ? (
        <p role="status">Loading patients…</p>
      ) : (
        data &&
        !error && (
          <>
            <p className="muted">
              {data.count} patient{data.count !== 1 ? 's' : ''}
            </p>
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Date of birth</th>
                    <th>Phone</th>
                    <th>Patient ID</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link state={{ returnTo: location.pathname + location.search }} to={`/patients/${p.id}`}>
                          {displayName(p)}
                        </Link>
                      </td>
                      <td>{p.date_of_birth}</td>
                      <td>{p.phone || '—'}</td>
                      <td className="identifier">{p.identifier || p.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.results.length && <p className="empty">No patients found.</p>}
            </div>
            <div className="pagination">
              <button className="secondary" disabled={!data.previous} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>Page {page}</span>
              <button className="secondary" disabled={!data.next} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          </>
        )
      )}
    </>
  );
}

function PlannedModules() {
  const modules = [
    'Billing',
    'WhatsApp correspondence',
    'Medicine knowledge library',
    'Printing',
    'Barcode scanning',
    'AI drafting',
  ];
  return (
    <>
      <h1>More clinic tools</h1>
      <p>Upcoming tools will connect to the same patient record.</p>
      <div className="module-grid">
        {modules.map((name) => (
          <article className="panel" key={name}>
            <span className="badge">Planned</span>
            <h2>{name}</h2>
            <p className="muted">Not available yet.</p>
          </article>
        ))}
      </div>
    </>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [locked, setLocked] = useState(false);
  const navigate = useNavigate();
  // The server ended the session (401): cover the workspace but keep it mounted so drafts survive.
  useEffect(() => {
    setUnauthorizedHandler(() => setLocked(true));
    return () => setUnauthorizedHandler(null);
  }, []);
  // No keyboard or pointer activity: lock here and end the server session too.
  const lockForInactivity = useCallback(() => {
    setLocked(true);
    api('auth/logout/', { method: 'POST', body: '{}' }).catch(() => {});
  }, []);
  useIdleLock(!!session && !locked, session?.idle_timeout_seconds, lockForInactivity);
  const refreshSession = useCallback(() => {
    api<Session>('auth/me/')
      .then((s) => {
        setCSRF(s.csrf_token);
        setSession(s);
      })
      .catch(() => {});
  }, []);
  function switchUser() {
    if (
      draftDirty &&
      !window.confirm('Sign in as someone else? Unsaved changes on the locked screen will be discarded.')
    )
      return;
    setLocked(false);
    setSession(null);
    navigate('/');
  }
  useEffect(() => {
    api<Session>('auth/me/')
      .then((s) => {
        setCSRF(s.csrf_token);
        setSession(s);
      })
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) setError(e.message);
      })
      .finally(() => setLoading(false));
  }, []);
  async function logout() {
    if (draftDirty && !window.confirm('Sign out without saving? Your unsaved changes will be discarded.')) return;
    try {
      await api('auth/logout/', { method: 'POST', body: '{}' });
      setSession(null);
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function switchClinic(clinicId: string) {
    if (draftDirty && !window.confirm('Switch clinics without saving? Your unsaved changes will be discarded.')) return;
    setSwitching(true);
    setError('');
    try {
      const s = await api<Session>('auth/clinic/', { method: 'POST', body: JSON.stringify({ clinic_id: clinicId }) });
      setSession(s);
      setCSRF(s.csrf_token);
      navigate('/patients');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  }
  if (loading)
    return (
      <main className="login">
        <p role="status">Opening clinic…</p>
      </main>
    );
  if (!session)
    return (
      <>
        <ErrorMessage message={error} />
        <Login
          onLogin={(s) => {
            setError('');
            setSession(s);
          }}
        />
        <div className="dev-warning">Development build · Use synthetic patient data only</div>
      </>
    );
  const member: Membership | undefined = session.memberships.find((m) => m.clinic_id === session.clinic_id);
  if (!member)
    return (
      <main>
        <ErrorMessage message="Your clinic membership is no longer available. Sign out and contact your administrator." />
        <button onClick={logout}>Sign out</button>
      </main>
    );
  return (
    <DraftStateContext.Provider value={setDraftDirty}>
      {locked && (
        <LockScreen
          session={session}
          onUnlocked={(s) => {
            setSession(s);
            setLocked(false);
            setError('');
          }}
          onSwitchUser={switchUser}
        />
      )}
      <div hidden={locked}>
        <header className="workspace-header">
          <Link className="brand" to="/dashboard">
            CLINIC RECORDS
          </Link>
          <div className="account">
            {session.memberships.length > 1 ? (
              <label>
                Clinic
                <select
                  aria-label="Active clinic"
                  value={session.clinic_id}
                  disabled={switching}
                  onChange={(e) => switchClinic(e.target.value)}
                >
                  {session.memberships.map((m) => (
                    <option key={m.clinic_id} value={m.clinic_id}>
                      {m.clinic_name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span>{member.clinic_name}</span>
            )}
            <span className="muted">
              {session.user.name || session.user.username} · {member.role}
            </span>
            <button className="secondary" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>
        <nav className="workspace-tabs" aria-label="Clinic workspace">
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/patients">Patients</NavLink>
          <NavLink to="/billing">
            Billing <span className="planned-label">Planned</span>
          </NavLink>
          <NavLink to="/modules">More tools</NavLink>
          <NavLink to="/settings">Clinic settings</NavLink>
          {canAdministerClinic(member.role) && <NavLink to="/audit">Audit log</NavLink>}
        </nav>
        <div className="dev-warning">Development build · Use synthetic patient data only</div>
        <main className="content">
          <ErrorMessage message={error} />
          {switching ? (
            <p role="status">Switching clinic…</p>
          ) : (
            <Routes key={session.clinic_id}>
              <Route path="/patients" element={<PatientList role={member.role} />} />
              <Route path="/dashboard" element={<Dashboard role={member.role} />} />
              <Route
                path="/billing"
                element={
                  <>
                    <h1>Billing</h1>
                    <BillingPlaceholder />
                  </>
                }
              />
              <Route
                path="/patients/new"
                element={canWriteDemographics(member.role) ? <NewPatient /> : <Navigate to="/patients" replace />}
              />
              <Route path="/patients/:id" element={<PatientProfile role={member.role} />} />
              <Route path="/patients/:id/encounters/new" element={<NewEncounter role={member.role} />} />
              <Route path="/modules" element={<PlannedModules />} />
              <Route path="/settings" element={<ClinicSettingsScreen role={member.role} onSaved={refreshSession} />} />
              <Route
                path="/audit"
                element={canAdministerClinic(member.role) ? <AuditLogScreen /> : <Navigate to="/dashboard" replace />}
              />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          )}
        </main>
      </div>
    </DraftStateContext.Provider>
  );
}
