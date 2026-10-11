import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, setCSRF, setUnauthorizedHandler } from './api';
import {
  Membership,
  ROLE_LABELS,
  Session,
  canOpenSettings,
  canReadClinical,
  canUseAppointments,
  canUseBilling,
  canUseMessages,
  canWriteDemographics,
  featureOn,
} from './types';
import { NewPatient, PatientProfile } from './PatientScreens';
import { PatientList } from './PatientList';
import { NewEncounter } from './VisitScreen';
import { Brand, ErrorMessage } from './components';
import { Dashboard } from './WorkspaceScreens';
import { BillingScreen } from './BillingScreen';
import { InvoiceScreen, NewBill } from './InvoiceScreen';
import { PrintRoutes } from './PrintScreens';
import { PrintingScreen } from './PrintingScreen';
import { DraftStateContext } from './useUnsavedChanges';
import { MyAccount, SettingsScreen } from './SettingsScreen';
import { SetupScreen } from './SetupScreen';
import { LockScreen, useIdleLock } from './LockScreen';
import { Login } from './Login';
import { FindPatient } from './FindPatient';
import { resolveScan, takeScannedProduct, useScanner } from './Scanner';
import { LibraryScreen } from './Library';
import { setClinicLocale } from './format';
import { Avatar, Kbd, Menu, Modal, Notices, notify, useOfflineNotice, useShortcut } from './ui';

const DevBanner = () => <div className="dev-warning">Development build · Use synthetic patient data only</div>;

const SHORTCUTS: [string, string][] = [
  ['Ctrl K', 'Find a patient'],
  ['Ctrl L', 'Lock the screen'],
  ['Ctrl S', 'Save the form you are in'],
  ['Esc', 'Close a window or menu'],
  ['?', 'Show this list'],
];

function ShortcutList({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <dl className="shortcut-list">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} style={{ display: 'contents' }}>
            <dt>
              <Kbd>{keys}</Kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">
        A barcode scanner works on every screen: a patient card opens that patient, a product pack goes to the bill.
      </p>
    </Modal>
  );
}

function ComingSoon({ title }: { title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="panel muted">This part of the application is being built and is not available yet.</p>
    </>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [locked, setLocked] = useState<false | 'idle' | 'manual'>(false);
  const [finder, setFinder] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [scanProblem, setScanProblem] = useState<'' | 'unknown' | 'revoked'>('');
  const [unknownCode, setUnknownCode] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const printing = location.pathname.startsWith('/print/');
  const working = !!session && !locked;
  useOfflineNotice();
  // The server ended the session (401): cover the workspace but keep it mounted so drafts survive.
  useEffect(() => {
    setUnauthorizedHandler(() => setLocked((now) => now || 'idle'));
    return () => setUnauthorizedHandler(null);
  }, []);
  // Locking ends the server session too; the password brings everything back as it was.
  const lock = useCallback((why: 'idle' | 'manual') => {
    setFinder(false);
    setShortcuts(false);
    setLocked(why);
    api('auth/logout/', { method: 'POST', body: '{}' }).catch(() => {});
  }, []);
  const lockForInactivity = useCallback(() => lock('idle'), [lock]);
  // Whether a scanned product may start a new bill; kept in a ref so the scan handler always sees today's answer.
  const billingRef = useRef(false);
  useIdleLock(working, session?.idle_timeout_seconds, lockForInactivity);
  useShortcut('k', () => setFinder(true), { ctrl: true, active: working });
  useShortcut('l', () => lock('manual'), { ctrl: true, active: working });
  useShortcut('?', () => setShortcuts(true), { active: working });
  // One place decides what a scanned barcode means. A patient card opens that patient from anywhere;
  // unsaved work is still protected by the leave warning.
  const openScanned = useCallback(
    (code: string) => {
      setError('');
      setFinder(false);
      resolveScan(code)
        .then((result) => {
          if (result.kind === 'patient') navigate(`/patients/${result.patient.id}`);
          // A product goes to whatever is open: a bill adds a line, a visit asks who it is for.
          // With neither open, a new bill starts with the product on it.
          else if (!takeScannedProduct(result.product)) {
            if (billingRef.current) navigate('/billing/new', { state: { product: result.product } });
            else notify(`${result.product.name} is a product. Open a visit to add it for a patient.`);
          }
        })
        .catch((e) => {
          if (e instanceof ApiError && e.status === 404) {
            setUnknownCode(code.trim());
            setScanProblem((e.data as { kind?: string } | undefined)?.kind === 'revoked' ? 'revoked' : 'unknown');
          } else setError(e.message);
        });
    },
    [navigate],
  );
  useScanner(working && !printing, openScanned);
  const refreshSession = useCallback(() => {
    api<Session>('auth/me/')
      .then((s) => {
        setCSRF(s.csrf_token);
        setSession(s);
      })
      .catch(() => {});
  }, []);
  function switchUser() {
    if (
      draftDirty &&
      !window.confirm('Sign in as someone else? Unsaved changes on the locked screen will be discarded.')
    )
      return;
    setLocked(false);
    setSession(null);
    navigate('/');
  }
  useEffect(() => {
    api<Session>('auth/me/')
      .then((s) => {
        setCSRF(s.csrf_token);
        setSession(s);
      })
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) return setError(e.message);
        // Nobody is signed in. On a brand-new installation there is nobody to sign in as yet.
        return api<{ needed: boolean }>('auth/setup/')
          .then((setup) => setSetupNeeded(setup.needed))
          .catch(() => {});
      })
      .finally(() => setLoading(false));
  }, []);
  async function logout() {
    if (draftDirty && !window.confirm('Sign out without saving? Your unsaved changes will be discarded.')) return;
    try {
      await api('auth/logout/', { method: 'POST', body: '{}' });
      setSession(null);
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function switchClinic(clinicId: string) {
    if (clinicId === session?.clinic_id) return;
    if (draftDirty && !window.confirm('Switch clinics without saving? Your unsaved changes will be discarded.')) return;
    setSwitching(true);
    setError('');
    try {
      const s = await api<Session>('auth/clinic/', { method: 'POST', body: JSON.stringify({ clinic_id: clinicId }) });
      setSession(s);
      setCSRF(s.csrf_token);
      navigate('/dashboard');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  }
  const member: Membership | undefined = session?.memberships.find((m) => m.clinic_id === session.clinic_id);
  // Dates, times and money are written the clinic's way on every screen.
  setClinicLocale(member?.time_zone, member?.currency);

  if (loading)
    return (
      <main className="login">
        <p role="status">Opening clinic…</p>
      </main>
    );
  if (!session && setupNeeded)
    return (
      <>
        <SetupScreen
          onDone={(s) => {
            setSetupNeeded(false);
            setSession(s);
            navigate('/dashboard');
          }}
        />
        <DevBanner />
      </>
    );
  if (!session)
    return (
      <>
        <ErrorMessage message={error} />
        <Login
          onLogin={(s) => {
            setError('');
            setSession(s);
          }}
        />
        <DevBanner />
      </>
    );
  if (!member)
    return (
      <main>
        <ErrorMessage message="Your clinic membership is no longer available. Sign out and contact your administrator." />
        <button onClick={logout}>Sign out</button>
      </main>
    );
  const role = member.role;
  const userName = session.user.name || session.user.username;
  const tabs: [string, string, boolean][] = [
    ['/dashboard', 'Dashboard', true],
    ['/patients', 'Patients', true],
    ['/appointments', 'Appointments', canUseAppointments(role) && featureOn(member, 'appointments')],
    ['/messages', 'Messages', canUseMessages(role) && featureOn(member, 'messages')],
    ['/billing', 'Billing', canUseBilling(role) && featureOn(member, 'billing')],
    ['/library', 'Library', canReadClinical(role) && featureOn(member, 'library')],
    ['/printing', 'Printing', true],
    ['/settings', 'Settings', canOpenSettings(role)],
  ];
  const allowed = (path: string) => tabs.some(([to, , shown]) => to === path && shown);
  billingRef.current = allowed('/billing');
  const canAddProduct = (role === 'owner' || role === 'admin') && featureOn(member, 'billing');
  const guarded = (path: string, element: ReactNode) =>
    allowed(path) ? element : <Navigate to="/dashboard" replace />;
  return (
    <DraftStateContext.Provider value={setDraftDirty}>
      {locked && (
        <LockScreen
          session={session}
          clinicName={member.clinic_name}
          reason={locked}
          onUnlocked={(s) => {
            setSession(s);
            setLocked(false);
            setError('');
          }}
          onSwitchUser={switchUser}
        />
      )}
      {printing && <div hidden={!!locked}>{switching ? null : <PrintRoutes />}</div>}
      <div hidden={!!locked || printing}>
        <header className="workspace-header">
          <Link className="brand" to="/dashboard">
            <Brand />
          </Link>
          <button type="button" className="global-search" onClick={() => setFinder(true)}>
            <span>Find a patient by name, phone or ID, or scan a card</span>
            <Kbd>Ctrl K</Kbd>
          </button>
          <div className="account">
            {session.memberships.length > 1 ? (
              <Menu
                label={`${member.clinic_name} ▾`}
                ariaLabel={`Active clinic: ${member.clinic_name}. Switch clinic`}
                className="link-button"
                items={[
                  { heading: 'Your clinics' },
                  ...session.memberships.map((m) => ({
                    label: m.clinic_name,
                    kbd: m.clinic_id === session.clinic_id ? '✓' : undefined,
                    disabled: switching,
                    onSelect: () => switchClinic(m.clinic_id),
                  })),
                ]}
              />
            ) : (
              <span>{member.clinic_name}</span>
            )}
            <button type="button" className="secondary btn-sm" onClick={() => lock('manual')}>
              Lock
            </button>
            <Menu
              className="account-btn"
              ariaLabel={`Account: ${userName}, ${ROLE_LABELS[role]}`}
              label={
                <>
                  <Avatar name={userName} /> {userName} · {ROLE_LABELS[role]} ▾
                </>
              }
              items={[
                { heading: `${userName} · ${ROLE_LABELS[role]}` },
                { label: 'My account', to: canOpenSettings(role) ? '/settings/account' : '/account' },
                {
                  label: 'Change password',
                  to: canOpenSettings(role) ? '/settings/account' : '/account',
                },
                { label: 'Keyboard shortcuts', kbd: '?', onSelect: () => setShortcuts(true) },
                'sep',
                { label: 'Lock', kbd: 'Ctrl L', onSelect: () => lock('manual') },
                { label: 'Sign out', onSelect: logout },
              ]}
            />
          </div>
        </header>
        <nav className="workspace-tabs" aria-label="Clinic workspace">
          {tabs
            .filter(([, , shown]) => shown)
            .map(([to, label]) => (
              <NavLink key={to} to={to}>
                {label}
              </NavLink>
            ))}
        </nav>
        <DevBanner />
        <main className="content">
          <ErrorMessage message={error} />
          {switching ? (
            <p role="status">Switching clinic…</p>
          ) : (
            <Routes key={session.clinic_id}>
              <Route path="/dashboard" element={<Dashboard role={role} />} />
              <Route path="/patients" element={<PatientList role={role} />} />
              <Route
                path="/patients/new"
                element={canWriteDemographics(role) ? <NewPatient /> : <Navigate to="/patients" replace />}
              />
              <Route path="/patients/:id" element={<PatientProfile role={role} billingOn={allowed('/billing')} />} />
              <Route
                path="/patients/:id/encounters/new"
                element={<NewEncounter role={role} billingOn={allowed('/billing')} libraryOn={allowed('/library')} />}
              />
              <Route path="/appointments" element={guarded('/appointments', <ComingSoon title="Appointments" />)} />
              <Route path="/messages" element={guarded('/messages', <ComingSoon title="Messages" />)} />
              <Route path="/billing/new" element={guarded('/billing', <NewBill features={member.features} />)} />
              <Route
                path="/billing/invoices/:id"
                element={guarded('/billing', <InvoiceScreen role={role} features={member.features} />)}
              />
              <Route path="/billing/:tab?" element={guarded('/billing', <BillingScreen role={role} />)} />
              <Route path="/library" element={guarded('/library', <LibraryScreen role={role} />)} />
              <Route path="/printing/:section?" element={<PrintingScreen role={role} />} />
              <Route path="/account" element={<MyAccount session={session} onSaved={refreshSession} standalone />} />
              <Route
                path="/settings/:section?"
                element={guarded(
                  '/settings',
                  <SettingsScreen session={session} member={member} onSaved={refreshSession} />,
                )}
              />
              {/* Addresses from before the eight tabs. */}
              <Route path="/audit" element={<Navigate to="/settings/activity" replace />} />
              <Route path="/backups" element={<Navigate to="/settings/backups" replace />} />
              {/* Print pages are drawn above, without the tabs; this keeps the catch-all from sending them away. */}
              <Route path="/print/*" element={null} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          )}
        </main>
        {finder && <FindPatient role={role} onClose={() => setFinder(false)} />}
        {shortcuts && <ShortcutList onClose={() => setShortcuts(false)} />}
        {scanProblem && (
          <Modal
            title={scanProblem === 'revoked' ? 'This card is no longer valid' : 'Barcode not recognised'}
            onClose={() => setScanProblem('')}
            footer={
              <>
                <button data-autofocus className="secondary" onClick={() => setScanProblem('')}>
                  Close
                </button>
                {scanProblem === 'unknown' && canAddProduct && (
                  <button
                    onClick={() => {
                      setScanProblem('');
                      navigate(`/billing/prices?barcode=${encodeURIComponent(unknownCode)}`);
                    }}
                  >
                    Add as a new product
                  </button>
                )}
              </>
            }
          >
            {scanProblem === 'revoked' ? (
              <p>
                This patient card was replaced by a newer one. Nothing was opened. Find the patient by name or phone
                number instead.
              </p>
            ) : (
              <p>This code is not a patient ID or a product in the price list. Nothing was opened.</p>
            )}
          </Modal>
        )}
      </div>
      <Notices />
    </DraftStateContext.Provider>
  );
}
