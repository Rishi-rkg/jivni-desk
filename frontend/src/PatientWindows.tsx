/** Floating windows of the patient record: photo, import, archive, consent, family, alert, notes, documents, history. */
import { FormEvent, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ErrorMessage } from './components';
import { dateTime, shortDate } from './format';
import { ConsentAnswer, Note, Page, Patient, PatientDocument, Role, canWriteClinical, displayName } from './types';
import { Modal, SettingRow, StatusLabel, Switch, notify, useLoad } from './ui';

/* ---------- W6: patient photo ---------- */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface FaceFinder {
  detect(source: CanvasImageSource): Promise<{ boundingBox: Box }[]>;
}
/** The browser's own face finder, where it has one. Nothing is sent anywhere: it runs on this computer. */
function faceFinder(): FaceFinder | null {
  const Maker = (window as unknown as { FaceDetector?: new (options?: object) => FaceFinder }).FaceDetector;
  try {
    return Maker ? new Maker({ fastMode: true, maxDetectedFaces: 3 }) : null;
  } catch {
    return null;
  }
}

/**
 * The square to keep from a picture. Around the face when one was found (with room for hair and
 * shoulders); otherwise the middle of the picture, a little above centre, where a face usually is.
 */
export function cropSquare(width: number, height: number, face: Box | null, zoom = 1): Box {
  let side: number;
  let cx: number;
  let cy: number;
  if (face) {
    side = Math.max(face.width, face.height) * 2;
    cx = face.x + face.width / 2;
    cy = face.y + face.height / 2 + face.height * 0.1;
  } else {
    side = Math.min(width, height) * 0.8;
    cx = width / 2;
    cy = height * 0.45;
  }
  side = Math.min(side / zoom, width, height);
  const x = Math.min(Math.max(cx - side / 2, 0), width - side);
  const y = Math.min(Math.max(cy - side / 2, 0), height - side);
  return { x, y, width: side, height: side };
}

const PHOTO_SIDE = 600;

export function PhotoWindow({ onClose, onUse }: { onClose: () => void; onUse: (photo: Blob) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const shot = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<'starting' | 'live' | 'blocked'>('starting');
  const [taken, setTaken] = useState(false);
  const [face, setFace] = useState<Box | null>(null);
  const [message, setMessage] = useState('');
  const [zoom, setZoom] = useState(1);
  const [adjusting, setAdjusting] = useState(false);

  useEffect(() => {
    let stopped = false;
    if (!navigator.mediaDevices?.getUserMedia) setCamera('blocked');
    else
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
        .then((media) => {
          if (stopped) return media.getTracks().forEach((track) => track.stop());
          stream.current = media;
          if (video.current) {
            video.current.srcObject = media;
            video.current.play().catch(() => {});
          }
          setCamera('live');
        })
        .catch(() => setCamera('blocked'));
    return () => {
      stopped = true;
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  /** Draws the cropped square into the preview. */
  function draw(found: Box | null, scale: number) {
    const source = shot.current;
    const target = preview.current;
    if (!source || !target) return;
    const box = cropSquare(source.width, source.height, found, scale);
    target.width = PHOTO_SIDE;
    target.height = PHOTO_SIDE;
    target.getContext('2d')?.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, PHOTO_SIDE, PHOTO_SIDE);
  }
  async function examine() {
    const source = shot.current;
    if (!source) return;
    const finder = faceFinder();
    let found: Box | null = null;
    let text = '';
    if (finder) {
      try {
        const faces = await finder.detect(source);
        if (faces.length > 1) text = 'More than one face, only the patient please.';
        else if (!faces.length) text = 'No face found. Move closer and look at the camera, or adjust the crop by hand.';
        else found = faces[0].boundingBox;
      } catch {
        text = '';
      }
    } else
      text =
        'This browser cannot find faces by itself, so the middle of the picture was kept. Adjust the crop if it looks wrong.';
    setFace(found);
    setMessage(text);
    setZoom(1);
    setTaken(true);
    draw(found, 1);
  }
  function capture() {
    const frame = video.current;
    const canvas = shot.current;
    if (!frame || !canvas || !frame.videoWidth) return;
    canvas.width = frame.videoWidth;
    canvas.height = frame.videoHeight;
    canvas.getContext('2d')?.drawImage(frame, 0, 0);
    examine();
  }
  function fromFile(file: File | undefined) {
    if (!file) return;
    const image = new Image();
    const address = URL.createObjectURL(file);
    image.onload = () => {
      const canvas = shot.current;
      if (canvas) {
        const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        examine();
      }
      URL.revokeObjectURL(address);
    };
    image.onerror = () => {
      setMessage('That file is not a picture this browser can open. Use a JPEG or PNG.');
      URL.revokeObjectURL(address);
    };
    image.src = address;
  }
  function use() {
    preview.current?.toBlob((blob) => blob && onUse(blob), 'image/jpeg', 0.9);
  }
  return (
    <Modal
      title="Patient photo"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <input
            ref={picker}
            type="file"
            accept="image/jpeg,image/png"
            aria-label="Photo file"
            hidden
            onChange={(e) => fromFile(e.target.files?.[0])}
          />
          <button type="button" className="secondary" onClick={() => picker.current?.click()}>
            Upload a file instead
          </button>
          {taken && (
            <>
              <button type="button" className="secondary" onClick={() => setAdjusting(!adjusting)}>
                Adjust crop
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setTaken(false);
                  setMessage('');
                }}
              >
                Retake
              </button>
              <button type="button" onClick={use}>
                Use photo
              </button>
            </>
          )}
          {!taken && camera === 'live' && (
            <button type="button" onClick={capture}>
              Take photo
            </button>
          )}
        </>
      }
    >
      <div className="camera" hidden={taken}>
        <video ref={video} muted playsInline aria-label="Camera preview" />
        {camera === 'starting' && <span>Starting the camera…</span>}
        {camera === 'blocked' && (
          <span>Allow camera access in the browser to take a photo here, or upload a file instead.</span>
        )}
      </div>
      <canvas ref={shot} hidden />
      <div className="photo-result" hidden={!taken}>
        <canvas ref={preview} aria-label="Cropped photo" />
        {face && <StatusLabel tone="green">Face found</StatusLabel>}
      </div>
      {taken && adjusting && (
        <label className="crop-zoom">
          Closer or wider
          <input
            type="range"
            min={0.6}
            max={2.5}
            step={0.05}
            value={zoom}
            onChange={(e) => {
              const value = Number(e.target.value);
              setZoom(value);
              draw(face, value);
            }}
          />
        </label>
      )}
      {message && <p className="info small">{message}</p>}
      <p className="small muted">
        The photo is cropped to the face on this computer and nothing is sent anywhere else. Retake or adjust only if it
        looks wrong.
      </p>
    </Modal>
  );
}

/* ---------- W12: import patients, three steps ---------- */

/** Splits spreadsheet text (CSV) into rows of cells, honouring quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  // Spreadsheet programs often start a file with an invisible byte-order mark.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',' || char === ';' || char === '\t') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

const IMPORT_FIELDS: [string, string, RegExp][] = [
  ['first_name', 'First name', /^(first|given|name$|patient ?name)/i],
  ['middle_name', 'Middle name', /middle/i],
  ['last_name', 'Last name', /(last|sur|family) ?name/i],
  ['date_of_birth', 'Date of birth', /(birth|dob)/i],
  ['gender', 'Sex', /(sex|gender)/i],
  ['phone', 'Phone', /(phone|mobile|contact)/i],
  ['whatsapp_number', 'WhatsApp number', /whats/i],
  ['email', 'Email', /e-?mail/i],
  ['old_file_number', 'Old file number', /(file|record|case) ?(no|number|#)/i],
  ['referred_by', 'Referred by', /refer/i],
];
interface ImportReport {
  ready: number;
  duplicates: number;
  errors: { row: number; problem: string }[];
  error_count: number;
  created: number;
}

export function ImportPatients({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState(1);
  const [rows, setRows] = useState<string[][]>([]);
  const [columns, setColumns] = useState<Record<string, number>>({});
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const headings = rows[0] ?? [];
  const body = rows.slice(1);

  function choose(file: File | undefined) {
    if (!file) return;
    setError('');
    file
      .text()
      .then((text) => {
        const parsed = parseCsv(text);
        if (parsed.length < 2)
          return setError('That file has no rows under its headings. Save the spreadsheet as CSV and try again.');
        if (parsed.length > 2001)
          return setError('Import at most 2,000 patients at a time. Split the file and import each part.');
        setRows(parsed);
        // A first guess at which column is which, from the headings.
        const guess: Record<string, number> = {};
        for (const [field, , pattern] of IMPORT_FIELDS) {
          const index = parsed[0].findIndex(
            (heading, at) => pattern.test(heading.trim()) && !Object.values(guess).includes(at),
          );
          if (index >= 0) guess[field] = index;
        }
        setColumns(guess);
        setStep(2);
      })
      .catch(() => setError('That file could not be read.'));
  }
  const mapped = () =>
    body.map((cells) =>
      Object.fromEntries(Object.entries(columns).map(([field, index]) => [field, cells[index] ?? ''])),
    );
  async function run(dryRun: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await api<ImportReport>('patients/import/', {
        method: 'POST',
        body: JSON.stringify({ rows: mapped(), dry_run: dryRun }),
      });
      if (dryRun) {
        setReport(result);
        setStep(3);
      } else {
        notify(`${result.created} patient${result.created === 1 ? '' : 's'} imported.`);
        onDone();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function downloadErrors() {
    if (!report) return;
    const text = [
      'Row,Problem',
      ...report.errors.map((item) => `${item.row},"${item.problem.replace(/"/g, '""')}"`),
    ].join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    link.download = 'import-errors.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }
  const titles = ['choose the file', 'match the columns', 'trial run'];
  return (
    <Modal
      title={`Import patients · step ${step} of 3, ${titles[step - 1]}`}
      size="wide"
      onClose={onClose}
      footer={
        <>
          {step === 3 && !!report?.errors.length && (
            <button type="button" className="secondary" onClick={downloadErrors}>
              Download error list
            </button>
          )}
          {step > 1 && (
            <button type="button" className="secondary" disabled={busy} onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              disabled={busy || columns.first_name === undefined || columns.date_of_birth === undefined}
              onClick={() => run(true)}
            >
              {busy ? 'Checking…' : 'Trial run'}
            </button>
          )}
          {step === 3 && report && (
            <button type="button" disabled={busy || !report.ready} onClick={() => run(false)}>
              {busy ? 'Importing…' : `Import ${report.ready} patient${report.ready === 1 ? '' : 's'}`}
            </button>
          )}
        </>
      }
    >
      <ErrorMessage message={error} />
      {step === 1 && (
        <>
          <p>
            Save the spreadsheet as a CSV file with one patient on each row and headings in the first row. First name
            and date of birth are needed for every patient.
          </p>
          <label>
            Spreadsheet file (CSV)
            <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => choose(e.target.files?.[0])} />
          </label>
          <p className="muted small">Nothing is saved until you have seen the trial run.</p>
        </>
      )}
      {step === 2 && (
        <>
          <p>
            {body.length} row{body.length === 1 ? '' : 's'} found. Say which column of the file holds each detail.
          </p>
          <div className="form-grid two">
            {IMPORT_FIELDS.map(([field, label]) => (
              <label key={field}>
                {label}
                <select
                  aria-label={label}
                  value={columns[field] ?? ''}
                  onChange={(e) => {
                    const next = { ...columns };
                    if (e.target.value === '') delete next[field];
                    else next[field] = Number(e.target.value);
                    setColumns(next);
                  }}
                >
                  <option value="">Not in the file</option>
                  {headings.map((heading, index) => (
                    <option key={index} value={index}>
                      {heading || `Column ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </>
      )}
      {step === 3 && report && (
        <>
          <p className="actions">
            <StatusLabel tone="green">{report.ready} ready</StatusLabel>
            <StatusLabel tone="amber">
              {report.duplicates} possible duplicate{report.duplicates === 1 ? '' : 's'}
            </StatusLabel>
            <StatusLabel tone="red">
              {report.error_count} row{report.error_count === 1 ? '' : 's'} with errors
            </StatusLabel>
          </p>
          {!!report.errors.length && (
            <table className="small">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {report.errors.slice(0, 8).map((item) => (
                  <tr key={item.row}>
                    <td>{item.row}</td>
                    <td>{item.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted">
            Nothing has been saved yet. Possible duplicates (same name and date of birth, or same phone, as someone
            already registered) and rows with errors are left out.
          </p>
        </>
      )}
    </Modal>
  );
}

/* ---------- W15, W24: confirmations ---------- */

export function ArchivePatient({
  patient,
  onClose,
  onDone,
}: {
  patient: Patient;
  onClose: () => void;
  onDone: (patient: Patient) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const restoring = !!patient.archived_at;
  async function go() {
    setBusy(true);
    try {
      onDone(
        await api<Patient>(`patients/${patient.id}/${restoring ? 'restore' : 'archive'}/`, {
          method: 'POST',
          body: '{}',
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      alert
      title={`${restoring ? 'Restore' : 'Archive'} ${displayName(patient)}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={restoring ? undefined : 'danger'} disabled={busy} onClick={go}>
            {restoring ? 'Restore' : 'Archive'}
          </button>
        </>
      }
    >
      <ErrorMessage message={error} />
      <p>
        {restoring
          ? 'The patient returns to the patient list and visits can be recorded again.'
          : 'The record is kept and can be restored. Archived patients do not appear in search unless “Archived” is chosen and receive no messages.'}
      </p>
    </Modal>
  );
}

export function ReplaceCard({
  patient,
  onClose,
  onDone,
}: {
  patient: Patient;
  onClose: () => void;
  onDone: (patient: Patient) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      onDone(await api<Patient>(`patients/${patient.id}/reissue-code/`, { method: 'POST', body: '{}' }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      alert
      title="Replace a lost card?"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={go}>
            Make a new card
          </button>
        </>
      }
    >
      <ErrorMessage message={error} />
      <p>
        The old card <span className="mono">{patient.identifier}</span> stops working at once, and so do bills and
        labels printed with it. {displayName(patient)} gets a new code to print.
      </p>
    </Modal>
  );
}

/* ---------- W23: message consent ---------- */

const CONSENT_KINDS = [
  ['care', 'Care messages', 'Appointment reminders, follow-up check-ins, invoices and receipts.'],
  ['greetings', 'Greetings and clinic news', 'Birthday and festival greetings, announcements, newsletters.'],
] as const;

export function ConsentSwitches({
  value,
  onChange,
  recorded,
}: {
  value: { care: boolean; greetings: boolean };
  onChange: (value: { care: boolean; greetings: boolean }) => void;
  recorded?: Record<'care' | 'greetings', ConsentAnswer | null>;
}) {
  return (
    <>
      {CONSENT_KINDS.map(([kind, title, hint]) => {
        const answer = recorded?.[kind];
        return (
          <SettingRow
            key={kind}
            title={title}
            hint={
              <>
                {hint}
                {answer &&
                  ` ${answer.granted ? 'Agreed' : 'Declined'} ${shortDate(answer.at)}, recorded by ${answer.by}.`}
              </>
            }
            control={
              <Switch label={title} checked={value[kind]} onChange={(on) => onChange({ ...value, [kind]: on })} />
            }
          />
        );
      })}
    </>
  );
}

export function ConsentWindow({
  patient,
  onClose,
  onSaved,
}: {
  patient: Patient;
  onClose: () => void;
  onSaved: (consent: NonNullable<Patient['consent']>) => void;
}) {
  const [value, setValue] = useState({
    care: !!patient.consent?.care?.granted,
    greetings: !!patient.consent?.greetings?.granted,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      onSaved(
        await api<NonNullable<Patient['consent']>>(`patients/${patient.id}/consent/`, {
          method: 'POST',
          body: JSON.stringify(value),
        }),
      );
      notify('Consent recorded.');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Message consent · ${displayName(patient)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={save}>
            Save consent
          </button>
        </>
      }
    >
      <ErrorMessage message={error} />
      <ConsentSwitches value={value} onChange={setValue} recorded={patient.consent} />
      <p className="small muted">
        Each change is recorded with today&apos;s date and your name; earlier answers are kept. Messages never contain a
        diagnosis, symptoms or medicine names.
      </p>
    </Modal>
  );
}

/* ---------- W25: family link ---------- */

export function PatientPicker({
  exclude,
  onPick,
  label = 'Find the patient',
}: {
  exclude?: string;
  onPick: (patient: Patient) => void;
  label?: string;
}) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<Patient[]>([]);
  const query = text.trim();
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<Page<Patient>>(`patients/?search=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((page) => setResults(page.results.filter((patient) => patient.id !== exclude).slice(0, 5)))
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, exclude]);
  return (
    <>
      <label>
        {label}
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Name, phone or patient ID"
          autoComplete="off"
        />
      </label>
      {results.map((patient) => (
        <button type="button" className="pick" key={patient.id} onClick={() => onPick(patient)}>
          <span>
            <strong>{displayName(patient)}</strong>
          </span>
          <span className="mono muted">{patient.identifier}</span>
        </button>
      ))}
      {query.length >= 2 && !results.length && <p className="muted small">No patients match.</p>}
    </>
  );
}

export function FamilyWindow({
  patient,
  onClose,
  onChanged,
}: {
  patient: Patient;
  onClose: () => void;
  onChanged: (family: NonNullable<Patient['family']>) => void;
}) {
  const [relative, setRelative] = useState<Patient | null>(null);
  const [relation, setRelation] = useState('');
  const [error, setError] = useState('');
  const family = patient.family ?? [];
  async function act(work: () => Promise<NonNullable<Patient['family']>>) {
    setError('');
    try {
      onChanged(await work());
      setRelative(null);
      setRelation('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title={`Family of ${displayName(patient)}`}
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose}>
          Done
        </button>
      }
    >
      <ErrorMessage message={error} />
      {family.map((member) => (
        <div className="row" key={member.id}>
          <span>
            <strong>{member.name}</strong>
            {member.relation && <span className="muted">{member.relation}</span>}
          </span>
          <button
            type="button"
            className="link-button"
            onClick={() => act(() => api(`patients/${patient.id}/family/${member.id}/`, { method: 'DELETE' }))}
          >
            Remove link
          </button>
        </div>
      ))}
      {!family.length && <p className="muted">No family members are linked yet.</p>}
      <div className="stack family-add">
        {relative ? (
          <>
            <p>
              Link <strong>{displayName(relative)}</strong>{' '}
              <button type="button" className="link-button" onClick={() => setRelative(null)}>
                Change
              </button>
            </p>
            <label>
              What they are to {patient.first_name}
              <input
                value={relation}
                maxLength={60}
                placeholder="For example: daughter, husband, guardian"
                onChange={(e) => setRelation(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                act(() =>
                  api(`patients/${patient.id}/family/`, {
                    method: 'POST',
                    body: JSON.stringify({ relative: relative.id, relation: relation.trim() }),
                  }),
                )
              }
            >
              Add link
            </button>
          </>
        ) : (
          <PatientPicker exclude={patient.id} label="Link another patient" onPick={setRelative} />
        )}
      </div>
    </Modal>
  );
}

/* ---------- W26: alert ---------- */

export function AlertWindow({
  patient,
  onClose,
  onSaved,
}: {
  patient: Patient;
  onClose: () => void;
  onSaved: (patient: Patient) => void;
}) {
  const [text, setText] = useState(patient.alert ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      onSaved(
        await api<Patient>(`patients/${patient.id}/`, {
          method: 'PATCH',
          body: JSON.stringify({ alert: text.trim() }),
        }),
      );
      notify('Alert saved.');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Patient alert"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={save}>
            Save alert
          </button>
        </>
      }
    >
      <ErrorMessage message={error} />
      <label>
        Alert
        <textarea data-autofocus rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="small muted">
        Something every clinical person must see at once, such as a sensitivity. Shown on the patient record to clinical
        roles only. Leave empty to remove it.
      </p>
    </Modal>
  );
}

/* ---------- W19: add note ---------- */

export function AddNote({
  patientId,
  role,
  onClose,
  onSaved,
}: {
  patientId: string;
  role: Role;
  onClose: () => void;
  onSaved: (note: Note) => void;
}) {
  const doctor = canWriteClinical(role);
  const [kind, setKind] = useState<'general' | 'clinical'>(doctor ? 'clinical' : 'general');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      onSaved(
        await api<Note>('notes/', {
          method: 'POST',
          body: JSON.stringify({ patient: patientId, kind, body: body.trim() }),
        }),
      );
      notify('Note saved.');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add note"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="note-form" disabled={busy || !body.trim()}>
            Save note
          </button>
        </>
      }
    >
      <form id="note-form" className="stack" onSubmit={save}>
        <ErrorMessage message={error} />
        {doctor && (
          <label>
            Kind of note
            <select
              aria-label="Kind of note"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'general' | 'clinical')}
            >
              <option value="clinical">Clinical note, for clinical roles</option>
              <option value="general">General note, for everyone at the clinic</option>
            </select>
          </label>
        )}
        <label>
          Note
          <textarea data-autofocus rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <p className="small muted">
          {kind === 'general'
            ? 'A general note is read by everyone at the clinic. Keep anything clinical out of it.'
            : 'A clinical note is read by doctors and clinical assistants.'}{' '}
          Notes are never edited; add another note to correct one.
        </p>
      </form>
    </Modal>
  );
}

/* ---------- W20, W21: documents ---------- */

export function AddDocument({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: (document: PatientDocument) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSaved(
        await api<PatientDocument>(`patients/${patientId}/documents/`, {
          method: 'POST',
          body: new FormData(event.currentTarget),
        }),
      );
      notify('Document saved.');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add document"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="document-form" disabled={busy}>
            {busy ? 'Saving…' : 'Save document'}
          </button>
        </>
      }
    >
      <form id="document-form" className="stack" onSubmit={save}>
        <ErrorMessage message={error} />
        <label>
          Title
          <input name="title" required maxLength={200} data-autofocus placeholder="For example: Blood report, 12 Sep" />
        </label>
        <label>
          File
          <input name="file" type="file" required accept="application/pdf,image/jpeg,image/png" />
        </label>
        <p className="small muted">
          A PDF, or a JPEG or PNG picture, up to 10 MiB. Kept with the patient and never edited.
        </p>
      </form>
    </Modal>
  );
}

export function ViewDocument({
  document,
  onClose,
}: {
  document: { id: string; title: string; mime_type: string };
  onClose: () => void;
}) {
  const address = `/api/v1/documents/${document.id}/`;
  return (
    <Modal
      title={document.title}
      size="xl"
      className="viewer"
      onClose={onClose}
      footer={
        <>
          <a className="button secondary" href={address} target="_blank" rel="noreferrer">
            Open in a new tab
          </a>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {document.mime_type === 'application/pdf' ? (
        <iframe title={document.title} src={address} />
      ) : (
        <img alt={document.title} src={address} />
      )}
    </Modal>
  );
}

/* ---------- P22, P23: change history and measurements ---------- */

interface Revision {
  id: string;
  changed_by_name: string;
  changes: Record<string, { from: string; to: string }>;
  created_at: string;
}
const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name',
  middle_name: 'Middle name',
  last_name: 'Last name',
  date_of_birth: 'Date of birth',
  gender: 'Sex',
  phone: 'Phone',
  whatsapp_number: 'WhatsApp number',
  email: 'Email',
  referred_by: 'Referred by',
  old_file_number: 'Old file number',
  'address.line1': 'Address',
  'address.line2': 'Address, second line',
  'address.city': 'City',
  'address.region': 'State',
  'address.postal_code': 'PIN code',
  'address.country': 'Country',
};

export function ChangeHistory({ patient, onClose }: { patient: Patient; onClose: () => void }) {
  const { data, error } = useLoad(
    (signal) => api<{ revisions: Revision[] }>(`patients/${patient.id}/revisions/`, { signal }),
    [patient.id],
  );
  return (
    <Modal
      title={`Change history · ${displayName(patient)}`}
      size="wide"
      onClose={onClose}
      footer={<button onClick={onClose}>Close</button>}
    >
      <ErrorMessage message={error} />
      {!data && !error && <p role="status">Loading the history…</p>}
      {data && !data.revisions.length && (
        <p className="muted">These details have not been changed since the patient was registered.</p>
      )}
      {data?.revisions.map((revision) => (
        <div className="row" key={revision.id}>
          <span>
            <strong>
              {dateTime(revision.created_at)} · {revision.changed_by_name}
            </strong>
            {Object.entries(revision.changes).map(([field, change]) => (
              <span className="muted" key={field}>
                {FIELD_LABELS[field] ?? field}: {change.from || 'empty'} → {change.to || 'empty'}
              </span>
            ))}
          </span>
        </div>
      ))}
    </Modal>
  );
}

interface MeasurementRow {
  date: string;
  height?: string;
  weight?: string;
  systolic?: string;
  diastolic?: string;
  pulse?: string;
}
export function MeasurementHistory({ patient, onClose }: { patient: Patient; onClose: () => void }) {
  const { data, error } = useLoad(
    (signal) => api<{ results: MeasurementRow[] }>(`patients/${patient.id}/measurements/`, { signal }),
    [patient.id],
  );
  return (
    <Modal
      title={`Measurements · ${displayName(patient)}`}
      size="wide"
      onClose={onClose}
      footer={<button onClick={onClose}>Close</button>}
    >
      <ErrorMessage message={error} />
      {!data && !error && <p role="status">Loading measurements…</p>}
      {data && !data.results.length && <p className="muted">No measurements have been recorded.</p>}
      {!!data?.results.length && (
        <table className="small">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Height cm</th>
              <th className="num">Weight kg</th>
              <th className="num">BP</th>
              <th className="num">Pulse</th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((row, index) => (
              <tr key={index}>
                <td>{shortDate(row.date)}</td>
                <td className="num">{row.height ?? '—'}</td>
                <td className="num">{row.weight ?? '—'}</td>
                <td className="num">{row.systolic && row.diastolic ? `${row.systolic}/${row.diastolic}` : '—'}</td>
                <td className="num">{row.pulse ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
