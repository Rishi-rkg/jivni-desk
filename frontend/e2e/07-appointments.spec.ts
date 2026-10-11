import { expect, test } from '@playwright/test';
import { printToPdf, shot, signIn } from './helpers';

// Runs after the earlier tests: "Synthetic Smoke-Test" is registered on the number 5550100 by now.
test('appointments: the work week, booking by phone, a quick new patient, a walk-in, the day sheet and the dashboard', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / })).toBeVisible();

  // The work week: a month nobody has set up shows the usual week. Saving makes it the clinic's own.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Work week' }).click();
  await expect(page.getByText(/has not been set up yet/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Regular clinic times/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Mon to Sat morning from')).toHaveValue('09:30');
  const dates = page.getByRole('group', { name: /^Working dates in / });
  const before = await dates.getByRole('button', { name: /: working$/ }).count();
  expect(before).toBeGreaterThan(20);
  // A holiday: tap the last working date to close it, and the count follows.
  await dates
    .getByRole('button', { name: /: working$/ })
    .last()
    .click();
  await expect(page.getByText(`${before - 1} working days in`)).toBeVisible();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Work week saved.')).toBeVisible();
  await expect(page.getByText(/has not been set up yet/)).toBeHidden();
  // Keep these times as a saved work week, then carry the same weekdays into next month.
  await page.getByRole('button', { name: 'Save current here' }).first().click();
  const naming = page.getByRole('dialog', { name: 'Save as work week 1' });
  await naming.getByLabel('Name').fill('Regular week');
  await naming.getByRole('button', { name: 'Save work week' }).click();
  await expect(page.getByText('1 of 4 used')).toBeVisible();
  await expect(
    page.getByText(/Weekdays 09:30–13:00, 17:00–20:00 · Sat 09:30–13:00, 17:00–20:00 · Sun closed/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Copy to next month' }).click();
  await expect(page.getByText(/^Copied to \w+ \d{4}\.$/)).toBeVisible();
  await shot(page, '07-work-week');

  // Book from a phone number. The first Monday of next month is a working day whatever today is.
  const now = new Date();
  const first = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
  const monday = String(1 + ((8 - first.getUTCDay()) % 7)).padStart(2, '0');
  await page.getByRole('link', { name: 'Appointments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Appointments' })).toBeVisible();
  await page.getByRole('button', { name: 'New appointment' }).click();
  const booking = page.getByRole('dialog', { name: 'New appointment' });
  await booking.getByLabel('Phone number').fill('5550100');
  await booking.getByRole('button', { name: /Synthetic Smoke-Test/ }).click();
  await booking.getByRole('button', { name: 'Later month' }).click();
  await booking
    .getByRole('group', { name: 'Day' })
    .getByRole('button', { name: new RegExp(`^${monday} `) })
    .click();
  await expect(booking.getByText('Morning')).toBeVisible();
  await booking.getByRole('button', { name: '09:30', exact: true }).click();
  await expect(booking.getByText(/Synthetic Smoke-Test · Mon \d\d \w+ \d{4} · 09:30/)).toBeVisible();
  await shot(page, '07-booking');
  await booking.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByText('Appointment booked.')).toBeVisible();
  // The diary opens on the day that was booked.
  const day = page.getByRole('region', { name: 'Day' });
  await expect(day.getByRole('link', { name: 'Synthetic Smoke-Test' })).toBeVisible();
  await expect(day.getByText(/^Booked/)).toBeVisible();

  // A caller nobody knows yet: the booking window asks only for a name.
  await day.getByRole('button', { name: 'Free · click to book' }).first().click();
  await booking.getByLabel('Phone number').fill('5550777');
  await expect(booking.getByText('Nobody is registered on this number yet.')).toBeVisible();
  await booking.getByRole('button', { name: /New patient with this number/ }).click();
  await booking.getByLabel('Name of the new patient').fill('Quick Synthetic-Caller');
  await booking.getByRole('button', { name: 'Add patient' }).click();
  await expect(booking.getByRole('button', { name: /Quick Synthetic-Caller/ })).toHaveAttribute('aria-pressed', 'true');
  // The time that was just taken is no longer offered; the free time that was clicked is already chosen.
  await expect(booking.getByRole('button', { name: '09:30', exact: true })).toBeDisabled();
  await expect(booking.getByRole('button', { name: '09:45', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await booking.getByRole('button', { name: 'Book appointment' }).click();
  await expect(day.getByRole('link', { name: 'Quick Synthetic-Caller' })).toBeVisible();
  await shot(page, '07-day');

  // The day sheet prints on one A4 page.
  await page.getByRole('link', { name: 'Print day sheet' }).click();
  const sheet = page.getByLabel('Day sheet');
  await expect(sheet.getByText('Quick Synthetic-Caller')).toBeVisible();
  await expect(sheet.getByText('2 appointments')).toBeVisible();
  const paper = await printToPdf(page, '07-day-sheet');
  expect(paper.count).toBe(1);
  expect(Math.round(paper.width)).toBe(595);
  expect(Math.round(paper.height)).toBe(842);
  await page.getByRole('link', { name: 'Back to appointments' }).click();

  // Cancelling asks for a reason and frees the time.
  await page.getByRole('button', { name: 'Actions for Quick Synthetic-Caller' }).click();
  await page.getByRole('menuitem', { name: 'Cancel appointment' }).click();
  const cancelling = page.getByRole('dialog', { name: "Cancel Quick Synthetic-Caller's appointment?" });
  await cancelling.getByLabel('Reason').fill('Synthetic: travelling');
  await cancelling.getByRole('button', { name: 'Cancel appointment' }).click();
  await expect(page.getByText('Appointment cancelled.')).toBeVisible();
  await expect(day.getByText('Cancelled · Synthetic: travelling')).toBeVisible();

  // Someone who just came in joins the waiting list today, booked or not.
  await page.getByRole('button', { name: 'Add walk-in' }).click();
  const walkIn = page.getByRole('dialog', { name: 'Add walk-in' });
  await walkIn.getByLabel('Find the patient').fill('Smoke-Test');
  await walkIn.getByRole('button', { name: /Synthetic Smoke-Test/ }).click();
  await walkIn.getByLabel('What they came for').fill('collect medicine');
  await walkIn.getByRole('button', { name: 'Add to the waiting list' }).click();
  await expect(page.getByText('Synthetic Smoke-Test added to the waiting list.')).toBeVisible();
  const waiting = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Walk-ins and waiting' }) });
  await expect(waiting.getByText('1. Synthetic Smoke-Test')).toBeVisible();
  await expect(waiting.getByText(/Walk-in · collect medicine · arrived \d\d:\d\d/)).toBeVisible();
  await expect(waiting.getByRole('link', { name: 'Start visit' })).toBeVisible();

  // The week and the list show the same diary.
  await page.getByRole('radio', { name: 'List' }).click();
  await expect(page.getByRole('region', { name: 'List' }).getByText('collect medicine')).toBeVisible();
  await page.getByRole('radio', { name: 'Week' }).click();
  await expect(page.getByRole('region', { name: 'Week' }).getByText(/Walk-in Synthetic Smoke-Test/)).toBeVisible();

  // The dashboard has the queue, and the patient's record has the appointment on its timeline.
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  const queue = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Today.s queue$/ }) });
  await expect(queue.getByRole('link', { name: 'Synthetic Smoke-Test' })).toBeVisible();
  await expect(queue.getByText(/^(Arrived|Waiting \d+ min)$/)).toBeVisible();
  await expect(page.getByRole('link', { name: /1\s*appointment today · 0 seen/ })).toBeVisible();
  await shot(page, '07-dashboard');
  await queue.getByRole('link', { name: 'Synthetic Smoke-Test' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Smoke-Test' })).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline.getByText(/Walk-in/).first()).toBeVisible();

  // "Book appointment" on the record opens the booking window with the patient already chosen.
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Book appointment' }).click();
  await expect(booking.getByText(/^Synthetic Smoke-Test · tap a day · tap a time$/)).toBeVisible();
  await booking.getByRole('button', { name: 'Cancel' }).click();
});
