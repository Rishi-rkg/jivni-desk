import { FormEvent, useState } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { api, setCSRF } from './api';
import { ActivityLog, ClinicDetails } from './AdminScreens';
import { BackupScreen } from './BackupScreen';
import { ErrorMessage } from './components';
import { RulesPanel, TemplatesPanel } from './MessagesScreen';
import {
  ImportExport,
  PriceListSettings,
  PrintSettings,
  SecuritySettings,
  TwoStepPanel,
  UsersAndRoles,
} from './TeamScreens';
import { WorkWeek } from './WorkWeek';
import {
  ClinicSettings,
  FeatureName,
  Membership,
  ROLE_LABELS,
  Role,
  Session,
  canManageBackups,
  featureOn,
} from './types';
import { SettingRow, Switch, notify, useLoad } from './ui';

interface Section {
  key: string;
  label: string;
  group: string;
  /** Who may open it. The server enforces the same rule. */
  roles: Role[];
  /** Shown only while this switch is on. */
  feature?: FeatureName;
}
const OWNER: Role[] = ['owner'];
const KEEPERS: Role[] = ['owner', 'admin'];
const SECTIONS: Section[] = [
  { key: 'clinic', label: 'Clinic details', group: 'Clinic', roles: KEEPERS },
  { key: 'work-week', label: 'Work week', group: 'Clinic', roles: KEEPERS },
  { key: 'price-list', label: 'Price list and tax', group: 'Clinic', roles: KEEPERS, feature: 'billing' },
  { key: 'users', label: 'Users and roles', group: 'People', roles: OWNER },
  { key: 'account', label: 'My account', group: 'People', roles: KEEPERS },
  { key: 'switches', label: 'Switches', group: 'Features', roles: OWNER },
  { key: 'messaging', label: 'Messaging', group: 'Features', roles: KEEPERS, feature: 'messages' },
  { key: 'print-templates', label: 'Print templates', group: 'Features', roles: KEEPERS },
  { key: 'printers', label: 'Printers', group: 'Features', roles: KEEPERS },
  { key: 'security', label: 'Security', group: 'Safety', roles: OWNER },
  { key: 'backups', label: 'Backups', group: 'Safety', roles: OWNER },
  { key: 'activity', label: 'Activity log', group: 'Safety', roles: KEEPERS },
  { key: 'import-export', label: 'Import and export', group: 'Safety', roles: OWNER },
];

/** P58: how messages leave the clinic, and the wording and rules behind them. */
function Messaging({ role }: { role: Role }) {
  return (
    <>
      <div className="heading">
        <div>
          <h2>Messaging</h2>
          <p className="muted">How WhatsApp messages are worded, when they are prepared, and how they are sent.</p>
        </div>
      </div>
      <section className="panel">
        <h2>How messages are sent</h2>
        <p>
          <strong>By a person, from WhatsApp on this computer or the clinic’s phone.</strong> A message is prepared
          here, approved by a doctor or the owner, and then opened in WhatsApp with the wording ready; someone presses
          Send there. Nothing is sent by itself, there is no account to connect and no cost per message.
        </p>
        <p className="muted small">
          Sending automatically through the WhatsApp Business Platform is not available in this version. Because a
          person sends each message, this application cannot show whether it was delivered or read.
        </p>
        <p className="muted small">
          A message goes only to a patient who agreed to that kind of message, recorded on their record under More,
          Message consent. A number written without a country code is taken to be an Indian number.
        </p>
      </section>
      <RulesPanel role={role} />
      <TemplatesPanel role={role} />
    </>
  );
}

export function SettingsScreen({
  session,
  member,
  onSaved,
}: {
  session: Session;
  member: Membership;
  onSaved: () => void;
}) {
  const { section } = useParams();
  const sections = SECTIONS.filter(
    (item) => item.roles.includes(member.role) && (!item.feature || featureOn(member, item.feature)),
  );
  const current = sections.find((item) => item.key === (section ?? 'clinic'));
  if (!current) return <Navigate to="/settings/clinic" replace />;
  return (
    <>
      <div className="heading">
        <div>
          <h1>Settings</h1>
          <p className="muted">For the clinic owner and administrators.</p>
        </div>
      </div>
      <div className="cols cols-nav">
        <nav className="side-nav" aria-label="Settings sections">
          {sections.map((item, index) => (
            <span key={item.key} style={{ display: 'contents' }}>
              {(index === 0 || sections[index - 1].group !== item.group) && <span className="group">{item.group}</span>}
              <NavLink to={`/settings/${item.key}`} className={item.key === current.key ? 'active' : ''}>
                {item.label}
              </NavLink>
            </span>
          ))}
        </nav>
        <div>
          {current.key === 'clinic' && <ClinicDetails role={member.role} onSaved={onSaved} />}
          {current.key === 'work-week' && <WorkWeek role={member.role} />}
          {current.key === 'messaging' && <Messaging role={member.role} />}
          {current.key === 'price-list' && <PriceListSettings role={member.role} />}
          {current.key === 'users' && <UsersAndRoles />}
          {current.key === 'account' && <MyAccount session={session} onSaved={onSaved} />}
          {current.key === 'print-templates' && <PrintSettings which="templates" />}
          {current.key === 'printers' && <PrintSettings which="printers" />}
          {current.key === 'security' && <SecuritySettings onSaved={onSaved} />}
          {current.key === 'import-export' && (
            <ImportExport role={member.role} billingOn={featureOn(member, 'billing')} />
          )}
          {current.key === 'switches' && <Switches onSaved={onSaved} />}
          {current.key === 'backups' && canManageBackups(member.role) && <BackupScreen />}
          {current.key === 'activity' && <ActivityLog />}
        </div>
      </div>
    </>
  );
}

const SWITCHES: { name: FeatureName; title: string; hint: string; notBuilt?: boolean }[] = [
  { name: 'appointments', title: 'Appointments', hint: 'Booking calendar and waiting queue.' },
  { name: 'billing', title: 'Billing', hint: 'Invoices, payments and day-end report.' },
  { name: 'product_sales', title: 'Product sales', hint: 'Shelf medicines, supplements and consumables on the bill.' },
  {
    name: 'show_gst',
    title: 'Show GST on bills',
    hint: 'The GST number, column and summary print only when a GSTIN is entered in Clinic details.',
  },
  { name: 'messages', title: 'WhatsApp messages', hint: 'Messages prepared here and sent by staff from WhatsApp.' },
  { name: 'auto_reminders', title: 'Send reminders without approval', hint: 'Appointment reminders only.' },
  { name: 'library', title: 'Homeopathy library', hint: 'Remedy and symptom reference for doctors.' },
  {
    name: 'stock_control',
    title: 'Stock control',
    hint: 'Batches, expiry and stock counts for dispensed medicines. Not available in this version.',
    notBuilt: true,
  },
  {
    name: 'ai_drafting',
    title: 'AI drafting',
    hint: 'Off by default. Drafts messages and summaries; a person approves every one. Not available in this version.',
    notBuilt: true,
  },
];

function Switches({ onSaved }: { onSaved: () => void }) {
  const { data, setData, error, loading } = useLoad((signal) => api<ClinicSettings>('clinic/', { signal }), []);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  async function change(name: FeatureName, value: boolean) {
    setBusy(name);
    setFailure('');
    try {
      setData(
        await api<ClinicSettings>('clinic/', {
          method: 'PATCH',
          body: JSON.stringify({ features: { [name]: value } }),
        }),
      );
      notify('Saved.');
      onSaved();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel">
      <h2>Switches</h2>
      <p className="muted">
        Turn parts of the application on or off for this clinic. A part that is off disappears for everyone and nothing
        in it is deleted.
      </p>
      <ErrorMessage message={error || failure} />
      {loading && !data && <p role="status">Loading switches…</p>}
      {data &&
        SWITCHES.map((item) => (
          <SettingRow
            key={item.name}
            title={item.title}
            hint={item.hint}
            control={
              <Switch
                label={item.title}
                checked={data.features[item.name]}
                disabled={item.notBuilt || busy === item.name}
                onChange={(value) => change(item.name, value)}
              />
            }
          />
        ))}
    </section>
  );
}

/** A person's own name and password. Open to every role. */
export function MyAccount({
  session,
  onSaved,
  standalone = false,
}: {
  session: Session;
  onSaved: () => void;
  standalone?: boolean;
}) {
  const [error, setError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [busy, setBusy] = useState(false);
  const member = session.memberships.find((m) => m.clinic_id === session.clinic_id);

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('auth/account/', {
        method: 'POST',
        body: JSON.stringify({ full_name: String(new FormData(event.currentTarget).get('full_name') || '') }),
      });
      notify('Name saved.');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPasswordError('');
    if (data.get('new_password') !== data.get('new_password_again'))
      return setPasswordError('The two new passwords are not the same.');
    setBusy(true);
    try {
      const result = await api<{ csrf_token: string }>('auth/password/', {
        method: 'POST',
        body: JSON.stringify({
          current_password: data.get('current_password'),
          new_password: data.get('new_password'),
        }),
      });
      setCSRF(result.csrf_token);
      form.reset();
      notify('Password changed.');
    } catch (e) {
      setPasswordError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {standalone && <h1>My account</h1>}
      <section className="panel">
        <h2>{standalone ? 'Your details' : 'My account'}</h2>
        <form className="stack" onSubmit={saveName}>
          <ErrorMessage message={error} />
          <div className="form-grid">
            <label>
              Your name
              <input
                name="full_name"
                defaultValue={session.user.name}
                required
                maxLength={150}
                autoComplete="name"
                aria-describedby="name-hint"
              />
            </label>
            <label>
              Username
              <input value={session.user.username} disabled readOnly />
            </label>
            <label>
              Role
              <input value={member ? ROLE_LABELS[member.role] : ''} disabled readOnly />
            </label>
          </div>
          <p className="muted" id="name-hint">
            Your name appears on visits, prescriptions and bills you make.
          </p>
          <div className="actions">
            <button disabled={busy}>Save name</button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>Change password</h2>
        <form className="stack" onSubmit={savePassword}>
          <ErrorMessage message={passwordError} />
          <div className="form-grid">
            <label>
              Current password
              <input name="current_password" type="password" required autoComplete="current-password" />
            </label>
            <label>
              New password
              <input name="new_password" type="password" required minLength={12} autoComplete="new-password" />
            </label>
            <label>
              New password again
              <input name="new_password_again" type="password" required minLength={12} autoComplete="new-password" />
            </label>
          </div>
          <p className="muted">
            At least 12 characters. Your password also unlocks the clinic&apos;s records, so it is changed for those at
            the same time. Other computers you are signed in on are signed out.
          </p>
          <div className="actions">
            <button disabled={busy}>Change password</button>
          </div>
        </form>
      </section>
      <TwoStepPanel session={session} onChanged={onSaved} />
    </>
  );
}
