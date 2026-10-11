import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

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
  await page.getByLabel('WhatsApp number').fill('5550100');
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page.getByText('Patient registered.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic Smoke-Test' })).toBeVisible();
  // Every patient gets a short card code at registration.
  await expect(page.getByText(/^PAT-[2-9A-Z]{10}$/)).toBeVisible();

  await page.getByRole('link', { name: 'New visit' }).click();
  // Something to remember about the person, kept apart from the clinical record.
  await page.getByLabel('Add something to remember').fill('Synthetic: teaches dance on weekends');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Synthetic: teaches dance on weekends')).toBeVisible();
  await page.getByLabel("Complaint, in the patient's words").fill('Synthetic complaint for the smoke test');
  await page.getByLabel("Doctor's notes for this visit").fill('Synthetic internal note');
  // One envelope: a mix of two medicines with one dosage line.
  await page.getByRole('button', { name: 'Add an envelope' }).click();
  await page.getByLabel('Medicine name').fill('Synthetic remedy');
  await page.getByRole('button', { name: 'Add a medicine to this mix' }).click();
  await page.getByLabel('Medicine name').nth(1).fill('Second synthetic remedy');
  await page.getByLabel('Amount', { exact: true }).fill('4');
  await page.getByLabel('When', { exact: true }).selectOption('before meals');
  await page.getByLabel('For', { exact: true }).fill('14');
  await expect(page.getByText('Label will read: 4 tabs, twice daily before meals · 14 days')).toBeVisible();
  await page.getByRole('button', { name: '2 weeks' }).click();
  await page.getByRole('button', { name: 'Save visit' }).click();
  await expect(page.getByText('Visit saved.')).toBeVisible();
  await expect(page.getByText('Synthetic complaint for the smoke test').first()).toBeVisible();
  await expect(page.getByText('Envelope: 4 tabs, twice daily before meals · 14 days')).toBeVisible();

  // A barcode scanner types the card code very fast and presses Enter; that opens the patient from anywhere.
  const code = (await page.getByText(/^PAT-[2-9A-Z]{10}$/).textContent()) ?? '';
  await page.getByRole('link', { name: 'More tools' }).click();
  await expect(page.getByRole('heading', { name: 'More clinic tools' })).toBeVisible();
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Synthetic Smoke-Test' })).toBeVisible();

  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByText('Recorded visit')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
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
