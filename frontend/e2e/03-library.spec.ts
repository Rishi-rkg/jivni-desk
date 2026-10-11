import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

function signIn(): { username: string; password: string } {
  return JSON.parse(readFileSync('../.tools/e2e-credentials.json', 'utf-8'));
}

test('the library answers from the shipped book, explains itself and learns a choice', async ({ page }) => {
  const credentials = signIn();
  await page.goto('/');
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await expect(page.getByText(/\d+ remedies, \d+ rubrics/)).toBeVisible();

  const search = page.getByLabel('Symptoms or remedy');
  await search.fill('anti+arnica');
  const answer = page.getByRole('region', { name: 'Relationships' });
  await expect(answer.getByRole('heading')).toHaveText('Antidotes of Arnica montana');
  await expect(answer.getByRole('button', { name: 'Camphora' })).toBeVisible();
  await answer.getByRole('button', { name: 'Arnica montana' }).hover();
  await expect(page.getByRole('tooltip')).toContainText('Complementary: Aconitum napellus, Ipecacuanha');

  await search.fill('bruised + bed feels too hard + zzzz');
  const first = page.getByRole('region', { name: 'Remedies by symptom' }).getByRole('article').first();
  await expect(first.getByRole('button', { name: 'Arnica montana' })).toBeVisible();
  await expect(first.getByText('2 of 3 symptoms')).toBeVisible();
  await expect(first.getByText('○ zzzz')).toBeVisible();
  await expect(first.getByText(/William Boericke/).first()).toBeVisible();
  // The search never appears in the address bar.
  expect(page.url()).not.toContain('bruised');

  // On the visit page, choosing a remedy fills the prescription and is remembered for next time.
  await page.getByRole('link', { name: 'Patients', exact: true }).click();
  await page
    .getByRole('link', { name: /Smoke-Test/ })
    .first()
    .click();
  await page.getByRole('link', { name: 'New visit' }).click();
  await page.getByText('Look up a remedy in the library').click();
  await page.getByLabel('Symptoms or remedy').fill('bruised');
  await page
    .getByRole('button', { name: /^Add to prescription: / })
    .first()
    .click();
  await expect(page.getByLabel('Medicine name')).toHaveValue(/\w+/);
  const chosen = await page.getByLabel('Medicine name').inputValue();
  await page.getByLabel('Symptoms or remedy').fill('bruised ');
  const remembered = page.getByRole('region', { name: 'Remedies by symptom' }).getByRole('article').first();
  await expect(remembered.getByRole('button', { name: chosen, exact: true })).toBeVisible();
  await expect(remembered.getByText('Chosen 1 time')).toBeVisible();
});
