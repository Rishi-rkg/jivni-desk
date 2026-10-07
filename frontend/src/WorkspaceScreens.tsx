import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from './api';
import { ErrorMessage } from './components';
import { Page, Patient, Role, canWriteDemographics, displayName } from './types';

export function Dashboard({ role }: { role: Role }) {
  const navigate = useNavigate();
  const [data, setData] = useState<Page<Patient> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<Page<Patient>>('patients/', { signal: controller.signal }).then(setData)
      .catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, []);
  function findPatient(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    navigate(`/patients?search=${encodeURIComponent(String(new FormData(e.currentTarget).get('search') || ''))}`);
  }
  return <><div className="heading"><div><h1>Dashboard</h1><p className="muted">Start with a patient, then continue their visit.</p></div><time>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</time></div>
    <section className="panel"><h2>Find a patient</h2><form className="quick-search" onSubmit={findPatient}><label>Name, phone, or patient ID<input name="search" type="search" autoFocus/></label><button>Find patient</button></form></section>
    <div className="dashboard-grid"><section className="panel"><div className="heading"><h2>Patient directory</h2><Link to="/patients">View all{data ? ` (${data.count})` : ''}</Link></div><ErrorMessage message={error}/>
      {!data && !error && <p role="status">Loading patients…</p>}
      {data && <>{data.results.slice(0, 5).map(p => <Link className="directory-row" key={p.id} to={`/patients/${p.id}`}><span><strong>{displayName(p)}</strong><span className="muted">Born {p.date_of_birth}</span></span><span>Open record →</span></Link>)}{!data.count && <p className="muted">Register your first patient to begin.</p>}</>}
    </section><section className="panel"><h2>Clinic tasks</h2>{canWriteDemographics(role) && <Link className="task-link" to="/patients/new"><strong>Register a patient</strong><span className="muted">Create the record, then start a visit.</span></Link>}<Link className="task-link" to="/patients"><strong>Continue a patient’s care</strong><span className="muted">Review visits, prescriptions and notes.</span></Link><Link className="task-link" to="/billing"><strong>Billing</strong><span className="muted">Planned · Invoices and payments</span></Link><p className="muted">Appointments and daily queues will appear here when scheduling is available.</p></section></div>
  </>;
}

export function BillingPlaceholder({ patientName }: { patientName?: string }) {
  return <section className="panel placeholder"><span className="badge">Planned</span><h2>{patientName ? `Billing for ${patientName}` : 'Billing'}</h2><p>Invoices and payments are not available yet.</p><p className="muted">When enabled, each invoice will stay linked to the patient and the visit. You’ll be able to move between the clinical record and its billing history without finding the patient again.</p>{!patientName && <Link to="/patients">Find a patient →</Link>}</section>;
}
