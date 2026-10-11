/** The dashboard: the day at a glance. Each part appears only for the roles that work with it. */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from './api';
import { AddWalkIn, Appointment, BookAppointment, TYPE_LABELS, statusOf } from './AppointmentsScreen';
import { ErrorMessage } from './components';
import { dateTime, longDate, money, relativeDay } from './format';
import { Role, canWriteClinical, canWriteDemographics } from './types';
import { Modal, StatusLabel, useLoad } from './ui';

interface DashboardData {
  day: string;
  appointments: { total: number; seen: number } | null;
  follow_ups_due: number | null;
  unpaid: { count: number; total: string } | null;
  messages_waiting?: number | null;
  queue: Appointment[];
  attention: (
    { kind: 'drafts'; count: number } | { kind: 'backup'; last_ok_at: string | null; overdue: boolean; problem: string }
  )[];
  recent: { id: string; name: string; last_visit: string | null }[];
}
interface DraftRow {
  id: string;
  patient: string;
  patient_name: string;
  author_name: string;
  updated_at: string;
}

/** "Good morning", by the clinic's own clock. */
export function greeting(hour: number) {
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export function Dashboard({ role, userName, onFind }: { role: Role; userName: string; onFind: () => void }) {
  const navigate = useNavigate();
  const [turn, setTurn] = useState(0);
  const { data, error } = useLoad((signal) => api<DashboardData>('dashboard/', { signal }), [turn]);
  const [booking, setBooking] = useState(false);
  const [walkIn, setWalkIn] = useState(false);
  const [drafts, setDrafts] = useState(false);
  const [failure, setFailure] = useState('');
  const refresh = () => setTurn((value) => value + 1);
  const hour = Number(dateTime(new Date()).slice(-5, -3));
  const diary = !!data?.appointments;
  const queue = data?.queue ?? [];
  const attention = data?.attention ?? [];
  const recent = data?.recent ?? [];
  async function arrive(appointment: Appointment) {
    setFailure('');
    try {
      await api(`appointments/${appointment.id}/arrive/`, { method: 'POST', body: '{}' });
      refresh();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  const metrics = data
    ? [
        data.appointments && {
          to: '/appointments',
          figure: data.appointments.total,
          text: `${plural(data.appointments.total, 'appointment', 'appointments')} today · ${data.appointments.seen} seen`,
        },
        typeof data.follow_ups_due === 'number' && {
          to: '/patients?follow_up=due',
          figure: data.follow_ups_due,
          text: `${plural(data.follow_ups_due, 'patient', 'patients')} due for their next visit`,
        },
        data.unpaid && {
          to: '/billing/outstanding',
          figure: data.unpaid.count,
          text: `unpaid ${plural(data.unpaid.count, 'invoice', 'invoices')} · ${money(data.unpaid.total)}`,
        },
        data.messages_waiting !== null &&
          data.messages_waiting !== undefined && {
            to: '/messages',
            figure: data.messages_waiting,
            text: `${plural(data.messages_waiting, 'message', 'messages')} waiting for approval`,
          },
      ].filter((item): item is { to: string; figure: number; text: string } => !!item)
    : [];
  return (
    <>
      <div className="heading">
        <div>
          <h1>
            {greeting(hour)}, {userName}
          </h1>
          <p className="muted">{longDate(data?.day ?? new Date())}</p>
        </div>
        <div className="actions">
          {diary && (
            <button type="button" onClick={() => setBooking(true)}>
              New appointment
            </button>
          )}
          {canWriteDemographics(role) && (
            <Link className={`button ${diary ? 'secondary' : ''}`} to="/patients/new">
              New patient
            </Link>
          )}
          <button type="button" className="secondary" onClick={onFind}>
            Find or scan card
          </button>
          {diary && (
            <button type="button" className="secondary" onClick={() => setWalkIn(true)}>
              Walk-in
            </button>
          )}
        </div>
      </div>
      <ErrorMessage message={error || failure} />
      {!data && !error && <p role="status">Loading the day…</p>}
      {!!metrics.length && (
        <div className="metrics" style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}>
          {metrics.map((metric) => (
            <Link to={metric.to} key={metric.to}>
              <strong>{metric.figure}</strong>
              <span>{metric.text}</span>
            </Link>
          ))}
        </div>
      )}
      {data && (
        <div className="cols cols-2">
          {diary ? (
            <section className="panel flush">
              <div className="heading">
                <h2>Today&apos;s queue</h2>
                <Link to="/appointments">Open appointments →</Link>
              </div>
              {!queue.length && (
                <p className="empty">
                  Nobody is booked today. “New appointment” books one; “Walk-in” adds someone who just came.
                </p>
              )}
              {!!queue.length && (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Patient</th>
                        <th>Reason</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {queue.map((appointment) => {
                        const [tone, label] = statusOf(appointment);
                        return (
                          <tr key={appointment.id}>
                            <td>{appointment.time ?? 'Walk-in'}</td>
                            <td>
                              <Link to={`/patients/${appointment.patient.id}`}>{appointment.patient.name}</Link>
                              <div className="muted small mono">{appointment.patient.code}</div>
                            </td>
                            <td>{appointment.reason || TYPE_LABELS[appointment.visit_type]}</td>
                            <td>
                              <StatusLabel tone={tone}>{label}</StatusLabel>
                            </td>
                            <td className="right">
                              {appointment.status === 'booked' && (
                                <button type="button" className="secondary btn-sm" onClick={() => arrive(appointment)}>
                                  Mark arrived
                                </button>
                              )}
                              {appointment.status === 'arrived' &&
                                (canWriteClinical(role) ? (
                                  <Link
                                    className="button btn-sm"
                                    to={`/patients/${appointment.patient.id}/encounters/new`}
                                  >
                                    Start visit
                                  </Link>
                                ) : (
                                  <Link to={`/patients/${appointment.patient.id}`}>Open</Link>
                                ))}
                              {appointment.status === 'seen' && (
                                <Link to={`/patients/${appointment.patient.id}`}>Open</Link>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : (
            <section className="panel">
              <h2>Where to start</h2>
              <p className="muted">Use the tabs above, or find a patient with the search box at the top (Ctrl K).</p>
            </section>
          )}

          <div>
            {!!attention.length && (
              <section className="panel">
                <div className="heading">
                  <h2>Needs attention</h2>
                </div>
                {attention.map((item) =>
                  item.kind === 'drafts' ? (
                    <div className="row" key="drafts">
                      <span>
                        <strong>
                          {item.count} {plural(item.count, 'visit', 'visits')} left as{' '}
                          {plural(item.count, 'a draft', 'drafts')}
                        </strong>
                        <span className="muted">Finalise to lock the record</span>
                      </span>
                      <button type="button" className="link-button" onClick={() => setDrafts(true)}>
                        Review
                      </button>
                    </div>
                  ) : (
                    <div className="row" key="backup">
                      <span>
                        <strong>
                          {item.problem
                            ? 'Backups need setting up'
                            : item.overdue
                              ? 'Backup overdue'
                              : 'Backup completed'}
                        </strong>
                        <span className="muted">
                          {item.problem ||
                            (item.last_ok_at ? `Last: ${dateTime(item.last_ok_at)}` : 'No backup has been made yet')}
                        </span>
                      </span>
                      {item.overdue || item.problem ? (
                        <Link to="/settings/backups">Check</Link>
                      ) : (
                        <StatusLabel tone="green">OK</StatusLabel>
                      )}
                    </div>
                  ),
                )}
              </section>
            )}
            <section className="panel">
              <div className="heading">
                <h2>Recent patients</h2>
                <Link to="/patients">All patients →</Link>
              </div>
              {!recent.length && <p className="muted">Register your first patient to begin.</p>}
              {recent.map((patient) => (
                <div className="row" key={patient.id}>
                  <span>
                    <Link to={`/patients/${patient.id}`}>
                      <strong>{patient.name}</strong>
                    </Link>
                    <span className="muted">
                      {patient.last_visit ? `Last visit: ${relativeDay(patient.last_visit)}` : 'No visit yet'}
                    </span>
                  </span>
                  <Link to={`/patients/${patient.id}`}>Open →</Link>
                </div>
              ))}
            </section>
          </div>
        </div>
      )}
      {booking && (
        <BookingWindow
          role={role}
          onClose={() => setBooking(false)}
          onBooked={(appointment) => {
            setBooking(false);
            refresh();
            navigate(`/appointments?day=${appointment.day}`);
          }}
        />
      )}
      {walkIn && (
        <AddWalkIn
          onClose={() => setWalkIn(false)}
          onAdded={() => {
            setWalkIn(false);
            refresh();
          }}
        />
      )}
      {drafts && <DraftList onClose={() => setDrafts(false)} />}
    </>
  );
}

/** The booking window with the list of doctors it needs, for screens other than Appointments. */
export function BookingWindow({
  role,
  patient,
  day,
  onClose,
  onBooked,
}: {
  role: Role;
  patient?: { id: string; name: string };
  day?: string;
  onClose: () => void;
  onBooked: (appointment: Appointment) => void;
}) {
  const { data: doctors } = useLoad(
    (signal) => api<{ id: string; name: string }[]>('appointments/doctors/', { signal }),
    [],
  );
  if (!doctors) return null;
  return (
    <BookAppointment role={role} doctors={doctors} patient={patient} day={day} onClose={onClose} onBooked={onBooked} />
  );
}

/** P27: visits that were started and not yet finalised. */
function DraftList({ onClose }: { onClose: () => void }) {
  const { data, error } = useLoad((signal) => api<DraftRow[]>('visit-drafts/', { signal }), []);
  return (
    <Modal title="Draft visits" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <ErrorMessage message={error} />
      {!data && !error && <p role="status">Loading drafts…</p>}
      {data && !data.length && <p className="muted">No visits are waiting to be finalised.</p>}
      {data?.map((draft) => (
        <div className="row" key={draft.id}>
          <span>
            <strong>{draft.patient_name}</strong>
            <span className="muted">
              {draft.author_name} · saved {dateTime(draft.updated_at)}
            </span>
          </span>
          <Link to={`/patients/${draft.patient}/encounters/new`} onClick={onClose}>
            Continue
          </Link>
        </div>
      ))}
      <p className="small muted">A draft is seen by doctors only. Finalising it locks the visit into the record.</p>
    </Modal>
  );
}
