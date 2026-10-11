import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

function signIn(): { username: string; password: string } {
  return JSON.parse(readFileSync('../.tools/e2e-credentials.json', 'utf-8'));
}

test('the owner adds a backup folder, backs up, and checks that the backup reads back', async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), 'jivni-e2e-backup-'));
  const credentials = signIn();
  await page.goto('/');
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Backups' }).click();
  await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Test folder');
  await page.getByLabel('Folder', { exact: true }).fill(folder);
  await page.getByRole('button', { name: 'Add a place' }).click();
  await expect(page.getByText('A test file was written and read back.')).toBeVisible();

  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText('Backup saved to 1 of 1 place.')).toBeVisible();
  const files = readdirSync(folder);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^jivni-backup-\d{8}-\d{6}\.jivni$/);
  const content = readFileSync(join(folder, files[0]));
  expect(statSync(join(folder, files[0])).size).toBeGreaterThan(1000);
  // Nothing readable about the clinic or its people is in the file.
  expect(content.includes('Synthetic E2E Clinic')).toBe(false);
  expect(content.includes(credentials.username)).toBe(false);

  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByText(/The backup reads back in full/)).toBeVisible();
  await expect(page.getByText(/^Verified/)).toBeVisible();

  // Left for the restore drill in scripts/restore_drill.py.
  writeFileSync('../.tools/e2e-last-backup.txt', join(folder, files[0]));
});
