import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The database starts empty. This test sets the clinic up through the real first-time screen and
// leaves the sign-in it chose for the tests that follow. Synthetic clinic, synthetic people.
test('a new installation is set up with encryption on and a recovery key', async ({ page }) => {
  const credentials = { username: 'e2e-owner', password: randomBytes(18).toString('base64url') };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up your clinic' })).toBeVisible();
  await page.getByLabel('Clinic name').fill('Synthetic E2E Clinic');
  await page.getByLabel('Your name').fill('Dr Synthetic');
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByLabel('Password again').fill(credentials.password);
  await page.getByLabel('Time zone').fill('Asia/Kolkata');
  await page.getByRole('button', { name: 'Create clinic' }).click();

  await expect(page.getByRole('heading', { name: 'Write down your recovery key' })).toBeVisible();
  await expect(page.getByLabel('Recovery key', { exact: true })).toHaveText(
    /^([0-9A-HJKMNP-TV-Z]{4}-){9}[0-9A-HJKMNP-TV-Z]{4}$/,
  );
  await expect(page.getByRole('button', { name: 'Continue to the clinic' })).toBeDisabled();
  await page.getByLabel(/I have written the recovery key down/).check();
  await page.getByRole('button', { name: 'Continue to the clinic' }).click();

  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / })).toBeVisible();
  await expect(page.getByText('Synthetic E2E Clinic')).toBeVisible();

  mkdirSync('../.tools', { recursive: true });
  writeFileSync('../.tools/e2e-credentials.json', JSON.stringify(credentials));

  // Setup is closed for good: a second visitor gets the ordinary sign-in.
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your clinic' })).toBeVisible();
});
