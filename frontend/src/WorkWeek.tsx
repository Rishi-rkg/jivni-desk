/** Settings, Work week: the days and times the clinic sees patients, set month by month. */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { addMonths, monthCells, monthName } from './AppointmentsScreen';
import { ErrorMessage } from './components';
import { isoDay } from './format';
import { Role, canAdministerClinic } from './types';
import { Modal, notify, useLoad } from './ui';
import { useUnsavedChanges } from './useUnsavedChanges';

type Session = [string, string];
/** Morning and evening for one kind of day. An empty start or end means "no session". */
type Times = { m1: string; m2: string; e1: string; e2: string };
interface Hours {
  weekday: Times;
  saturday: Times;
  sunday: Times;
}
interface MonthData {
  month: string;
  saved: boolean;
  days: Record<string, Session[]>;
}
interface Template {
  slot: number;
  name: string;
  hours: Record<'weekday' | 'saturday' | 'sunday', Session[]> | null;
}

const REGULAR: Times = { m1: '09:30', m2: '13:00', e1: '17:00', e2: '20:00' };
const NONE: Times = { m1: '', m2: '', e1: '', e2: '' };
const sessionsOf = (times: Times): Session[] =>
  (
    [
      [times.m1, times.m2],
      [times.e1, times.e2],
    ] as Session[]
  ).filter(([start, end]) => start && end);
const timesOf = (sessions: Session[] | undefined): Times => ({
  m1: sessions?.[0]?.[0] ?? '',
  m2: sessions?.[0]?.[1] ?? '',
  e1: sessions?.[1]?.[0] ?? '',
  e2: sessions?.[1]?.[1] ?? '',
});
const kindOf = (date: string) => {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 'sunday' : weekday === 6 ? 'saturday' : 'weekday';
};
const same = (a: Times, b: Times) => JSON.stringify(sessionsOf(a)) === JSON.stringify(sessionsOf(b));
const describe = (sessions: Session[]) =>
  sessions.length ? sessions.map(([start, end]) => `${start}–${end}`).join(', ') : 'closed';

/** The times a saved month uses, read back from its dates. */
function hoursFrom(days: Record<string, Session[]>): Hours | null {
  const first = (kind: string) => Object.entries(days).find(([date]) => kindOf(date) === kind)?.[1];
  if (!Object.keys(days).length) return null;
  const weekday = first('weekday');
  return {
    weekday: timesOf(weekday),
    saturday: timesOf(first('saturday') ?? weekday),
    sunday: timesOf(first('sunday')),
  };
}

export function WorkWeek({ role }: { role: Role }) {
  const editable = canAdministerClinic(role);
  const [month, setMonth] = useState(isoDay().slice(0, 7));
  const { data, setData, error } = useLoad(
    (signal) => api<MonthData>(`work-days/?month=${month}`, { signal }),
    [month],
  );
  const { data: templates, setData: setTemplates } = useLoad(
    (signal) => api<Template[]>('work-days/templates/', { signal }),
    [],
  );
  const [hours, setHours] = useState<Hours>({ weekday: REGULAR, saturday: REGULAR, sunday: NONE });
  const [weekendDiffers, setWeekendDiffers] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [naming, setNaming] = useState<number | null>(null);
  const { prompt } = useUnsavedChanges(dirty);
  const dates = useMemo(() => monthCells(month).filter((date): date is string => !!date), [month]);

  // Opening a month shows what is saved for it, or the usual week if nobody has set it up yet.
  useEffect(() => {
    if (!data || data.month !== month) return;
    const read = hoursFrom(data.days);
    if (read) {
      setHours(read);
      setWeekendDiffers(!same(read.weekday, read.saturday) || sessionsOf(read.sunday).length > 0);
    }
    setOpen(new Set(Object.keys(data.days)));
    setDirty(false);
  }, [data, month]);

  const timesFor = (date: string): Times => {
    const kind = kindOf(date);
    return weekendDiffers ? hours[kind] : kind === 'sunday' ? hours.sunday : hours.weekday;
  };
  function change(kind: keyof Hours, patch: Partial<Times>) {
    setDirty(true);
    setHours((old) => {
      const next = { ...old, [kind]: { ...old[kind], ...patch } };
      // With regular times, Saturday follows the weekdays.
      return weekendDiffers ? next : { ...next, saturday: next.weekday };
    });
  }
  function toggle(date: string) {
    if (!editable) return;
    setDirty(true);
    setOpen((old) => {
      const next = new Set(old);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }
  const daysFor = (targetDates: string[], chosen: Set<string>) =>
    Object.fromEntries(
      targetDates
        .filter((date) => chosen.has(date) && sessionsOf(timesFor(date)).length)
        .map((date) => [date, sessionsOf(timesFor(date))]),
    );
  async function save(target = month, days = daysFor(dates, open)) {
    setBusy(true);
    setFailure('');
    try {
      const saved = await api<MonthData>('work-days/', {
        method: 'POST',
        body: JSON.stringify({ month: target, days }),
      });
      if (target === month) {
        setData(saved);
        setDirty(false);
      }
      notify(target === month ? 'Work week saved.' : `Copied to ${monthName(target)}.`);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** The same weekdays next month: every Monday that is open here is open there, and so on. */
  function copyToNextMonth() {
    const next = addMonths(month, 1);
    const openKinds = new Set([...open].map((date) => new Date(`${date}T00:00:00Z`).getUTCDay()));
    const nextDates = monthCells(next).filter((date): date is string => !!date);
    const chosen = new Set(nextDates.filter((date) => openKinds.has(new Date(`${date}T00:00:00Z`).getUTCDay())));
    return save(next, daysFor(nextDates, chosen));
  }
  function applyTemplate(template: Template) {
    if (!template.hours) return;
    const next = {
      weekday: timesOf(template.hours.weekday),
      saturday: timesOf(template.hours.saturday),
      sunday: timesOf(template.hours.sunday),
    };
    setHours(next);
    setWeekendDiffers(!same(next.weekday, next.saturday) || sessionsOf(next.sunday).length > 0);
    // Dates follow the template: a kind of day with no times is closed.
    setOpen(new Set(dates.filter((date) => sessionsOf(next[kindOf(date)]).length)));
    setDirty(true);
    notify(`“${template.name}” applied to ${monthName(month)}. Save to keep it.`);
  }
  async function saveTemplate(slot: number, name: string) {
    setFailure('');
    try {
      const body = {
        name,
        hours: {
          weekday: sessionsOf(hours.weekday),
          saturday: sessionsOf(weekendDiffers ? hours.saturday : hours.weekday),
          sunday: sessionsOf(hours.sunday),
        },
      };
      setTemplates(
        await api<Template[]>(`work-days/templates/${slot}/`, { method: 'PUT', body: JSON.stringify(body) }),
      );
      notify(`Saved as work week ${slot}.`);
    } catch (e) {
      setFailure((e as Error).message);
    }
    setNaming(null);
  }
  const used = templates?.filter((template) => template.hours).length ?? 0;
  const timeRow = (kind: keyof Hours, label: string, evening = true) => (
    <div className="times" key={kind}>
      <strong>{label}</strong>
      <span className="range">
        <input
          type="time"
          aria-label={`${label} morning from`}
          value={hours[kind].m1}
          disabled={!editable}
          onChange={(e) => change(kind, { m1: e.target.value })}
        />
        <input
          type="time"
          aria-label={`${label} morning to`}
          value={hours[kind].m2}
          disabled={!editable}
          onChange={(e) => change(kind, { m2: e.target.value })}
        />
      </span>
      {evening || hours[kind].e1 ? (
        <span className="range">
          <input
            type="time"
            aria-label={`${label} evening from`}
            value={hours[kind].e1}
            disabled={!editable}
            onChange={(e) => change(kind, { e1: e.target.value })}
          />
          <input
            type="time"
            aria-label={`${label} evening to`}
            value={hours[kind].e2}
            disabled={!editable}
            onChange={(e) => change(kind, { e2: e.target.value })}
          />
        </span>
      ) : (
        <button
          type="button"
          className="link-button"
          disabled={!editable}
          onClick={() => change(kind, { e1: '17:00', e2: '20:00' })}
        >
          No evening · add one
        </button>
      )}
    </div>
  );
  const year = Number(month.slice(0, 4));
  const working = dates.filter((date) => open.has(date) && sessionsOf(timesFor(date)).length).length;
  return (
    <>
      {prompt}
      <div className="heading">
        <div>
          <h2>Work week</h2>
          <p className="muted">
            The days and times the clinic sees patients. Appointments can only be booked inside these.
          </p>
        </div>
      </div>
      <ErrorMessage message={error || failure} />
      {data && !data.saved && (
        <p className="info">
          {monthName(month)} has not been set up yet, so the usual week is shown: Monday to Saturday, morning and
          evening. Save to make it your own.
        </p>
      )}
      <div className="cols cols-workweek">
        <div>
          <section className="panel">
            <h2>Clinic times</h2>
            <div className="quick">
              <button
                type="button"
                className={`secondary ${weekendDiffers ? '' : 'on'}`}
                aria-pressed={!weekendDiffers}
                disabled={!editable}
                onClick={() => {
                  setWeekendDiffers(false);
                  setHours((old) => ({ ...old, saturday: old.weekday, sunday: NONE }));
                  setDirty(true);
                }}
              >
                Regular clinic times
                <br />
                <span className="small">same every working day</span>
              </button>
              <button
                type="button"
                className={`secondary ${weekendDiffers ? 'on' : ''}`}
                aria-pressed={weekendDiffers}
                disabled={!editable}
                onClick={() => {
                  setWeekendDiffers(true);
                  setDirty(true);
                }}
              >
                Different weekend times
                <br />
                <span className="small">Saturday and Sunday differ</span>
              </button>
            </div>
            <div className="times small muted">
              <span></span>
              <span>Morning</span>
              <span>Evening</span>
            </div>
            {timeRow('weekday', weekendDiffers ? 'Mon to Fri' : 'Mon to Sat')}
            {weekendDiffers && timeRow('saturday', 'Saturday', false)}
            {weekendDiffers && timeRow('sunday', 'Sunday', false)}
            <p className="small muted">Changing a time updates every working date in the month on the right.</p>
          </section>

          <section className="panel">
            <div className="heading">
              <h2>Saved work weeks</h2>
              <span className="muted small">{used} of 4 used</span>
            </div>
            {templates?.map((template) => (
              <div className="row" key={template.slot}>
                {template.hours ? (
                  <span>
                    <strong>{template.name}</strong>
                    <span className="muted">
                      Weekdays {describe(template.hours.weekday)} · Sat {describe(template.hours.saturday)} · Sun{' '}
                      {describe(template.hours.sunday)}
                    </span>
                  </span>
                ) : (
                  <span className="muted">Empty</span>
                )}
                {editable && (
                  <span className="actions">
                    {template.hours && (
                      <button type="button" className="secondary btn-sm" onClick={() => applyTemplate(template)}>
                        Use
                      </button>
                    )}
                    <button type="button" className="secondary btn-sm" onClick={() => setNaming(template.slot)}>
                      Save current here
                    </button>
                  </span>
                )}
              </div>
            ))}
          </section>
        </div>

        <section className="panel">
          <div className="toolbar">
            <select
              aria-label="Month"
              value={Number(month.slice(5, 7))}
              onChange={(e) => setMonth(`${year}-${e.target.value.padStart(2, '0')}`)}
            >
              {Array.from({ length: 12 }, (_, index) => (
                <option key={index} value={index + 1}>
                  {monthName(`${year}-${String(index + 1).padStart(2, '0')}`).split(' ')[0]}
                </option>
              ))}
            </select>
            <select aria-label="Year" value={year} onChange={(e) => setMonth(`${e.target.value}-${month.slice(5, 7)}`)}>
              {[year - 1, year, year + 1, year + 2].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <span className="spacer" />
            {editable && (
              <>
                <button
                  type="button"
                  className="secondary btn-sm"
                  onClick={() => {
                    setOpen(new Set(dates));
                    setDirty(true);
                  }}
                >
                  Select all dates
                </button>
                <button
                  type="button"
                  className="secondary btn-sm"
                  onClick={() => {
                    setOpen(new Set());
                    setDirty(true);
                  }}
                >
                  Clear all
                </button>
              </>
            )}
          </div>
          <div className="cal big" role="group" aria-label={`Working dates in ${monthName(month)}`}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name) => (
              <span className="dow" key={name}>
                {name}
              </span>
            ))}
            {monthCells(month).map((date, index) => {
              if (!date) return <span key={`blank-${index}`} />;
              const sessions = sessionsOf(timesFor(date));
              const on = open.has(date) && sessions.length > 0;
              return (
                <button
                  type="button"
                  key={date}
                  className={`cal-day ${on ? '' : 'off'}`}
                  aria-pressed={on}
                  aria-label={`${Number(date.slice(8))} ${monthName(month)}: ${on ? 'working' : 'closed'}`}
                  disabled={!editable}
                  onClick={() => toggle(date)}
                >
                  {Number(date.slice(8))}
                  <small>
                    {on ? sessions.map(([start, end]) => <span key={start}>{`${start}–${end}`}</span>) : 'Closed'}
                  </small>
                </button>
              );
            })}
          </div>
          <p className="small muted">
            Tap a date to switch it between working and closed, for example for a holiday.{' '}
            <strong>
              {working} working day{working === 1 ? '' : 's'} in {monthName(month)}.
            </strong>
          </p>
        </section>
      </div>
      {editable ? (
        <div className="save-bar">
          <span className="muted">{dirty ? 'Unsaved changes' : data?.saved ? 'Saved' : 'Not saved yet'}</span>
          <div className="actions">
            <button type="button" className="secondary" disabled={busy} onClick={copyToNextMonth}>
              Copy to next month
            </button>
            <button type="button" disabled={busy} onClick={() => save()}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">Only the clinic owner or an administrator can change the work week.</p>
      )}
      {naming !== null && (
        <NameTemplate
          slot={naming}
          current={templates?.find((template) => template.slot === naming)?.name ?? ''}
          onClose={() => setNaming(null)}
          onSave={(name) => saveTemplate(naming, name)}
        />
      )}
    </>
  );
}

function NameTemplate({
  slot,
  current,
  onClose,
  onSave,
}: {
  slot: number;
  current: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  return (
    <Modal
      title={`Save as work week ${slot}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim()} onClick={() => onSave(name.trim())}>
            Save work week
          </button>
        </>
      }
    >
      <label>
        Name
        <input
          data-autofocus
          value={name}
          maxLength={60}
          placeholder="For example: Regular week"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <p className="small muted">Keeps the clinic times shown now, to use in another month with one tap.</p>
    </Modal>
  );
}
