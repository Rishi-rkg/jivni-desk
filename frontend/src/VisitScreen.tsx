import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { ErrorMessage } from './components';
import { RemedySearch } from './Library';
import { Note, Observation, Page, Patient, Role, canWriteClinical, displayName } from './types';
import { useUnsavedChanges } from './useUnsavedChanges';

const UNITS = ['tabs', 'pills', 'drops', 'ml', 'powders', 'teaspoons'];
const FREQUENCIES = ['once daily', 'twice daily', 'three times daily', 'at bedtime', 'once a week', 'when needed'];
const TIMINGS = ['', 'before meals', 'after meals', 'on an empty stomach', 'in water'];
const PERIODS = ['days', 'weeks', 'doses'];
const VISIT_TYPES = [
  ['first', 'First visit'],
  ['follow_up', 'Follow-up'],
  ['medicine_only', 'Medicine only'],
];
const PROGRESS = [
  ['much_better', 'Much better'],
  ['better', 'Better'],
  ['no_change', 'No change'],
  ['worse', 'Worse'],
  ['new_complaint', 'New complaint'],
];

interface Medicine {
  name: string;
  potency: string;
}
/** One envelope: one mix of medicines and the single dosage line that is written for the patient. */
interface Envelope {
  medicines: Medicine[];
  amount: string;
  unit: string;
  frequency: string;
  timing: string;
  length: string;
  period: string;
}

const blankMedicine = (name = ''): Medicine => ({ name, potency: '' });
const blankEnvelope = (first = blankMedicine()): Envelope => ({
  medicines: [first],
  amount: '',
  unit: UNITS[0],
  frequency: 'twice daily',
  timing: '',
  length: '',
  period: PERIODS[0],
});

/** The sentence that goes on the envelope's label, for example "4 tabs, twice daily before meals · 14 days". */
export function dosageLine(e: Envelope) {
  const dose = [e.amount.trim(), e.unit].filter(Boolean).join(' ');
  const when = [e.frequency, e.timing].filter(Boolean).join(' ');
  const line = [e.amount.trim() ? dose : '', when].filter(Boolean).join(', ');
  return e.length.trim() ? `${line} · ${e.length.trim()} ${e.period}` : line;
}

const isoDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function RememberBox({ patient }: { patient: Patient }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<Page<Note>>(`notes/?patient=${patient.id}&kind=remember`, { signal: controller.signal })
      .then((page) => setNotes(page.results))
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [patient.id]);
  async function add() {
    if (!draft.trim()) return;
    setBusy(true);
    setError('');
    try {
      const note = await api<Note>('notes/', {
        method: 'POST',
        body: JSON.stringify({ patient: patient.id, kind: 'remember', body: draft.trim() }),
      });
      setNotes((old) => [note, ...old]);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel remember" aria-label={`Remember about ${patient.first_name}`}>
      <h2>Remember about {patient.first_name}</h2>
      <ErrorMessage message={error} />
      {notes.length ? (
        <ul>
          {notes.map((note) => (
            <li key={note.id} className="prewrap">
              {note.body}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing yet. A hobby, a family member, how they like things explained.</p>
      )}
      <div className="remember-add">
        <label>
          Add something to remember
          <input
            value={draft}
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </label>
        <button type="button" className="secondary" disabled={busy || !draft.trim()} onClick={add}>
          Add
        </button>
      </div>
      <p className="muted">Stays with the patient across visits. Seen by doctors only. Never printed or sent.</p>
    </section>
  );
}

export function NewEncounter({ role }: { role: Role }) {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [nextVisit, setNextVisit] = useState('');
  const [dirty, setDirty] = useState(false);
  const { allowNavigation, prompt } = useUnsavedChanges(dirty || !!envelopes.length);
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

  const change = (index: number, patch: Partial<Envelope>) =>
    setEnvelopes((old) => old.map((envelope, i) => (i === index ? { ...envelope, ...patch } : envelope)));
  const changeMedicine = (index: number, at: number, patch: Partial<Medicine>) =>
    change(index, {
      medicines: envelopes[index].medicines.map((medicine, i) => (i === at ? { ...medicine, ...patch } : medicine)),
    });
  /** A remedy chosen in the library goes into the last envelope, filling an empty line first. */
  function addFromLibrary(name: string) {
    setEnvelopes((old) => {
      if (!old.length) return [blankEnvelope(blankMedicine(name))];
      const last = old[old.length - 1];
      const empty = last.medicines.findIndex((medicine) => !medicine.name.trim());
      const medicines =
        empty >= 0
          ? last.medicines.map((medicine, i) => (i === empty ? { ...medicine, name } : medicine))
          : [...last.medicines, blankMedicine(name)];
      return [...old.slice(0, -1), { ...last, medicines }];
    });
  }
  const pickNextVisit = (days: number) => setNextVisit(isoDate(new Date(Date.now() + days * 86400000)));

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
      visit_type: data.get('visit_type') || '',
      progress: data.get('progress') || '',
      chief_complaint: data.get('chief_complaint'),
      internal_notes: data.get('internal_notes'),
      follow_up_date: nextVisit || null,
      observations: observations.map((o) => ({ ...o, measured_at: occurredAt })),
      prescriptions: envelopes.map((envelope) => ({
        dosage_line: dosageLine(envelope),
        dosage: {
          amount: envelope.amount.trim(),
          unit: envelope.unit,
          frequency: envelope.frequency,
          timing: envelope.timing,
          length: envelope.length.trim(),
          period: envelope.length.trim() ? envelope.period : '',
        },
        items: envelope.medicines
          .filter((medicine) => medicine.name.trim())
          .map((medicine) => ({ medicine_name_snapshot: medicine.name.trim(), potency: medicine.potency.trim() })),
      })),
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
        <span className="muted">{dirty || envelopes.length ? 'Unsaved visit' : 'New consultation'}</span>
      </div>
      <ErrorMessage message={error} />
      {patient && <RememberBox patient={patient} />}
      <form className="stack visit-form" onChangeCapture={() => setDirty(true)} onSubmit={submit}>
        <div className="visit-layout">
          <section className="panel stack">
            <h2>Consultation</h2>
            <div className="form-grid">
              <label>
                Visit date and time
                <input name="occurred_at" type="datetime-local" required defaultValue={localNow} max={localNow} />
              </label>
              <label>
                Visit type
                <select name="visit_type" defaultValue="follow_up">
                  {VISIT_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Since last visit
                <select name="progress" defaultValue="">
                  <option value="">Not recorded</option>
                  {PROGRESS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Complaint, in the patient&apos;s words
              <textarea name="chief_complaint" required rows={3} />
            </label>
            <label>
              Doctor&apos;s notes for this visit
              <textarea name="internal_notes" rows={5} />
            </label>
            <fieldset>
              <legend>Measurements (optional)</legend>
              <div className="form-grid">
                <label>
                  Height (cm)
                  <input name="height" type="number" min="0.01" max="99999.99" step="0.01" />
                </label>
                <label>
                  Weight (kg)
                  <input name="weight" type="number" min="0.01" max="99999.99" step="0.01" />
                </label>
              </div>
            </fieldset>
          </section>
          <aside className="stack visit-support">
            <section className="panel">
              <fieldset>
                <legend>Prescription</legend>
                <p className="muted">
                  Each envelope is one mix. Medicine names stay in the record; the dosage line is what goes on the
                  label.
                </p>
                <details className="remedy-lookup">
                  <summary>Look up a remedy in the library</summary>
                  <RemedySearch chooseLabel="Add to prescription" onChoose={(remedy) => addFromLibrary(remedy.name)} />
                </details>
                {envelopes.map((envelope, index) => (
                  <section className="rx-form" key={index} aria-label={`Envelope ${index + 1}`}>
                    <div className="heading">
                      <h3>Envelope {index + 1}</h3>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setEnvelopes((old) => old.filter((_, i) => i !== index))}
                      >
                        Remove envelope {index + 1}
                      </button>
                    </div>
                    {envelope.medicines.map((medicine, at) => (
                      <div className="medicine-row" key={at}>
                        <label>
                          Medicine name
                          <input
                            value={medicine.name}
                            required
                            maxLength={200}
                            onChange={(e) => changeMedicine(index, at, { name: e.target.value })}
                          />
                        </label>
                        <label>
                          Potency
                          <input
                            value={medicine.potency}
                            maxLength={60}
                            placeholder="30C"
                            onChange={(e) => changeMedicine(index, at, { potency: e.target.value })}
                          />
                        </label>
                        {envelope.medicines.length > 1 && (
                          <button
                            type="button"
                            className="secondary"
                            aria-label={`Remove ${medicine.name || 'this medicine'} from envelope ${index + 1}`}
                            onClick={() => change(index, { medicines: envelope.medicines.filter((_, i) => i !== at) })}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => change(index, { medicines: [...envelope.medicines, blankMedicine()] })}
                    >
                      Add a medicine to this mix
                    </button>
                    <div className="dosage-grid">
                      <label>
                        Amount
                        <input
                          value={envelope.amount}
                          required
                          maxLength={12}
                          inputMode="decimal"
                          onChange={(e) => change(index, { amount: e.target.value })}
                        />
                      </label>
                      <label>
                        Unit
                        <select
                          aria-label="Unit"
                          value={envelope.unit}
                          onChange={(e) => change(index, { unit: e.target.value })}
                        >
                          {UNITS.map((unit) => (
                            <option key={unit}>{unit}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        How often
                        <select
                          aria-label="How often"
                          value={envelope.frequency}
                          onChange={(e) => change(index, { frequency: e.target.value })}
                        >
                          {FREQUENCIES.map((frequency) => (
                            <option key={frequency}>{frequency}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        When
                        <select
                          aria-label="When"
                          value={envelope.timing}
                          onChange={(e) => change(index, { timing: e.target.value })}
                        >
                          {TIMINGS.map((timing) => (
                            <option key={timing} value={timing}>
                              {timing || '(no timing)'}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        For
                        <input
                          value={envelope.length}
                          maxLength={6}
                          inputMode="numeric"
                          onChange={(e) => change(index, { length: e.target.value })}
                        />
                      </label>
                      <label>
                        Days, weeks or doses
                        <select
                          aria-label="Days, weeks or doses"
                          value={envelope.period}
                          onChange={(e) => change(index, { period: e.target.value })}
                        >
                          {PERIODS.map((period) => (
                            <option key={period}>{period}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p className="label-preview">
                      Label will read: <strong>{dosageLine(envelope) || '…'}</strong>
                    </p>
                  </section>
                ))}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEnvelopes((old) => [...old, blankEnvelope()])}
                >
                  {envelopes.length ? 'Add another envelope' : 'Add an envelope'}
                </button>
              </fieldset>
            </section>
            <section className="panel">
              <fieldset>
                <legend>Next visit</legend>
                <div className="actions">
                  <button type="button" className="secondary" onClick={() => pickNextVisit(7)}>
                    1 week
                  </button>
                  <button type="button" className="secondary" onClick={() => pickNextVisit(14)}>
                    2 weeks
                  </button>
                  <button type="button" className="secondary" onClick={() => pickNextVisit(30)}>
                    1 month
                  </button>
                  <button type="button" className="secondary" onClick={() => setNextVisit('')}>
                    As needed
                  </button>
                </div>
                <label>
                  Next visit advised
                  <input type="date" value={nextVisit} onChange={(e) => setNextVisit(e.target.value)} />
                </label>
              </fieldset>
            </section>
          </aside>
        </div>
        <div className="save-bar">
          <span className="muted">The visit, measurements and envelopes save together.</span>
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
