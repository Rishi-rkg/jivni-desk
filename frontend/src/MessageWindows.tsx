/** The floating windows of Messages: write or edit a message, send later, note a reply, templates, rules, campaigns. */
import { FormEvent, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ErrorMessage } from './components';
import { addDays, isoDay, shortDate } from './format';
import {
  CONSENT_WORDS,
  CONTENT_RULE,
  KIND_LABELS,
  Message,
  Rule,
  Template,
  TemplateList,
  canApproveMessages,
  messagesChanged,
  sendOnWhatsApp,
} from './messages';
import { PatientPicker } from './PatientWindows';
import { Role, displayName } from './types';
import { ChoiceStrip, Modal, notify, useLoad } from './ui';

interface Preview {
  title: string;
  kind: 'care' | 'greetings';
  body: string;
  missing: string[];
  values: { label: string; value: string }[];
  to: string;
  blocked: { care: string; greetings: string };
}
type Person = { id: string; name: string };

/** Puts text where the cursor is in a text box, and leaves the cursor after it. */
function insertAt(box: HTMLTextAreaElement | null, current: string, text: string, set: (value: string) => void) {
  const start = box?.selectionStart ?? current.length;
  const end = box?.selectionEnd ?? current.length;
  set(current.slice(0, start) + text + current.slice(end));
  window.setTimeout(() => {
    box?.focus();
    box?.setSelectionRange(start + text.length, start + text.length);
  });
}

/** W9: write a message to one patient, or change one that has not gone yet. */
export function WriteMessage({
  role,
  patient: presetPatient,
  message,
  invoice,
  appointment,
  templateKey,
  onClose,
  onDone,
}: {
  role: Role;
  patient?: Person;
  /** An unsent message to change. */
  message?: Message;
  /** The bill or appointment the message is about, when it was started from one. */
  invoice?: string;
  appointment?: string;
  /** A template to start from, by its standing name: "invoice", "appointment_reminder"... */
  templateKey?: string;
  onClose: () => void;
  onDone: (message: Message | null) => void;
}) {
  const approver = canApproveMessages(role);
  const [patient, setPatient] = useState<Person | null>(message?.patient ?? presetPatient ?? null);
  const [templateId, setTemplateId] = useState('');
  const [body, setBody] = useState(message?.body ?? '');
  const [info, setInfo] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const started = useRef(false);
  const { data: templates } = useLoad((signal) => api<TemplateList>('message-templates/', { signal }), []);
  const usable = templates?.results.filter((template) => template.approved) ?? [];

  async function choose(id: string, person = patient) {
    if (!person) return;
    setTemplateId(id);
    setError('');
    try {
      const preview = await api<Preview>('messages/preview/', {
        method: 'POST',
        body: JSON.stringify({ patient: person.id, template: id || undefined, invoice, appointment }),
      });
      setInfo(preview);
      if (id) setBody(preview.body);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // Once the patient is known: what can be inserted for them, and the template the window was opened for.
  useEffect(() => {
    if (!patient || !templates || started.current) return;
    started.current = true;
    const preset =
      templateKey && !message ? templates.results.find((item) => item.key === templateKey && item.approved) : null;
    void choose(preset?.id ?? '', patient);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patient, templates]);

  const kind = message?.kind ?? info?.kind ?? 'care';
  const blocked = info?.blocked[kind] ?? '';
  async function save(send: boolean) {
    setBusy(true);
    setError('');
    try {
      const saved = message
        ? await api<Message>(`messages/${message.id}/`, { method: 'PATCH', body: JSON.stringify({ body }) })
        : await api<Message>('messages/', {
            method: 'POST',
            body: JSON.stringify({
              patient: patient!.id,
              body,
              template: templateId || undefined,
              invoice,
              appointment,
            }),
          });
      if (send) onDone(await sendOnWhatsApp(saved.id));
      else {
        notify(saved.status === 'approved' ? 'Saved. Ready to send.' : 'Saved. Waiting for approval.');
        messagesChanged();
        onDone(saved);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function discard() {
    if (!message) return onClose();
    setBusy(true);
    try {
      await api(`messages/${message.id}/discard/`, { method: 'POST', body: '{}' });
      notify('Message discarded.');
      messagesChanged();
      onDone(null);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={patient ? `WhatsApp message to ${patient.name}` : 'New WhatsApp message'}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="danger" disabled={busy} onClick={discard}>
            Discard
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !patient || !body.trim()}
            onClick={() => save(false)}
          >
            {approver ? 'Save draft' : 'Save for approval'}
          </button>
          {approver && (
            <button type="button" disabled={busy || !patient || !body.trim() || !!blocked} onClick={() => save(true)}>
              Approve and send
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        <ErrorMessage message={error} />
        {!patient && <PatientPicker onPick={(picked) => setPatient({ id: picked.id, name: displayName(picked) })} />}
        {patient && (
          <>
            {!message && (
              <label>
                Template
                <select data-autofocus value={templateId} onChange={(e) => choose(e.target.value)}>
                  <option value="">Write my own</option>
                  {usable.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Message
              <textarea ref={box} rows={6} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
            {!!templateId && !!info?.missing.length && (
              <p className="warning">
                Nothing is known yet for: {info.missing.join(', ')}. Fill {info.missing.length === 1 ? 'it' : 'them'} in
                or remove {info.missing.length === 1 ? 'it' : 'them'} before saving.
              </p>
            )}
            <p className="small muted insert-row">
              {!!info?.values.length && (
                <>
                  Insert:{' '}
                  {info.values.map((item) => (
                    <button
                      type="button"
                      className="chip"
                      key={item.label}
                      title={item.value}
                      onClick={() => insertAt(box.current, body, item.value, setBody)}
                    >
                      {item.label}
                    </button>
                  ))}
                  <br />
                </>
              )}
              {CONTENT_RULE}
            </p>
            {info && (
              <p className="small muted">
                {info.to ? `Goes to ${info.to} on WhatsApp.` : 'No WhatsApp number is on the patient’s record.'} A
                person presses Send in WhatsApp; nothing is sent by itself.
              </p>
            )}
            {blocked && (
              <p className="warning">
                Not sendable now: {blocked} It can still be saved, and waits in the queue until that is put right.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** "Send later": hold a message until a day. */
export function SendLater({ message, onClose, onDone }: { message: Message; onClose: () => void; onDone: () => void }) {
  const tomorrow = addDays(isoDay(), 1);
  const [day, setDay] = useState(message.send_after ?? tomorrow);
  const [error, setError] = useState('');
  async function hold(value: string | null) {
    try {
      await api(`messages/${message.id}/`, { method: 'PATCH', body: JSON.stringify({ send_after: value }) });
      notify(value ? `Held until ${shortDate(value)}.` : 'No longer held for later.');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title="Send later"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          {message.send_after && (
            <button type="button" className="secondary" onClick={() => hold(null)}>
              Clear the date
            </button>
          )}
          <button type="button" disabled={!day || day < tomorrow} onClick={() => hold(day)}>
            Hold until this day
          </button>
        </>
      }
    >
      <ErrorMessage message={error} />
      <label>
        Send on or after
        <input data-autofocus type="date" min={tomorrow} value={day} onChange={(e) => setDay(e.target.value)} />
      </label>
      <p className="small muted">
        The message stays in the queue, marked with this day. Nothing is sent by itself: someone still presses Send.
      </p>
    </Modal>
  );
}

/** For a message that turned out not to go. */
export function DidNotGo({ message, onClose, onDone }: { message: Message; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`messages/${message.id}/failed/`, { method: 'POST', body: JSON.stringify({ reason }) });
      notify('Marked as failed.');
      messagesChanged();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title={`The message to ${message.patient.name} did not go?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="failed-form" disabled={!reason.trim()}>
            Mark as failed
          </button>
        </>
      }
    >
      <form id="failed-form" className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />
        <label>
          What went wrong
          <input
            data-autofocus
            value={reason}
            maxLength={200}
            placeholder="For example: the number is not on WhatsApp"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <p className="small muted">It moves to Failed, where it can be tried again once the number is corrected.</p>
      </form>
    </Modal>
  );
}

/** A reply the patient sent on WhatsApp, written down so the next person sees it. */
export function NoteReply({
  patient: preset,
  onClose,
  onDone,
}: {
  patient?: Person;
  onClose: () => void;
  onDone: () => void;
}) {
  const [patient, setPatient] = useState<Person | null>(preset ?? null);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api('messages/replies/', { method: 'POST', body: JSON.stringify({ patient: patient!.id, body }) });
      notify('Reply noted.');
      messagesChanged();
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={patient ? `Reply from ${patient.name}` : 'Note a reply'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !patient || !body.trim()} onClick={save}>
            Save reply
          </button>
        </>
      }
    >
      <div className="stack">
        <ErrorMessage message={error} />
        {!patient && <PatientPicker onPick={(picked) => setPatient({ id: picked.id, name: displayName(picked) })} />}
        {patient && (
          <label>
            What the patient wrote
            <textarea data-autofocus rows={4} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
        )}
        <p className="small muted">
          Replies arrive in WhatsApp on the clinic’s phone. Noting one here lets the next person see it without the
          phone.
        </p>
      </div>
    </Modal>
  );
}

/** W28: a template's name, wording and whether it is approved for use. */
export function EditTemplate({
  template,
  fields,
  onClose,
  onSaved,
}: {
  template?: Template;
  fields: TemplateList['fields'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [kind, setKind] = useState<Template['kind']>(template?.kind ?? 'care');
  const [body, setBody] = useState(template?.body ?? '');
  const [approved, setApproved] = useState(template?.approved ?? false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(template ? `message-templates/${template.id}/` : 'message-templates/', {
        method: template ? 'PATCH' : 'POST',
        body: JSON.stringify({ name, kind, body, approved }),
      });
      notify(template ? 'Template saved.' : 'Template added.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={template ? `Template: ${template.name}` : 'New template'}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="template-form" disabled={busy || !name.trim() || !body.trim()}>
            Save template
          </button>
        </>
      }
    >
      <form id="template-form" className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />
        <label>
          Name
          <input data-autofocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <span className="field-label">Kind</span>
          <ChoiceStrip
            label="Kind"
            value={kind}
            options={[
              ['care', KIND_LABELS.care],
              ['greetings', KIND_LABELS.greetings],
            ]}
            onChange={setKind}
          />
          <p className="small muted">Goes only to patients who agreed to {CONSENT_WORDS[kind]}.</p>
        </div>
        <label>
          Wording
          <textarea ref={box} rows={6} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <p className="small muted insert-row">
          Insert:{' '}
          {fields.map((field) => (
            <button
              type="button"
              className="chip"
              key={field.name}
              onClick={() => insertAt(box.current, body, `{${field.name}}`, setBody)}
            >
              {field.label}
            </button>
          ))}
          <br />
          Each is replaced by the patient’s own details when a message is made. {CONTENT_RULE}
        </p>
        <label className="check">
          <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
          Approved for use
        </label>
        {template && (
          <p className="small muted">
            Version {template.version}. Changing the wording makes version {template.version + 1}; messages already made
            keep the wording they have.
          </p>
        )}
      </form>
    </Modal>
  );
}

const TRIGGERS: [Rule['trigger'], string][] = [
  ['before_appointment', 'Before an appointment'],
  ['after_last_visit', 'After the last visit'],
  ['birthday', 'On the patient’s birthday'],
];

/** W27: when a message is prepared without anyone asking. */
export function EditRule({
  rule,
  templates,
  withoutApproval,
  onClose,
  onSaved,
}: {
  rule?: Rule;
  templates: Template[];
  /** The clinic's "Send reminders without approval" switch. */
  withoutApproval: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState<Rule['trigger']>(rule?.trigger ?? 'after_last_visit');
  const [days, setDays] = useState(String(rule?.days || 30));
  const [onlyIfNotBooked, setOnlyIfNotBooked] = useState(rule?.only_if_not_booked ?? true);
  const [template, setTemplate] = useState(rule?.template.id ?? '');
  const [needsApproval, setNeedsApproval] = useState(rule?.needs_approval ?? true);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(rule ? `message-rules/${rule.id}/` : 'message-rules/', {
        method: rule ? 'PATCH' : 'POST',
        body: JSON.stringify({
          name,
          trigger,
          days: trigger === 'birthday' ? 0 : Number(days),
          only_if_not_booked: onlyIfNotBooked,
          template,
          needs_approval: trigger === 'before_appointment' ? needsApproval : true,
          enabled,
        }),
      });
      notify(rule ? 'Rule saved.' : 'Rule added.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={rule ? `Rule: ${rule.name}` : 'New rule'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="rule-form" disabled={busy || !name.trim() || !template}>
            Save rule
          </button>
        </>
      }
    >
      <form id="rule-form" className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />
        <label>
          Name
          <input data-autofocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          When
          <select value={trigger} disabled={!!rule} onChange={(e) => setTrigger(e.target.value as Rule['trigger'])}>
            {TRIGGERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {trigger !== 'birthday' && (
          <label>
            {trigger === 'before_appointment' ? 'Days before the appointment' : 'Days after the last visit'}
            <input
              type="number"
              min={1}
              max={trigger === 'before_appointment' ? 7 : 730}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </label>
        )}
        {trigger === 'after_last_visit' && (
          <label className="check">
            <input type="checkbox" checked={onlyIfNotBooked} onChange={(e) => setOnlyIfNotBooked(e.target.checked)} />
            Only if no follow-up is booked
          </label>
        )}
        <label>
          Template
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Choose a template</option>
            {templates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.approved ? '' : ' (draft)'}
              </option>
            ))}
          </select>
        </label>
        {trigger === 'before_appointment' && (
          <label className="check">
            <input type="checkbox" checked={needsApproval} onChange={(e) => setNeedsApproval(e.target.checked)} />
            Needs approval before it can be sent
          </label>
        )}
        {trigger === 'before_appointment' && !needsApproval && !withoutApproval && (
          <p className="small muted">
            Reminders still wait for approval until “Send reminders without approval” is switched on in Settings,
            Switches.
          </p>
        )}
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Switched on
        </label>
        <p className="small muted">
          Messages are prepared when someone opens Messages or the dashboard, never twice for the same occasion.
        </p>
      </form>
    </Modal>
  );
}

/** A greeting or piece of clinic news for a group of patients. */
export function NewCampaign({
  templates,
  audiences,
  onClose,
  onDone,
}: {
  templates: Template[];
  audiences: { name: string; label: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const usable = templates.filter((template) => template.approved);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [audience, setAudience] = useState(audiences[0]?.name ?? 'everyone');
  const [count, setCount] = useState<{ ready: number; left_out: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCount(null);
    if (!template) return;
    const controller = new AbortController();
    api<{ ready: number; left_out: number }>('message-campaigns/count/', {
      method: 'POST',
      body: JSON.stringify({ template, audience }),
      signal: controller.signal,
    })
      .then(setCount)
      .catch(() => {});
    return () => controller.abort();
  }, [template, audience]);
  async function prepare() {
    setBusy(true);
    setError('');
    try {
      const made = await api<{ prepared: number }>('message-campaigns/', {
        method: 'POST',
        body: JSON.stringify({ name, template, audience }),
      });
      notify(`${made.prepared} message${made.prepared === 1 ? ' is' : 's are'} waiting for approval.`);
      messagesChanged();
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const chosen = usable.find((item) => item.id === template);
  return (
    <Modal
      title="New campaign"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !name.trim() || !template || !count?.ready} onClick={prepare}>
            Prepare messages
          </button>
        </>
      }
    >
      <div className="stack">
        <ErrorMessage message={error} />
        <label>
          Name
          <input
            data-autofocus
            value={name}
            maxLength={80}
            placeholder="For example: Diwali greeting"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Template
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Choose a template</option>
            {usable.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          For
          <select value={audience} onChange={(e) => setAudience(e.target.value)}>
            {audiences.map((item) => (
              <option key={item.name} value={item.name}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {chosen && count && (
          <p className="info">
            <strong>
              {count.ready} patient{count.ready === 1 ? '' : 's'} will get it.
            </strong>{' '}
            {count.left_out} left out: no consent to {CONSENT_WORDS[chosen.kind]}, or no WhatsApp number.
          </p>
        )}
        <p className="small muted">
          Each message waits for approval and is then sent one at a time from WhatsApp by a person. Nothing goes out in
          bulk by itself.
        </p>
      </div>
    </Modal>
  );
}
