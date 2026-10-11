/** Settings for the owner: users and roles, security, and the smaller pages that point at work done elsewhere. */
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { PriceList } from './BillingScreen';
import { ErrorMessage } from './components';
import { addDays, dateTime, isoDay, relativeDay, shortDate } from './format';
import { ImportPatients } from './PatientWindows';
import { ShowOnce, TwoStepSetup } from './SignInSteps';
import { ClinicSettings, ROLE_LABELS, Role, Session } from './types';
import { Menu, Modal, SettingRow, StatusLabel, Switch, notify, useLoad } from './ui';

interface Person {
  id: string;
  username: string;
  name: string;
  role: Role;
  is_active: boolean;
  two_step: boolean;
  two_step_asked: boolean;
  signed_in: number;
  last_active: string | null;
  must_change_password: boolean;
  can_open_records: boolean;
  you: boolean;
}
interface Team {
  roles: { code: Role; label: string }[];
  results: Person[];
}
type Given = Person & { one_time_password?: string };
const called = (person: Person) => person.name || person.username;

function lastActive(person: Person) {
  if (person.signed_in) return 'Now';
  if (!person.last_active) return 'Never';
  const day = isoDay(new Date(person.last_active));
  if (day === isoDay()) return `Today ${dateTime(person.last_active).slice(-5)}`;
  return relativeDay(day).replace(/^y/, 'Y');
}

/** P55: who works here and as what. */
export function UsersAndRoles() {
  const { data, error, reload } = useLoad((signal) => api<Team>('clinic/users/', { signal }), []);
  const [failure, setFailure] = useState('');
  const [inviting, setInviting] = useState(false);
  const [given, setGiven] = useState<Given | null>(null);
  const [asking, setAsking] = useState<null | { person: Person; what: 'off' | 'reset' | 'name' }>(null);
  async function send(person: Person, path: string, method: 'PATCH' | 'POST', body: object, done?: string) {
    setFailure('');
    try {
      const answer = await api<Given>(`clinic/users/${person.id}/${path}`, { method, body: JSON.stringify(body) });
      if (answer.one_time_password) setGiven(answer);
      else if (done) notify(done);
      reload();
    } catch (e) {
      setFailure((e as Error).message);
      reload();
    }
  }
  return (
    <>
      <section className="panel flush">
        <div className="heading">
          <div>
            <h2>Users and roles</h2>
            <p className="muted small">Each person signs in as themselves. A role decides what they can open.</p>
          </div>
          <button type="button" className="btn-sm" onClick={() => setInviting(true)}>
            Invite user
          </button>
        </div>
        <ErrorMessage message={error || failure} />
        {data && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Two-step sign-in</th>
                  <th>Last active</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((person) => (
                  <tr key={person.id} className={person.is_active ? '' : 'muted'}>
                    <td>
                      <strong>{called(person)}</strong>
                      {person.you && ' (you)'}
                      <div className="muted small">
                        {person.username}
                        {person.must_change_password && person.is_active && ' · has a one-time password'}
                      </div>
                    </td>
                    <td>
                      <select
                        aria-label={`Role of ${called(person)}`}
                        value={person.role}
                        disabled={person.you || !person.is_active}
                        onChange={(e) =>
                          send(
                            person,
                            '',
                            'PATCH',
                            { role: e.target.value },
                            `${called(person)} is now ${ROLE_LABELS[e.target.value as Role]}.`,
                          )
                        }
                      >
                        {data.roles.map((role) => (
                          <option key={role.code} value={role.code}>
                            {ROLE_LABELS[role.code] ?? role.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {person.two_step ? (
                        <StatusLabel tone="green">On</StatusLabel>
                      ) : person.two_step_asked && person.is_active ? (
                        <StatusLabel tone="amber">Asked at next sign-in</StatusLabel>
                      ) : (
                        <StatusLabel tone="grey">Off</StatusLabel>
                      )}
                    </td>
                    <td>{person.is_active ? lastActive(person) : 'Switched off'}</td>
                    <td>
                      <Switch
                        label={`${called(person)} can sign in`}
                        checked={person.is_active}
                        disabled={person.you}
                        onChange={(on) =>
                          on ? send(person, '', 'PATCH', { is_active: true }) : setAsking({ person, what: 'off' })
                        }
                      />
                    </td>
                    <td className="right">
                      <Menu
                        label="Manage ▾"
                        className="link-button"
                        ariaLabel={`Manage ${called(person)}`}
                        align="right"
                        items={[
                          { label: 'Change name…', onSelect: () => setAsking({ person, what: 'name' }) },
                          {
                            label: 'Reset password…',
                            disabled: person.you || !person.is_active,
                            onSelect: () => setAsking({ person, what: 'reset' }),
                          },
                          {
                            label: 'Sign out everywhere',
                            disabled: !person.signed_in,
                            onSelect: () =>
                              send(person, 'sign-out/', 'POST', {}, `${called(person)} is signed out everywhere.`),
                          },
                          {
                            label: 'Take two-step sign-in off',
                            disabled: !person.two_step || person.you,
                            onSelect: () =>
                              send(
                                person,
                                'two-step-off/',
                                'POST',
                                {},
                                `Two-step sign-in is off for ${called(person)}.`,
                              ),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted table-note">
          Switching someone off signs them out at once and keeps everything they recorded. Your own role and sign-in are
          changed by another owner, so a clinic is never left without one.
        </p>
      </section>
      {inviting && data && (
        <InviteUser
          roles={data.roles}
          onClose={() => setInviting(false)}
          onInvited={(person) => {
            setInviting(false);
            setGiven(person);
            reload();
          }}
        />
      )}
      {asking?.what === 'off' && (
        <Modal
          title={`Switch off ${called(asking.person)}?`}
          alert
          onClose={() => setAsking(null)}
          footer={
            <>
              <button type="button" className="secondary" onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void send(
                    asking.person,
                    '',
                    'PATCH',
                    { is_active: false },
                    `${called(asking.person)} can no longer sign in.`,
                  );
                  setAsking(null);
                }}
              >
                Switch off
              </button>
            </>
          }
        >
          They are signed out at once and cannot sign in or open the clinic’s records until switched back on. Everything
          they recorded stays, under their name.
        </Modal>
      )}
      {asking?.what === 'reset' && (
        <Modal
          title={`Reset the password of ${called(asking.person)}?`}
          alert
          onClose={() => setAsking(null)}
          footer={
            <>
              <button type="button" className="secondary" onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void send(asking.person, 'reset-password/', 'POST', {});
                  setAsking(null);
                }}
              >
                Reset password
              </button>
            </>
          }
        >
          They are signed out everywhere. You are shown a one-time password to give them, and they choose their own at
          the next sign-in. If they use two-step sign-in, they set it up again.
        </Modal>
      )}
      {asking?.what === 'name' && (
        <ChangeName
          person={asking.person}
          onClose={() => setAsking(null)}
          onSave={(name) => {
            void send(asking.person, '', 'PATCH', { name }, 'Name saved.');
            setAsking(null);
          }}
        />
      )}
      {given?.one_time_password && (
        <ShowOnce
          title={`One-time password for ${called(given)}`}
          label="One-time password"
          value={given.one_time_password}
          confirm="I have given it to them, or written it down"
          onClose={() => setGiven(null)}
        >
          <p>
            Give this to <strong>{called(given)}</strong> with their username,{' '}
            <span className="mono">{given.username}</span>. They sign in with it once and are asked to choose their own
            password before anything opens.
          </p>
        </ShowOnce>
      )}
    </>
  );
}

function ChangeName({
  person,
  onClose,
  onSave,
}: {
  person: Person;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(person.name);
  return (
    <Modal
      title={`Name of ${person.username}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim()} onClick={() => onSave(name.trim())}>
            Save name
          </button>
        </>
      }
    >
      <label>
        Name as it appears on records
        <input data-autofocus value={name} maxLength={150} onChange={(e) => setName(e.target.value)} />
      </label>
    </Modal>
  );
}

/** W10: a new person. They get a one-time password, shown once, and choose their own at first sign-in. */
function InviteUser({
  roles,
  onClose,
  onInvited,
}: {
  roles: Team['roles'];
  onClose: () => void;
  onInvited: (person: Given) => void;
}) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('reception');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onInvited(await api<Given>('clinic/users/', { method: 'POST', body: JSON.stringify({ name, username, role }) }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Invite a user"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="invite-form" disabled={busy || !name.trim() || !username.trim()}>
            Create and show one-time password
          </button>
        </>
      }
    >
      <form id="invite-form" className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />
        <label>
          Full name
          <input data-autofocus value={name} maxLength={150} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Username
          <input
            value={username}
            maxLength={150}
            autoComplete="off"
            placeholder="What they type to sign in, for example priya"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((item) => (
              <option key={item.code} value={item.code}>
                {ROLE_LABELS[item.code] ?? item.label}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted">{ROLE_HINTS[role]}</p>
      </form>
    </Modal>
  );
}

const ROLE_HINTS: Record<Role, string> = {
  owner: 'Everything, including users, switches, backups and the recovery key.',
  clinician: 'A doctor: visits, prescriptions, notes, bills, messages and the library.',
  assistant: 'Reads clinical records to help the doctor and prepare medicines; books appointments; prints labels.',
  reception:
    'The front desk: registers patients, books appointments, takes payments, sends approved messages. No clinical notes.',
  billing: 'Bills, payments, refunds and the day-end report. No clinical notes.',
  admin:
    'Looks after the installation: clinic details, work week, price list, templates and printers. No patient records.',
};

interface Security {
  two_step_asked: boolean;
  lock_after_minutes: number;
  recovery_key_created_at: string | null;
  sessions: number;
}

/** P59: the clinic's security settings. */
export function SecuritySettings({ onSaved }: { onSaved: () => void }) {
  const { data, error, reload } = useLoad((signal) => api<Security>('clinic/security/', { signal }), []);
  const [failure, setFailure] = useState('');
  const [window_, setWindow] = useState<'' | 'key' | 'sessions'>('');
  const [fresh, setFresh] = useState('');
  async function save(changes: object, done: string) {
    setFailure('');
    try {
      await api<ClinicSettings>('clinic/', { method: 'PATCH', body: JSON.stringify(changes) });
      notify(done);
      reload();
      onSaved();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  async function endSessions() {
    setWindow('');
    try {
      const answer = await api<{ ended: number }>('clinic/sessions/end/', { method: 'POST', body: '{}' });
      notify(`Signed out ${answer.ended} other session${answer.ended === 1 ? '' : 's'}.`);
      reload();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <section className="panel">
      <h2>Security</h2>
      <ErrorMessage message={error || failure} />
      {data && (
        <>
          <SettingRow
            title="Two-step sign-in for owners and doctors"
            hint="After the password, a 6-digit code from an authenticator app. Each owner and doctor sets it up at their next sign-in."
            control={
              <Switch
                label="Two-step sign-in for owners and doctors"
                checked={data.two_step_asked}
                onChange={(on) =>
                  save(
                    { features: { two_step: on } },
                    on
                      ? 'Owners and doctors will be asked at their next sign-in.'
                      : 'Two-step sign-in is no longer asked for.',
                  )
                }
              />
            }
          />
          <SettingRow
            title="Lock after no activity"
            hint="The screen locks and asks for the password again. A shared computer locks after 2 minutes whatever is chosen."
            after={
              <select
                aria-label="Lock after no activity"
                className="narrow"
                value={data.lock_after_minutes}
                onChange={(e) => save({ lock_after_minutes: Number(e.target.value) }, 'Lock time saved.')}
              >
                <option value={2}>2 minutes</option>
                <option value={5}>5 minutes</option>
                <option value={15}>15 minutes</option>
              </select>
            }
          />
          <SettingRow
            title="Recovery key"
            hint={
              data.recovery_key_created_at
                ? `Created ${shortDate(data.recovery_key_created_at)}. Needed if every password is lost.`
                : 'This clinic has no recovery key.'
            }
            after={
              <button type="button" className="secondary btn-sm" onClick={() => setWindow('key')}>
                Make a new one
              </button>
            }
          />
          <SettingRow
            title="Backups"
            hint="Encrypted copies of everything, with a test that they read back."
            after={<Link to="/settings/backups">Open</Link>}
          />
          <SettingRow
            title="Activity log"
            hint="Who opened or changed which record, and when."
            after={<Link to="/settings/activity">Open</Link>}
          />
          <SettingRow
            title="Signed-in devices"
            hint={`${data.sessions} active session${data.sessions === 1 ? '' : 's'}, counting this one`}
            after={
              <button type="button" className="danger btn-sm" onClick={() => setWindow('sessions')}>
                Sign out all
              </button>
            }
          />
        </>
      )}
      {window_ === 'key' && (
        <NewRecoveryKey
          onClose={() => setWindow('')}
          onMade={(key) => {
            setWindow('');
            setFresh(key);
            reload();
          }}
        />
      )}
      {window_ === 'sessions' && (
        <Modal
          title="Sign everyone out?"
          alert
          onClose={() => setWindow('')}
          footer={
            <>
              <button type="button" className="secondary" onClick={() => setWindow('')}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={endSessions}>
                Sign out all
              </button>
            </>
          }
        >
          Everyone in the clinic is signed out on every computer, except this screen. Unsaved work on those screens is
          lost; visit drafts that were saved are kept.
        </Modal>
      )}
      {fresh && (
        <ShowOnce
          title="Write down the new recovery key"
          label="New recovery key"
          value={fresh}
          onClose={() => setFresh('')}
        >
          <p>
            The old recovery key no longer works. Write this one down and keep it somewhere safe and away from the
            clinic’s computer. It is the only way back in if every password is lost.
          </p>
        </ShowOnce>
      )}
    </section>
  );
}

function NewRecoveryKey({ onClose, onMade }: { onClose: () => void; onMade: (key: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const made = await api<{ recovery_key: string }>('clinic/recovery-key/', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      onMade(made.recovery_key);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Make a new recovery key"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button form="recovery-form" disabled={busy || !password}>
            Make a new key
          </button>
        </>
      }
    >
      <form id="recovery-form" className="stack" onSubmit={submit}>
        <p>
          Do this if the paper copy is lost or someone may have seen it. The old key stops working at once and the new
          one is shown a single time.
        </p>
        <ErrorMessage message={error} />
        <label>
          Your password
          <input
            data-autofocus
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </form>
    </Modal>
  );
}

/** My account: the signed-in person's own two-step sign-in. */
export function TwoStepPanel({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const on = !!session.user.two_step;
  const [window_, setWindow] = useState<'' | 'setup' | 'off'>('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function turnOff(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('auth/two-step/off/', { method: 'POST', body: JSON.stringify({ password }) });
      notify('Two-step sign-in is off.');
      setWindow('');
      setPassword('');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="panel">
      <h2>Two-step sign-in</h2>
      <SettingRow
        title={on ? 'On' : 'Off'}
        hint={
          on
            ? 'Sign-in asks for a code from your authenticator app after your password.'
            : 'Adds a code from an authenticator app on your phone after your password.'
        }
        after={
          <button type="button" className="secondary btn-sm" onClick={() => setWindow(on ? 'off' : 'setup')}>
            {on ? 'Turn off' : 'Set up'}
          </button>
        }
      />
      <p className="small muted">
        Lost the phone? The clinic owner can take two-step sign-in off for you in Users and roles; an owner uses the
        recovery key.
      </p>
      {window_ === 'setup' && (
        <Modal title="Set up two-step sign-in" size="wide" onClose={() => setWindow('')}>
          <TwoStepSetup
            onCancel={() => setWindow('')}
            onDone={() => {
              setWindow('');
              onChanged();
            }}
          />
        </Modal>
      )}
      {window_ === 'off' && (
        <Modal
          title="Turn off two-step sign-in?"
          onClose={() => setWindow('')}
          footer={
            <>
              <button type="button" className="secondary" onClick={() => setWindow('')}>
                Cancel
              </button>
              <button form="two-step-off" className="danger" disabled={!password}>
                Turn off
              </button>
            </>
          }
        >
          <form id="two-step-off" className="stack" onSubmit={turnOff}>
            <p>Sign-in will ask only for your password.</p>
            <ErrorMessage message={error} />
            <label>
              Your password
              <input
                data-autofocus
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </form>
        </Modal>
      )}
    </section>
  );
}

/** Settings pages that are one step away from where the work is done. */
export function PriceListSettings({ role }: { role: Role }) {
  return (
    <>
      <div className="heading">
        <div>
          <h2>Price list and tax</h2>
          <p className="muted">
            What the clinic charges. Prices include GST; the rate on each line decides the tax shown on the bill. With
            no GSTIN in Clinic details, nothing about GST is printed.
          </p>
        </div>
      </div>
      <PriceList editable={role === 'owner' || role === 'admin'} />
    </>
  );
}

export function PrintSettings({ which }: { which: 'templates' | 'printers' }) {
  return (
    <section className="panel">
      <h2>{which === 'templates' ? 'Print templates' : 'Printers'}</h2>
      {which === 'templates' ? (
        <p>
          The layout of envelope labels, bills, receipts, prescriptions and the patient card: what each shows and at
          what size. Each change is kept as a new version.
        </p>
      ) : (
        <p>
          Printing goes through this computer’s own print window, so any printer it can use works here, including a 2
          inch label printer. The Printers page prints a test label to check the size.
        </p>
      )}
      <Link className="button" to={which === 'templates' ? '/printing/label' : '/printing/printers'}>
        {which === 'templates' ? 'Open print layouts' : 'Open printers'}
      </Link>
    </section>
  );
}

/** P61: getting records in and out. */
export function ImportExport({ role, billingOn }: { role: Role; billingOn: boolean }) {
  const [importing, setImporting] = useState(false);
  const today = isoDay();
  const from = addDays(today, -365);
  return (
    <section className="panel">
      <h2>Import and export</h2>
      <SettingRow
        title="Import patients from a spreadsheet"
        hint="A CSV file from another system or a register kept in a spreadsheet. A trial run shows what would happen first."
        after={
          <button type="button" className="secondary btn-sm" onClick={() => setImporting(true)}>
            Import
          </button>
        }
      />
      <SettingRow
        title="Export the patient list"
        hint="Names, contact details and patient IDs as a CSV file. No clinical notes."
        after={
          <a className="button secondary btn-sm" href="/api/v1/patients/export/">
            Download
          </a>
        }
      />
      {billingOn && role === 'owner' && (
        <>
          <SettingRow
            title="Export invoices"
            hint={`Every invoice from ${shortDate(from)} to today, one row each.`}
            after={
              <a
                className="button secondary btn-sm"
                href={`/api/v1/billing/export/?kind=invoices&from=${from}&to=${today}`}
              >
                Download
              </a>
            }
          />
          <SettingRow
            title="Export payments"
            hint="Every payment and refund in the same year."
            after={
              <a
                className="button secondary btn-sm"
                href={`/api/v1/billing/export/?kind=payments&from=${from}&to=${today}`}
              >
                Download
              </a>
            }
          />
        </>
      )}
      <SettingRow
        title="Everything, encrypted"
        hint="A backup holds every record and file and can be restored on another computer."
        after={
          role === 'owner' ? (
            <Link to="/settings/backups">Open backups</Link>
          ) : (
            <span className="muted small">Owner only</span>
          )
        }
      />
      <p className="small muted">
        An exported file is no longer protected by this application. Keep it only as long as it is needed.
      </p>
      {importing && <ImportPatients onClose={() => setImporting(false)} onDone={() => setImporting(false)} />}
    </section>
  );
}
