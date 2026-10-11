import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { shot, signIn } from './helpers';

// Runs after the earlier tests: "Synthetic Smoke-Test" has a visit and a part-paid bill by now.
test('patients: the list, the record with its timeline, details, family, consent, a document and an import', async ({
  page,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'jivni-e2e-patients-'));
  await signIn(page);
  await page.getByRole('link', { name: 'Patients', exact: true }).click();

  // Import three people from a spreadsheet: a trial run first, then the real thing.
  const csv = join(folder, 'patients.csv');
  writeFileSync(
    csv,
    'First name,Surname,DOB,Sex,Mobile\r\nLeela,Synthetic-Import,14/03/1990,F,5550201\r\nFarid,Synthetic-Import,1 Jan 1975,M,5550202\r\n,Nameless,1990-01-01,,\r\n',
  );
  await page.getByRole('button', { name: 'Import from spreadsheet' }).click();
  const importing = page.getByRole('dialog', { name: /Import patients/ });
  await importing.getByLabel('Spreadsheet file (CSV)').setInputFiles(csv);
  await expect(importing.getByText('3 rows found.')).toBeVisible();
  await expect(importing.getByLabel('Last name')).toHaveValue('1');
  await expect(importing.getByLabel('Date of birth')).toHaveValue('2');
  await importing.getByRole('button', { name: 'Trial run' }).click();
  await expect(importing.getByText('2 ready')).toBeVisible();
  await expect(importing.getByText('1 row with errors')).toBeVisible();
  await expect(importing.getByText('First name is missing')).toBeVisible();
  await shot(page, '06-import');
  await importing.getByRole('button', { name: 'Import 2 patients' }).click();
  await expect(page.getByText('2 patients imported.')).toBeVisible();

  // The list: who was seen, who is due, who owes.
  await page.getByLabel('Search patients').fill('Synthetic');
  await expect(page.getByRole('link', { name: 'Leela Synthetic-Import' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Synthetic Smoke-Test' });
  await expect(row.getByText(/Due \d\d \w{3}/)).toBeVisible();
  await expect(row.getByText('5550100')).toBeVisible();
  await shot(page, '06-patients');
  await page.getByRole('button', { name: 'Seen this month' }).click();
  await expect(page.getByRole('link', { name: 'Leela Synthetic-Import' })).toBeHidden();
  await expect(page.getByRole('link', { name: 'Synthetic Smoke-Test' })).toBeVisible();

  // The record: banner, details and one timeline of visits, bills and notes.
  await page.getByRole('link', { name: 'Synthetic Smoke-Test' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic Smoke-Test' })).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline.getByText('First consultation')).toBeVisible();
  await expect(timeline.getByText(/Envelope 1 · Synthetic remedy, Second synthetic remedy/)).toBeVisible();
  await expect(timeline.getByText(/Invoice INV\/\d\d-\d\d\/0002/)).toBeVisible();

  // A front-desk note and a document.
  await page.getByRole('button', { name: 'Add note' }).click();
  const note = page.getByRole('dialog', { name: 'Add note' });
  await note.getByLabel('Kind of note').selectOption('general');
  await note.getByLabel('Note', { exact: true }).fill('Synthetic: prefers morning appointments');
  await note.getByRole('button', { name: 'Save note' }).click();
  await expect(timeline.getByText('Synthetic: prefers morning appointments')).toBeVisible();
  const pdf = join(folder, 'report.pdf');
  writeFileSync(pdf, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  await page.getByRole('button', { name: 'Add document' }).click();
  const adding = page.getByRole('dialog', { name: 'Add document' });
  await adding.getByLabel('Title').fill('Synthetic blood report');
  await adding.getByLabel('File').setInputFiles(pdf);
  await adding.getByRole('button', { name: 'Save document' }).click();
  await expect(timeline.getByText('Synthetic blood report')).toBeVisible();
  await shot(page, '06-record');

  // An alert, consent and a family member.
  await page.getByRole('button', { name: 'Add an alert' }).click();
  await page.getByRole('dialog', { name: 'Patient alert' }).getByLabel('Alert').fill('Synthetic: sensitive to camphor');
  await page.getByRole('button', { name: 'Save alert' }).click();
  await expect(page.getByText('Synthetic: sensitive to camphor')).toBeVisible();
  await page.getByRole('button', { name: 'More ▾' }).click();
  await page.getByRole('menuitem', { name: 'Message consent…' }).click();
  await page.getByRole('switch', { name: 'Care messages' }).click();
  await page.getByRole('button', { name: 'Save consent' }).click();
  await expect(page.getByText('WhatsApp consent: care')).toBeVisible();
  await page.getByRole('button', { name: 'More ▾' }).click();
  await page.getByRole('menuitem', { name: 'Family…' }).click();
  const family = page.getByRole('dialog', { name: /Family of/ });
  await family.getByLabel('Link another patient').fill('Leela');
  await family.getByRole('button', { name: /Leela Synthetic-Import/ }).click();
  await family.getByLabel(/What they are to/).fill('sister');
  await family.getByRole('button', { name: 'Add link' }).click();
  await expect(family.getByText('sister')).toBeVisible();
  await family.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('link', { name: 'Leela Synthetic-Import' })).toBeVisible();

  // Editing keeps a history of what changed.
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Address').fill('12 Lake Road');
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('State').selectOption('Maharashtra');
  await page.getByLabel('Referred by').fill('Dr Synthetic Elsewhere');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Details saved.')).toBeVisible();
  await expect(page.getByText('12 Lake Road, Pune, Maharashtra')).toBeVisible();
  await page.getByRole('button', { name: 'More ▾' }).click();
  await page.getByRole('menuitem', { name: 'Change history' }).click();
  const history = page.getByRole('dialog', { name: /Change history/ });
  await expect(history.getByText('City: empty → Pune')).toBeVisible();
  await expect(history.getByText('Referred by: empty → Dr Synthetic Elsewhere')).toBeVisible();
  await history.getByRole('button', { name: 'Close', exact: true }).click();

  // A lost card is replaced: the old code stops working.
  const oldCode = (await page.getByText(/^PAT-[2-9A-Z]{10}$/).textContent()) ?? '';
  await page.getByRole('button', { name: 'More ▾' }).click();
  await page.getByRole('menuitem', { name: 'Replace lost card' }).click();
  await page.getByRole('button', { name: 'Make a new card' }).click();
  await expect(page.getByText('A new card code was made. Print the new card.')).toBeVisible();
  await expect(page.getByText(/^PAT-[2-9A-Z]{10}$/)).not.toHaveText(oldCode);
});
