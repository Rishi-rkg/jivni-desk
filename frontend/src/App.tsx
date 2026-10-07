import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError, initializeCSRF, setCSRF } from './api';
import { Membership, Page, Patient, Role, Session, canWriteDemographics, displayName } from './types';
import { NewPatient, PatientProfile, NewEncounter } from './PatientScreens';
import { ErrorMessage } from './components';

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      await initializeCSRF();
      const session = await api<Session>('auth/login/', { method: 'POST', body: JSON.stringify(Object.fromEntries(data)) });
      setCSRF(session.csrf_token); onLogin(session);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="login"><div className="brand">CLINIC RECORDS</div><h1>Sign in to your clinic</h1><p>Patient records and clinical history in one place.</p>
    <form onSubmit={submit} className="panel stack"><ErrorMessage message={error}/>
      <label>Username<input name="username" autoComplete="username" required maxLength={150}/></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required/></label>
      <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form><p className="muted">An administrator must create your account and clinic membership.</p></main>;
}

function PatientList({ role }: { role: Role }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<Patient> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    const timer = setTimeout(() => {
      api<Page<Patient>>(`patients/?search=${encodeURIComponent(search)}&page=${page}`, { signal: controller.signal })
        .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, page]);
  return <><div className="heading"><div><h1>Patients</h1><p className="muted">Find a record or register a new patient.</p></div>{canWriteDemographics(role) && <Link className="button" to="/patients/new">New patient</Link>}</div>
    <label className="search">Search patients<input type="search" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Name, phone, or patient ID"/></label>
    <ErrorMessage message={error}/>{busy ? <p role="status">Loading patients…</p> : data && !error && <>
      <p className="muted">{data.count} patient{data.count !== 1 ? 's' : ''}</p>
      <div className="panel table-wrap"><table><thead><tr><th>Name</th><th>Date of birth</th><th>Phone</th><th>Patient ID</th></tr></thead><tbody>
        {data.results.map(p => <tr key={p.id}><td><Link to={`/patients/${p.id}`}>{displayName(p)}</Link></td><td>{p.date_of_birth}</td><td>{p.phone || '—'}</td><td className="identifier">{p.id}</td></tr>)}
      </tbody></table>{!data.results.length && <p className="empty">No patients found.</p>}</div>
      <div className="pagination"><button className="secondary" disabled={!data.previous} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page}</span><button className="secondary" disabled={!data.next} onClick={() => setPage(page + 1)}>Next</button></div>
    </>}</>;
}

function PlannedModules() {
  const modules = ['Billing', 'WhatsApp correspondence', 'Medicine knowledge library', 'Printing', 'Barcode scanning', 'AI drafting'];
  return <><h1>Planned modules</h1><p>These modules have separate backend interfaces. Providers and workflows will be added in later milestones.</p><div className="module-grid">{modules.map(name => <article className="panel" key={name}><span className="badge">Planned</span><h2>{name}</h2><p className="muted">Not enabled in this release.</p></article>)}</div></>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    api<Session>('auth/me/').then(s => { setCSRF(s.csrf_token); setSession(s); })
      .catch(e => { if (!(e instanceof ApiError && e.status === 401)) setError(e.message); })
      .finally(() => setLoading(false));
  }, []);
  async function logout() {
    try { await api('auth/logout/', { method: 'POST', body: '{}' }); setSession(null); navigate('/'); }
    catch (e) { setError((e as Error).message); }
  }
  async function switchClinic(clinicId: string) {
    setSwitching(true); setError('');
    try {
      const s = await api<Session>('auth/clinic/', { method: 'POST', body: JSON.stringify({ clinic_id: clinicId }) });
      setSession(s); setCSRF(s.csrf_token); navigate('/patients');
    } catch (e) { setError((e as Error).message); }
    finally { setSwitching(false); }
  }
  if (loading) return <main className="login"><p role="status">Opening clinic…</p></main>;
  if (!session) return <><ErrorMessage message={error}/><Login onLogin={s => { setError(''); setSession(s); }}/><div className="dev-warning">Development build · Use synthetic patient data only</div></>;
  const member: Membership | undefined = session.memberships.find(m => m.clinic_id === session.clinic_id);
  if (!member) return <main><ErrorMessage message="Your clinic membership is no longer available. Sign out and contact your administrator."/><button onClick={logout}>Sign out</button></main>;
  return <><header><Link className="brand" to="/patients">CLINIC RECORDS</Link><nav><Link to="/patients">Patients</Link><Link to="/modules">Modules</Link></nav><div className="account">
    {session.memberships.length > 1 ? <label>Clinic<select aria-label="Active clinic" value={session.clinic_id} disabled={switching} onChange={e => switchClinic(e.target.value)}>{session.memberships.map(m => <option key={m.clinic_id} value={m.clinic_id}>{m.clinic_name}</option>)}</select></label> : <span>{member.clinic_name}</span>}
    <span className="muted">{session.user.name || session.user.username} · {member.role}</span><button className="secondary" onClick={logout}>Sign out</button>
  </div></header><div className="dev-warning">Development build · Use synthetic patient data only</div><main className="content"><ErrorMessage message={error}/>
    {switching ? <p role="status">Switching clinic…</p> : <Routes key={session.clinic_id}>
      <Route path="/patients" element={<PatientList role={member.role}/>}/>
      <Route path="/patients/new" element={canWriteDemographics(member.role) ? <NewPatient/> : <Navigate to="/patients" replace/>}/>
      <Route path="/patients/:id" element={<PatientProfile role={member.role}/>}/>
      <Route path="/patients/:id/encounters/new" element={<NewEncounter role={member.role}/>}/>
      <Route path="/modules" element={<PlannedModules/>}/>
      <Route path="*" element={<Navigate to="/patients" replace/>}/>
    </Routes>}
  </main></>;
}
