/** The Messages tab: the approval queue, replies, what was sent, what failed, templates, rules and campaigns. */
import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { ErrorMessage } from './components';
import { dateTime, shortDate } from './format';
import { DidNotGo, EditRule, EditTemplate, NewCampaign, NoteReply, SendLater, WriteMessage } from './MessageWindows';
import {
  CONSENT_WORDS,
  CONTENT_RULE,
  Counts,
  KIND_LABELS,
  Message,
  Rule,
  SOURCE_LABELS,
  Template,
  TemplateList,
  canApproveMessages,
  canSetUpMessages,
  messagesChanged,
  onMessagesChanged,
  sendOnWhatsApp,
  statusOfMessage,
} from './messages';
import { Role } from './types';
import { Modal, SettingRow, StatusLabel, Switch, notify, useLoad } from './ui';

const TABS = [
  ['waiting', 'Waiting for approval'],
  ['replies', 'Replies'],
  ['sent', 'Sent'],
  ['failed', 'Failed'],
  ['templates', 'Templates'],
  ['rules', 'Rules'],
  ['campaigns', 'Campaigns'],
] as const;
type Tab = (typeof TABS)[number][0];
interface MessageList {
  today: string;
  results: Message[];
}
interface CampaignList {
  audiences: { name: string; label: string }[];
  results: {
    id: string;
    name: string;
    template_name: string;
    audience: string;
    prepared: number;
    left_out: number;
    waiting: number;
    sent: number;
    created_at: string;
    created_by_name: string;
  }[];
}

/** A number that goes up each time messages change anywhere, to reload what depends on them. */
function useMessageTurn() {
  const [turn, setTurn] = useState(0);
  useEffect(() => onMessagesChanged(() => setTurn((value) => value + 1)), []);
  return turn;
}

export function MessagesScreen({ role }: { role: Role }) {
  const params = useParams();
  const navigate = useNavigate();
  const tab = TABS.find(([key]) => key === params.tab)?.[0] ?? 'waiting';
  const turn = useMessageTurn();
  const { data: counts } = useLoad((signal) => api<Counts>('messages/counts/', { signal }), [turn]);
  const [writing, setWriting] = useState(false);
  const [campaign, setCampaign] = useState(false);
  const { data: templates } = useLoad((signal) => api<TemplateList>('message-templates/', { signal }), [turn]);
  const { data: campaigns, reload } = useLoad((signal) => api<CampaignList>('message-campaigns/', { signal }), [turn]);
  const count = (key: Tab) => (key === 'waiting' || key === 'replies' || key === 'failed' ? counts?.[key] : 0);
  return (
    <>
      <div className="heading">
        <h1>Messages</h1>
        <div className="actions">
          <button type="button" onClick={() => setWriting(true)}>
            New message
          </button>
          {role === 'owner' && (
            <button type="button" className="secondary" onClick={() => setCampaign(true)}>
              New campaign
            </button>
          )}
        </div>
      </div>
      <nav className="sub-tabs" aria-label="Message sections">
        {TABS.map(([key, label]) => (
          <NavLink key={key} to={key === 'waiting' ? '/messages' : `/messages/${key}`} end>
            {label}
            {!!count(key) && <span className="count">{count(key)}</span>}
          </NavLink>
        ))}
      </nav>
      {tab === 'waiting' && <Queue role={role} turn={turn} />}
      {tab === 'replies' && <Replies turn={turn} />}
      {(tab === 'sent' || tab === 'failed') && <Box name={tab} role={role} turn={turn} />}
      {tab === 'templates' && <TemplatesPanel role={role} />}
      {tab === 'rules' && <RulesPanel role={role} />}
      {tab === 'campaigns' && (
        <section className="panel flush">
          <div className="heading">
            <h2>Campaigns</h2>
            {role === 'owner' && (
              <button type="button" className="secondary btn-sm" onClick={() => setCampaign(true)}>
                New campaign
              </button>
            )}
          </div>
          {campaigns && !campaigns.results.length && (
            <p className="empty">
              A campaign prepares one greeting or piece of clinic news for a group of patients who agreed to receive
              them. {role === 'owner' ? '“New campaign” starts one.' : 'The clinic owner starts one.'}
            </p>
          )}
          {!!campaigns?.results.length && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>For</th>
                    <th className="num">Prepared</th>
                    <th className="num">Left out</th>
                    <th className="num">Still waiting</th>
                    <th className="num">Sent</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.results.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.name}</strong>
                        <div className="muted small">Template: {row.template_name}</div>
                      </td>
                      <td>{row.audience}</td>
                      <td className="num">{row.prepared}</td>
                      <td className="num">{row.left_out}</td>
                      <td className="num">{row.waiting}</td>
                      <td className="num">{row.sent}</td>
                      <td>
                        {shortDate(row.created_at)}
                        <div className="muted small">{row.created_by_name}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {writing && <WriteMessage role={role} onClose={() => setWriting(false)} onDone={() => setWriting(false)} />}
      {campaign && templates && campaigns && (
        <NewCampaign
          templates={templates.results}
          audiences={campaigns.audiences}
          onClose={() => setCampaign(false)}
          onDone={() => {
            setCampaign(false);
            reload();
            navigate('/messages');
          }}
        />
      )}
    </>
  );
}

/** One short line under a name in the queue: where the message came from, and what holds it up. */
function queueLine(message: Message, today: string) {
  if (message.blocked) return `Not sendable: ${message.blocked}`;
  if (message.send_after && message.send_after > today)
    return `${message.context} · held until ${shortDate(message.send_after)}`;
  return message.context;
}

function Queue({ role, turn }: { role: Role; turn: number }) {
  const approver = canApproveMessages(role);
  const { data, error } = useLoad((signal) => api<MessageList>('messages/?box=waiting', { signal }), [turn]);
  const [openId, setOpenId] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState('');
  const messages = data?.results ?? [];
  const open = messages.find((message) => message.id === openId) ?? messages[0];
  // Ticks only ever name messages that are still in the queue.
  const ticked = messages.filter((message) => checked.has(message.id));
  const tickable = messages.filter((message) => !message.blocked || !approver);
  function tick(id: string, on: boolean) {
    setChecked((old) => {
      const next = new Set(old);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  async function bulk(action: 'approve' | 'discard') {
    setFailure('');
    try {
      const done = await api<{ done: number; skipped: number }>('messages/bulk/', {
        method: 'POST',
        body: JSON.stringify({ action, ids: ticked.map((message) => message.id) }),
      });
      const word = action === 'approve' ? 'approved' : 'discarded';
      notify(
        `${done.done} message${done.done === 1 ? '' : 's'} ${word}.` +
          (done.skipped ? ` ${done.skipped} left as ${done.skipped === 1 ? 'it was' : 'they were'}.` : ''),
      );
      setChecked(new Set());
      messagesChanged();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <>
      <ErrorMessage message={error || failure} />
      {data && !messages.length && (
        <p className="empty panel">
          Nothing is waiting. Messages appear here when a rule prepares one, such as tomorrow’s appointment reminders,
          or when someone writes one with “New message”.
        </p>
      )}
      {!!messages.length && (
        <div className="cols cols-even">
          <section className="panel flush queue" aria-label="Messages waiting">
            <div className="heading">
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!tickable.length && ticked.length === tickable.length}
                  onChange={(e) => setChecked(new Set(e.target.checked ? tickable.map((message) => message.id) : []))}
                />
                Select all
              </label>
              <div className="actions">
                {approver && (
                  <button
                    type="button"
                    className="secondary btn-sm"
                    disabled={!ticked.some((message) => message.status === 'waiting')}
                    onClick={() => bulk('approve')}
                  >
                    Approve selected
                  </button>
                )}
                <button
                  type="button"
                  className="secondary btn-sm"
                  disabled={!ticked.length}
                  onClick={() => bulk('discard')}
                >
                  Discard selected
                </button>
              </div>
            </div>
            {messages.map((message) => {
              const [tone, label] = statusOfMessage(message);
              return (
                <div className={`row ${open?.id === message.id ? 'sel' : ''}`} key={message.id}>
                  <input
                    type="checkbox"
                    aria-label={`Select the message to ${message.patient.name}`}
                    checked={checked.has(message.id)}
                    onChange={(e) => tick(message.id, e.target.checked)}
                  />
                  <button type="button" className="queue-item" onClick={() => setOpenId(message.id)}>
                    <span>
                      <strong>{message.patient.name}</strong> · {message.title}
                    </span>
                    <span className="muted">{queueLine(message, data!.today)}</span>
                  </button>
                  <StatusLabel tone={message.blocked || message.status === 'approved' ? tone : 'grey'}>
                    {message.blocked || message.status === 'approved' ? label : SOURCE_LABELS[message.source]}
                  </StatusLabel>
                </div>
              );
            })}
          </section>
          {open && <Preview key={open.id} message={open} role={role} today={data!.today} />}
        </div>
      )}
    </>
  );
}

function Preview({ message, role, today }: { message: Message; role: Role; today: string }) {
  const approver = canApproveMessages(role);
  const [window_, setWindow] = useState<'' | 'edit' | 'later'>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const turn = useMessageTurn();
  const { data: history } = useLoad(
    (signal) => api<MessageList>(`messages/?patient=${message.patient.id}`, { signal }),
    [message.patient.id, turn],
  );
  const earlier = history?.results.filter((item) => item.id !== message.id).slice(0, 5) ?? [];
  async function act(work: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError('');
    try {
      await work();
      if (done) notify(done);
      messagesChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  const step = (name: string) => api(`messages/${message.id}/${name}/`, { method: 'POST', body: '{}' });
  const held = !!message.send_after && message.send_after > today;
  return (
    <section className="panel" aria-label="Message">
      <div className="heading">
        <h2>
          {message.patient.name} · {message.title}
        </h2>
        <Link to={`/patients/${message.patient.id}`}>Open patient →</Link>
      </div>
      <p className="small muted">
        {message.to ? `To ${message.to} on WhatsApp` : 'No WhatsApp number'}
        {message.consent &&
          (message.consent.granted
            ? ` · Consent: ${CONSENT_WORDS[message.kind]}, recorded ${shortDate(message.consent.recorded_at)}`
            : ` · No consent to ${CONSENT_WORDS[message.kind]}`)}
        {message.template && ` · Template “${message.template.name}” v${message.template.version}`}
      </p>
      <div className="bubble">{message.body}</div>
      <p className="small muted">{CONTENT_RULE}</p>
      <ErrorMessage message={error} />
      {message.blocked && <p className="warning">Not sendable: {message.blocked}</p>}
      {message.status === 'waiting' && !approver && (
        <p className="info">Waiting for a doctor or the owner to approve the wording.</p>
      )}
      {message.status === 'approved' && (
        <p className="small muted">
          Approved{message.approved_by_name ? ` by ${message.approved_by_name}` : ' by the reminder rule'}
          {held ? ` · held until ${shortDate(message.send_after)}` : ''}.
        </p>
      )}
      <div className="actions">
        {message.status === 'waiting' && approver && (
          <>
            <button
              type="button"
              disabled={busy || !!message.blocked}
              onClick={() => act(() => sendOnWhatsApp(message.id))}
            >
              Approve and send
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !!message.blocked}
              onClick={() => act(() => step('approve'), 'Approved. Ready to send.')}
            >
              Approve
            </button>
          </>
        )}
        {message.status === 'approved' && (
          <button
            type="button"
            disabled={busy || !!message.blocked}
            onClick={() => act(() => sendOnWhatsApp(message.id))}
          >
            Send
          </button>
        )}
        <button type="button" className="secondary" disabled={busy} onClick={() => setWindow('edit')}>
          Edit
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setWindow('later')}>
          Send later…
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => act(() => step('discard'), 'Message discarded.')}
        >
          Discard
        </button>
      </div>
      {!!earlier.length && (
        <>
          <hr className="rule" />
          <h3>Earlier messages</h3>
          {earlier.map((item) => {
            const [tone, label] = statusOfMessage(item);
            return (
              <p className="small" key={item.id}>
                {shortDate(item.sent_at ?? item.created_at)} · {item.title} ·{' '}
                <StatusLabel tone={tone}>{label}</StatusLabel>
              </p>
            );
          })}
        </>
      )}
      {window_ === 'edit' && (
        <WriteMessage role={role} message={message} onClose={() => setWindow('')} onDone={() => setWindow('')} />
      )}
      {window_ === 'later' && (
        <SendLater
          message={message}
          onClose={() => setWindow('')}
          onDone={() => {
            setWindow('');
            messagesChanged();
          }}
        />
      )}
    </section>
  );
}

function Replies({ turn }: { turn: number }) {
  const { data, error } = useLoad((signal) => api<MessageList>('messages/?box=replies', { signal }), [turn]);
  const [noting, setNoting] = useState(false);
  const [failure, setFailure] = useState('');
  async function handled(message: Message) {
    try {
      await api(`messages/${message.id}/handled/`, { method: 'POST', body: '{}' });
      messagesChanged();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <section className="panel flush">
      <div className="heading">
        <h2>Replies</h2>
        <button type="button" className="secondary btn-sm" onClick={() => setNoting(true)}>
          Note a reply
        </button>
      </div>
      <ErrorMessage message={error || failure} />
      {data && !data.results.length && (
        <p className="empty">
          Replies arrive in WhatsApp on the clinic’s phone, not here. “Note a reply” writes one down so the next person
          sees it and can deal with it.
        </p>
      )}
      {data?.results.map((message) => (
        <div className="row" key={message.id}>
          <span>
            <Link to={`/patients/${message.patient.id}`}>
              <strong>{message.patient.name}</strong>
            </Link>
            <span className="reply-text">“{message.body}”</span>
            <span className="muted">
              Noted {dateTime(message.created_at)}
              {message.created_by_name && ` by ${message.created_by_name}`}
            </span>
          </span>
          {message.status === 'received' ? (
            <button type="button" className="secondary btn-sm" onClick={() => handled(message)}>
              Mark as dealt with
            </button>
          ) : (
            <StatusLabel tone="grey">Dealt with</StatusLabel>
          )}
        </div>
      ))}
      {noting && <NoteReply onClose={() => setNoting(false)} onDone={() => setNoting(false)} />}
    </section>
  );
}

/** Sent and Failed: what has already left the queue. */
function Box({ name, role, turn }: { name: 'sent' | 'failed'; role: Role; turn: number }) {
  const { data, error } = useLoad((signal) => api<MessageList>(`messages/?box=${name}`, { signal }), [name, turn]);
  const [reading, setReading] = useState<Message | null>(null);
  const [failing, setFailing] = useState<Message | null>(null);
  const [failure, setFailure] = useState('');
  async function retry(message: Message) {
    setFailure('');
    try {
      const again = await api<Message>(`messages/${message.id}/retry/`, { method: 'POST', body: '{}' });
      notify(
        again.status === 'approved' ? 'Back in the queue, ready to send.' : 'Back in the queue, waiting for approval.',
      );
      messagesChanged();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <section className="panel flush">
      <ErrorMessage message={error || failure} />
      {data && !data.results.length && (
        <p className="empty">
          {name === 'sent'
            ? 'Nothing has been sent yet. A message shows here once someone has opened it in WhatsApp to send.'
            : 'Nothing has failed. A sent message that turned out not to go is moved here with “Did not go”.'}
        </p>
      )}
      {!!data?.results.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{name === 'sent' ? 'Sent' : 'Tried'}</th>
                <th>Patient</th>
                <th>Message</th>
                <th>To</th>
                <th>{name === 'sent' ? 'Status' : 'What went wrong'}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((message) => (
                <tr key={message.id}>
                  <td>
                    {dateTime(message.sent_at)}
                    <div className="muted small">{message.sent_by_name}</div>
                  </td>
                  <td>
                    <Link to={`/patients/${message.patient.id}`}>{message.patient.name}</Link>
                  </td>
                  <td>
                    <button type="button" className="link-button" onClick={() => setReading(message)}>
                      {message.title}
                    </button>
                    <div className="muted small">{message.context}</div>
                  </td>
                  <td>{message.to}</td>
                  <td>
                    {name === 'sent' ? <StatusLabel tone="green">Sent by staff</StatusLabel> : message.failed_reason}
                  </td>
                  <td className="right">
                    {name === 'sent' ? (
                      <button type="button" className="link-button" onClick={() => setFailing(message)}>
                        Did not go
                      </button>
                    ) : (
                      <button type="button" className="secondary btn-sm" onClick={() => retry(message)}>
                        Try again
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {name === 'sent' && !!data?.results.length && (
        <p className="small muted table-note">
          “Sent by staff” means someone opened it in WhatsApp to send. WhatsApp does not tell this application whether
          it was delivered or read.
        </p>
      )}
      {reading && (
        <Modal
          title={`${reading.title} to ${reading.patient.name}`}
          onClose={() => setReading(null)}
          footer={<button onClick={() => setReading(null)}>Close</button>}
        >
          <div className="bubble">{reading.body}</div>
          <p className="small muted">
            {reading.context}
            {canApproveMessages(role) && reading.approved_by_name && ` · approved by ${reading.approved_by_name}`}
          </p>
        </Modal>
      )}
      {failing && <DidNotGo message={failing} onClose={() => setFailing(null)} onDone={() => setFailing(null)} />}
    </section>
  );
}

/** P40: the wording the clinic reuses. Also shown in Settings, Messaging. */
export function TemplatesPanel({ role }: { role: Role }) {
  const editor = canSetUpMessages(role);
  const { data, error, reload } = useLoad((signal) => api<TemplateList>('message-templates/', { signal }), []);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  return (
    <section className="panel">
      <div className="heading">
        <h2>Templates</h2>
        {editor && (
          <button type="button" className="secondary btn-sm" onClick={() => setEditing('new')}>
            New template
          </button>
        )}
      </div>
      <ErrorMessage message={error} />
      {data?.results.map((template) => (
        <div className="row" key={template.id}>
          <span>
            <strong>{template.name}</strong>
            <span className="muted">
              v{template.version} · {KIND_LABELS[template.kind].toLowerCase()}
              {template.uses.length ? ` · uses ${template.uses.join(', ')}` : ''}
            </span>
          </span>
          <span className="actions">
            <StatusLabel tone={template.approved ? 'green' : 'grey'}>
              {template.approved ? 'Approved' : 'Draft'}
            </StatusLabel>
            {editor && (
              <button
                type="button"
                className="link-button"
                aria-label={`Edit the template ${template.name}`}
                onClick={() => setEditing(template)}
              >
                Edit
              </button>
            )}
          </span>
        </div>
      ))}
      {!editor && <p className="small muted">The clinic owner or an administrator changes templates.</p>}
      {editing && data && (
        <EditTemplate
          template={editing === 'new' ? undefined : editing}
          fields={data.fields}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
            messagesChanged();
          }}
        />
      )}
    </section>
  );
}

/** P41: when a message is prepared without anyone asking. Also shown in Settings, Messaging. */
export function RulesPanel({ role }: { role: Role }) {
  const editor = canSetUpMessages(role);
  const { data, error, reload } = useLoad(
    (signal) => api<{ without_approval: boolean; results: Rule[] }>('message-rules/', { signal }),
    [],
  );
  const { data: templates } = useLoad((signal) => api<TemplateList>('message-templates/', { signal }), []);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [failure, setFailure] = useState('');
  async function toggle(rule: Rule, enabled: boolean) {
    setFailure('');
    try {
      await api(`message-rules/${rule.id}/`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
      reload();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <section className="panel">
      <div className="heading">
        <h2>Rules</h2>
        {editor && (
          <button type="button" className="secondary btn-sm" onClick={() => setEditing('new')}>
            New rule
          </button>
        )}
      </div>
      <ErrorMessage message={error || failure} />
      {data?.results.map((rule) => (
        <SettingRow
          key={rule.id}
          title={rule.name}
          hint={`${rule.words}${rule.enabled && !rule.template.approved ? ' · its template is a draft, so nothing is prepared' : ''}`}
          control={
            <Switch checked={rule.enabled} disabled={!editor} label={rule.name} onChange={(on) => toggle(rule, on)} />
          }
          after={
            editor && (
              <button
                type="button"
                className="link-button"
                aria-label={`Edit the rule ${rule.name}`}
                onClick={() => setEditing(rule)}
              >
                Edit
              </button>
            )
          }
        />
      ))}
      <p className="small muted">
        Rule messages are prepared when someone opens Messages or the dashboard, and wait in the queue. Nothing is sent
        by itself.
      </p>
      {editing && data && templates && (
        <EditRule
          rule={editing === 'new' ? undefined : editing}
          templates={templates.results}
          withoutApproval={data.without_approval}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </section>
  );
}

/** P20: one patient's messages, on their record. */
export function PatientMessages({ patient, role }: { patient: { id: string; name: string }; role: Role }) {
  const turn = useMessageTurn();
  const { data, error } = useLoad(
    (signal) => api<MessageList>(`messages/?patient=${patient.id}`, { signal }),
    [patient.id, turn],
  );
  const [window_, setWindow] = useState<'' | 'write' | 'reply'>('');
  return (
    <section className="panel">
      <div className="heading">
        <h2>Messages</h2>
        <div className="actions">
          <button type="button" className="secondary btn-sm" onClick={() => setWindow('reply')}>
            Note a reply
          </button>
          <button type="button" className="btn-sm" onClick={() => setWindow('write')}>
            New message
          </button>
        </div>
      </div>
      <ErrorMessage message={error} />
      {data && !data.results.length && (
        <p className="muted">No WhatsApp messages have been prepared for this patient.</p>
      )}
      {data?.results.map((message) => {
        const [tone, label] = statusOfMessage(message);
        return (
          <div className="row" key={message.id}>
            <span>
              <strong>{message.title}</strong> <StatusLabel tone={tone}>{label}</StatusLabel>
              <span className="reply-text">“{message.body}”</span>
              <span className="muted">
                {dateTime(message.sent_at ?? message.created_at)} · {message.context}
                {message.failed_reason && ` · ${message.failed_reason}`}
              </span>
            </span>
          </div>
        );
      })}
      {window_ === 'write' && (
        <WriteMessage role={role} patient={patient} onClose={() => setWindow('')} onDone={() => setWindow('')} />
      )}
      {window_ === 'reply' && (
        <NoteReply patient={patient} onClose={() => setWindow('')} onDone={() => setWindow('')} />
      )}
    </section>
  );
}
