/** The Printing tab: what was printed today, the printers, and how each document is laid out. */
import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { ErrorMessage } from './components';
import { clock, shortDate } from './format';
import { EnvelopeLabel, LabelData, LabelSettings, dosageParts, labelSize } from './Labels';
import { ViewDocument } from './PatientWindows';
import { Role, canAdministerClinic, canReadClinical } from './types';
import { Chip, Modal, SettingRow, StatusLabel, Switch, notify, useLoad } from './ui';

type Kind = 'label' | 'prescription' | 'invoice' | 'receipt' | 'card';
type Value = string | number | boolean;
interface Template {
  kind: Kind;
  title: string;
  version: number;
  settings: Record<string, Value>;
  saved_by_name: string;
  saved_at: string | null;
}
interface Job {
  id: string;
  kind: string;
  title: string;
  patient: string;
  patient_id: string | null;
  encounter: string | null;
  invoice: string | null;
  copies: number;
  printer: string;
  envelopes: number[] | null;
  created_by_name: string;
  created_at: string;
}

const SECTIONS: { key: string; label: string; group?: string; kind?: Kind; clinical?: boolean }[] = [
  { key: 'queue', label: 'Print queue' },
  { key: 'printers', label: 'Printers' },
  { key: 'documents', label: 'Patient documents', clinical: true },
  { key: 'invoice', label: 'Invoice (A4)', group: 'Templates', kind: 'invoice' },
  { key: 'receipt', label: 'Receipt', group: 'Templates', kind: 'receipt' },
  { key: 'prescription', label: 'Prescription', group: 'Templates', kind: 'prescription' },
  { key: 'label', label: 'Envelope label', group: 'Templates', kind: 'label' },
  { key: 'card', label: 'Patient card', group: 'Templates', kind: 'card' },
];

export function PrintingScreen({ role }: { role: Role }) {
  const { section = 'queue' } = useParams();
  const sections = SECTIONS.filter((item) => !item.clinical || canReadClinical(role));
  const current = sections.find((item) => item.key === section);
  if (!current) return <Navigate to="/printing" replace />;
  return (
    <>
      <div className="heading">
        <h1>Documents and printing</h1>
      </div>
      <div className="cols cols-nav">
        <nav className="side-nav" aria-label="Printing sections">
          {sections.map((item, index) => (
            <span key={item.key} style={{ display: 'contents' }}>
              {item.group && sections[index - 1]?.group !== item.group && <span className="group">{item.group}</span>}
              <NavLink
                to={item.key === 'queue' ? '/printing' : `/printing/${item.key}`}
                className={item.key === current.key ? 'active' : ''}
                end
              >
                {item.label}
              </NavLink>
            </span>
          ))}
        </nav>
        <div>
          {current.key === 'queue' && <Queue />}
          {current.key === 'printers' && <Printers />}
          {current.key === 'documents' && <AllDocuments />}
          {current.kind && (
            <TemplateEditor key={current.kind} kind={current.kind} editable={canAdministerClinic(role)} />
          )}
        </div>
      </div>
    </>
  );
}

interface DocumentRow {
  id: string;
  patient: string;
  patient_name: string;
  title: string;
  mime_type: string;
  uploaded_by_name: string;
  created_at: string;
}

/** P52: lab reports and other papers across every patient, newest first. */
function AllDocuments() {
  const { data, error } = useLoad((signal) => api<{ results: DocumentRow[] }>('documents/', { signal }), []);
  const [text, setText] = useState('');
  const [viewing, setViewing] = useState<DocumentRow | null>(null);
  const wanted = text.trim().toLowerCase();
  const rows = (data?.results ?? []).filter(
    (row) => !wanted || row.title.toLowerCase().includes(wanted) || row.patient_name.toLowerCase().includes(wanted),
  );
  return (
    <section className="panel flush">
      <div className="heading">
        <div>
          <h2>Patient documents</h2>
          <p className="muted small">Lab reports and other papers kept with patients, newest first.</p>
        </div>
        <input
          type="search"
          className="narrow-search"
          aria-label="Find a document"
          placeholder="Title or patient"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <ErrorMessage message={error} />
      {data && !rows.length && (
        <p className="empty">
          {data.results.length
            ? 'No document matches.'
            : 'No documents yet. One is added from a patient’s record with “Add document”.'}
        </p>
      )}
      {!!rows.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Added</th>
                <th>Patient</th>
                <th>Document</th>
                <th>Kind</th>
                <th>Added by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{shortDate(row.created_at)}</td>
                  <td>
                    <Link to={`/patients/${row.patient}?tab=documents`}>{row.patient_name}</Link>
                  </td>
                  <td>
                    <button type="button" className="link-button" onClick={() => setViewing(row)}>
                      {row.title}
                    </button>
                  </td>
                  <td>{row.mime_type === 'application/pdf' ? 'PDF' : 'Picture'}</td>
                  <td>{row.uploaded_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && <ViewDocument document={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}

/** Where "Reprint" goes: the same page the document was printed from. */
export function reprintLink(job: Job) {
  if (job.kind === 'label' && job.encounter)
    return `/print/labels/${job.encounter}${job.envelopes?.length ? `?e=${job.envelopes.join(',')}` : ''}`;
  if (job.kind === 'prescription' && job.encounter) return `/print/prescription/${job.encounter}`;
  if (job.kind === 'card' && job.patient_id) return `/print/card/${job.patient_id}`;
  if (job.kind === 'invoice' && job.invoice) return `/print/invoice/${job.invoice}`;
  if (job.kind === 'receipt' && job.invoice) return `/billing/invoices/${job.invoice}`;
  if (job.kind === 'test') return '/print/test-label';
  return '';
}

const FILTERS = [
  ['', 'All'],
  ['label', 'Labels'],
  ['bills', 'Bills and receipts'],
  ['card', 'Cards'],
] as const;

function Queue() {
  const { data, error, loading } = useLoad(
    (signal) => api<{ day: string; results: Job[] }>('print-jobs/', { signal }),
    [],
  );
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('');
  const jobs = (data?.results ?? []).filter(
    (job) =>
      !filter || (filter === 'bills' ? ['invoice', 'receipt', 'day_end'].includes(job.kind) : job.kind === filter),
  );
  return (
    <section className="panel flush">
      <div className="heading">
        <h2>Print queue · today</h2>
        <div className="actions">
          {FILTERS.map(([key, label]) => (
            <Chip key={key} on={filter === key} onClick={() => setFilter(key)}>
              {label}
            </Chip>
          ))}
        </div>
      </div>
      <ErrorMessage message={error} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Document</th>
              <th>Patient</th>
              <th>Printer</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const link = reprintLink(job);
              return (
                <tr key={job.id}>
                  <td>{clock(job.created_at)}</td>
                  <td>{job.title}</td>
                  <td>{job.patient || <span className="muted">—</span>}</td>
                  <td>{job.printer}</td>
                  <td>
                    <StatusLabel tone="green">Sent to the print window</StatusLabel>
                  </td>
                  <td className="right">{link && <Link to={link}>Reprint</Link>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {loading && !data && <p role="status">Loading the print queue…</p>}
      {data && !jobs.length && (
        <p className="empty">
          Nothing has been printed today. Bills, labels and cards appear here as they are printed.
        </p>
      )}
      <p className="muted small inset">
        Printing goes through this computer&apos;s own print window, so the application cannot tell whether the paper
        came out. If it did not, use Reprint.
      </p>
    </section>
  );
}

function Printers() {
  const [pairing, setPairing] = useState(false);
  return (
    <section className="panel">
      <div className="heading">
        <h2>Printers</h2>
        <button type="button" className="secondary btn-sm" onClick={() => setPairing(true)}>
          Pair a label printer
        </button>
      </div>
      <div className="row">
        <span>
          <strong>Label printer</strong>
          <span className="muted">
            Any thermal label printer set up on this computer. Labels are sent at their own size; choose the label
            printer in the print window.
          </span>
        </span>
        <StatusLabel tone="green">Ready</StatusLabel>
      </div>
      <div className="row">
        <span>
          <strong>Office printer (A4)</strong>
          <span className="muted">
            Uses this computer&apos;s normal print window. “Save as PDF” there keeps a copy as a file.
          </span>
        </span>
        <StatusLabel tone="green">Ready</StatusLabel>
      </div>
      <p className="panel-action">
        <Link className="button secondary btn-sm" to="/print/test-label?auto=1">
          Print test label
        </Link>
      </p>
      {pairing && (
        <Modal
          title="Pair a label printer"
          onClose={() => setPairing(false)}
          footer={<button onClick={() => setPairing(false)}>Close</button>}
        >
          <p>
            Nothing needs pairing. Install the label printer on this computer as its maker describes, load the labels,
            then use “Print test label” and choose that printer in the print window.
          </p>
          <p className="muted">
            A small print helper, for sending labels to the printer without the print window appearing each time, is
            planned and is not part of this version.
          </p>
        </Modal>
      )}
    </section>
  );
}

type Field =
  | { name: string; type: 'switch'; label: string; hint?: string }
  | { name: string; type: 'choice'; label: string; options: [string, string][] }
  | { name: string; type: 'number'; label: string; when: (settings: Record<string, Value>) => boolean }
  | { name: string; type: 'text'; label: string; hint?: string };

const FIELDS: Record<Kind, Field[]> = {
  label: [
    {
      name: 'size',
      type: 'choice',
      label: 'Label size',
      options: [
        ['2x2in', '2 × 2 in (50.8 mm square)'],
        ['50x25mm', '50 × 25 mm'],
        ['58x40mm', '58 × 40 mm'],
        ['custom', 'Custom…'],
      ],
    },
    { name: 'width_mm', type: 'number', label: 'Width (mm)', when: (s) => s.size === 'custom' },
    { name: 'height_mm', type: 'number', label: 'Height (mm)', when: (s) => s.size === 'custom' },
    {
      name: 'dosage_size',
      type: 'choice',
      label: 'Dosage text size',
      options: [
        ['large', 'Large'],
        ['medium', 'Medium'],
      ],
    },
    { name: 'show_logo', type: 'switch', label: 'Show clinic logo' },
    { name: 'show_address', type: 'switch', label: 'Show clinic address' },
    { name: 'show_phone', type: 'switch', label: 'Show clinic phone' },
    { name: 'show_barcode', type: 'switch', label: 'Show patient barcode' },
    { name: 'show_next_visit', type: 'switch', label: 'Show next visit date' },
    {
      name: 'show_medicines',
      type: 'switch',
      label: 'Print medicine names',
      hint: 'Off unless you choose otherwise: the label then carries the dosage instructions only.',
    },
  ],
  prescription: [
    {
      name: 'paper',
      type: 'choice',
      label: 'Paper',
      options: [
        ['A4', 'A4'],
        ['A5', 'A5'],
      ],
    },
    {
      name: 'show_medicines',
      type: 'switch',
      label: 'Print medicine names',
      hint: 'Off unless you choose otherwise: the prescription then lists each envelope and how to take it.',
    },
    { name: 'footer_note', type: 'text', label: 'Line at the foot of the page', hint: 'For example clinic hours.' },
  ],
  invoice: [
    {
      name: 'show_upi',
      type: 'switch',
      label: 'Print a UPI code while a balance is due',
      hint: 'Needs the clinic’s UPI ID in Settings, Clinic details.',
    },
    {
      name: 'footer_note',
      type: 'text',
      label: 'Line at the foot of the bill',
      hint: 'Left empty, the bill says “Thank you for visiting” and the clinic’s name.',
    },
  ],
  receipt: [{ name: 'footer_note', type: 'text', label: 'Line at the foot of the receipt' }],
  card: [
    { name: 'show_phone', type: 'switch', label: 'Show clinic phone' },
    { name: 'show_address', type: 'switch', label: 'Show clinic address' },
  ],
};

function TemplateEditor({ kind, editable }: { kind: Kind; editable: boolean }) {
  const { data, setData, error } = useLoad((signal) => api<Template[]>('print-templates/', { signal }), []);
  const { data: sample } = useLoad(
    (signal) => (kind === 'label' ? api<LabelData>('print-data/test-label/', { signal }) : Promise.resolve(null)),
    [kind],
  );
  const saved = data?.find((row) => row.kind === kind);
  const [settings, setSettings] = useState<Record<string, Value>>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (saved) setSettings(saved.settings);
  }, [saved]);
  const changed = !!saved && JSON.stringify(settings) !== JSON.stringify(saved.settings);
  const set = (name: string, value: Value) => setSettings((old) => ({ ...old, [name]: value }));
  async function save() {
    setBusy(true);
    setFailure('');
    try {
      const next = await api<Template>('print-templates/', {
        method: 'POST',
        body: JSON.stringify({ kind, settings }),
      });
      setData((old) => (old ?? []).map((row) => (row.kind === kind ? next : row)));
      notify(`Saved as version ${next.version}.`);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const fields = FIELDS[kind].filter((field) => field.type !== 'number' || field.when(settings));
  const grid = fields.filter((field) => field.type === 'choice' || field.type === 'number' || field.type === 'text');
  const switches = fields.filter((field) => field.type === 'switch');
  // The preview follows the switches as they are flipped, before anything is saved.
  const preview = sample
    ? {
        ...sample,
        settings: { ...sample.settings, ...settings } as LabelSettings,
        envelopes: sample.envelopes.map((envelope) => ({
          ...envelope,
          medicines: settings.show_medicines === true ? ['Test remedy 30C'] : [],
        })),
      }
    : null;
  return (
    <div className={kind === 'label' ? 'cols cols-even' : ''}>
      <section className="panel">
        <div className="heading">
          <h2>{saved?.title ?? 'Layout'}</h2>
          {saved && (
            <StatusLabel>
              {saved.version ? `Version ${saved.version} · in use` : 'Standard layout · in use'}
            </StatusLabel>
          )}
        </div>
        <ErrorMessage message={error || failure} />
        {!saved && !error && <p role="status">Loading the layout…</p>}
        {saved && (
          <fieldset disabled={!editable || busy}>
            {!!grid.length && (
              <div className="form-grid two">
                {grid.map((field) => (
                  <label key={field.name} className={field.type === 'text' ? 'span-all' : undefined}>
                    {field.label}
                    {field.type === 'choice' && (
                      <select
                        aria-label={field.label}
                        value={String(settings[field.name] ?? '')}
                        onChange={(e) => set(field.name, e.target.value)}
                      >
                        {field.options.map(([value, text]) => (
                          <option key={value} value={value}>
                            {text}
                          </option>
                        ))}
                      </select>
                    )}
                    {field.type === 'number' && (
                      <input
                        type="number"
                        min={20}
                        max={110}
                        step={0.5}
                        value={Number(settings[field.name] ?? 50)}
                        onChange={(e) => set(field.name, Number(e.target.value))}
                      />
                    )}
                    {field.type === 'text' && (
                      <input
                        maxLength={200}
                        value={String(settings[field.name] ?? '')}
                        placeholder={field.hint}
                        onChange={(e) => set(field.name, e.target.value)}
                      />
                    )}
                  </label>
                ))}
              </div>
            )}
            {switches.map((field) => (
              <SettingRow
                key={field.name}
                title={field.label}
                hint={field.type === 'switch' ? field.hint : undefined}
                control={
                  <Switch
                    label={field.label}
                    checked={settings[field.name] === true}
                    disabled={!editable || busy}
                    onChange={(value) => set(field.name, value)}
                  />
                }
              />
            ))}
          </fieldset>
        )}
        {saved?.saved_at && (
          <p className="muted small">
            Saved by {saved.saved_by_name} on {shortDate(saved.saved_at)}. Earlier versions are kept.
          </p>
        )}
        {saved && (
          <div className="actions template-actions">
            {kind === 'label' && (
              <Link className="button secondary" to="/print/test-label">
                Preview
              </Link>
            )}
            {editable ? (
              <button type="button" disabled={busy || !changed} onClick={save}>
                Save as version {saved.version + 1}
              </button>
            ) : (
              <span className="muted">Only the owner or an administrator changes a layout.</span>
            )}
          </div>
        )}
      </section>
      {kind === 'label' && preview && (
        <section className="panel">
          <h2>How it will print</h2>
          <div className="label-zoom label-preview-box">
            <EnvelopeLabel data={preview} envelope={preview.envelopes[0]} settings={preview.settings} />
          </div>
          <p className="muted small">
            Shown about twice its size, with made-up wording. Actual size {labelSize(preview.settings).join(' × ')} mm.
            {changed && ' Not saved yet.'}
          </p>
        </section>
      )}
    </div>
  );
}

/** W4: choose which envelopes of a visit to label, and how many copies of each. */
export function PrintLabelsWindow({ encounterId, onClose }: { encounterId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { data, error } = useLoad(
    (signal) => api<LabelData>(`print-data/label/${encounterId}/`, { signal }),
    [encounterId],
  );
  const [chosen, setChosen] = useState<Record<number, number>>({});
  useEffect(() => {
    if (data) setChosen(Object.fromEntries(data.envelopes.map((envelope) => [envelope.number, 1])));
  }, [data]);
  const picked = (data?.envelopes ?? []).filter((envelope) => chosen[envelope.number] > 0);
  const total = picked.reduce((sum, envelope) => sum + chosen[envelope.number], 0);
  const link = (auto: boolean) =>
    `/print/labels/${encounterId}?e=${picked.map((envelope) => envelope.number).join(',')}&c=${picked
      .map((envelope) => chosen[envelope.number])
      .join(',')}${auto ? '&auto=1' : ''}`;
  return (
    <Modal
      title="Print envelope labels"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Skip
          </button>
          <button type="button" disabled={!total} onClick={() => navigate(link(true))}>
            Print {total} label{total === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <ErrorMessage message={error} />
      {!data && !error && <p role="status">Loading the envelopes…</p>}
      {data && !data.envelopes.length && <p>This visit has no envelopes, so there is nothing to label.</p>}
      {!!data?.envelopes.length && (
        <>
          <table className="small">
            <thead>
              <tr>
                <th></th>
                <th>Envelope</th>
                <th>Printed on the label</th>
                <th>Copies</th>
              </tr>
            </thead>
            <tbody>
              {data.envelopes.map((envelope) => {
                const copies = chosen[envelope.number] ?? 0;
                return (
                  <tr key={envelope.number}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Label envelope ${envelope.number}`}
                        checked={copies > 0}
                        onChange={(e) => setChosen({ ...chosen, [envelope.number]: e.target.checked ? 1 : 0 })}
                      />
                    </td>
                    <td>Envelope {envelope.number}</td>
                    <td>
                      {dosageParts(envelope).filter(Boolean).join(', ')}
                      {!!envelope.medicines.length && <div className="muted">{envelope.medicines.join(' + ')}</div>}
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={20}
                        className="copies"
                        aria-label={`Copies for envelope ${envelope.number}`}
                        value={copies}
                        onChange={(e) =>
                          setChosen({
                            ...chosen,
                            [envelope.number]: Math.min(Math.max(Number(e.target.value) || 0, 0), 20),
                          })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="info small">
            Each label carries the clinic&apos;s name{data.settings.show_address ? ' and address' : ''}, the
            patient&apos;s name, the dosage, {data.settings.show_barcode ? 'the patient barcode, ' : ''}the visit date
            {data.settings.show_next_visit
              ? ` and the next advised date (${data.next_visit ? shortDate(data.next_visit) : 'as needed'})`
              : ''}
            . {data.settings.show_medicines ? 'Medicine names are printed.' : 'Medicine names are not printed.'} The
            layout is set in Printing, Envelope label.
          </p>
          <p className="small">
            Printer: this computer&apos;s print window; choose the label printer there.{' '}
            {!!total && <Link to={link(false)}>Preview the labels</Link>}
          </p>
        </>
      )}
    </Modal>
  );
}

export const canPrintLabels = canReadClinical;
