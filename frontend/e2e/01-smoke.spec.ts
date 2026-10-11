import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { shot } from './helpers';

// Written by scripts/e2e_server.py for this run only. Synthetic clinic, synthetic patient.
function signIn(): { username: string; password: string } {
  return JSON.parse(readFileSync('../.tools/e2e-credentials.json', 'utf-8'));
}

test('a clinician signs in, registers a patient, records a visit and signs out', async ({ page }) => {
  const credentials = signIn();
  await page.goto('/');
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.getByRole('link', { name: 'Patients', exact: true }).click();
  await page.getByRole('link', { name: 'New patient' }).click();
  await page.getByLabel('First name').fill('Synthetic');
  await page.getByLabel('Last name').fill('Smoke-Test');
  await page.getByLabel('Date of birth').fill('1990-01-01');
  await page.getByLabel('Phone', { exact: true }).fill('5550100');
  // The patient card has its own test; here the record opens straight after saving.
  await page.getByLabel('Print card after saving').uncheck();
  await shot(page, '01-register');
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page.getByText('Patient registered.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Smoke-Test' })).toBeVisible();
  // Every patient gets a short card code at registration.
  await expect(page.getByText(/^PAT-[2-9A-Z]{10}$/)).toBeVisible();

  await page.getByRole('link', { name: 'New visit' }).click();
  // Something to remember about the person, kept apart from the clinical record.
  await page.getByRole('button', { name: '+ Add', exact: true }).click();
  await page.getByLabel('Add something to remember').fill('Synthetic: teaches dance on weekends');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Synthetic: teaches dance on weekends')).toBeVisible();
  await page.getByLabel("Complaint, in the patient's words").fill('Synthetic complaint for the smoke test');
  await page.getByLabel("Doctor's notes for this visit").fill('Synthetic internal note');
  await page.getByText('Measurements (optional)').click();
  await page.getByLabel('BP', { exact: true }).fill('118/76');
  // One envelope: a mix of two medicines with one dosage line.
  await page.getByRole('button', { name: '+ Add an envelope' }).click();
  await page.getByLabel('Medicine name').fill('Synthetic remedy');
  await page.getByRole('button', { name: '+ Add a medicine to this mix' }).click();
  await page.getByLabel('Medicine name').nth(1).fill('Second synthetic remedy');
  await page.getByLabel('Amount', { exact: true }).fill('4');
  await page.getByLabel('When', { exact: true }).selectOption('before meals');
  await page.getByLabel('For', { exact: true }).fill('14');
  await expect(page.getByLabel('Label will read: 4 tabs, twice daily before meals · 14 days')).toBeVisible();
  await page.getByRole('radio', { name: '2 wk' }).click();
  await shot(page, '01-visit');
  // The draft saves itself; closing the page and coming back finds the work as it was left.
  await expect(page.getByText(/Draft saved \d\d:\d\d\./).first()).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByLabel("Complaint, in the patient's words")).toHaveValue(
    'Synthetic complaint for the smoke test',
  );
  await expect(page.getByLabel('Medicine name').nth(1)).toHaveValue('Second synthetic remedy');
  // Labels and the bill have their own tests; here the visit is simply made final.
  await page.getByLabel('Print envelope label').uncheck();
  await page.getByLabel(/Create the bill/).uncheck();
  await page.getByRole('button', { name: 'Finalise visit' }).click();
  await page
    .getByRole('alertdialog', { name: 'Finalise this visit?' })
    .getByRole('button', { name: 'Finalise' })
    .click();
  await expect(page.getByText('Visit finalised.')).toBeVisible();
  await expect(page.getByText('Synthetic complaint for the smoke test').first()).toBeVisible();
  await expect(page.getByText('Envelope: 4 tabs, twice daily before meals · 14 days')).toBeVisible();
  // A finalised visit is corrected by adding beside it.
  await page.getByRole('button', { name: 'Amend' }).click();
  const amending = page.getByRole('dialog', { name: /Amend visit/ });
  await amending.getByLabel('Correction').fill('Synthetic correction to the prescription');
  await amending.getByLabel('Reason').fill('Typing mistake');
  await amending.getByRole('button', { name: 'Add amendment' }).click();
  await expect(page.getByText('Synthetic correction to the prescription')).toBeVisible();
  await expect(page.getByText('Amended')).toBeVisible();

  // A barcode scanner types the card code very fast and presses Enter; that opens the patient from anywhere.
  const code = (await page.getByText(/^PAT-[2-9A-Z]{10}$/).textContent()) ?? '';
  await page.getByRole('link', { name: 'Printing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Documents and printing' })).toBeVisible();
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Synthetic Smoke-Test' })).toBeVisible();

  // A code nobody knows opens nothing and says so.
  await page.keyboard.type('8900000000000', { delay: 5 });
  await page.keyboard.press('Enter');
  const unknown = page.getByRole('dialog', { name: 'Barcode not recognised' });
  await expect(unknown).toBeVisible();
  await shot(page, '01-scan-unknown');
  await unknown.getByRole('button', { name: 'Close', exact: true }).click();

  // Ctrl K finds a patient from anywhere.
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Find a patient' }).fill('Smoke');
  await expect(page.getByRole('option', { name: /Synthetic Smoke-Test/ })).toBeVisible();
  await shot(page, '01-finder');
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Activity log' }).click();
  // Newest first: the scan that matched nothing is near the top, in plain words.
  await expect(page.getByText('Scanned an unknown code').first()).toBeVisible();
  await expect(page.getByText('Scanned a patient card').first()).toBeVisible();
  await shot(page, '01-activity');

  // Lock from the header, then come back with the password.
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible();
  await shot(page, '01-locked');
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Activity log' })).toBeVisible();

  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your clinic' })).toBeVisible();
});

test('a wrong password is refused and shown in plain words', async ({ page }) => {
  const credentials = signIn();
  await page.goto('/');
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid username or password.');
});
