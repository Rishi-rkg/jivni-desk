/**
 * How dates, times and money are written everywhere in the application: 06 Oct 2026, 09:41, ₹1,320.00.
 * Times follow the clinic's own time zone, so a screen opened elsewhere still shows the clinic's day.
 */

let zone: string | undefined;
let currencySymbol = '₹';

export function setClinicLocale(timeZone?: string, currency?: string) {
  zone = timeZone || undefined;
  currencySymbol = !currency || currency === 'INR' ? '₹' : `${currency} `;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parts(value: string | Date, options: Intl.DateTimeFormatOptions) {
  // A plain calendar date has no time zone: 2026-10-06 is the 6th wherever it is read.
  const dateOnly = typeof value === 'string' && DATE_ONLY.test(value);
  const date = dateOnly ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const result: Record<string, string> = {};
  try {
    for (const part of new Intl.DateTimeFormat('en-GB', {
      timeZone: dateOnly ? 'UTC' : zone,
      ...options,
    }).formatToParts(date))
      result[part.type] = part.value;
  } catch {
    for (const part of new Intl.DateTimeFormat('en-GB', options).formatToParts(date)) result[part.type] = part.value;
  }
  return result;
}

/** 06 Oct 2026 */
export function shortDate(value: string | Date | null | undefined) {
  if (!value) return '';
  const p = parts(value, { day: '2-digit', month: 'short', year: 'numeric' });
  return p ? `${p.day} ${p.month} ${p.year}` : '';
}

/** Tuesday, 6 October 2026 */
export function longDate(value: string | Date) {
  const p = parts(value, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return p ? `${p.weekday}, ${p.day} ${p.month} ${p.year}` : '';
}

/** Tue 20 Oct 2026 */
export function weekdayDate(value: string | Date) {
  const p = parts(value, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  return p ? `${p.weekday} ${p.day} ${p.month} ${p.year}` : '';
}

/** 09:41 */
export function clock(value: string | Date | null | undefined) {
  if (!value) return '';
  const p = parts(value, { hour: '2-digit', minute: '2-digit', hour12: false });
  return p ? `${p.hour === '24' ? '00' : p.hour}:${p.minute}` : '';
}

/** 06 Oct 2026, 09:41 */
export function dateTime(value: string | Date | null | undefined) {
  return value ? `${shortDate(value)}, ${clock(value)}` : '';
}

/** The calendar date at the clinic, as YYYY-MM-DD. */
export function isoDay(value: Date = new Date()) {
  const p = parts(value, { day: '2-digit', month: '2-digit', year: 'numeric' });
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

/** A YYYY-MM-DD date some days away from another one. */
export function addDays(day: string, count: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** "today", "yesterday", or the short date. */
export function relativeDay(value: string | Date | null | undefined) {
  if (!value) return '';
  const day = typeof value === 'string' && DATE_ONLY.test(value) ? value : isoDay(new Date(value));
  const today = isoDay();
  if (day === today) return 'today';
  if (day === addDays(today, -1)) return 'yesterday';
  if (day === addDays(today, 1)) return 'tomorrow';
  return shortDate(day);
}

const number = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1,320.00 */
export function amount(value: number | string | null | undefined) {
  const n = Number(value ?? 0);
  return number.format(Number.isFinite(n) ? n : 0);
}

/** ₹1,320.00 */
export function money(value: number | string | null | undefined) {
  const n = Number(value ?? 0);
  return `${n < 0 ? '−' : ''}${currencySymbol}${amount(Math.abs(Number.isFinite(n) ? n : 0))}`;
}

/** Whole years between a date of birth and today at the clinic. */
export function age(dateOfBirth: string | null | undefined, on: string = isoDay()) {
  if (!dateOfBirth || !DATE_ONLY.test(dateOfBirth)) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  const years = y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  return years >= 0 ? years : null;
}

const SEX: Record<string, string> = { female: 'F', male: 'M', other: 'O' };
const SEX_WORD: Record<string, string> = { female: 'Female', male: 'Male', other: 'Other', undisclosed: 'Not stated' };
export const sexWord = (gender: string) => SEX_WORD[gender] ?? gender;

/** "42 F" for a list row. */
export function ageSex(person: { date_of_birth: string | null; gender: string }) {
  return [age(person.date_of_birth), SEX[person.gender]]
    .filter((part) => part !== null && part !== undefined)
    .join(' ');
}

/** "RP" for Dr. R. Patel. */
export function initials(name: string) {
  const words = (name || '')
    .replace(/^(dr|mr|mrs|ms)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

/** "…00142": enough of a phone number to tell two people apart without showing all of it. */
export function phoneTail(phone: string | null | undefined) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits ? `…${digits.slice(-5)}` : '';
}
