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
  await page.getByLabel('Chief complaint').fill('Synthetic complaint for the smoke test');
  await page.getByLabel('Internal clinical notes').fill('Synthetic internal note');
  await page.getByRole('button', { name: 'Add medicine' }).click();
  await page.getByLabel('Medicine name').fill('Synthetic remedy');
  await page.getByLabel('Dose').fill('4 pills');
  await page.getByLabel('Frequency').fill('twice daily');
  await page.getByRole('button', { name: 'Save visit' }).click();
  await expect(page.getByText('Visit saved.')).toBeVisible();
  await expect(page.getByText('Synthetic complaint for the smoke test').first()).toBeVisible();

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
