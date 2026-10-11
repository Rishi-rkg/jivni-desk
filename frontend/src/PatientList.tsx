import { FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from './api';
import { ErrorMessage } from './components';
import { ageSex, amount, isoDay, money, shortDate } from './format';
import { ImportPatients } from './PatientWindows';
import { Page, Patient, Role, canUseBilling, canWriteClinical, canWriteDemographics, displayName } from './types';
import { Avatar, Chip, Menu, StatusLabel } from './ui';

const SORTS = [
  ['last_visit', 'Last visit, newest'],
  ['name', 'Name A to Z'],
  ['registered', 'Registered, newest'],
] as const;

/** "Due 20 Oct" while the advised day is still ahead, "Overdue 4 days" once it has passed. */
export function NextAdvised({ day, today = isoDay() }: { day: string | null | undefined; today?: string }) {
  if (!day) return <span className="muted">None</span>;
  if (day >= today) return <StatusLabel tone="amber">Due {shortDate(day).slice(0, 6)}</StatusLabel>;
  const late = Math.round((Date.parse(today) - Date.parse(day)) / 86400000);
  return (
    <StatusLabel tone="red">
      Overdue {late} day{late === 1 ? '' : 's'}
    </StatusLabel>
  );
}

export function PatientList({ role, billingOn = true }: { role: Role; billingOn?: boolean }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const search = params.get('search') || '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const archived = params.get('archived') === 'true';
  const followUp = params.get('follow_up') === 'due';
  const balanceDue = params.get('balance') === 'due';
  const seen = params.get('seen') === 'month';
  const sort = SORTS.some(([key]) => key === params.get('sort')) ? params.get('sort')! : 'last_visit';
  const showBalance = billingOn && canUseBilling(role);
  const [data, setData] = useState<Page<Patient> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [importing, setImporting] = useState(false);
  const [turn, setTurn] = useState(0);

  /** Changes one part of the address and goes back to the first page. */
  function set(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    next.delete('page');
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  }
  const query = new URLSearchParams({
    search,
    page: String(page),
    sort,
    ...(archived ? { archived: 'true' } : {}),
    ...(followUp ? { follow_up: 'due' } : {}),
    ...(balanceDue ? { balance: 'due' } : {}),
    ...(seen ? { seen: 'month' } : {}),
  }).toString();
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const timer = setTimeout(() => {
      api<Page<Patient>>(`patients/?${query}`, { signal: controller.signal })
        .then(setData)
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, turn]);
  function goTo(target: number) {
    const next = new URLSearchParams(params);
    next.set('page', String(target));
    setParams(next);
  }
  const back = { returnTo: location.pathname + location.search };
  const today = isoDay();
  return (
    <>
      <div className="heading">
        <h1>Patients</h1>
        <div className="actions">
          {canWriteDemographics(role) && (
            <Link className="button" to="/patients/new">
              New patient
            </Link>
          )}
          {role === 'owner' && (
            <button type="button" className="secondary" onClick={() => setImporting(true)}>
              Import from spreadsheet
            </button>
          )}
        </div>
      </div>
      <form className="toolbar" onSubmit={(event: FormEvent) => event.preventDefault()}>
        <input
          type="search"
          aria-label="Search patients"
          className="patient-search"
          value={search}
          onChange={(e) => set({ search: e.target.value || null })}
          placeholder="Name, phone or patient ID"
        />
        <button>Search</button>
        <Chip on={!archived} onClick={() => set({ archived: null })}>
          Active
        </Chip>
        <Chip on={archived} onClick={() => set({ archived: archived ? null : 'true' })}>
          Archived
        </Chip>
        <Chip on={followUp} onClick={() => set({ follow_up: followUp ? null : 'due' })}>
          Follow-up due
        </Chip>
        {showBalance && (
          <Chip on={balanceDue} onClick={() => set({ balance: balanceDue ? null : 'due' })}>
            Balance due
          </Chip>
        )}
        <Chip on={seen} onClick={() => set({ seen: seen ? null : 'month' })}>
          Seen this month
        </Chip>
        <span className="spacer" />
        <label className="check small">
          Sort
          <select aria-label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value })}>
            {SORTS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </form>
      <ErrorMessage message={error} />
      {busy && !data && <p role="status">Loading patients…</p>}
      {data && !error && !data.results.length && (
        <section className="panel empty">
          {search ? (
            <>
              No patient matches “{search}”. Check the spelling, try the phone number
              {canWriteDemographics(role) && (
                <>
                  , or{' '}
                  <Link to="/patients/new" state={{ name: search }}>
                    register a new patient
                  </Link>
                </>
              )}
              .
            </>
          ) : archived || followUp || balanceDue || seen ? (
            'No patients found.'
          ) : (
            'No patients found. Register the first patient to begin.'
          )}
        </section>
      )}
      {data && !error && !!data.results.length && (
        <section className="panel flush">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Patient</th>
                  <th>Age · Sex</th>
                  <th>Phone</th>
                  <th>Last visit</th>
                  <th>Next advised</th>
                  {showBalance && <th className="num">Balance</th>}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Avatar name={displayName(p)} />
                    </td>
                    <td>
                      <Link state={back} to={`/patients/${p.id}`}>
                        <strong>{displayName(p)}</strong>
                      </Link>
                      <div className="mono muted">{p.identifier}</div>
                    </td>
                    <td>{ageSex(p).replace(' ', ' · ')}</td>
                    <td>{p.phone || p.whatsapp_number || <span className="muted">—</span>}</td>
                    <td>{p.last_visit ? shortDate(p.last_visit) : <span className="muted">Never</span>}</td>
                    <td>
                      <NextAdvised day={p.next_advised} today={today} />
                    </td>
                    {showBalance && <td className="num">{Number(p.balance) > 0 ? money(p.balance) : amount(0)}</td>}
                    <td className="right">
                      <Menu
                        label="Open ▾"
                        className="link-button"
                        ariaLabel={`Actions for ${displayName(p)}`}
                        items={[
                          { label: 'Open', onSelect: () => navigate(`/patients/${p.id}`, { state: back }) },
                          { label: 'Open in new tab', to: `/patients/${p.id}`, newTab: true },
                          ...(canWriteClinical(role) && !p.archived_at
                            ? [{ label: 'Start visit', to: `/patients/${p.id}/encounters/new` }]
                            : []),
                          ...(showBalance && !p.archived_at
                            ? [
                                {
                                  label: 'New invoice',
                                  onSelect: () =>
                                    navigate('/billing/new', {
                                      state: { patient: { id: p.id, name: displayName(p) } },
                                    }),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span className="muted">
              {data.results.length} of {data.count} match{data.count === 1 ? '' : 'es'}
              {data.clinic_total !== undefined &&
                ` · ${data.clinic_total} patient${data.clinic_total === 1 ? '' : 's'} in the clinic`}
            </span>
            <button type="button" className="secondary btn-sm" disabled={!data.previous} onClick={() => goTo(page - 1)}>
              Previous
            </button>
            <button type="button" className="secondary btn-sm" disabled={!data.next} onClick={() => goTo(page + 1)}>
              Next
            </button>
          </div>
        </section>
      )}
      {importing && (
        <ImportPatients
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            setTurn((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
