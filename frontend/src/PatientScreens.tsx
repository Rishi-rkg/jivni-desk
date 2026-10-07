import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { ErrorMessage } from './components';
import { Encounter, Note, Observation, Page, Patient, PrescriptionItem, Role, canReadClinical, canWriteClinical, canWriteDemographics, displayName } from './types';

export function NewPatient() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasAddress, setHasAddress] = useState(false);
  const navigate = useNavigate();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const get = (key: string) => String(form.get(key) || '').trim();
    const patientData = { first_name: get('first_name'), middle_name: get('middle_name'), last_name: get('last_name'), date_of_birth: get('date_of_birth'), gender: get('gender'), phone: get('phone'), email: get('email'),
      ...(hasAddress ? { address: Object.fromEntries(['line1', 'line2', 'city', 'region', 'postal_code', 'country'].map(key => [key, get(key)])) } : {}) };
    try {
      const patient = await api<Patient>('patients/', { method: 'POST', body: JSON.stringify(patientData) });
      navigate(`/patients/${patient.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <><Link to="/patients">← Patients</Link><h1>New patient</h1><p className="muted">A permanent patient ID is assigned when you save.</p><form className="panel stack" onSubmit={submit}><ErrorMessage message={error}/>
    <fieldset><legend>Demographics</legend><div className="form-grid"><label>First name<input name="first_name" required maxLength={100}/></label><label>Middle name<input name="middle_name" maxLength={100}/></label><label>Last name<input name="last_name" maxLength={100}/></label>
      <label>Date of birth<input name="date_of_birth" type="date" required max={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}/></label><label>Gender<select name="gender" required defaultValue="undisclosed"><option value="undisclosed">Not disclosed</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></label>
      <label>Phone<input name="phone" type="tel" maxLength={40}/></label><label>Email<input name="email" type="email"/></label></div></fieldset>
    <label className="check"><input type="checkbox" checked={hasAddress} onChange={e => setHasAddress(e.target.checked)}/>Add address</label>
    {hasAddress && <fieldset><legend>Address</legend><div className="form-grid"><label>Address line 1<input name="line1" required maxLength={200}/></label><label>Address line 2<input name="line2" maxLength={200}/></label><label>City<input name="city" required maxLength={100}/></label><label>State / region<input name="region" maxLength={100}/></label><label>Postal code<input name="postal_code" maxLength={30}/></label><label>Country code<input name="country" required minLength={2} maxLength={2} placeholder="e.g. US or IN" pattern="[A-Za-z]{2}"/></label></div></fieldset>}
    <div className="actions"><button disabled={busy}>{busy ? 'Saving…' : 'Save patient'}</button><Link to="/patients">Cancel</Link></div>
  </form></>;
}

function EncounterCard({ encounter: e }: { encounter: Encounter }) {
  return <article className="timeline-card panel"><div className="heading"><h3>Encounter</h3><time>{new Date(e.occurred_at).toLocaleString()}</time></div><p className="muted">{e.clinician_name || 'Clinic clinician'}</p>
    {[['Chief complaint', e.chief_complaint], ['Symptoms', e.symptoms], ['History', e.history], ['Assessment', e.assessment], ['Internal notes', e.internal_notes]].map(([label, value]) => value && <div key={label}><strong>{label}</strong><p className="prewrap">{value}</p></div>)}
    {!!e.observations.length && <div className="observations">{e.observations.map(o => <span className="badge" key={o.id}>{o.kind}: {o.value} {o.unit}</span>)}</div>}
    {e.prescriptions.map(rx => <div className="prescription" key={rx.id}><h4>Prescription</h4>{rx.items.map(item => <p key={item.id}><strong>{item.medicine_name_snapshot} {item.potency}</strong> — {item.dose}, {item.frequency}{item.duration && `, ${item.duration}`}<br/>{item.instructions}{item.quantity && ` · Quantity: ${item.quantity}`}</p>)}{rx.instructions && <p className="prewrap">{rx.instructions}</p>}</div>)}
    {e.follow_up_date && <p><strong>Follow-up:</strong> {e.follow_up_date}</p>}
  </article>;
}

export function PatientProfile({ role }: { role: Role }) {
  const { id } = useParams();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [encounterPage, setEncounterPage] = useState(1);
  const [notePage, setNotePage] = useState(1);
  const [moreEncounters, setMoreEncounters] = useState(false);
  const [moreNotes, setMoreNotes] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const readClinical = canReadClinical(role);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setPatient(null); setEncounters([]); setNotes([]); setEncounterPage(1); setNotePage(1);
    const options = { signal: controller.signal };
    Promise.all([api<Patient>(`patients/${id}/`, options), ...(readClinical ? [api<Page<Encounter>>(`encounters/?patient=${id}`, options), api<Page<Note>>(`notes/?patient=${id}`, options)] : [])])
      .then(([p, e, n]) => {
        setPatient(p as Patient);
        if (e && n) { setEncounters((e as Page<Encounter>).results); setNotes((n as Page<Note>).results); setMoreEncounters(!!(e as Page<Encounter>).next); setMoreNotes(!!(n as Page<Note>).next); }
      }).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, readClinical]);
  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = event.currentTarget;
    try { const n = await api<Note>('notes/', { method: 'POST', body: JSON.stringify({ patient: id, body: new FormData(form).get('body') }) }); setNotes(old => [n, ...old]); form.reset(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(`patients/${id}/photos/`, { method: 'POST', body: new FormData(event.currentTarget) });
      setPatient(await api<Patient>(`patients/${id}/`));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function older(kind: 'encounters' | 'notes') {
    setBusy(true); setError('');
    try {
      if (kind === 'encounters') {
        const page = await api<Page<Encounter>>(`encounters/?patient=${id}&page=${encounterPage + 1}`);
        setEncounters(old => [...old, ...page.results.filter(e => !old.some(x => x.id === e.id))]); setEncounterPage(encounterPage + 1); setMoreEncounters(!!page.next);
      } else {
        const page = await api<Page<Note>>(`notes/?patient=${id}&page=${notePage + 1}`);
        setNotes(old => [...old, ...page.results.filter(n => !old.some(x => x.id === n.id))]); setNotePage(notePage + 1); setMoreNotes(!!page.next);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (loading) return <p role="status">Loading patient…</p>;
  if (!patient) return <><Link to="/patients">← Patients</Link><ErrorMessage message={error || 'Patient not found.'}/></>;
  const latestPhoto = [...patient.photos].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const timeline = [...encounters.map(e => ({ id: e.id, date: e.occurred_at, encounter: e, note: null })), ...notes.map(n => ({ id: n.id, date: n.created_at, encounter: null, note: n }))].sort((a, b) => b.date.localeCompare(a.date));
  return <><Link to="/patients">← Patients</Link><ErrorMessage message={error}/><div className="heading profile-heading"><div className="identity">{latestPhoto && <img className="photo" alt="Patient profile" src={`/api/v1/photos/${latestPhoto.id}/`}/>}<div><h1>{displayName(patient)}</h1><p>{patient.date_of_birth} · {patient.gender}{patient.archived_at && ' · Archived'}</p><p className="identifier">{patient.id}</p></div></div>{canWriteClinical(role) && !patient.archived_at && <Link className="button" to={`/patients/${id}/encounters/new`}>New encounter</Link>}</div>
    <section className="panel demographics"><h2>Patient details</h2><div className="form-grid"><div><strong>Phone</strong><p>{patient.phone || '—'}</p></div><div><strong>Email</strong><p>{patient.email || '—'}</p></div><div><strong>Address</strong>{patient.address ? <p>{[patient.address.line1, patient.address.line2, patient.address.city, patient.address.region, patient.address.postal_code, patient.address.country].filter(Boolean).join(', ')}</p> : <p>—</p>}</div></div>
      {canWriteDemographics(role) && <form className="upload" onSubmit={upload}><label>Patient photo<input name="photo" type="file" accept="image/jpeg,image/png" required/></label><button className="secondary" disabled={busy}>Upload photo</button><span className="muted">JPEG or PNG, up to 5 MiB</span></form>}
    </section>
    {readClinical ? <section><h2>Clinical timeline</h2>{canWriteClinical(role) && <form className="panel stack" onSubmit={addNote}><label>Add patient note<textarea name="body" required rows={3} placeholder="General history or context for future visits"/></label><div><button disabled={busy}>Save note</button></div></form>}
      <p className="muted">Notes and encounters are preserved in the record. Add a new note to clarify or amend an earlier entry.</p>
      {!timeline.length && <p className="empty panel">No clinical history yet.</p>}{timeline.map(item => item.encounter ? <EncounterCard key={item.id} encounter={item.encounter}/> : <article className="panel timeline-card" key={item.id}><div className="heading"><h3>{item.note!.amends ? 'Note amendment' : 'Patient note'}</h3><time>{new Date(item.date).toLocaleString()}</time></div><p className="prewrap">{item.note!.body}</p><p className="muted">{item.note!.author_name || 'Clinic clinician'}</p></article>)}
      <div className="actions">{moreEncounters && <button disabled={busy} className="secondary" onClick={() => older('encounters')}>Load older encounters</button>}{moreNotes && <button disabled={busy} className="secondary" onClick={() => older('notes')}>Load older notes</button>}</div>
    </section> : <p className="panel muted">Clinical records are restricted to clinical roles.</p>}
  </>;
}

const blankItem = (): PrescriptionItem => ({ medicine_name_snapshot: '', potency: '', dose: '', frequency: '', duration: '', instructions: '', quantity: null });

export function NewEncounter({ role }: { role: Role }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<PrescriptionItem[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    if (canWriteClinical(role)) api<Patient>(`patients/${id}/`, { signal: controller.signal }).then(setPatient).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [id, role]);
  if (!canWriteClinical(role)) return <Navigate to={`/patients/${id}`} replace/>;
  function updateItem(index: number, field: keyof PrescriptionItem, value: string) {
    setItems(old => old.map((item, i) => i === index ? { ...item, [field]: field === 'quantity' ? (value ? Number(value) : null) : value } : item));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const data = new FormData(event.currentTarget);
    const observations: Observation[] = [];
    for (const kind of ['height', 'weight'] as const) if (data.get(kind)) observations.push({ kind, value: String(data.get(kind)), unit: kind === 'height' ? 'cm' : 'kg' });
    const occurredAt = new Date(String(data.get('occurred_at'))).toISOString();
    const payload = { patient: id, occurred_at: occurredAt, chief_complaint: data.get('chief_complaint'), symptoms: data.get('symptoms'), history: data.get('history'), assessment: data.get('assessment'), internal_notes: data.get('internal_notes'), follow_up_date: data.get('follow_up_date') || null, observations: observations.map(o => ({ ...o, measured_at: occurredAt })), prescriptions: items.length ? [{ instructions: data.get('prescription_instructions') || '', items }] : [] };
    try { await api('encounters/', { method: 'POST', body: JSON.stringify(payload) }); navigate(`/patients/${id}`); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return <><Link to={`/patients/${id}`}>← Patient profile</Link><h1>New encounter</h1>{patient && <p>{displayName(patient)}</p>}<ErrorMessage message={error}/><form className="panel stack" onSubmit={submit}>
    <label>Visit date and time<input name="occurred_at" type="datetime-local" required defaultValue={localNow} max={localNow}/></label>
    <label>Chief complaint<textarea name="chief_complaint" required rows={2}/></label><label>Symptoms<textarea name="symptoms" rows={3}/></label><label>History of illness<textarea name="history" rows={3}/></label><label>Assessment<textarea name="assessment" rows={3}/></label><label>Internal clinical notes<textarea name="internal_notes" rows={2}/></label>
    <fieldset><legend>Observations</legend><div className="form-grid"><label>Height (cm)<input name="height" type="number" min="0.01" max="99999.99" step="0.01"/></label><label>Weight (kg)<input name="weight" type="number" min="0.01" max="99999.99" step="0.01"/></label><label>Follow-up date<input name="follow_up_date" type="date"/></label></div></fieldset>
    <fieldset><legend>Prescription</legend><p className="muted">Record the clinician’s prescription. Medicines are entered manually in this release.</p>
      {items.map((item, i) => <div className="rx-form" key={i}><div className="heading"><h3>Item {i + 1}</h3><button type="button" className="secondary" onClick={() => setItems(old => old.filter((_, j) => j !== i))}>Remove item {i + 1}</button></div><div className="form-grid">
        {(['medicine_name_snapshot', 'potency', 'dose', 'frequency', 'duration', 'instructions'] as const).map(field => <label key={field}>{({ medicine_name_snapshot: 'Medicine name', potency: 'Potency', dose: 'Dose', frequency: 'Frequency', duration: 'Duration', instructions: 'Instructions' })[field]}<input value={item[field]} required={['medicine_name_snapshot', 'dose', 'frequency'].includes(field)} onChange={e => updateItem(i, field, e.target.value)}/></label>)}<label>Quantity<input type="number" min={1} step={1} value={item.quantity ?? ''} onChange={e => updateItem(i, 'quantity', e.target.value)}/></label></div></div>)}
      <button type="button" className="secondary" onClick={() => setItems(old => [...old, blankItem()])}>Add medicine</button>{items.length > 0 && <label>Prescription instructions<textarea name="prescription_instructions" rows={2}/></label>}
    </fieldset><div className="actions"><button disabled={busy || !patient || !!patient.archived_at}>{busy ? 'Saving…' : 'Save encounter'}</button><Link to={`/patients/${id}`}>Cancel</Link></div><p className="muted">The encounter and all prescription items are saved together.</p>
  </form></>;
}
