import { expect, test } from '@playwright/test';
import { printToPdf, shot, signIn } from './helpers';

const MM = 72 / 25.4; // points per millimetre

// Runs after 01-smoke, whose visit has one envelope: "4 tabs, twice daily before meals · 14 days".
test('printing: envelope labels, the patient card and a prescription come out at their own paper size', async ({
  page,
}) => {
  // The print window cannot be driven from a test; note that it was asked for and carry on.
  await page.addInitScript(() => {
    const counter = window as unknown as { printed: number };
    counter.printed = 0;
    window.print = () => {
      counter.printed += 1;
    };
  });
  await signIn(page);
  await page.getByRole('link', { name: 'Patients', exact: true }).click();
  await page.getByRole('link', { name: 'Synthetic Smoke-Test' }).click();
  await page.getByRole('link', { name: 'Visits', exact: true }).click();

  // Labels: choose the envelope and two copies.
  await page.getByRole('button', { name: 'Print labels' }).click();
  const window_ = page.getByRole('dialog', { name: 'Print envelope labels' });
  await expect(window_.getByText('4 tabs, twice daily, before meals · 14 days')).toBeVisible();
  await expect(window_.getByText('Medicine names are not printed.')).toBeVisible();
  await window_.getByLabel('Copies for envelope 1').fill('2');
  await shot(page, '05-label-window');
  await window_.getByRole('button', { name: 'Print 2 labels' }).click();
  await expect(page.getByRole('img', { name: 'Label for envelope 1' })).toHaveCount(2);
  const first = page.getByRole('img', { name: 'Label for envelope 1' }).first();
  await expect(first.getByText('Synthetic Smoke-Test')).toBeVisible();
  await expect(first.getByText('4 tabs, twice daily')).toBeVisible();
  await expect(first.getByText(/^PAT-[2-9A-Z]{10}$/)).toBeVisible();
  await expect(first.getByText('Synthetic remedy')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  await shot(page, '05-labels');
  const labels = await printToPdf(page, '05-labels');
  expect(labels.count).toBe(2);
  expect(labels.width).toBeCloseTo(144, 0); // 2 inches
  expect(labels.height).toBeCloseTo(144, 0);

  // The patient card, the size of a bank card.
  await page.getByRole('link', { name: 'Back to the patient' }).click();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'More ▾' }).click();
  await page.getByRole('menuitem', { name: 'Print patient card' }).click();
  await expect(page.getByRole('img', { name: 'Patient card for Synthetic Smoke-Test' })).toBeVisible();
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  await shot(page, '05-card');
  const card = await printToPdf(page, '05-card');
  expect(card.count).toBe(1);
  expect(card.width).toBeCloseTo(85.6 * MM, 0);
  expect(card.height).toBeCloseTo(54 * MM, 0);

  // The prescription: each envelope and how to take it, with no medicine name unless the clinic chose so.
  await page.getByRole('link', { name: 'Back to the patient' }).click();
  await page.getByRole('link', { name: 'Visits', exact: true }).click();
  await page.getByRole('link', { name: 'Print prescription' }).click();
  const sheet = page.getByLabel('Prescription', { exact: true });
  await expect(sheet.getByText('Envelope 1')).toBeVisible();
  await expect(sheet.getByText('4 tabs, twice daily')).toBeVisible();
  await expect(sheet.getByText('Synthetic remedy')).toHaveCount(0);
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  const prescription = await printToPdf(page, '05-prescription');
  expect(prescription.count).toBe(1);
  expect(prescription.width).toBeCloseTo(210 * MM, 0);

  // A smaller label: the layout is saved as a new version and the test label follows it.
  await page.goto('/printing/label');
  await expect(page.getByText('Standard layout · in use')).toBeVisible();
  await page.getByLabel('Label size').selectOption('50x25mm');
  await page.getByRole('switch', { name: 'Print medicine names' }).click();
  await shot(page, '05-label-settings');
  await page.getByRole('button', { name: 'Save as version 1' }).click();
  await expect(page.getByText('Version 1 · in use')).toBeVisible();
  await page.getByRole('link', { name: 'Printers' }).click();
  await page.getByRole('link', { name: 'Print test label' }).click();
  await expect(
    page.getByRole('img', { name: 'Label for envelope 1' }).first().getByText('Test remedy 30C'),
  ).toBeVisible();
  const small = await printToPdf(page, '05-small-label');
  expect(small.count).toBe(1);
  expect(small.width).toBeCloseTo(50 * MM, 0);
  expect(small.height).toBeCloseTo(25 * MM, 0);

  // Everything printed is in today's queue.
  await page.getByRole('link', { name: 'Back to printing' }).click();
  await page.getByRole('link', { name: 'Print queue' }).click();
  for (const title of ['Envelope label × 2', 'Patient card', 'Prescription'])
    await expect(page.getByRole('cell', { name: title, exact: true })).toBeVisible();
  await shot(page, '05-queue');

  // Back to the standard label for anything that runs after this.
  await page.goto('/printing/label');
  await page.getByLabel('Label size').selectOption('2x2in');
  await page.getByRole('switch', { name: 'Print medicine names' }).click();
  await page.getByRole('button', { name: 'Save as version 2' }).click();
  await expect(page.getByText('Version 2 · in use')).toBeVisible();
});
