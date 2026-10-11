import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from './api';
import { ErrorMessage } from './components';
import { Page, Patient, Role, canWriteDemographics, displayName } from './types';

export function PatientList({ role }: { role: Role }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const search = params.get('search') || '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  function setPage(value: number) {
    setParams({ ...(search ? { search } : {}), page: String(value) });
  }
  const [data, setData] = useState<Page<Patient> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const timer = setTimeout(() => {
      api<Page<Patient>>(`patients/?search=${encodeURIComponent(search)}&page=${page}`, { signal: controller.signal })
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
  }, [search, page]);
  return (
    <>
      <div className="heading">
        <div>
          <h1>Patients</h1>
          <p className="muted">Find a record or register a new patient.</p>
        </div>
        {canWriteDemographics(role) && (
          <Link className="button" to="/patients/new">
            New patient
          </Link>
        )}
      </div>
      <label className="search">
        Search patients
        <input
          type="search"
          value={search}
          onChange={(e) => setParams(e.target.value ? { search: e.target.value } : {}, { replace: true })}
          placeholder="Name, phone, or patient ID"
        />
      </label>
      <ErrorMessage message={error} />
      {busy ? (
        <p role="status">Loading patients…</p>
      ) : (
        data &&
        !error && (
          <>
            <p className="muted">
              {data.count} patient{data.count !== 1 ? 's' : ''}
            </p>
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Date of birth</th>
                    <th>Phone</th>
                    <th>Patient ID</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link state={{ returnTo: location.pathname + location.search }} to={`/patients/${p.id}`}>
                          {displayName(p)}
                        </Link>
                      </td>
                      <td>{p.date_of_birth}</td>
                      <td>{p.phone || '—'}</td>
                      <td className="identifier">{p.identifier || p.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.results.length && <p className="empty">No patients found.</p>}
            </div>
            <div className="pagination">
              <button className="secondary" disabled={!data.previous} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>Page {page}</span>
              <button className="secondary" disabled={!data.next} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          </>
        )
      )}
    </>
  );
}
