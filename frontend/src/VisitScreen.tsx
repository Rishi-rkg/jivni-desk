/**
 * Writing a visit. It is a draft while the doctor works (saved as they go, seen by doctors only) and
 * becomes a visit that cannot be edited when it is finalised; corrections after that are amendments.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { PriceItem } from './billing';
import { AddFromPriceList } from './BillingWindows';
import { ErrorMessage } from './components';
import { addDays, age, clock, isoDay, money, sexWord, shortDate } from './format';
import { RemedySearch } from './Library';
import { Product, useProductScans } from './Scanner';
import { Encounter, Note, Observation, Page, Patient, Role, canWriteClinical, displayName } from './types';
import { ChoiceStrip, Menu, MenuItem, Modal, StatusLabel, notify, useShortcut } from './ui';
import { useUnsavedChanges } from './useUnsavedChanges';

const UNITS = ['tabs', 'pills', 'drops', 'ml', 'powders', 'teaspoons'];
const FREQUENCIES = ['once daily', 'twice daily', 'three times daily', 'at bedtime', 'once a week', 'when needed'];
const TIMINGS = ['', 'before meals', 'after meals', 'on an empty stomach', 'in water'];
const PERIODS = ['days', 'weeks', 'doses'];
const POTENCIES = ['6C', '30C', '200C', '1M', '10M', '50M', 'CM', '6X', '30X', 'Q'];
const VISIT_TYPES = [
  ['first', 'First visit'],
  ['follow_up', 'Follow-up'],
  ['medicine_only', 'Medicine only'],
] as const;
type VisitType = (typeof VISIT_TYPES)[number][0];
const PROGRESS = [
  ['much_better', 'Much better'],
  ['better', 'Better'],
  ['no_change', 'No change'],
  ['worse', 'Worse'],
  ['new_complaint', 'New complaint'],
  ['', 'Not recorded'],
] as const;
type Progress = (typeof PROGRESS)[number][0];
const NEXT_VISITS = [
  ['7', '1 wk'],
  ['14', '2 wk'],
  ['30', '1 mo'],
  ['', 'As needed'],
] as const;
type NextVisit = (typeof NEXT_VISITS)[number][0];

interface Medicine {
  name: string;
  potency: string;
}
/** One envelope: one mix of medicines and the single dosage line that is written for the patient. */
export interface Envelope {
  medicines: Medicine[];
  amount: string;
  unit: string;
  frequency: string;
  timing: string;
  length: string;
  period: string;
}
interface VisitProduct {
  price_item_id: string | null;
  name: string;
  kind: string;
  quantity: string;
  rate: string;
  gst_rate: string;
  note: string;
}
/** Everything on the page, which is also exactly what a draft keeps. */
interface VisitForm {
  occurred_at: string;
  visit_type: VisitType;
  progress: Progress;
  complaint: string;
  notes: string;
  remember: string;
  height: string;
  weight: string;
  bp: string;
  pulse: string;
  envelopes: Envelope[];
  products: VisitProduct[];
  next_visit: string;
  print_labels: boolean;
  create_bill: boolean;
}
interface Draft {
  id: string;
  patient: string;
  author_name: string;
  mine: boolean;
  data: Partial<VisitForm>;
  updated_at: string;
}
interface SavedSet {
  id: string;
  name: string;
  envelopes: Envelope[];
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
const localNow = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const blankForm = (visitType: VisitType): VisitForm => ({
  occurred_at: localNow(),
  visit_type: visitType,
  progress: '',
  complaint: '',
  notes: '',
  remember: '',
  height: '',
  weight: '',
  bp: '',
  pulse: '',
  envelopes: [],
  products: [],
  next_visit: '',
  print_labels: true,
  create_bill: true,
});

/** The two halves of the label wording: "4 tabs, twice daily" and "before meals · 14 days". */
export function dosageHalves(e: Envelope): [string, string] {
  const dose = e.amount.trim() ? [e.amount.trim(), e.unit].filter(Boolean).join(' ') : '';
  const main = [dose, e.frequency].filter(Boolean).join(', ');
  const rest = [e.timing, e.length.trim() ? `${e.length.trim()} ${e.period}` : ''].filter(Boolean).join(' · ');
  return [main, rest];
}

/** The sentence that goes on the envelope's label, for example "4 tabs, twice daily before meals · 14 days". */
export function dosageLine(e: Envelope) {
  const dose = [e.amount.trim(), e.unit].filter(Boolean).join(' ');
  const when = [e.frequency, e.timing].filter(Boolean).join(' ');
  const line = [e.amount.trim() ? dose : '', when].filter(Boolean).join(', ');
  return e.length.trim() ? `${line} · ${e.length.trim()} ${e.period}` : line;
}

/** A saved visit's envelopes, turned back into what the form edits. Used by "Repeat last" and "Copy prescription". */
export function envelopesOf(encounter: Encounter): Envelope[] {
  return encounter.prescriptions.map((rx) => {
    const d = (rx.dosage ?? {}) as Record<string, string>;
    return {
      medicines: rx.items.map((item) => ({ name: item.medicine_name_snapshot, potency: item.potency })),
      amount: d.amount ?? '',
      unit: UNITS.includes(d.unit) ? d.unit : UNITS[0],
      frequency: FREQUENCIES.includes(d.frequency) ? d.frequency : 'twice daily',
      timing: TIMINGS.includes(d.timing) ? d.timing : '',
      length: d.length ?? '',
      period: PERIODS.includes(d.period) ? d.period : PERIODS[0],
    };
  });
}

function bloodPressure(text: string): [number, number] | null {
  const match = /^\s*(\d{2,3})\s*[/ ]\s*(\d{2,3})\s*$/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

// "Do not ask again today" for the finalise question. Kept in memory only, so it also ends with the session.
let skipFinaliseQuestionOn = '';

function RememberBox({ patient }: { patient: Patient }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<Page<Note>>(`notes/?patient=${patient.id}&kind=remember`, { signal: controller.signal })
      .then((page) => setNotes(page.results ?? []))
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
      setAdding(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="remember" aria-label={`Remember about ${patient.first_name}`}>
      <div className="heading remember-head">
        <strong>Remember about {patient.first_name}</strong>
        {!adding && (
          <button type="button" className="link-button" onClick={() => setAdding(true)}>
            + Add
          </button>
        )}
      </div>
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
      {adding && (
        <div className="remember-add">
          <label>
            Add something to remember
            <input
              autoFocus
              value={draft}
              maxLength={500}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
                if (e.key === 'Escape') setAdding(false);
              }}
            />
          </label>
          <button type="button" className="secondary" disabled={busy || !draft.trim()} onClick={add}>
            Add
          </button>
        </div>
      )}
      <p className="small muted">Stays with the patient across visits. Seen by doctors only. Never printed or sent.</p>
    </section>
  );
}

function measurementsOf(encounter: Encounter) {
  const value = (kind: string) => encounter.observations.find((o) => o.kind === kind)?.value;
  const parts = [
    value('height') && `${Number(value('height'))} cm`,
    value('weight') && `${Number(value('weight'))} kg`,
    value('systolic') && value('diastolic') && `BP ${Number(value('systolic'))}/${Number(value('diastolic'))}`,
    value('pulse') && `pulse ${Number(value('pulse'))}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Side panel: an earlier visit beside the one being written. */
function LastVisitPanel({
  visits,
  onCopy,
  onClose,
}: {
  visits: Encounter[];
  onCopy: (envelopes: Envelope[]) => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState(0);
  const visit = visits[at];
  return (
    <aside className="drawer" aria-label="Last visit">
      <div className="heading">
        <h2>
          {at === 0 ? 'Last visit' : 'Earlier visit'} · {shortDate(visit.occurred_at)}
        </h2>
        <button type="button" className="x" aria-label="Close the last visit panel" onClick={onClose}>
          ✕
        </button>
      </div>
      <dl>
        <dt>Complaint</dt>
        <dd className="prewrap">{visit.chief_complaint}</dd>
        {visit.internal_notes && (
          <>
            <dt>Doctor&apos;s notes</dt>
            <dd className="prewrap">{visit.internal_notes}</dd>
          </>
        )}
        {visit.prescriptions.map((rx, index) => (
          <span key={rx.id ?? index} style={{ display: 'contents' }}>
            <dt>Envelope {index + 1}</dt>
            <dd>
              {rx.items.map((item) => `${item.medicine_name_snapshot} ${item.potency}`.trim()).join(' + ')}
              {rx.dosage_line && ` · ${rx.dosage_line}`}
            </dd>
          </span>
        ))}
        {measurementsOf(visit) && (
          <>
            <dt>Measurements</dt>
            <dd>{measurementsOf(visit)}</dd>
          </>
        )}
      </dl>
      <p className="actions">
        {!!visit.prescriptions.length && (
          <button type="button" className="secondary btn-sm" onClick={() => onCopy(envelopesOf(visit))}>
            Copy prescription
          </button>
        )}
        {at < visits.length - 1 && (
          <button type="button" className="link-button" onClick={() => setAt(at + 1)}>
            ‹ Earlier
          </button>
        )}
        {at > 0 && (
          <button type="button" className="link-button" onClick={() => setAt(at - 1)}>
            Later ›
          </button>
        )}
      </p>
    </aside>
  );
}

export function NewEncounter({
  role,
  billingOn = false,
  libraryOn = true,
}: {
  role: Role;
  billingOn?: boolean;
  libraryOn?: boolean;
}) {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const allowed = canWriteClinical(role);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [visits, setVisits] = useState<Encounter[]>([]);
  const [form, setForm] = useState<VisitForm | null>(null);
  const [draftId, setDraftId] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const [otherDraft, setOtherDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'' | 'last' | 'library'>('');
  const [addingProduct, setAddingProduct] = useState(false);
  const [scanned, setScanned] = useState<Product | null>(null);
  const [asking, setAsking] = useState(false);
  const [namingSet, setNamingSet] = useState(false);
  const [sets, setSets] = useState<SavedSet[]>([]);
  const [remedies, setRemedies] = useState<{ name: string; abbreviation: string }[]>([]);
  const latest = useRef({ form, draftId, dirty });
  latest.current = { form, draftId, dirty };

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    Promise.all([
      api<Patient>(`patients/${id}/`, options),
      api<Page<Encounter>>(`encounters/?patient=${id}`, options),
      api<Draft[]>(`visit-drafts/?patient=${id}`, options),
    ])
      .then(([person, earlier, drafts]) => {
        const list = Array.isArray(drafts) ? drafts : [];
        const mine = list.find((draft) => draft.mine);
        setPatient(person);
        setVisits(earlier.results ?? []);
        setOtherDraft(list.find((draft) => !draft.mine)?.author_name ?? '');
        const start = blankForm(earlier.results?.length ? 'follow_up' : 'first');
        if (mine) {
          setForm({ ...start, ...mine.data });
          setDraftId(mine.id);
          setSavedAt(mine.updated_at);
        } else setForm(start);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    // Saved sets and the remedy names are conveniences; the visit works without them.
    api<SavedSet[]>('prescription-sets/', options)
      .then((list) => setSets(Array.isArray(list) ? list : []))
      .catch(() => {});
    if (libraryOn)
      api<{ name: string; abbreviation: string }[]>('knowledge/medicines/', options)
        .then((list) => setRemedies(Array.isArray(list) ? list : []))
        .catch(() => {});
    return () => controller.abort();
  }, [id, allowed, libraryOn]);

  const change = useCallback((patch: Partial<VisitForm>) => {
    setDirty(true);
    setForm((old) => (old ? { ...old, ...patch } : old));
  }, []);
  const changeEnvelope = (index: number, patch: Partial<Envelope>) =>
    change({ envelopes: form!.envelopes.map((envelope, i) => (i === index ? { ...envelope, ...patch } : envelope)) });
  const changeMedicine = (index: number, at: number, patch: Partial<Medicine>) =>
    changeEnvelope(index, {
      medicines: form!.envelopes[index].medicines.map((medicine, i) =>
        i === at ? { ...medicine, ...patch } : medicine,
      ),
    });
  const changeProduct = (index: number, patch: Partial<VisitProduct>) =>
    change({ products: form!.products.map((product, i) => (i === index ? { ...product, ...patch } : product)) });
  /** A remedy chosen in the library goes into the last envelope, filling an empty line first. */
  function addFromLibrary(name: string) {
    const old = form!.envelopes;
    if (!old.length) return change({ envelopes: [blankEnvelope(blankMedicine(name))] });
    const last = old[old.length - 1];
    const empty = last.medicines.findIndex((medicine) => !medicine.name.trim());
    const medicines =
      empty >= 0
        ? last.medicines.map((medicine, i) => (i === empty ? { ...medicine, name } : medicine))
        : [...last.medicines, blankMedicine(name)];
    change({ envelopes: [...old.slice(0, -1), { ...last, medicines }] });
  }
  function addProduct(item: { id: string; name: string; kind: string; rate: string; gst_rate: string }) {
    const products = form!.products;
    const same = products.findIndex((product) => product.price_item_id === item.id);
    change({
      products:
        same >= 0
          ? products.map((product, i) =>
              i === same ? { ...product, quantity: String((Number(product.quantity) || 0) + 1) } : product,
            )
          : [
              ...products,
              {
                price_item_id: item.id,
                name: item.name,
                kind: item.kind,
                quantity: '1',
                rate: String(Number(item.rate)),
                gst_rate: String(Number(item.gst_rate)),
                note: '',
              },
            ],
    });
    notify(`${item.name} added.`);
  }
  // A product scanned while a visit is open: ask who it is for.
  useProductScans((product) => setScanned(product));

  const saveDraft = useCallback(
    async (quiet = false) => {
      const now = latest.current;
      if (!now.form) return;
      try {
        const saved = now.draftId
          ? await api<Draft>(`visit-drafts/${now.draftId}/`, {
              method: 'PATCH',
              body: JSON.stringify({ data: now.form }),
            })
          : await api<Draft>('visit-drafts/', {
              method: 'POST',
              body: JSON.stringify({ patient: id, data: now.form }),
            });
        setDraftId(saved.id);
        setSavedAt(saved.updated_at);
        // Only "saved" if nothing was typed while the request was on its way.
        if (latest.current.form === now.form) setDirty(false);
        if (!quiet) notify('Draft saved.');
      } catch (e) {
        if (!quiet) setError((e as Error).message);
      }
    },
    [id],
  );
  // The draft saves itself a few seconds after the doctor stops typing.
  useEffect(() => {
    if (!dirty || busy) return;
    const timer = window.setTimeout(() => saveDraft(true), 2500);
    return () => window.clearTimeout(timer);
  }, [dirty, busy, form, saveDraft]);
  useShortcut('s', () => saveDraft(), { ctrl: true, active: allowed && !!form && !busy });
  const { allowNavigation, prompt } = useUnsavedChanges(dirty, () => saveDraft(true));

  const lastVisit = visits[0];
  const title = useMemo(
    () => (form ? (VISIT_TYPES.find(([key]) => key === form.visit_type)?.[1] ?? 'Visit') : 'Visit'),
    [form],
  );
  if (!allowed) return <Navigate to={`/patients/${id}`} replace />;
  if (!patient || !form)
    return (
      <>
        <Link to={`/patients/${id}`}>← Patient record</Link>
        <ErrorMessage message={error} />
        {!error && <p role="status">Opening the visit…</p>}
      </>
    );

  async function discard() {
    setBusy(true);
    setError('');
    try {
      if (draftId) await api(`visit-drafts/${draftId}/`, { method: 'DELETE' });
      allowNavigation.current = true;
      notify('Draft discarded.');
      navigate(`/patients/${id}?tab=visits`, { state: location.state });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function payload(current: VisitForm) {
    const observations: Observation[] = [];
    const occurredAt = new Date(current.occurred_at).toISOString();
    if (current.height.trim()) observations.push({ kind: 'height', value: current.height.trim(), unit: 'cm' });
    if (current.weight.trim()) observations.push({ kind: 'weight', value: current.weight.trim(), unit: 'kg' });
    if (current.bp.trim()) {
      const reading = bloodPressure(current.bp);
      if (!reading) throw new Error('Write blood pressure as two numbers, for example 118/76.');
      observations.push({ kind: 'systolic', value: String(reading[0]), unit: 'mmHg' });
      observations.push({ kind: 'diastolic', value: String(reading[1]), unit: 'mmHg' });
    }
    if (current.pulse.trim()) observations.push({ kind: 'pulse', value: current.pulse.trim(), unit: 'bpm' });
    for (const [index, envelope] of current.envelopes.entries())
      if (!envelope.medicines.some((medicine) => medicine.name.trim()))
        throw new Error(`Envelope ${index + 1} has no medicine. Add one, or remove the envelope.`);
    const complaint = current.complaint.trim() || (current.visit_type === 'medicine_only' ? 'Medicine only' : '');
    if (!complaint) throw new Error('Write the complaint, in the patient’s words, before finalising.');
    return {
      patient: id,
      draft: draftId || null,
      occurred_at: occurredAt,
      visit_type: current.visit_type,
      progress: current.progress,
      chief_complaint: complaint,
      internal_notes: current.notes,
      follow_up_date: current.next_visit || null,
      observations: observations.map((o) => ({ ...o, measured_at: occurredAt })),
      prescriptions: current.envelopes.map((envelope) => ({
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
      products: current.products.map((product) => ({
        price_item_id: product.price_item_id,
        name: product.name,
        kind: product.kind,
        quantity: product.quantity || '1',
        rate: product.rate || '0',
        gst_rate: product.gst_rate || '0',
        note: product.note.trim(),
      })),
    };
  }

  async function finalise() {
    const current = form!;
    setAsking(false);
    setBusy(true);
    setError('');
    try {
      const visit = await api<Encounter>('encounters/', { method: 'POST', body: JSON.stringify(payload(current)) });
      allowNavigation.current = true;
      setDirty(false);
      // What follows the visit is helpful but separate: if a step fails, the visit is still saved.
      if (current.remember.trim())
        await api('notes/', {
          method: 'POST',
          body: JSON.stringify({ patient: id, kind: 'remember', body: current.remember.trim() }),
        }).catch(() => notify('The visit is saved, but the “remember” note was not.', { kind: 'failed' }));
      let billed = false;
      if (current.create_bill && billingOn)
        billed = await api('invoices/from-visit/', { method: 'POST', body: JSON.stringify({ encounter: visit.id }) })
          .then(() => true)
          .catch(() => {
            notify('The visit is saved, but the bill was not made. Make it from Billing.', { kind: 'failed' });
            return false;
          });
      navigate(`/patients/${id}?tab=visits`, {
        state: {
          ...location.state,
          message: billed ? 'Visit finalised. A draft bill is waiting in Billing.' : 'Visit finalised.',
          labels: current.print_labels && current.envelopes.length ? visit.id : undefined,
        },
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  function askToFinalise() {
    setError('');
    try {
      payload(form!);
    } catch (e) {
      return setError((e as Error).message);
    }
    if (skipFinaliseQuestionOn === isoDay()) finalise();
    else setAsking(true);
  }

  const years = age(patient.date_of_birth);
  const quickPick: NextVisit =
    NEXT_VISITS.find(([days]) => days && form.next_visit === addDays(isoDay(), Number(days)))?.[0] ?? '';
  const setItems: MenuItem[] = [
    { heading: sets.length ? 'Saved sets' : 'No saved sets yet' },
    ...sets.map((set) => ({
      label: set.name,
      onSelect: () => {
        change({ envelopes: [...form.envelopes, ...set.envelopes] });
        notify(`“${set.name}” added to the prescription.`);
      },
    })),
    'sep',
    { label: 'Save current as a set…', disabled: !form.envelopes.length, onSelect: () => setNamingSet(true) },
  ];
  return (
    <>
      {prompt}
      <Link state={location.state} to={`/patients/${id}?tab=visits`}>
        ← Patient record
      </Link>
      <div className="patient-banner visit-banner">
        <div>
          <h1>{displayName(patient)}</h1>
          <p>
            {[sexWord(patient.gender), years !== null && `${years} years`, patient.phone].filter(Boolean).join(' · ')}
            {patient.identifier && (
              <>
                {' · '}
                <span className="mono">{patient.identifier}</span>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="heading">
        <div>
          <h2>
            {title.endsWith('visit') ? title : `${title} visit`} · {shortDate(form.occurred_at)}{' '}
            <StatusLabel tone="amber">Draft</StatusLabel>
          </h2>
          <p className="muted small">
            {savedAt && !dirty
              ? `Draft saved ${clock(savedAt)}.`
              : dirty
                ? 'Saving the draft as you write.'
                : 'Not saved yet.'}{' '}
            Visible only to doctors until finalised.
            {otherDraft && ` ${otherDraft} also has a draft open for this patient.`}
          </p>
        </div>
        <div className="actions">
          <ChoiceStrip
            label="Visit type"
            value={form.visit_type}
            options={VISIT_TYPES}
            onChange={(visit_type) => change({ visit_type })}
          />
          {lastVisit && (
            <button type="button" className="secondary" onClick={() => setPanel(panel === 'last' ? '' : 'last')}>
              Last visit ▸
            </button>
          )}
          {libraryOn && (
            <button type="button" className="secondary" onClick={() => setPanel(panel === 'library' ? '' : 'library')}>
              Library ▸
            </button>
          )}
        </div>
      </div>
      <ErrorMessage message={error} />
      <div className="cols cols-visit">
        <div>
          <RememberBox patient={patient} />
          <section className="panel stack">
            {lastVisit && (
              <div className="info">
                <strong>Last visit, {shortDate(lastVisit.occurred_at)}:</strong> {lastVisit.chief_complaint}
                {lastVisit.prescriptions[0]?.dosage_line &&
                  ` Envelope: ${lastVisit.prescriptions[0].dosage_line}.`}{' '}
                <button type="button" className="link-button" onClick={() => setPanel('last')}>
                  Open
                </button>
              </div>
            )}
            <div>
              <span className="field-label">Since last visit</span>
              <ChoiceStrip
                label="Since last visit"
                value={form.progress}
                options={PROGRESS}
                onChange={(progress) => change({ progress })}
              />
            </div>
            <label>
              Complaint, in the patient&apos;s words
              <textarea rows={3} value={form.complaint} onChange={(e) => change({ complaint: e.target.value })} />
            </label>
            <label>
              Doctor&apos;s notes for this visit
              <textarea rows={4} value={form.notes} onChange={(e) => change({ notes: e.target.value })} />
            </label>
            <label>
              Add something from these notes to “Remember about {patient.first_name}”
              <input
                value={form.remember}
                maxLength={500}
                placeholder="Optional. Goes to the Remember box when the visit is finalised"
                onChange={(e) => change({ remember: e.target.value })}
              />
            </label>
            <details open={!!(form.height || form.weight || form.bp || form.pulse) || undefined}>
              <summary className="muted">Measurements (optional)</summary>
              <div className="form-grid four measurements">
                <label>
                  Height cm
                  <input value={form.height} inputMode="decimal" onChange={(e) => change({ height: e.target.value })} />
                </label>
                <label>
                  Weight kg
                  <input value={form.weight} inputMode="decimal" onChange={(e) => change({ weight: e.target.value })} />
                </label>
                <label>
                  BP
                  <input value={form.bp} placeholder="118/76" onChange={(e) => change({ bp: e.target.value })} />
                </label>
                <label>
                  Pulse
                  <input value={form.pulse} inputMode="numeric" onChange={(e) => change({ pulse: e.target.value })} />
                </label>
              </div>
            </details>
            <label className="visit-when">
              Visit date and time
              <input
                type="datetime-local"
                value={form.occurred_at}
                max={localNow()}
                onChange={(e) => change({ occurred_at: e.target.value })}
              />
            </label>
          </section>
        </div>

        <div>
          <section className="panel">
            <div className="heading">
              <h2>Prescription</h2>
              <div className="actions">
                {lastVisit && !!lastVisit.prescriptions.length && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      change({ envelopes: [...form.envelopes, ...envelopesOf(lastVisit)] });
                      notify('Last prescription copied. Check it before finalising.');
                    }}
                  >
                    Repeat last
                  </button>
                )}
                <Menu label="From a set ▾" className="link-button" items={setItems} />
              </div>
            </div>
            <p className="small muted">
              Each envelope is one mix with one dosage line. Medicine names stay in the record; the label carries what
              the clinic&apos;s label layout says.
            </p>
            <datalist id="remedy-names">
              {remedies.map((remedy) => (
                <option key={remedy.name} value={remedy.name}>
                  {remedy.abbreviation}
                </option>
              ))}
            </datalist>
            <datalist id="potencies">
              {POTENCIES.map((potency) => (
                <option key={potency} value={potency} />
              ))}
            </datalist>
            {form.envelopes.map((envelope, index) => {
              const [main, rest] = dosageHalves(envelope);
              return (
                <section className="envelope" key={index} aria-label={`Envelope ${index + 1}`}>
                  <div className="heading envelope-head">
                    <strong>Envelope {index + 1}</strong>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => change({ envelopes: form.envelopes.filter((_, i) => i !== index) })}
                    >
                      Remove envelope {index + 1}
                    </button>
                  </div>
                  <div className="med-line small muted">
                    <span>Medicines in this mix (doctor only)</span>
                    <span>Potency</span>
                    <span></span>
                  </div>
                  {envelope.medicines.map((medicine, at) => (
                    <div className="med-line" key={at}>
                      <input
                        aria-label="Medicine name"
                        list="remedy-names"
                        value={medicine.name}
                        maxLength={200}
                        placeholder="Search medicines by name or short code…"
                        onChange={(e) => changeMedicine(index, at, { name: e.target.value })}
                      />
                      <input
                        aria-label="Potency"
                        list="potencies"
                        value={medicine.potency}
                        maxLength={60}
                        placeholder="30C"
                        onChange={(e) => changeMedicine(index, at, { potency: e.target.value })}
                      />
                      {envelope.medicines.length > 1 ? (
                        <button
                          type="button"
                          className="x"
                          aria-label={`Remove ${medicine.name || 'this medicine'} from envelope ${index + 1}`}
                          onClick={() =>
                            changeEnvelope(index, { medicines: envelope.medicines.filter((_, i) => i !== at) })
                          }
                        >
                          ✕
                        </button>
                      ) : (
                        <span></span>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => changeEnvelope(index, { medicines: [...envelope.medicines, blankMedicine()] })}
                  >
                    + Add a medicine to this mix
                  </button>
                  <div className="small muted dose-title">Dosage, as written for the patient</div>
                  <div className="dose-grid">
                    <input
                      aria-label="Amount"
                      value={envelope.amount}
                      maxLength={12}
                      inputMode="decimal"
                      placeholder="4"
                      onChange={(e) => changeEnvelope(index, { amount: e.target.value })}
                    />
                    <select
                      aria-label="Unit"
                      value={envelope.unit}
                      onChange={(e) => changeEnvelope(index, { unit: e.target.value })}
                    >
                      {UNITS.map((unit) => (
                        <option key={unit}>{unit}</option>
                      ))}
                    </select>
                    <select
                      aria-label="How often"
                      value={envelope.frequency}
                      onChange={(e) => changeEnvelope(index, { frequency: e.target.value })}
                    >
                      {FREQUENCIES.map((frequency) => (
                        <option key={frequency}>{frequency}</option>
                      ))}
                    </select>
                  </div>
                  <div className="dose-grid2">
                    <select
                      aria-label="When"
                      value={envelope.timing}
                      onChange={(e) => changeEnvelope(index, { timing: e.target.value })}
                    >
                      {TIMINGS.map((timing) => (
                        <option key={timing} value={timing}>
                          {timing || '(no timing)'}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="For"
                      value={envelope.length}
                      maxLength={6}
                      inputMode="numeric"
                      placeholder="14"
                      onChange={(e) => changeEnvelope(index, { length: e.target.value })}
                    />
                    <select
                      aria-label="Days, weeks or doses"
                      value={envelope.period}
                      onChange={(e) => changeEnvelope(index, { period: e.target.value })}
                    >
                      {PERIODS.map((period) => (
                        <option key={period}>{period}</option>
                      ))}
                    </select>
                  </div>
                  <div className="dose-preview" aria-label={`Label will read: ${dosageLine(envelope) || '…'}`}>
                    <span className="small muted">Label will read</span>
                    <br />
                    <strong>{main || '…'}</strong>
                    {rest && (
                      <>
                        <br />
                        <span>{rest}</span>
                      </>
                    )}
                  </div>
                </section>
              );
            })}
            <button
              type="button"
              className="link-button"
              onClick={() => change({ envelopes: [...form.envelopes, blankEnvelope()] })}
            >
              {form.envelopes.length ? '+ Add another envelope' : '+ Add an envelope'}
            </button>
          </section>

          {billingOn && (
            <section className="panel">
              <div className="heading">
                <h2>Products and supplements</h2>
                <button type="button" className="link-button" onClick={() => setAddingProduct(true)}>
                  + Add product
                </button>
              </div>
              {form.products.map((product, index) => (
                <div className="row visit-product" key={index}>
                  <span>
                    {product.name}
                    <input
                      aria-label={`Note for ${product.name}`}
                      className="product-note"
                      value={product.note}
                      maxLength={200}
                      placeholder="How to use it, optional"
                      onChange={(e) => changeProduct(index, { note: e.target.value })}
                    />
                  </span>
                  <span className="actions">
                    <input
                      aria-label={`Quantity of ${product.name}`}
                      className="copies num"
                      value={product.quantity}
                      inputMode="decimal"
                      onChange={(e) => changeProduct(index, { quantity: e.target.value })}
                    />
                    <span>× {money(product.rate)}</span>
                    <button
                      type="button"
                      className="x"
                      aria-label={`Remove ${product.name}`}
                      onClick={() => change({ products: form.products.filter((_, i) => i !== index) })}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}
              <p className="small muted">
                Scan a pack to add it. Products are not labelled; they go on the bill as their own lines.
              </p>
            </section>
          )}

          <section className="panel">
            <h2>Next steps</h2>
            <div className="form-grid two">
              <div>
                <span className="field-label">Next visit advised</span>
                <ChoiceStrip
                  label="Next visit advised"
                  value={form.next_visit && !quickPick ? ('other' as NextVisit) : quickPick}
                  options={NEXT_VISITS}
                  onChange={(days) => change({ next_visit: days ? addDays(isoDay(), Number(days)) : '' })}
                />
              </div>
              <label>
                Date
                <input
                  type="date"
                  value={form.next_visit}
                  min={isoDay()}
                  onChange={(e) => change({ next_visit: e.target.value })}
                />
              </label>
            </div>
            <label className="check next-step">
              <input
                type="checkbox"
                checked={form.print_labels}
                onChange={(e) => change({ print_labels: e.target.checked })}
              />
              Print envelope label
            </label>
            {billingOn && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.create_bill}
                  onChange={(e) => change({ create_bill: e.target.checked })}
                />
                Create the bill (consultation + prescribed medicines + products)
              </label>
            )}
          </section>
        </div>
      </div>

      <div className="save-bar">
        <span className="muted">
          {savedAt && !dirty ? `Draft saved ${clock(savedAt)} · ` : ''}finalising locks the visit; later corrections are
          added as amendments
        </span>
        <div className="actions">
          <button type="button" className="danger" disabled={busy} onClick={discard}>
            Discard draft
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => saveDraft()}>
            Save draft
          </button>
          <button type="button" disabled={busy || !!patient.archived_at} onClick={askToFinalise}>
            {busy ? 'Saving…' : 'Finalise visit'}
          </button>
        </div>
      </div>

      {panel === 'last' && lastVisit && (
        <LastVisitPanel
          visits={visits}
          onClose={() => setPanel('')}
          onCopy={(envelopes) => {
            change({ envelopes: [...form.envelopes, ...envelopes] });
            notify('Prescription copied. Check it before finalising.');
          }}
        />
      )}
      {panel === 'library' && (
        <aside className="drawer wide" aria-label="Library">
          <div className="heading">
            <h2>Library</h2>
            <button type="button" className="x" aria-label="Close the library panel" onClick={() => setPanel('')}>
              ✕
            </button>
          </div>
          <RemedySearch chooseLabel="Add to prescription" onChoose={(remedy) => addFromLibrary(remedy.name)} />
        </aside>
      )}
      {addingProduct && (
        <AddFromPriceList
          productsOnly
          title="Add a product to the visit"
          onClose={() => setAddingProduct(false)}
          onPick={(item: PriceItem) => {
            addProduct(item);
            setAddingProduct(false);
          }}
        />
      )}
      {scanned && (
        <Modal
          title="Product scanned"
          onClose={() => setScanned(null)}
          footer={
            <>
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  const product = scanned;
                  setScanned(null);
                  await saveDraft(true);
                  allowNavigation.current = true;
                  navigate('/billing/new', { state: { product } });
                }}
              >
                New bill for someone else
              </button>
              <button
                type="button"
                data-autofocus
                onClick={() => {
                  addProduct(scanned);
                  setScanned(null);
                }}
              >
                Add to {patient.first_name}&apos;s visit
              </button>
            </>
          }
        >
          <p className="scanned-product">
            <strong>{scanned.name}</strong> · {money(scanned.rate)}
          </p>
          <p className="muted">
            A visit for <strong>{displayName(patient)}</strong> is open. Who is this for?
          </p>
        </Modal>
      )}
      {asking && (
        <FinaliseQuestion
          onBack={() => setAsking(false)}
          onFinalise={(skipToday) => {
            if (skipToday) skipFinaliseQuestionOn = isoDay();
            finalise();
          }}
        />
      )}
      {namingSet && (
        <SaveSet
          envelopes={form.envelopes}
          onClose={() => setNamingSet(false)}
          onSaved={(set) => {
            setSets((old) => [...old, set].sort((a, b) => a.name.localeCompare(b.name)));
            setNamingSet(false);
          }}
        />
      )}
    </>
  );
}

/** W14: finalising cannot be undone, so it is asked once (or once a day). */
function FinaliseQuestion({ onBack, onFinalise }: { onBack: () => void; onFinalise: (skipToday: boolean) => void }) {
  const [skip, setSkip] = useState(false);
  return (
    <Modal
      title="Finalise this visit?"
      alert
      onClose={onBack}
      footer={
        <>
          <button type="button" className="secondary" onClick={onBack}>
            Back
          </button>
          <button type="button" data-autofocus onClick={() => onFinalise(skip)}>
            Finalise
          </button>
        </>
      }
    >
      <p>After this the visit cannot be edited. Corrections are added as amendments.</p>
      <label className="check">
        <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
        Do not ask again today
      </label>
    </Modal>
  );
}

/** W34: keep the envelopes on the page as a named starting point. */
function SaveSet({
  envelopes,
  onClose,
  onSaved,
}: {
  envelopes: Envelope[];
  onClose: () => void;
  onSaved: (set: SavedSet) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const saved = await api<SavedSet>('prescription-sets/', {
        method: 'POST',
        body: JSON.stringify({ name, envelopes }),
      });
      notify(`Saved as “${saved.name}”.`);
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Save as a prescription set"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !name.trim()} onClick={save}>
            Save set
          </button>
        </>
      }
    >
      <ErrorMessage message={error} />
      <label>
        Name of the set
        <input
          data-autofocus
          value={name}
          maxLength={100}
          placeholder="For example: Teething"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <p className="muted small">
        Keeps the {envelopes.length} envelope{envelopes.length === 1 ? '' : 's'} on this page, medicines and dosage, to
        start from another day. A set holds nothing about the patient.
      </p>
    </Modal>
  );
}

/** W7: correct a finalised visit by adding beside it. */
export function AmendVisit({
  visit,
  onClose,
  onSaved,
}: {
  visit: Encounter;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [section, setSection] = useState('prescription');
  const [correction, setCorrection] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(`encounters/${visit.id}/amendments/`, {
        method: 'POST',
        body: JSON.stringify({ section, correction: correction.trim(), reason: reason.trim() }),
      });
      notify('Amendment added.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Amend visit · ${shortDate(visit.occurred_at)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !correction.trim() || !reason.trim()} onClick={save}>
            Add amendment
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted">The visit stays as it was written. The amendment is added beside it.</p>
        <ErrorMessage message={error} />
        <label>
          What is being corrected
          <select aria-label="What is being corrected" value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="prescription">Prescription</option>
            <option value="complaint">Complaint and symptoms</option>
            <option value="measurements">Measurements</option>
            <option value="follow_up">Follow-up date</option>
            <option value="other">Something else</option>
          </select>
        </label>
        <label>
          Correction
          <textarea data-autofocus rows={2} value={correction} onChange={(e) => setCorrection(e.target.value)} />
        </label>
        <label>
          Reason
          <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
