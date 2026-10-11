/** The patient record: banner, tabs, the details panel and the timeline of everything that happened. */
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api';
import { METHOD_LABELS, PayMethod, STATE_LABELS, STATE_TONES, InvoiceState } from './billing';
import { PatientBilling } from './BillingScreen';
import { RecordPayment } from './BillingWindows';
import { ErrorMessage } from './components';
import { age, dateTime, money, sexWord, shortDate } from './format';
import {
  AddDocument,
  AddNote,
  AlertWindow,
  ArchivePatient,
  ChangeHistory,
  ConsentWindow,
  FamilyWindow,
  MeasurementHistory,
  ReplaceCard,
  ViewDocument,
} from './PatientWindows';
import { PrintLabelsWindow } from './PrintingScreen';
import {
  Encounter,
  Note,
  Page,
  Patient,
  PatientDocument,
  Role,
  TimelineItem,
  canReadClinical,
  canTakePayments,
  canUseBilling,
  canWriteClinical,
  canWriteDemographics,
  displayName,
} from './types';
import { Avatar, Chip, Menu, MenuItem, StatusLabel, notify } from './ui';
import { PatientMessages } from './MessagesScreen';
import { WriteMessage } from './MessageWindows';
import { statusOfMessage } from './messages';
import { AmendVisit } from './VisitScreen';
import { BookingWindow } from './WorkspaceScreens';

const VISIT_TITLES: Record<string, string> = {
  first: 'First consultation',
  follow_up: 'Follow-up visit',
  medicine_only: 'Medicine only',
};
const SECTION_LABELS: Record<string, string> = {
  prescription: 'Prescription',
  complaint: 'Complaint and symptoms',
  measurements: 'Measurements',
  follow_up: 'Follow-up date',
  other: 'Other',
};
const medicines = (rx: Encounter['prescriptions'][number]) =>
  rx.items.map((item) => `${item.medicine_name_snapshot} ${item.potency}`.trim()).join(', ');

function measurementLine(visits: Encounter[]) {
  const latest = (kind: string) =>
    visits
      .flatMap((visit) => visit.observations.map((o) => ({ ...o, at: o.measured_at ?? visit.occurred_at })))
      .filter((o) => o.kind === kind)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
  const [height, weight, systolic, diastolic, pulse] = ['height', 'weight', 'systolic', 'diastolic', 'pulse'].map(
    latest,
  );
  const parts = [
    height && `${Number(height.value)} cm`,
    weight && `${Number(weight.value)} kg`,
    systolic && diastolic && `BP ${Number(systolic.value)}/${Number(diastolic.value)}`,
    pulse && `pulse ${Number(pulse.value)}`,
  ].filter(Boolean);
  const dates = [height, weight, systolic, pulse].filter(Boolean).map((o) => o!.at);
  return { text: parts.join(' · '), date: dates.sort().at(-1) };
}

/** One visit in full, used on the Visits tab. */
function EncounterCard({
  encounter: e,
  expanded = false,
  canAmend = false,
  onChanged,
}: {
  encounter: Encounter;
  expanded?: boolean;
  canAmend?: boolean;
  onChanged?: () => void;
}) {
  const [labelling, setLabelling] = useState(false);
  const [amending, setAmending] = useState(false);
  return (
    <details className="timeline-card panel" open={expanded}>
      <summary>
        <span>
          <strong>{e.chief_complaint}</strong>
          <span className="muted">
            {VISIT_TITLES[e.visit_type ?? ''] ?? 'Visit'} · {e.clinician_name || 'Clinic clinician'} ·{' '}
            <span className={`badge ${e.amendments?.length ? 'b-amber' : 'b-green'}`}>
              {e.amendments?.length ? 'Amended' : 'Final'}
            </span>
          </span>
        </span>
        <time>{dateTime(e.occurred_at)}</time>
      </summary>
      <div className="visit-detail">
        {[
          ['Complaint', e.chief_complaint],
          ['Symptoms', e.symptoms],
          ['History', e.history],
          ['Assessment', e.assessment],
          ['Doctor’s notes', e.internal_notes],
        ].map(
          ([label, value]) =>
            value && (
              <div key={label}>
                <strong>{label}</strong>
                <p className="prewrap">{value}</p>
              </div>
            ),
        )}
        {!!e.observations.length && <p className="muted">{measurementLine([e]).text}</p>}
        {e.prescriptions.map((rx) => (
          <div className="prescription" key={rx.id}>
            <h4>{rx.dosage_line ? `Envelope: ${rx.dosage_line}` : 'Prescription'}</h4>
            {rx.items.map((item) => (
              <p key={item.id}>
                <strong>
                  {item.medicine_name_snapshot} {item.potency}
                </strong>
                {(item.dose || item.frequency) &&
                  ` — ${[item.dose, item.frequency, item.duration].filter(Boolean).join(', ')}`}
                {item.instructions && (
                  <>
                    <br />
                    {item.instructions}
                  </>
                )}
              </p>
            ))}
            {rx.instructions && <p className="prewrap">{rx.instructions}</p>}
          </div>
        ))}
        {!!e.products?.length && (
          <div className="prescription">
            <h4>Products and supplements</h4>
            {e.products.map((product) => (
              <p key={product.id}>
                {product.name} × {Number(product.quantity)} · {money(product.rate)}
                {product.note && <span className="muted"> · {product.note}</span>}
              </p>
            ))}
          </div>
        )}
        {e.follow_up_date && (
          <p>
            <strong>Follow-up:</strong> {shortDate(e.follow_up_date)}
          </p>
        )}
        {e.amendments?.map((amendment) => (
          <div className="warning" key={amendment.id}>
            <strong>Amendment · {SECTION_LABELS[amendment.section] ?? amendment.section}</strong>
            <p className="prewrap">{amendment.correction}</p>
            <span className="muted">
              {amendment.author_name} · {shortDate(amendment.created_at)} · Reason: {amendment.reason}
            </span>
          </div>
        ))}
        {e.invoice && (
          <p>
            <Link to={`/billing/invoices/${e.invoice.id}`}>
              {e.invoice.state === 'draft' ? 'Draft bill for this visit' : `Bill ${e.invoice.number}`}
            </Link>
          </p>
        )}
        <p className="actions">
          {canAmend && (
            <button type="button" className="secondary btn-sm" onClick={() => setAmending(true)}>
              Amend
            </button>
          )}
          {!!e.prescriptions.length && (
            <button type="button" className="secondary btn-sm" onClick={() => setLabelling(true)}>
              Print labels
            </button>
          )}
          <Link className="button secondary btn-sm" to={`/print/prescription/${e.id}`}>
            Print prescription
          </Link>
        </p>
        {labelling && <PrintLabelsWindow encounterId={e.id} onClose={() => setLabelling(false)} />}
        {amending && (
          <AmendVisit
            visit={e}
            onClose={() => setAmending(false)}
            onSaved={() => {
              setAmending(false);
              onChanged?.();
            }}
          />
        )}
      </div>
    </details>
  );
}

const CHIPS = [
  ['', 'All'],
  ['visit', 'Visits'],
  ['prescription', 'Prescriptions'],
  ['invoice', 'Billing'],
  ['appointment', 'Appointments'],
  ['message', 'Messages'],
  ['note', 'Notes'],
  ['document', 'Documents'],
] as const;
type ChipKey = (typeof CHIPS)[number][0];
const DOTS: Record<TimelineItem['kind'], string> = {
  visit: 'V',
  invoice: 'B',
  note: 'N',
  document: 'D',
  appointment: 'A',
  message: 'M',
};

function Timeline({
  patient,
  role,
  turn,
  onChanged,
}: {
  patient: Patient;
  role: Role;
  turn: number;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [chip, setChip] = useState<ChipKey>('');
  const [adding, setAdding] = useState<'' | 'note' | 'document'>('');
  const [viewing, setViewing] = useState<{ id: string; title: string; mime_type: string } | null>(null);
  const [amending, setAmending] = useState<Encounter | null>(null);
  const [labelling, setLabelling] = useState('');
  const [paying, setPaying] = useState<Extract<TimelineItem, { kind: 'invoice' }> | null>(null);
  const clinical = canReadClinical(role);
  useEffect(() => {
    const controller = new AbortController();
    api<{ items: TimelineItem[]; more: boolean }>(`patients/${patient.id}/feed/`, { signal: controller.signal })
      .then((feed) => {
        setItems(feed.items ?? []);
        setMore(!!feed.more);
        setError('');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, [patient.id, turn]);
  async function earlier() {
    if (!items?.length) return;
    setBusy(true);
    try {
      const feed = await api<{ items: TimelineItem[]; more: boolean }>(
        `patients/${patient.id}/feed/?before=${encodeURIComponent(items[items.length - 1].at)}`,
      );
      setItems([
        ...items,
        ...feed.items.filter((item) => !items.some((old) => old.kind === item.kind && old.id === item.id)),
      ]);
      setMore(feed.more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const shown = (items ?? []).filter(
    (item) =>
      !chip ||
      item.kind === chip ||
      (chip === 'prescription' && item.kind === 'visit' && !!item.visit?.prescriptions.length),
  );
  const present = new Set((items ?? []).map((item) => item.kind));
  const card = (item: TimelineItem): ReactNode => {
    if (item.kind === 'visit') {
      const visit = item.visit;
      return (
        <>
          <div className="heading card-head">
            <span>
              <strong>{VISIT_TITLES[item.visit_type] ?? 'Visit'}</strong> · {item.clinician_name}{' '}
              <StatusLabel tone="green">Final</StatusLabel>{' '}
              {item.amended_at && <StatusLabel>Amended {shortDate(item.amended_at).slice(0, 6)}</StatusLabel>}
            </span>
            {visit && (
              <span className="actions small">
                <Link to={`/patients/${patient.id}?tab=visits`}>Open</Link>
                {canWriteClinical(role) && (
                  <button type="button" className="link-button" onClick={() => setAmending(visit)}>
                    Amend
                  </button>
                )}
                <Link to={`/print/prescription/${item.id}`}>Print prescription</Link>
              </span>
            )}
          </div>
          {visit ? (
            <>
              <p>
                <span className="muted">Complaint</span> {visit.chief_complaint}
              </p>
              {(!!visit.prescriptions.length || !!visit.products?.length) && (
                <table className="small rx-table">
                  <tbody>
                    {visit.prescriptions.map((rx, index) => (
                      <tr key={rx.id ?? index}>
                        <td>
                          Envelope {index + 1} · {medicines(rx)}
                        </td>
                        <td>{rx.dosage_line}</td>
                        <td className="right">
                          <button type="button" className="link-button" onClick={() => setLabelling(item.id)}>
                            Label
                          </button>
                        </td>
                      </tr>
                    ))}
                    {visit.products?.map((product) => (
                      <tr key={product.id}>
                        <td>Product · {product.name}</td>
                        <td>{product.note}</td>
                        <td className="right muted">{visit.invoice ? 'On bill' : 'Not billed yet'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {visit.amendments?.map((amendment) => (
                <p className="muted small" key={amendment.id}>
                  Amendment ({SECTION_LABELS[amendment.section] ?? amendment.section}): {amendment.correction}
                </p>
              ))}
            </>
          ) : (
            <p className="muted nonclinical">Clinical details are visible to doctors only.</p>
          )}
        </>
      );
    }
    if (item.kind === 'invoice') {
      const state = item.state as InvoiceState;
      return (
        <>
          <strong>Invoice {item.number}</strong> · {money(item.total)}{' '}
          <StatusLabel tone={STATE_TONES[state]}>{STATE_LABELS[state] ?? item.state}</StatusLabel>
          {Number(item.paid) > 0 &&
            ` · ${money(item.paid)} received${item.method ? ` by ${METHOD_LABELS[item.method as PayMethod] ?? item.method}` : ''}`}
          <div className="actions small card-actions">
            <Link to={`/billing/invoices/${item.id}`}>Open</Link>
            {Number(item.balance) > 0 && canTakePayments(role) && (
              <button type="button" className="link-button" onClick={() => setPaying(item)}>
                Record payment
              </button>
            )}
            <Link to={`/print/invoice/${item.id}`}>Print</Link>
          </div>
        </>
      );
    }
    if (item.kind === 'note')
      return (
        <>
          <strong>{item.note_kind === 'general' ? 'Note' : 'Clinical note'}</strong> · {item.author_name}
          <p className="prewrap card-text">{item.body}</p>
        </>
      );
    if (item.kind === 'document')
      return (
        <>
          <strong>Document</strong> · {item.title} ({item.mime_type === 'application/pdf' ? 'PDF' : 'picture'}){' '}
          <button type="button" className="link-button" onClick={() => setViewing(item)}>
            View
          </button>
        </>
      );
    if (item.kind === 'appointment')
      return (
        <>
          <strong>
            {item.walk_in
              ? 'Walk-in'
              : VISIT_TITLES[item.visit_type]
                ? `${VISIT_TITLES[item.visit_type].replace(' visit', '')} appointment`
                : 'Appointment'}
          </strong>{' '}
          · {dateTime(item.at).slice(-5)}
          {item.doctor_name && ` with ${item.doctor_name}`}{' '}
          <StatusLabel
            tone={
              item.status === 'booked'
                ? 'grey'
                : item.status === 'cancelled' || item.status === 'no_show'
                  ? 'red'
                  : 'green'
            }
          >
            {item.status.replace('_', '-').replace(/^./, (letter) => letter.toUpperCase())}
          </StatusLabel>
          <div className="actions small card-actions">
            <Link to={`/appointments?day=${item.at.slice(0, 10)}`}>Open the day</Link>
          </div>
        </>
      );
    return (
      <>
        <strong>WhatsApp · {item.title}</strong>{' '}
        <StatusLabel tone={statusOfMessage({ status: item.status, blocked: '' })[0]}>
          {statusOfMessage({ status: item.status, blocked: '' })[1]}
        </StatusLabel>
        <p className="muted card-text">“{item.body}”</p>
      </>
    );
  };
  return (
    <>
      <div className="toolbar">
        <strong>Timeline</strong>
        {CHIPS.filter(
          ([key]) =>
            key === '' ||
            present.has(key as TimelineItem['kind']) ||
            (key === 'prescription' ? clinical : ['visit', 'note'].includes(key)),
        ).map(([key, label]) => (
          <Chip key={key} on={chip === key} onClick={() => setChip(key)}>
            {label}
          </Chip>
        ))}
        <span className="spacer" />
        {(canWriteDemographics(role) || canWriteClinical(role)) && (
          <button type="button" className="secondary btn-sm" onClick={() => setAdding('note')}>
            Add note
          </button>
        )}
        {clinical && (
          <button type="button" className="secondary btn-sm" onClick={() => setAdding('document')}>
            Add document
          </button>
        )}
      </div>
      <ErrorMessage message={error} />
      {!items && !error && <p role="status">Loading the timeline…</p>}
      {items && !shown.length && (
        <p className="panel empty">
          {items.length
            ? 'Nothing of this kind yet.'
            : 'Nothing has happened yet. Visits, bills, notes and documents appear here as they are added.'}
        </p>
      )}
      <ul className="timeline" aria-label="Timeline">
        {shown.map((item) => (
          <li key={`${item.kind}-${item.id}`}>
            <time>{shortDate(item.at)}</time>
            <span className="dot" aria-hidden="true">
              {DOTS[item.kind]}
            </span>
            <div className="card">{card(item)}</div>
          </li>
        ))}
      </ul>
      {more && (
        <p className="right">
          <button type="button" className="secondary" disabled={busy} onClick={earlier}>
            Load earlier
          </button>
        </p>
      )}
      {adding === 'note' && (
        <AddNote
          patientId={patient.id}
          role={role}
          onClose={() => setAdding('')}
          onSaved={() => {
            setAdding('');
            onChanged();
          }}
        />
      )}
      {adding === 'document' && (
        <AddDocument
          patientId={patient.id}
          onClose={() => setAdding('')}
          onSaved={() => {
            setAdding('');
            onChanged();
          }}
        />
      )}
      {viewing && <ViewDocument document={viewing} onClose={() => setViewing(null)} />}
      {labelling && <PrintLabelsWindow encounterId={labelling} onClose={() => setLabelling('')} />}
      {amending && (
        <AmendVisit
          visit={amending}
          onClose={() => setAmending(null)}
          onSaved={() => {
            setAmending(null);
            onChanged();
          }}
        />
      )}
      {paying && (
        <RecordPayment
          bill={{ id: paying.id, number: paying.number, balance: paying.balance, name: displayName(patient) }}
          onClose={() => setPaying(null)}
          onSaved={() => {
            setPaying(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function RememberPanel({ patient }: { patient: Patient }) {
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api<Page<Note>>(`notes/?patient=${patient.id}&kind=remember`, { signal: controller.signal })
      .then((page) => setNotes(page.results ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [patient.id]);
  return (
    <div className="remember compact">
      <strong>Remember about {patient.first_name}</strong>
      {notes.length ? (
        <ul>
          {notes.map((note) => (
            <li key={note.id}>{note.body}</li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nothing yet.</p>
      )}
      <p className="small">
        <Link to={`/patients/${patient.id}/encounters/new`}>Add during a visit</Link> · doctors only
      </p>
    </div>
  );
}

type Window_ =
  | ''
  | 'archive'
  | 'card'
  | 'consent'
  | 'family'
  | 'alert'
  | 'history'
  | 'measurements'
  | 'note'
  | 'document'
  | 'book'
  | 'message';

export function PatientProfile({
  role,
  billingOn = true,
  diaryOn = false,
  messagesOn = false,
}: {
  role: Role;
  billingOn?: boolean;
  diaryOn?: boolean;
  messagesOn?: boolean;
}) {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [moreEncounters, setMoreEncounters] = useState(false);
  const [encounterPage, setEncounterPage] = useState(1);
  const [notes, setNotes] = useState<Note[]>([]);
  const [documents, setDocuments] = useState<PatientDocument[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Window_>('');
  const [viewing, setViewing] = useState<PatientDocument | null>(null);
  const [turn, setTurn] = useState(0);
  // A visit that was just finalised with "Print envelope label" ticked opens the label window once.
  const [labelsFor, setLabelsFor] = useState<string>(location.state?.labels ?? '');
  // ...and with "Book the next appointment" ticked, the booking window follows, on the advised day.
  const [bookDay, setBookDay] = useState<string>(location.state?.book ?? '');
  const [success, setSuccess] = useState<string>(location.state?.message ?? '');
  const clinical = canReadClinical(role);
  const doctor = canWriteClinical(role);
  const billing = billingOn && canUseBilling(role);
  const tabs = [
    'overview',
    ...(clinical ? ['visits', 'prescriptions'] : []),
    'notes',
    ...(billing ? ['billing'] : []),
    ...(messagesOn ? ['messages'] : []),
    ...(clinical ? ['documents'] : []),
  ];
  const tab = tabs.includes(params.get('tab') || '') ? params.get('tab')! : 'overview';
  const refresh = useCallback(() => setTurn((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    setError('');
    Promise.all([
      api<Patient>(`patients/${id}/`, options),
      clinical ? api<Page<Encounter>>(`encounters/?patient=${id}`, options) : null,
      api<Page<Note>>(`notes/?patient=${id}`, options),
      clinical ? api<{ results: PatientDocument[] }>(`patients/${id}/documents/`, options) : null,
    ])
      .then(([person, visits, noteList, documentList]) => {
        setPatient(person);
        setEncounters(visits?.results ?? []);
        setMoreEncounters(!!visits?.next);
        setEncounterPage(1);
        setNotes((noteList.results ?? []).filter((note) => note.kind !== 'remember'));
        setDocuments(documentList?.results ?? []);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, clinical, turn]);
  // Opening another patient starts from a clean page.
  useEffect(() => {
    setLoading(true);
    setPatient(null);
  }, [id]);

  async function olderVisits() {
    setBusy(true);
    try {
      const page = await api<Page<Encounter>>(`encounters/?patient=${id}&page=${encounterPage + 1}`);
      setEncounters((old) => [...old, ...page.results.filter((e) => !old.some((x) => x.id === e.id))]);
      setEncounterPage(encounterPage + 1);
      setMoreEncounters(!!page.next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (loading && !patient) return <p role="status">Loading patient…</p>;
  if (!patient)
    return (
      <>
        <Link to="/patients">← Patient list</Link>
        <ErrorMessage message={error || 'Patient not found.'} />
      </>
    );
  const name = displayName(patient);
  const latestPhoto = [...patient.photos].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const years = age(patient.date_of_birth);
  const measured = measurementLine(encounters);
  const prescriptions = encounters.flatMap((e) => e.prescriptions.map((rx, index) => ({ rx, index, encounter: e })));
  const owed = Number(patient.balance ?? 0);
  const more: MenuItem[] = [
    ...(canWriteDemographics(role)
      ? [
          { label: 'Edit details', to: `/patients/${patient.id}/edit` },
          ...(diaryOn && !patient.archived_at ? [{ label: 'Book appointment', onSelect: () => setOpen('book') }] : []),
          ...(patient.identifier ? [{ label: 'Print patient card', to: `/print/card/${patient.id}` }] : []),
          { label: 'Replace lost card', onSelect: () => setOpen('card') },
          { label: 'Message consent…', onSelect: () => setOpen('consent') },
          { label: 'Family…', onSelect: () => setOpen('family') },
        ]
      : []),
    ...(role === 'owner' || canWriteDemographics(role)
      ? [{ label: 'Change history', onSelect: () => setOpen('history') }]
      : []),
    ...(doctor
      ? ([
          'sep',
          patient.archived_at
            ? { label: 'Restore patient', onSelect: () => setOpen('archive') }
            : { label: 'Archive patient', danger: true, onSelect: () => setOpen('archive') },
        ] as MenuItem[])
      : []),
  ];
  const update = (changed: Patient) => setPatient((old) => (old ? { ...old, ...changed } : changed));
  return (
    <>
      {labelsFor && <PrintLabelsWindow encounterId={labelsFor} onClose={() => setLabelsFor('')} />}
      <p>
        <Link to={location.state?.returnTo || '/patients'}>← Patient list</Link>
      </p>
      <ErrorMessage message={error} />
      {success && (
        <p className="success" role="status">
          {success}
        </p>
      )}
      <div className="patient-banner record-banner">
        {latestPhoto ? (
          <img className="photo" alt="Patient photo" src={`/api/v1/photos/${latestPhoto.id}/`} />
        ) : (
          <Avatar name={name} large />
        )}
        <div>
          <h1>{name}</h1>
          <p>
            {[sexWord(patient.gender), years !== null && `${years} years`, patient.phone].filter(Boolean).join(' · ')}
            {patient.identifier && (
              <>
                {' · '}
                <span className="mono patient-code">{patient.identifier}</span>
              </>
            )}
          </p>
          <p className="small muted">
            {patient.archived_at && <StatusLabel tone="grey">Archived {shortDate(patient.archived_at)}</StatusLabel>}{' '}
            Last visit {patient.last_visit ? shortDate(patient.last_visit) : 'never'}
            {patient.next_advised && ` · Next advised ${shortDate(patient.next_advised)}`}
            {billing && owed > 0 && (
              <>
                {' · '}
                <StatusLabel tone="amber">Balance due {money(owed)}</StatusLabel>
              </>
            )}
            {patient.consent?.care?.granted && (
              <>
                {' '}
                <StatusLabel tone="green">WhatsApp consent: care</StatusLabel>
              </>
            )}
          </p>
        </div>
        <span className="spacer" />
        <div className="actions">
          {doctor && !patient.archived_at && (
            <Link state={location.state} className="button" to={`/patients/${id}/encounters/new`}>
              New visit
            </Link>
          )}
          {billing && !patient.archived_at && (
            <button
              type="button"
              className="secondary"
              onClick={() => navigate('/billing/new', { state: { patient: { id: patient.id, name } } })}
            >
              New invoice
            </button>
          )}
          {messagesOn && !patient.archived_at && (
            <button type="button" className="secondary" onClick={() => setOpen('message')}>
              Message
            </button>
          )}
          {!!more.length && <Menu label="More ▾" items={more} />}
        </div>
      </div>
      <nav className="patient-tabs" aria-label="Patient record">
        {tabs.map((key) => (
          <Link
            key={key}
            to={key === 'overview' ? '?' : `?tab=${key}`}
            state={location.state}
            aria-current={tab === key ? 'page' : undefined}
            className={tab === key ? 'active' : ''}
          >
            {key[0].toUpperCase() + key.slice(1)}
          </Link>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="cols cols-side">
          <aside className="panel">
            <div className="heading">
              <h2>Details</h2>
              {canWriteDemographics(role) && <Link to={`/patients/${patient.id}/edit`}>Edit</Link>}
            </div>
            <dl>
              <dt>Date of birth</dt>
              <dd>{shortDate(patient.date_of_birth) || 'Not recorded'}</dd>
              <dt>Phone · WhatsApp</dt>
              <dd>
                {patient.phone || <span className="muted">Not recorded</span>}
                {patient.whatsapp_number &&
                  patient.whatsapp_number !== patient.phone &&
                  ` · ${patient.whatsapp_number}`}
              </dd>
              <dt>Email</dt>
              <dd>{patient.email || <span className="muted">Not recorded</span>}</dd>
              <dt>Address</dt>
              <dd>
                {patient.address ? (
                  [
                    patient.address.line1,
                    patient.address.line2,
                    patient.address.city,
                    patient.address.region,
                    patient.address.postal_code,
                  ]
                    .filter(Boolean)
                    .join(', ')
                ) : (
                  <span className="muted">Not recorded</span>
                )}
              </dd>
              <dt>Family</dt>
              <dd>
                {patient.family?.length ? (
                  patient.family.map((member, index) => (
                    <span key={member.id}>
                      {index > 0 && ', '}
                      <Link to={`/patients/${member.patient}`}>{member.name}</Link>
                      {member.relation && ` (${member.relation})`}
                    </span>
                  ))
                ) : (
                  <span className="muted">None linked</span>
                )}
              </dd>
              {clinical && (
                <>
                  <dt>Latest measurements</dt>
                  <dd>
                    {measured.text || <span className="muted">None recorded</span>}
                    {measured.text && (
                      <>
                        <br />
                        <span className="muted small">
                          {shortDate(measured.date)} ·{' '}
                          <button type="button" className="link-button" onClick={() => setOpen('measurements')}>
                            history
                          </button>
                        </span>
                      </>
                    )}
                  </dd>
                </>
              )}
              {(patient.referred_by || patient.old_file_number) && (
                <>
                  <dt>Referred by · old file</dt>
                  <dd>{[patient.referred_by, patient.old_file_number].filter(Boolean).join(' · ')}</dd>
                </>
              )}
              <dt>Registered</dt>
              <dd>{shortDate(patient.created_at)}</dd>
            </dl>
            {clinical && (patient.alert || doctor) && (
              <div className={patient.alert ? 'warning' : 'muted small'}>
                {patient.alert && (
                  <>
                    <strong>Alert</strong>
                    <br />
                    {patient.alert}{' '}
                  </>
                )}
                {doctor && (
                  <button type="button" className="link-button" onClick={() => setOpen('alert')}>
                    {patient.alert ? 'Edit alerts' : 'Add an alert'}
                  </button>
                )}
              </div>
            )}
            {doctor && <RememberPanel patient={patient} />}
          </aside>
          <div>
            <Timeline patient={patient} role={role} turn={turn} onChanged={refresh} />
          </div>
        </div>
      )}

      {tab === 'visits' && (
        <section aria-label="visits content">
          <div className="heading">
            <h2>Visits</h2>
            <span className="muted">Latest first · Open a visit for details</span>
          </div>
          {!encounters.length && (
            <p className="panel muted">No visits yet. Start a new visit to record a consultation.</p>
          )}
          {encounters.map((e, i) => (
            <EncounterCard key={e.id} encounter={e} expanded={i === 0} canAmend={doctor} onChanged={refresh} />
          ))}
          {moreEncounters && (
            <button disabled={busy} className="secondary" onClick={olderVisits}>
              Load older visits
            </button>
          )}
        </section>
      )}

      {tab === 'prescriptions' && (
        <section aria-label="prescriptions content">
          <h2>Prescriptions</h2>
          {!prescriptions.length && (
            <p className="panel muted">
              No prescriptions in the loaded visits. Envelopes are added while writing a visit.
            </p>
          )}
          {!!prescriptions.length && (
            <div className="panel flush">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Envelope</th>
                      <th>Medicines</th>
                      <th>How to take it</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {prescriptions.map(({ rx, index, encounter }) => (
                      <tr key={rx.id}>
                        <td>{shortDate(encounter.occurred_at)}</td>
                        <td>Envelope {index + 1}</td>
                        <td>{medicines(rx)}</td>
                        <td>{rx.dosage_line}</td>
                        <td className="right">
                          <button type="button" className="link-button" onClick={() => setLabelsFor(encounter.id)}>
                            Label
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {moreEncounters && (
            <button disabled={busy} className="secondary" onClick={olderVisits}>
              Load older visits
            </button>
          )}
        </section>
      )}

      {tab === 'messages' && messagesOn && <PatientMessages patient={{ id: patient.id, name }} role={role} />}
      {tab === 'notes' && (
        <section aria-label="notes content">
          <div className="heading">
            <h2>Patient notes</h2>
            {(canWriteDemographics(role) || doctor) && (
              <button type="button" className="secondary" onClick={() => setOpen('note')}>
                Add note
              </button>
            )}
          </div>
          <p className="muted">Notes are never edited. Add another note to clarify an earlier one.</p>
          {!notes.length && <p className="panel muted">No patient notes yet.</p>}
          {notes.map((n) => (
            <article className="panel" key={n.id}>
              <div className="heading">
                <h3>{n.kind === 'general' ? 'Note' : 'Clinical note'}</h3>
                <time>{dateTime(n.created_at)}</time>
              </div>
              <p className="prewrap">{n.body}</p>
              <p className="muted">{n.author_name || 'Clinic staff'}</p>
            </article>
          ))}
        </section>
      )}

      {tab === 'billing' && billing && <PatientBilling patientId={patient.id} patientName={name} role={role} />}

      {tab === 'documents' && (
        <section aria-label="documents content">
          <div className="heading">
            <h2>Documents</h2>
            <button type="button" className="secondary" onClick={() => setOpen('document')}>
              Add document
            </button>
          </div>
          {!documents.length && (
            <p className="panel muted">No documents yet. Lab reports and other papers are kept here.</p>
          )}
          {documents.map((document) => (
            <div className="panel row-panel" key={document.id}>
              <span>
                <strong>{document.title}</strong>
                <span className="muted">
                  {document.mime_type === 'application/pdf' ? 'PDF' : 'Picture'} · {shortDate(document.created_at)}
                  {document.uploaded_by_name && ` · ${document.uploaded_by_name}`}
                </span>
              </span>
              <button type="button" className="secondary btn-sm" onClick={() => setViewing(document)}>
                View
              </button>
            </div>
          ))}
        </section>
      )}

      {open === 'archive' && (
        <ArchivePatient
          patient={patient}
          onClose={() => setOpen('')}
          onDone={(changed) => {
            setOpen('');
            update(changed);
            setSuccess(changed.archived_at ? 'Patient archived.' : 'Patient restored.');
          }}
        />
      )}
      {open === 'card' && (
        <ReplaceCard
          patient={patient}
          onClose={() => setOpen('')}
          onDone={(changed) => {
            setOpen('');
            update(changed);
            notify('A new card code was made. Print the new card.');
          }}
        />
      )}
      {open === 'consent' && (
        <ConsentWindow
          patient={patient}
          onClose={() => setOpen('')}
          onSaved={(consent) => {
            setOpen('');
            setPatient({ ...patient, consent });
          }}
        />
      )}
      {open === 'family' && (
        <FamilyWindow
          patient={patient}
          onClose={() => setOpen('')}
          onChanged={(family) => setPatient({ ...patient, family })}
        />
      )}
      {open === 'alert' && (
        <AlertWindow
          patient={patient}
          onClose={() => setOpen('')}
          onSaved={(changed) => {
            setOpen('');
            update(changed);
          }}
        />
      )}
      {open === 'history' && <ChangeHistory patient={patient} onClose={() => setOpen('')} />}
      {open === 'message' && (
        <WriteMessage
          role={role}
          patient={{ id: patient.id, name }}
          onClose={() => setOpen('')}
          onDone={() => {
            setOpen('');
            refresh();
          }}
        />
      )}
      {(open === 'book' || (!!bookDay && !labelsFor && diaryOn)) && (
        <BookingWindow
          role={role}
          patient={{ id: patient.id, name }}
          day={bookDay || undefined}
          onClose={() => {
            setOpen('');
            setBookDay('');
          }}
          onBooked={() => {
            setOpen('');
            setBookDay('');
            refresh();
          }}
        />
      )}
      {open === 'measurements' && <MeasurementHistory patient={patient} onClose={() => setOpen('')} />}
      {open === 'note' && (
        <AddNote
          patientId={patient.id}
          role={role}
          onClose={() => setOpen('')}
          onSaved={(note) => {
            setOpen('');
            setNotes((old) => [note, ...old]);
            setSuccess('Note saved.');
          }}
        />
      )}
      {open === 'document' && (
        <AddDocument
          patientId={patient.id}
          onClose={() => setOpen('')}
          onSaved={(document) => {
            setOpen('');
            setDocuments((old) => [document, ...old]);
          }}
        />
      )}
      {viewing && <ViewDocument document={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
