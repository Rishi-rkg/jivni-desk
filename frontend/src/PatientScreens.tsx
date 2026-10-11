import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api';
import { ErrorMessage } from './components';
import {
  Encounter,
  Note,
  Observation,
  Page,
  Patient,
  PrescriptionItem,
  Role,
  canReadClinical,
  canWriteClinical,
  canWriteDemographics,
  displayName,
} from './types';
import { BillingPlaceholder } from './WorkspaceScreens';
import { useUnsavedChanges } from './useUnsavedChanges';

export function NewPatient() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasAddress, setHasAddress] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { allowNavigation, prompt } = useUnsavedChanges(dirty);
  const navigate = useNavigate();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const get = (key: string) => String(form.get(key) || '').trim();
    const patientData = {
      first_name: get('first_name'),
      middle_name: get('middle_name'),
      last_name: get('last_name'),
      date_of_birth: get('date_of_birth'),
      gender: get('gender'),
      phone: get('phone'),
      whatsapp_number: get('whatsapp_number'),
      email: get('email'),
      ...(hasAddress
        ? {
            address: Object.fromEntries(
              ['line1', 'line2', 'city', 'region', 'postal_code', 'country'].map((key) => [key, get(key)]),
            ),
          }
        : {}),
    };
    try {
      const patient = await api<Patient>('patients/', { method: 'POST', body: JSON.stringify(patientData) });
      allowNavigation.current = true;
      navigate(`/patients/${patient.id}`, { state: { message: 'Patient registered.' } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {prompt}
      <Link to="/patients">← Patients</Link>
      <h1>New patient</h1>
      <p className="muted">Register the patient, then continue to their record.</p>
      <form className="panel stack" onChangeCapture={() => setDirty(true)} onSubmit={submit}>
        <ErrorMessage message={error} />
        <fieldset>
          <legend>Demographics</legend>
          <div className="form-grid">
            <label>
              First name
              <input name="first_name" required maxLength={100} />
            </label>
            <label>
              Middle name
              <input name="middle_name" maxLength={100} />
            </label>
            <label>
              Last name
              <input name="last_name" maxLength={100} />
            </label>
            <label>
              Date of birth
              <input
                name="date_of_birth"
                type="date"
                required
                max={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}
              />
            </label>
            <label>
              Gender
              <select name="gender" required defaultValue="undisclosed">
                <option value="undisclosed">Not disclosed</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Phone
              <input name="phone" type="tel" maxLength={40} />
            </label>
            <label>
              WhatsApp number
              <input name="whatsapp_number" type="tel" maxLength={40} />
            </label>
            <label>
              Email
              <input name="email" type="email" />
            </label>
          </div>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={hasAddress} onChange={(e) => setHasAddress(e.target.checked)} />
          Add address
        </label>
        {hasAddress && (
          <fieldset>
            <legend>Address</legend>
            <div className="form-grid">
              <label>
                Address line 1<input name="line1" required maxLength={200} />
              </label>
              <label>
                Address line 2<input name="line2" maxLength={200} />
              </label>
              <label>
                City
                <input name="city" required maxLength={100} />
              </label>
              <label>
                State / region
                <input name="region" maxLength={100} />
              </label>
              <label>
                Postal code
                <input name="postal_code" maxLength={30} />
              </label>
              <label>
                Country code
                <input
                  name="country"
                  required
                  minLength={2}
                  maxLength={2}
                  placeholder="e.g. US or IN"
                  pattern="[A-Za-z]{2}"
                />
              </label>
            </div>
          </fieldset>
        )}
        <div className="actions">
          <button disabled={busy}>{busy ? 'Saving…' : 'Save patient'}</button>
          <Link to="/patients">Cancel</Link>
        </div>
      </form>
    </>
  );
}

function EncounterCard({ encounter: e, expanded = false }: { encounter: Encounter; expanded?: boolean }) {
  return (
    <details className="timeline-card panel" open={expanded}>
      <summary>
        <span>
          <strong>{e.chief_complaint}</strong>
          <span className="muted">{e.clinician_name || 'Clinic clinician'}</span>
        </span>
        <time>{new Date(e.occurred_at).toLocaleString()}</time>
      </summary>
      <div className="visit-detail">
        {[
          ['Chief complaint', e.chief_complaint],
          ['Symptoms', e.symptoms],
          ['History', e.history],
          ['Assessment', e.assessment],
          ['Internal notes', e.internal_notes],
        ].map(
          ([label, value]) =>
            value && (
              <div key={label}>
                <strong>{label}</strong>
                <p className="prewrap">{value}</p>
              </div>
            ),
        )}
        {!!e.observations.length && (
          <div className="observations">
            {e.observations.map((o) => (
              <span className="badge" key={o.id}>
                {o.kind}: {o.value} {o.unit}
              </span>
            ))}
          </div>
        )}
        {e.prescriptions.map((rx) => (
          <div className="prescription" key={rx.id}>
            <h4>Prescription</h4>
            {rx.items.map((item) => (
              <p key={item.id}>
                <strong>
                  {item.medicine_name_snapshot} {item.potency}
                </strong>{' '}
                — {item.dose}, {item.frequency}
                {item.duration && `, ${item.duration}`}
                <br />
                {item.instructions}
                {item.quantity && ` · Quantity: ${item.quantity}`}
              </p>
            ))}
            {rx.instructions && <p className="prewrap">{rx.instructions}</p>}
          </div>
        ))}
        {e.follow_up_date && (
          <p>
            <strong>Follow-up:</strong> {e.follow_up_date}
          </p>
        )}
      </div>
    </details>
  );
}

export function PatientProfile({ role }: { role: Role }) {
  const { id } = useParams();
  const location = useLocation();
  const [params] = useSearchParams();
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
  const [noteDraft, setNoteDraft] = useState('');
  const [success, setSuccess] = useState('');
  const { prompt } = useUnsavedChanges(!!noteDraft.trim());
  const readClinical = canReadClinical(role);
  const allowedTabs = readClinical
    ? ['overview', 'visits', 'prescriptions', 'notes', 'billing']
    : ['overview', 'billing'];
  const tab = allowedTabs.includes(params.get('tab') || '') ? params.get('tab')! : 'overview';
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setPatient(null);
    setEncounters([]);
    setNotes([]);
    setNoteDraft('');
    setSuccess('');
    setEncounterPage(1);
    setNotePage(1);
    const options = { signal: controller.signal };
    Promise.all([
      api<Patient>(`patients/${id}/`, options),
      ...(readClinical
        ? [api<Page<Encounter>>(`encounters/?patient=${id}`, options), api<Page<Note>>(`notes/?patient=${id}`, options)]
        : []),
    ])
      .then(([p, e, n]) => {
        setPatient(p as Patient);
        if (e && n) {
          setEncounters((e as Page<Encounter>).results);
          setNotes((n as Page<Note>).results);
          setMoreEncounters(!!(e as Page<Encounter>).next);
          setMoreNotes(!!(n as Page<Note>).next);
        }
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, readClinical]);
  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const n = await api<Note>('notes/', { method: 'POST', body: JSON.stringify({ patient: id, body: noteDraft }) });
      setNotes((old) => [n, ...old]);
      setNoteDraft('');
      setSuccess('Note saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`patients/${id}/photos/`, { method: 'POST', body: new FormData(event.currentTarget) });
      setPatient(await api<Patient>(`patients/${id}/`));
      setSuccess('Photo saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function setArchived(archived: boolean) {
    if (
      archived &&
      !window.confirm(
        'Archive this patient? The record is kept and can be restored, but it leaves the patient list and no new visits can be recorded.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      setPatient(
        await api<Patient>(`patients/${id}/${archived ? 'archive' : 'restore'}/`, { method: 'POST', body: '{}' }),
      );
      setSuccess(archived ? 'Patient archived.' : 'Patient restored.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function older(kind: 'encounters' | 'notes') {
    setBusy(true);
    setError('');
    try {
      if (kind === 'encounters') {
        const page = await api<Page<Encounter>>(`encounters/?patient=${id}&page=${encounterPage + 1}`);
        setEncounters((old) => [...old, ...page.results.filter((e) => !old.some((x) => x.id === e.id))]);
        setEncounterPage(encounterPage + 1);
        setMoreEncounters(!!page.next);
      } else {
        const page = await api<Page<Note>>(`notes/?patient=${id}&page=${notePage + 1}`);
        setNotes((old) => [...old, ...page.results.filter((n) => !old.some((x) => x.id === n.id))]);
        setNotePage(notePage + 1);
        setMoreNotes(!!page.next);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <p role="status">Loading patient…</p>;
  if (!patient)
    return (
      <>
        <Link to="/patients">← Patients</Link>
        <ErrorMessage message={error || 'Patient not found.'} />
      </>
    );
  const latestPhoto = [...patient.photos].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const latest = encounters[0];
  const observation = (kind: string) =>
    encounters
      .flatMap((e) => e.observations)
      .filter((o) => o.kind === kind)
      .sort((a, b) => (b.measured_at || '').localeCompare(a.measured_at || ''))[0];
  const prescriptions = encounters.flatMap((e) => e.prescriptions.map((rx) => ({ rx, encounter: e })));
  const moreVisits = moreEncounters && (
    <button disabled={busy} className="secondary" onClick={() => older('encounters')}>
      Load older visits
    </button>
  );
  return (
    <>
      {prompt}
      <Link to={location.state?.returnTo || '/patients'}>← Patient list</Link>
      <ErrorMessage message={error} />
      {(success || location.state?.message) && (
        <p className="success" role="status">
          {success || location.state.message}
        </p>
      )}
      <div className="heading profile-heading patient-banner">
        <div className="identity">
          {latestPhoto && <img className="photo" alt="Patient profile" src={`/api/v1/photos/${latestPhoto.id}/`} />}
          <div>
            <h1>{displayName(patient)}</h1>
            <p>
              Born {patient.date_of_birth} · {patient.gender}
              {patient.archived_at && ' · Archived'}
            </p>
            {patient.identifier && <p className="identifier patient-code">{patient.identifier}</p>}
            <details className="record-id">
              <summary>Record ID</summary>
              <span className="identifier">{patient.id}</span>
            </details>
          </div>
        </div>
        {canWriteClinical(role) && !patient.archived_at && (
          <Link state={location.state} className="button" to={`/patients/${id}/encounters/new`}>
            New visit
          </Link>
        )}
      </div>
      <nav className="patient-tabs" aria-label="Patient record">
        {allowedTabs.map((t) => (
          <Link
            key={t}
            to={t === 'overview' ? '?' : `?tab=${t}`}
            state={location.state}
            aria-current={tab === t ? 'page' : undefined}
            className={tab === t ? 'active' : ''}
          >
            {t[0].toUpperCase() + t.slice(1)}
            {t === 'billing' && <span className="planned-label">Planned</span>}
          </Link>
        ))}
      </nav>
      <div className="patient-layout">
        <aside className="patient-sidebar panel">
          <h2>Patient details</h2>
          <dl>
            <dt>Date of birth</dt>
            <dd>{patient.date_of_birth}</dd>
            <dt>Phone</dt>
            <dd>{patient.phone || 'Not recorded'}</dd>
            <dt>WhatsApp</dt>
            <dd>{patient.whatsapp_number || 'Not recorded'}</dd>
            <dt>Email</dt>
            <dd>{patient.email || 'Not recorded'}</dd>
            <dt>Address</dt>
            <dd>
              {patient.address
                ? [
                    patient.address.line1,
                    patient.address.line2,
                    patient.address.city,
                    patient.address.region,
                    patient.address.postal_code,
                    patient.address.country,
                  ]
                    .filter(Boolean)
                    .join(', ')
                : 'Not recorded'}
            </dd>
          </dl>
          {canWriteDemographics(role) && (
            <details className="photo-editor">
              <summary>{latestPhoto ? 'Change photo' : 'Add photo'}</summary>
              <form className="stack" onSubmit={upload}>
                <label>
                  Patient photo
                  <input name="photo" type="file" accept="image/jpeg,image/png" required />
                </label>
                <button className="secondary" disabled={busy}>
                  Upload photo
                </button>
                <span className="muted">JPEG or PNG, up to 5 MiB</span>
              </form>
            </details>
          )}
          {canWriteClinical(role) && (
            <div className="archive-control">
              {patient.archived_at ? (
                <>
                  <p className="muted">Archived {new Date(patient.archived_at).toLocaleDateString()}</p>
                  <button type="button" className="secondary" disabled={busy} onClick={() => setArchived(false)}>
                    Restore patient
                  </button>
                </>
              ) : (
                <button type="button" className="secondary" disabled={busy} onClick={() => setArchived(true)}>
                  Archive patient
                </button>
              )}
            </div>
          )}
        </aside>
        <section className="patient-workspace" aria-label={`${tab} content`}>
          {tab === 'overview' && (
            <>
              <h2>Overview</h2>
              {readClinical ? (
                <>
                  <div className="overview-metrics">
                    <div>
                      <span className="muted">Last visit</span>
                      <strong>{latest ? new Date(latest.occurred_at).toLocaleDateString() : 'No visits yet'}</strong>
                    </div>
                    {(['height', 'weight'] as const).map((kind) => {
                      const o = observation(kind);
                      return (
                        <div key={kind}>
                          <span className="muted">Recent {kind}</span>
                          <strong>{o ? `${o.value} ${o.unit}` : 'No recent value'}</strong>
                          {o?.measured_at && <time>{new Date(o.measured_at).toLocaleDateString()}</time>}
                        </div>
                      );
                    })}
                  </div>
                  {moreEncounters && <p className="muted">Load older visits to check earlier measurements.</p>}
                  <section className="panel">
                    <div className="heading">
                      <h2>Latest visit</h2>
                      <Link to="?tab=visits" state={location.state}>
                        View visits →
                      </Link>
                    </div>
                    {latest ? (
                      <>
                        <p className="prewrap">
                          <strong>{latest.chief_complaint}</strong>
                        </p>
                        {latest.assessment && <p className="prewrap">{latest.assessment}</p>}
                        {latest.follow_up_date && <p>Follow-up: {latest.follow_up_date}</p>}
                      </>
                    ) : (
                      <p className="muted">
                        Start a new visit to record the consultation, observations and prescription.
                      </p>
                    )}
                  </section>
                  <section className="panel">
                    <div className="heading">
                      <h2>Latest note</h2>
                      <Link to="?tab=notes" state={location.state}>
                        View notes →
                      </Link>
                    </div>
                    <p className="prewrap">{notes[0]?.body || 'No patient notes yet.'}</p>
                  </section>
                </>
              ) : (
                <p className="panel muted">Clinical records are restricted to clinical roles.</p>
              )}
              <Link to="?tab=billing" state={location.state}>
                Open patient billing →
              </Link>
            </>
          )}
          {tab === 'visits' && (
            <>
              <div className="heading">
                <h2>Visits</h2>
                <span className="muted">Latest first · Open a visit for details</span>
              </div>
              {!encounters.length && (
                <p className="panel muted">No visits yet. Start a new visit to record this consultation.</p>
              )}
              {encounters.map((e, i) => (
                <EncounterCard key={e.id} encounter={e} expanded={i === 0} />
              ))}
              {moreVisits}
            </>
          )}
          {tab === 'prescriptions' && (
            <>
              <h2>Prescriptions</h2>
              {!prescriptions.length && (
                <p className="panel muted">
                  No prescriptions in the loaded visits. Record medicines while creating a visit.
                </p>
              )}
              {prescriptions.map(({ rx, encounter }) => (
                <section className="panel" key={rx.id}>
                  <div className="heading">
                    <h3>Prescription</h3>
                    <time>{new Date(encounter.occurred_at).toLocaleDateString()}</time>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Medicine / potency</th>
                          <th>Dose</th>
                          <th>Frequency</th>
                          <th>Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rx.items.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <strong>
                                {item.medicine_name_snapshot} {item.potency}
                              </strong>
                              {item.instructions && <p className="muted prewrap">{item.instructions}</p>}
                            </td>
                            <td>{item.dose}</td>
                            <td>{item.frequency}</td>
                            <td>{item.duration || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {rx.instructions && <p className="prewrap">{rx.instructions}</p>}
                </section>
              ))}
              {moreVisits}
            </>
          )}
          {tab === 'notes' && (
            <>
              <h2>Patient notes</h2>
              {canWriteClinical(role) && (
                <form className="panel stack" onSubmit={addNote}>
                  <label>
                    Add patient note
                    <textarea
                      name="body"
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      required
                      rows={3}
                      placeholder="History or context for future visits"
                    />
                  </label>
                  <div className="actions">
                    <button disabled={busy}>Save note</button>
                    {noteDraft && <span className="muted">Unsaved note</span>}
                  </div>
                </form>
              )}
              <p className="muted">Add a new note to clarify an earlier entry.</p>
              {!notes.length && <p className="panel muted">No patient notes yet.</p>}
              {notes.map((n) => (
                <article className="panel" key={n.id}>
                  <div className="heading">
                    <h3>{n.amends ? 'Note amendment' : 'Patient note'}</h3>
                    <time>{new Date(n.created_at).toLocaleString()}</time>
                  </div>
                  <p className="prewrap">{n.body}</p>
                  <p className="muted">{n.author_name || 'Clinic clinician'}</p>
                </article>
              ))}
              {moreNotes && (
                <button disabled={busy} className="secondary" onClick={() => older('notes')}>
                  Load older notes
                </button>
              )}
            </>
          )}
          {tab === 'billing' && <BillingPlaceholder patientName={displayName(patient)} />}
        </section>
      </div>
    </>
  );
}

const blankItem = (): PrescriptionItem => ({
  medicine_name_snapshot: '',
  potency: '',
  dose: '',
  frequency: '',
  duration: '',
  instructions: '',
  quantity: null,
});

export function NewEncounter({ role }: { role: Role }) {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<PrescriptionItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const { allowNavigation, prompt } = useUnsavedChanges(dirty || !!items.length);
  useEffect(() => {
    const controller = new AbortController();
    if (canWriteClinical(role))
      api<Patient>(`patients/${id}/`, { signal: controller.signal })
        .then(setPatient)
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    return () => controller.abort();
  }, [id, role]);
  if (!canWriteClinical(role)) return <Navigate to={`/patients/${id}`} replace />;
  function updateItem(index: number, field: keyof PrescriptionItem, value: string) {
    setItems((old) =>
      old.map((item, i) =>
        i === index ? { ...item, [field]: field === 'quantity' ? (value ? Number(value) : null) : value } : item,
      ),
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const observations: Observation[] = [];
    for (const kind of ['height', 'weight'] as const)
      if (data.get(kind))
        observations.push({ kind, value: String(data.get(kind)), unit: kind === 'height' ? 'cm' : 'kg' });
    const occurredAt = new Date(String(data.get('occurred_at'))).toISOString();
    const payload = {
      patient: id,
      occurred_at: occurredAt,
      chief_complaint: data.get('chief_complaint'),
      symptoms: data.get('symptoms'),
      history: data.get('history'),
      assessment: data.get('assessment'),
      internal_notes: data.get('internal_notes'),
      follow_up_date: data.get('follow_up_date') || null,
      observations: observations.map((o) => ({ ...o, measured_at: occurredAt })),
      prescriptions: items.length ? [{ instructions: data.get('prescription_instructions') || '', items }] : [],
    };
    try {
      await api('encounters/', { method: 'POST', body: JSON.stringify(payload) });
      allowNavigation.current = true;
      navigate(`/patients/${id}?tab=visits`, { state: { ...location.state, message: 'Visit saved.' } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return (
    <>
      {prompt}
      <Link state={location.state} to={`/patients/${id}?tab=visits`}>
        ← Patient record
      </Link>
      <div className="heading profile-heading">
        <div>
          <h1>New visit</h1>
          {patient && (
            <p>
              {displayName(patient)} · Born {patient.date_of_birth}
            </p>
          )}
        </div>
        <span className="muted">{dirty || items.length ? 'Unsaved visit' : 'New consultation'}</span>
      </div>
      <ErrorMessage message={error} />
      <form className="stack visit-form" onChangeCapture={() => setDirty(true)} onSubmit={submit}>
        <div className="visit-layout">
          <section className="panel stack">
            <h2>Consultation</h2>
            <label>
              Visit date and time
              <input name="occurred_at" type="datetime-local" required defaultValue={localNow} max={localNow} />
            </label>
            <label>
              Chief complaint
              <textarea name="chief_complaint" required rows={2} />
            </label>
            <div className="clinical-grid">
              <label>
                Symptoms
                <textarea name="symptoms" rows={4} />
              </label>
              <label>
                History of illness
                <textarea name="history" rows={4} />
              </label>
              <label>
                Assessment
                <textarea name="assessment" rows={4} />
              </label>
              <label>
                Internal clinical notes
                <textarea name="internal_notes" rows={4} />
              </label>
            </div>
          </section>
          <aside className="stack visit-support">
            <section className="panel">
              <fieldset>
                <legend>Observations</legend>
                <div className="form-grid">
                  <label>
                    Height (cm)
                    <input name="height" type="number" min="0.01" max="99999.99" step="0.01" />
                  </label>
                  <label>
                    Weight (kg)
                    <input name="weight" type="number" min="0.01" max="99999.99" step="0.01" />
                  </label>
                  <label>
                    Follow-up date
                    <input name="follow_up_date" type="date" />
                  </label>
                </div>
              </fieldset>
            </section>
            <section className="panel">
              <fieldset>
                <legend>Prescription</legend>
                <p className="muted">Add the medicines prescribed during this visit.</p>
                {items.map((item, i) => (
                  <div className="rx-form" key={i}>
                    <div className="heading">
                      <h3>Item {i + 1}</h3>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setItems((old) => old.filter((_, j) => j !== i))}
                      >
                        Remove item {i + 1}
                      </button>
                    </div>
                    <div className="form-grid">
                      {(
                        ['medicine_name_snapshot', 'potency', 'dose', 'frequency', 'duration', 'instructions'] as const
                      ).map((field) => (
                        <label key={field}>
                          {
                            {
                              medicine_name_snapshot: 'Medicine name',
                              potency: 'Potency',
                              dose: 'Dose',
                              frequency: 'Frequency',
                              duration: 'Duration',
                              instructions: 'Instructions',
                            }[field]
                          }
                          <input
                            value={item[field]}
                            required={['medicine_name_snapshot', 'dose', 'frequency'].includes(field)}
                            onChange={(e) => updateItem(i, field, e.target.value)}
                          />
                        </label>
                      ))}
                      <label>
                        Quantity
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={item.quantity ?? ''}
                          onChange={(e) => updateItem(i, 'quantity', e.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                ))}
                <button type="button" className="secondary" onClick={() => setItems((old) => [...old, blankItem()])}>
                  Add medicine
                </button>
                {items.length > 0 && (
                  <label>
                    Prescription instructions
                    <textarea name="prescription_instructions" rows={2} />
                  </label>
                )}
              </fieldset>
            </section>
          </aside>
        </div>
        <div className="save-bar">
          <span className="muted">The visit, observations and prescription save together.</span>
          <div className="actions">
            <Link state={location.state} to={`/patients/${id}?tab=visits`}>
              Cancel
            </Link>
            <button disabled={busy || !patient || !!patient.archived_at}>{busy ? 'Saving…' : 'Save visit'}</button>
          </div>
        </div>
      </form>
    </>
  );
}
