/** The Appointments tab: the day's diary, who is waiting, follow-ups due, and the booking window. */
import { FormEvent, ReactElement, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from './api';
import { ErrorMessage } from './components';
import { addDays, ageSex, clock, isoDay, longDate, shortDate, weekdayDate } from './format';
import { PatientPicker } from './PatientWindows';
import { Role, canWriteClinical, canWriteDemographics } from './types';
import { ChoiceStrip, Menu, MenuItem, Modal, StatusLabel, Tone, notify, useLoad } from './ui';

export interface Appointment {
  id: string;
  day: string;
  time: string | null;
  duration_minutes: number;
  visit_type: 'first' | 'follow_up' | 'medicine_only';
  reason: string;
  status: 'booked' | 'arrived' | 'seen' | 'cancelled' | 'no_show';
  walk_in: boolean;
  arrived_at: string | null;
  waiting_minutes: number | null;
  billed: boolean;
  remind: boolean;
  reminder_at: string | null;
  cancel_reason: string;
  patient: { id: string; name: string; code: string; phone: string };
  doctor: { id: string; name: string } | null;
}
interface Slots {
  day: string;
  sessions: [string, string][];
  slots: { time: string; free: boolean }[];
}
interface Doctor {
  id: string;
  name: string;
}
interface FollowUp {
  patient: { id: string; name: string };
  due: string;
  booked: { day: string; time: string | null } | null;
}
interface Found {
  id: string;
  name: string;
  date_of_birth: string | null;
  gender: string;
  code: string;
}

export const TYPE_LABELS: Record<Appointment['visit_type'], string> = {
  first: 'First consultation',
  follow_up: 'Follow-up',
  medicine_only: 'Collect medicine',
};

/** The status label of an appointment, as the diary and the dashboard show it. */
export function statusOf(appointment: Appointment): [Tone, string] {
  if (appointment.status === 'seen') return ['green', appointment.billed ? 'Seen · billed' : 'Seen'];
  if (appointment.status === 'cancelled')
    return ['red', appointment.cancel_reason ? `Cancelled · ${appointment.cancel_reason}` : 'Cancelled'];
  if (appointment.status === 'no_show') return ['red', 'No-show'];
  if (appointment.status === 'arrived')
    return appointment.waiting_minutes ? ['amber', `Waiting ${appointment.waiting_minutes} min`] : ['blue', 'Arrived'];
  return ['grey', appointment.reminder_at ? 'Booked · reminder prepared' : 'Booked'];
}

const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

export function AppointmentsScreen({ role }: { role: Role }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const today = isoDay();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day')! : today;
  const view = (['day', 'week', 'list'] as const).find((name) => name === params.get('view')) ?? 'day';
  const [doctor, setDoctor] = useState('');
  const [turn, setTurn] = useState(0);
  const refresh = () => setTurn((value) => value + 1);
  // Arriving from "Save and book appointment" or a patient's record opens the booking window for that patient.
  const preset = (location.state as { book?: { id: string; name: string } } | null)?.book;
  const [booking, setBooking] = useState<null | {
    patient?: { id: string; name: string };
    day?: string;
    time?: string;
    move?: Appointment;
  }>(preset ? { patient: preset } : null);
  const [walkIn, setWalkIn] = useState(false);
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [error, setError] = useState('');
  const from = view === 'day' ? day : mondayOf(day);
  const to = view === 'day' ? day : addDays(from, 6);
  const { data: doctors } = useLoad((signal) => api<Doctor[]>('appointments/doctors/', { signal }), []);
  const { data, error: loadError } = useLoad(
    (signal) =>
      api<{ results: Appointment[] }>(`appointments/?from=${from}&to=${to}${doctor ? `&doctor=${doctor}` : ''}`, {
        signal,
      }),
    [from, to, doctor, turn],
  );
  const { data: slots } = useLoad(
    (signal) => api<Slots>(`appointments/slots/?day=${day}${doctor ? `&doctor=${doctor}` : ''}`, { signal }),
    [day, doctor, turn],
  );
  const { data: followUps } = useLoad(
    (signal) => api<{ count: number; results: FollowUp[] }>('appointments/follow-ups/', { signal }),
    [turn],
  );
  // The diary keeps itself fresh, so "Waiting 12 min" counts up without anyone pressing anything.
  useEffect(() => {
    const timer = window.setInterval(() => setTurn((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const go = (changes: Record<string, string>) =>
    setParams({ ...Object.fromEntries(params), ...changes }, { replace: true });
  const appointments = useMemo(() => data?.results ?? [], [data]);
  const todays = appointments.filter((appointment) => appointment.day === day);

  async function act(appointment: Appointment, step: string, body: object = {}) {
    setError('');
    try {
      await api(`appointments/${appointment.id}/${step}/`, { method: 'POST', body: JSON.stringify(body) });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const startVisit = (appointment: Appointment) => navigate(`/patients/${appointment.patient.id}/encounters/new`);
  function menuFor(appointment: Appointment): MenuItem[] {
    const open = appointment.status === 'booked' || appointment.status === 'arrived';
    return [
      { label: 'Open patient', to: `/patients/${appointment.patient.id}` },
      ...(appointment.status === 'booked'
        ? [
            { label: 'Mark arrived', onSelect: () => act(appointment, 'arrive') },
            { label: 'Reschedule…', onSelect: () => setBooking({ move: appointment, patient: appointment.patient }) },
          ]
        : []),
      ...(open && canWriteClinical(role) ? [{ label: 'Start visit', onSelect: () => startVisit(appointment) }] : []),
      ...(appointment.status === 'arrived'
        ? [{ label: 'Mark as seen', onSelect: () => act(appointment, 'seen') }]
        : []),
      ...(open
        ? ([
            'sep',
            ...(appointment.status === 'booked'
              ? [{ label: 'No-show', onSelect: () => act(appointment, 'no-show') }]
              : []),
            { label: 'Cancel appointment', danger: true, onSelect: () => setCancelling(appointment) },
          ] as MenuItem[])
        : []),
    ];
  }
  /** The one action a row most likely needs next, as a button. */
  function mainAction(appointment: Appointment) {
    if (appointment.status === 'booked' && appointment.day === today)
      return (
        <button type="button" className="secondary btn-sm" onClick={() => act(appointment, 'arrive')}>
          Mark arrived
        </button>
      );
    if (appointment.status === 'arrived' && canWriteClinical(role))
      return (
        <button type="button" className="btn-sm" onClick={() => startVisit(appointment)}>
          Start visit
        </button>
      );
    return null;
  }
  const waiting = todays
    .filter((appointment) => appointment.status === 'arrived')
    .sort((a, b) => (a.arrived_at ?? '').localeCompare(b.arrived_at ?? ''));

  /** The day as rows: each bookable time, with the appointment in it or an offer to book it. */
  function dayRows() {
    const timed = todays.filter((appointment) => appointment.time);
    const rows: ReactElement[] = [];
    const covered = new Set<string>();
    for (const appointment of timed) {
      const [hours, minutes] = appointment.time!.split(':').map(Number);
      for (let offset = 15; offset < appointment.duration_minutes; offset += 15) {
        const total = hours * 60 + minutes + offset;
        if (appointment.status !== 'cancelled' && appointment.status !== 'no_show')
          covered.add(`${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`);
      }
    }
    const times = [...new Set([...(slots?.slots.map((slot) => slot.time) ?? []), ...timed.map((a) => a.time!)])].sort();
    let previous = '';
    for (const time of times) {
      const session = slots?.sessions.find(([start, end]) => start <= time && time < end);
      const before = slots?.sessions.find(([start, end]) => start <= previous && previous < end);
      if (previous && session && before && session !== before)
        rows.push(
          <div className="closed-row muted" key={`closed-${time}`}>
            Clinic closed {before[1]} to {session[0]}
          </div>,
        );
      previous = time;
      const here = timed.filter((appointment) => appointment.time === time);
      const slot = slots?.slots.find((item) => item.time === time);
      if (!here.length && (covered.has(time) || !slot?.free)) continue;
      rows.push(
        <div className="t" key={`t-${time}`}>
          {time}
        </div>,
        <div key={`c-${time}`}>
          {here.map((appointment) => {
            const [tone, label] = statusOf(appointment);
            const style = appointment.status === 'seen' ? 'done' : tone === 'amber' ? 'wait' : '';
            return (
              <div className={`slot ${style}`} key={appointment.id}>
                <span>
                  <Link to={`/patients/${appointment.patient.id}`}>
                    <strong>{appointment.patient.name}</strong>
                  </Link>{' '}
                  · {appointment.reason || TYPE_LABELS[appointment.visit_type]}
                  {appointment.duration_minutes > 15 && ` (${appointment.duration_minutes} min)`}
                  {appointment.doctor && (doctors?.length ?? 0) > 1 && (
                    <span className="muted"> · {appointment.doctor.name}</span>
                  )}
                </span>
                <span className="actions">
                  <StatusLabel tone={tone}>{label}</StatusLabel>
                  {mainAction(appointment)}
                  <Menu
                    label="⋯"
                    className="link-button"
                    ariaLabel={`Actions for ${appointment.patient.name}`}
                    items={menuFor(appointment)}
                  />
                </span>
              </div>
            );
          })}
          {!here.length && slot?.free && (
            <button type="button" className="slot free" onClick={() => setBooking({ day, time })}>
              Free · click to book
            </button>
          )}
        </div>,
      );
    }
    return rows;
  }

  return (
    <>
      <div className="heading">
        <h1>Appointments</h1>
        <div className="actions">
          <button type="button" onClick={() => setBooking({ day: day >= today ? day : today })}>
            New appointment
          </button>
          <button type="button" className="secondary" onClick={() => setWalkIn(true)}>
            Add walk-in
          </button>
          <Link className="button secondary" to={`/print/day-sheet/${day}`}>
            Print day sheet
          </Link>
        </div>
      </div>
      <div className="toolbar">
        <button
          type="button"
          className="secondary btn-sm"
          aria-label="Earlier"
          onClick={() => go({ day: addDays(day, view === 'day' ? -1 : -7) })}
        >
          ‹
        </button>
        <strong>{view === 'day' ? longDate(day) : `${shortDate(from)} to ${shortDate(to)}`}</strong>
        <button
          type="button"
          className="secondary btn-sm"
          aria-label="Later"
          onClick={() => go({ day: addDays(day, view === 'day' ? 1 : 7) })}
        >
          ›
        </button>
        <button type="button" className="secondary btn-sm" onClick={() => go({ day: today })}>
          Today
        </button>
        <ChoiceStrip
          label="View"
          value={view}
          options={[
            ['day', 'Day'],
            ['week', 'Week'],
            ['list', 'List'],
          ]}
          onChange={(value) => go({ view: value })}
        />
        <span className="spacer" />
        {(doctors?.length ?? 0) > 1 && (
          <label className="check small">
            Doctor
            <select aria-label="Doctor" value={doctor} onChange={(e) => setDoctor(e.target.value)}>
              <option value="">All doctors</option>
              {doctors!.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ErrorMessage message={error || loadError} />

      {view === 'day' && (
        <div className="cols cols-2">
          <section className="panel flush" aria-label="Day">
            <div className="day-grid">{dayRows()}</div>
            {slots && !slots.sessions.length && !todays.some((a) => a.time) && (
              <p className="empty">The clinic is closed on this day. Working days are set in Settings, Work week.</p>
            )}
            {slots && !!slots.sessions.length && !dayRows().length && (
              <p className="empty">No appointments, and no free times left on this day.</p>
            )}
          </section>
          <div>
            <section className="panel">
              <div className="heading">
                <h2>Walk-ins and waiting</h2>
                <span className="count">{waiting.length}</span>
              </div>
              {!waiting.length && <p className="muted">Nobody is waiting.</p>}
              {waiting.map((appointment, index) => (
                <div className="row" key={appointment.id}>
                  <span>
                    <strong>
                      {index + 1}. {appointment.patient.name}
                    </strong>
                    <span className="muted">
                      {appointment.walk_in
                        ? `Walk-in${appointment.reason ? ` · ${appointment.reason}` : ''}`
                        : `${appointment.time} appointment`}{' '}
                      · arrived {clock(appointment.arrived_at)}
                    </span>
                  </span>
                  <span className="actions">
                    {canWriteClinical(role) ? (
                      <Link to={`/patients/${appointment.patient.id}/encounters/new`}>Start visit</Link>
                    ) : (
                      <Link to={`/patients/${appointment.patient.id}`}>Open</Link>
                    )}
                    <Menu
                      label="⋯"
                      className="link-button"
                      ariaLabel={`Actions for ${appointment.patient.name}, waiting`}
                      items={menuFor(appointment)}
                    />
                  </span>
                </div>
              ))}
            </section>
            <section className="panel">
              <div className="heading">
                <h2>Follow-ups due</h2>
                {!!followUps?.count && <Link to="/patients?follow_up=due">See all ({followUps.count})</Link>}
              </div>
              {followUps && !followUps.results.length && (
                <p className="muted">Nobody is due for a follow-up this week.</p>
              )}
              {followUps?.results.slice(0, 6).map((item) => (
                <div className="row" key={item.patient.id}>
                  <span>
                    <Link to={`/patients/${item.patient.id}`}>
                      <strong>{item.patient.name}</strong>
                    </Link>
                    <span className="muted">
                      Due {item.due === today ? 'today' : shortDate(item.due).slice(0, 6)} ·{' '}
                      {item.booked
                        ? `booked ${item.booked.day === today ? '' : `${shortDate(item.booked.day).slice(0, 6)} `}${item.booked.time ?? ''}`
                        : 'not booked'}
                    </span>
                  </span>
                  {item.booked ? (
                    <StatusLabel tone="green">Booked</StatusLabel>
                  ) : (
                    <button type="button" className="link-button" onClick={() => setBooking({ patient: item.patient })}>
                      Book
                    </button>
                  )}
                </div>
              ))}
            </section>
          </div>
        </div>
      )}

      {view === 'week' && (
        <section className="week-grid" aria-label="Week">
          {Array.from({ length: 7 }, (_, index) => addDays(from, index)).map((date) => {
            const list = appointments.filter((appointment) => appointment.day === date);
            return (
              <div className={`panel week-day ${date === today ? 'today' : ''}`} key={date}>
                <button type="button" className="link-button" onClick={() => go({ day: date, view: 'day' })}>
                  <strong>{weekdayDate(date).slice(0, 10)}</strong>
                </button>
                {!list.length && <p className="muted small">Nothing booked</p>}
                {list.map((appointment) => (
                  <p className="small" key={appointment.id}>
                    {appointment.time ?? 'Walk-in'} {appointment.patient.name}{' '}
                    <StatusLabel tone={statusOf(appointment)[0]}>{statusOf(appointment)[1]}</StatusLabel>
                  </p>
                ))}
              </div>
            );
          })}
        </section>
      )}

      {view === 'list' && (
        <section className="panel flush" aria-label="List">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Time</th>
                  <th>Patient</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {appointments.map((appointment) => (
                  <tr key={appointment.id}>
                    <td>{weekdayDate(appointment.day).slice(0, 10)}</td>
                    <td>{appointment.time ?? 'Walk-in'}</td>
                    <td>
                      <Link to={`/patients/${appointment.patient.id}`}>{appointment.patient.name}</Link>
                      <div className="muted small mono">{appointment.patient.code}</div>
                    </td>
                    <td>{appointment.reason || TYPE_LABELS[appointment.visit_type]}</td>
                    <td>
                      <StatusLabel tone={statusOf(appointment)[0]}>{statusOf(appointment)[1]}</StatusLabel>
                    </td>
                    <td className="right">
                      <Menu
                        label="⋯"
                        className="link-button"
                        ariaLabel={`Actions for ${appointment.patient.name}`}
                        items={menuFor(appointment)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && !appointments.length && <p className="empty">Nothing is booked in this week.</p>}
        </section>
      )}

      {booking && (
        <BookAppointment
          role={role}
          doctors={doctors ?? []}
          patient={booking.patient}
          day={booking.day}
          time={booking.time}
          move={booking.move}
          onClose={() => setBooking(null)}
          onBooked={(booked) => {
            setBooking(null);
            refresh();
            go({ day: booked.day, view: 'day' });
          }}
        />
      )}
      {walkIn && (
        <AddWalkIn
          onClose={() => setWalkIn(false)}
          onAdded={() => {
            setWalkIn(false);
            refresh();
            go({ day: today, view: 'day' });
          }}
        />
      )}
      {cancelling && (
        <CancelAppointment
          appointment={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => {
            setCancelling(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

/** W17: cancelling needs a few words of reason. */
function CancelAppointment({
  appointment,
  onClose,
  onDone,
}: {
  appointment: Appointment;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('Cancelled by patient');
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`appointments/${appointment.id}/cancel/`, { method: 'POST', body: JSON.stringify({ reason }) });
      notify('Appointment cancelled.');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title={`Cancel ${appointment.patient.name}'s appointment?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Keep appointment
          </button>
          <button form="cancel-form" className="danger">
            Cancel appointment
          </button>
        </>
      }
    >
      <form id="cancel-form" className="stack" onSubmit={submit}>
        <p>
          {weekdayDate(appointment.day)} at {appointment.time}. The time becomes free for someone else.
        </p>
        <ErrorMessage message={error} />
        <label>
          Reason
          <input data-autofocus value={reason} maxLength={200} required onChange={(e) => setReason(e.target.value)} />
        </label>
      </form>
    </Modal>
  );
}

/** W18: someone who came without a booked time joins the waiting list at once. */
export function AddWalkIn({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    setError('');
    try {
      await api('appointments/', {
        method: 'POST',
        body: JSON.stringify({
          patient: patient!.id,
          walk_in: true,
          reason: reason.trim(),
          visit_type: reason.trim() ? 'medicine_only' : 'follow_up',
        }),
      });
      notify(`${patient!.name} added to the waiting list.`);
      onAdded();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add walk-in"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !patient} onClick={add}>
            Add to the waiting list
          </button>
        </>
      }
    >
      <div className="stack">
        <ErrorMessage message={error} />
        {patient ? (
          <p>
            <strong>{patient.name}</strong>{' '}
            <button type="button" className="link-button" onClick={() => setPatient(null)}>
              Change
            </button>
          </p>
        ) : (
          <PatientPicker
            onPick={(picked) =>
              setPatient({ id: picked.id, name: [picked.first_name, picked.last_name].filter(Boolean).join(' ') })
            }
          />
        )}
        <label>
          What they came for
          <input
            value={reason}
            maxLength={120}
            placeholder="Optional, for example: collect medicine"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <p className="small muted">A few plain words for the front desk. Nothing clinical goes here.</p>
      </div>
    </Modal>
  );
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
export const addMonths = (month: string, count: number) => {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};
/** The dates of a month laid out Monday to Sunday, with blanks before the first. */
export function monthCells(month: string): (string | null)[] {
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: days }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`),
  ];
}

/** W5: start from a phone number, then tap a day and a time. */
export function BookAppointment({
  role,
  doctors,
  patient: presetPatient,
  day: presetDay,
  time: presetTime,
  move,
  onClose,
  onBooked,
}: {
  role: Role;
  doctors: Doctor[];
  patient?: { id: string; name: string };
  day?: string;
  time?: string;
  move?: Appointment;
  onClose: () => void;
  onBooked: (appointment: Appointment) => void;
}) {
  const today = isoDay();
  const [phone, setPhone] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(presetPatient ?? null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [day, setDay] = useState(presetDay ?? move?.day ?? '');
  const [month, setMonth] = useState((presetDay ?? move?.day ?? today).slice(0, 7));
  const [time, setTime] = useState(presetTime ?? '');
  const [type, setType] = useState<'follow_up' | 'first'>(move?.visit_type === 'first' ? 'first' : 'follow_up');
  const [doctor, setDoctor] = useState(move?.doctor?.id ?? (doctors.length === 1 ? doctors[0].id : ''));
  const [remind, setRemind] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: work } = useLoad(
    (signal) => api<{ days: Record<string, [string, string][]> }>(`work-days/?month=${month}`, { signal }),
    [month],
  );
  const { data: slots } = useLoad(
    (signal) =>
      day
        ? api<Slots>(`appointments/slots/?day=${day}${doctor ? `&doctor=${doctor}` : ''}`, { signal })
        : Promise.resolve(null),
    [day, doctor],
  );
  const digits = phone.replace(/\D/g, '');
  useEffect(() => {
    if (digits.length < 5) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    // The number travels in the request body, never in an address.
    const timer = setTimeout(() => {
      api<{ patients: Found[] }>('appointments/by-phone/', {
        method: 'POST',
        body: JSON.stringify({ phone }),
        signal: controller.signal,
      })
        .then((result) => setFound(result.patients))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [digits, phone]);
  const length = type === 'first' ? 45 : 15;
  /** A time is offered only if every quarter hour the visit needs is free. */
  const fits = (start: string) => {
    if (!slots) return false;
    const index = slots.slots.findIndex((slot) => slot.time === start);
    for (let step = 0; step < length / 15; step += 1) {
      const slot = slots.slots[index + step];
      const [hours, minutes] = start.split(':').map(Number);
      const total = hours * 60 + minutes + step * 15;
      const expected = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      if (!slot || slot.time !== expected || !slot.free) return false;
    }
    return true;
  };
  async function addPatient() {
    setError('');
    try {
      const created = await api<Found>('appointments/quick-patient/', {
        method: 'POST',
        body: JSON.stringify({ name: newName, phone }),
      });
      setPatient({ id: created.id, name: created.name });
      setFound((old) => [...(old ?? []), created]);
      setAdding(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function book() {
    setBusy(true);
    setError('');
    try {
      const booked = move
        ? await api<Appointment>(`appointments/${move.id}/reschedule/`, {
            method: 'POST',
            body: JSON.stringify({ day, time }),
          })
        : await api<Appointment>('appointments/', {
            method: 'POST',
            body: JSON.stringify({ patient: patient!.id, day, time, visit_type: type, doctor: doctor || null, remind }),
          });
      notify(move ? 'Appointment moved.' : 'Appointment booked.');
      onBooked(booked);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const morning = slots?.slots.filter((slot) => slot.time < '13:00') ?? [];
  const evening = slots?.slots.filter((slot) => slot.time >= '13:00') ?? [];
  const chips = (list: Slots['slots']) =>
    list.map((slot) => {
      const free = fits(slot.time);
      return (
        <button
          type="button"
          key={slot.time}
          className={`slot-chip ${time === slot.time ? 'sel' : ''} ${free ? '' : 'taken'}`}
          disabled={!free}
          aria-pressed={time === slot.time}
          onClick={() => setTime(slot.time)}
        >
          {slot.time}
        </button>
      );
    });
  return (
    <Modal
      title={move ? `Move ${move.patient.name}'s appointment` : 'New appointment'}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !patient || !day || !time} onClick={book}>
            {move ? 'Move appointment' : 'Book appointment'}
          </button>
        </>
      }
    >
      <ErrorMessage message={error} />
      {!move && (
        <>
          <label>
            Phone number
            <input
              data-autofocus={presetPatient ? undefined : true}
              className="phone-entry"
              type="tel"
              inputMode="numeric"
              value={phone}
              maxLength={40}
              placeholder="Type the number to find everyone on it"
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          <div className="picks">
            {presetPatient && !found?.some((item) => item.id === presetPatient.id) && (
              <button
                type="button"
                className={`pick ${patient?.id === presetPatient.id ? 'sel' : ''}`}
                onClick={() => setPatient(presetPatient)}
              >
                <span>
                  <strong>{presetPatient.name}</strong>
                </span>
              </button>
            )}
            {found?.map((item) => (
              <button
                type="button"
                className={`pick ${patient?.id === item.id ? 'sel' : ''}`}
                aria-pressed={patient?.id === item.id}
                key={item.id}
                onClick={() => setPatient({ id: item.id, name: item.name })}
              >
                <span>
                  <strong>{item.name}</strong>
                  {item.date_of_birth && ` · ${ageSex({ date_of_birth: item.date_of_birth, gender: item.gender })}`}
                </span>
                <span className="mono muted">{item.code}</span>
              </button>
            ))}
            {found && !found.length && <p className="muted small">Nobody is registered on this number yet.</p>}
            {digits.length >= 5 &&
              canWriteDemographics(role) &&
              (adding ? (
                <div className="pick new-patient">
                  <label>
                    Name of the new patient
                    <input autoFocus value={newName} maxLength={200} onChange={(e) => setNewName(e.target.value)} />
                  </label>
                  <button type="button" className="secondary" disabled={!newName.trim()} onClick={addPatient}>
                    Add patient
                  </button>
                </div>
              ) : (
                <button type="button" className="pick" onClick={() => setAdding(true)}>
                  <span>
                    <strong>+ New patient</strong> with this number
                  </span>
                  <span className="muted small">asks only for a name now</span>
                </button>
              ))}
          </div>
        </>
      )}
      <div className="cols cols-even book-when">
        <div>
          <div className="heading month-head">
            <button
              type="button"
              className="secondary btn-sm"
              aria-label="Earlier month"
              disabled={month <= today.slice(0, 7)}
              onClick={() => setMonth(addMonths(month, -1))}
            >
              ‹
            </button>
            <strong>{monthName(month)}</strong>
            <button
              type="button"
              className="secondary btn-sm"
              aria-label="Later month"
              onClick={() => setMonth(addMonths(month, 1))}
            >
              ›
            </button>
          </div>
          <div className="cal" role="group" aria-label="Day">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((letter, index) => (
              <span className="dow" key={index}>
                {letter}
              </span>
            ))}
            {monthCells(month).map((date, index) =>
              date ? (
                <button
                  type="button"
                  key={date}
                  className={`cal-day ${date === day ? 'sel' : ''} ${date === today ? 'today' : ''} ${date < today || !work?.days[date] ? 'off' : ''}`}
                  disabled={date < today || !work?.days[date]}
                  aria-pressed={date === day}
                  aria-label={shortDate(date)}
                  onClick={() => {
                    setDay(date);
                    setTime('');
                  }}
                >
                  {Number(date.slice(8))}
                </button>
              ) : (
                <span key={`blank-${index}`} />
              ),
            )}
          </div>
          <p className="small muted">Greyed days are closed in the work week or already past.</p>
        </div>
        <div>
          {!move && (
            <ChoiceStrip
              label="Kind of visit"
              value={type}
              options={[
                ['follow_up', 'Follow-up · 15 min'],
                ['first', 'First visit · 45 min'],
              ]}
              onChange={(value) => {
                setType(value);
                setTime('');
              }}
            />
          )}
          {!day && <p className="muted">Tap a day to see its free times.</p>}
          {day && slots && !slots.slots.length && <p className="muted">The clinic is closed on this day.</p>}
          {!!morning.length && (
            <>
              <div className="small muted slot-title">Morning</div>
              <div className="slots">{chips(morning)}</div>
            </>
          )}
          {!!evening.length && (
            <>
              <div className="small muted slot-title">Afternoon and evening</div>
              <div className="slots">{chips(evening)}</div>
            </>
          )}
          {doctors.length > 1 && !move && (
            <label className="book-doctor">
              Doctor
              <select aria-label="Doctor" value={doctor} onChange={(e) => setDoctor(e.target.value)}>
                <option value="">Any doctor</option>
                {doctors.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      <div className="info book-summary">
        <strong>
          {[patient?.name ?? 'Choose the patient', day ? weekdayDate(day) : 'tap a day', time || 'tap a time'].join(
            ' · ',
          )}
        </strong>
        {!move && (
          <label className="check">
            <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
            Prepare a WhatsApp reminder for the day before
          </label>
        )}
      </div>
    </Modal>
  );
}
