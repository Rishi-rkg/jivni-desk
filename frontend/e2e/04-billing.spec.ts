import { expect, test } from '@playwright/test';
import { printToPdf, scan, shot, signIn } from './helpers';

const BARCODE = '8901234567890';

// Runs after 01-smoke, which registered the patient "Synthetic Smoke-Test". Synthetic data throughout.
test('billing: price list, a scanned walk-in sale, a patient bill, payment, and the bill as a PDF', async ({
  page,
}) => {
  await signIn(page);

  // The clinic's GST number and UPI ID decide what a printed bill shows.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('GSTIN').fill('27ABCDE1234F1Z5');
  await page.getByLabel('UPI ID for payments').fill('synthetic.clinic@okbank');
  await page.getByLabel('Address').fill('4 Garden Street\nPune 411001');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Clinic settings saved.')).toBeVisible();
  await shot(page, '04-clinic-details');

  // Price list: set the standard rates and add a product with the barcode on its pack.
  await page.getByRole('link', { name: 'Billing', exact: true }).click();
  await page.getByRole('link', { name: 'Price list' }).click();
  await expect(page.getByText(/Set the rate for/)).toBeVisible();
  for (const [item, rate, gst] of [
    ['Consultation, follow-up', '500', 'Exempt'],
    ['Prescribed medicines, per week', '150', '5%'],
  ]) {
    await page.getByRole('button', { name: item }).click();
    const window_ = page.getByRole('dialog', { name: 'Price list item' });
    await window_.getByLabel('Rate (₹), GST included').fill(rate);
    await window_.getByLabel('GST', { exact: true }).selectOption({ label: gst });
    await window_.getByRole('button', { name: 'Save item' }).click();
    await expect(window_).toBeHidden();
  }
  await page.getByRole('button', { name: 'Add item' }).click();
  const adding = page.getByRole('dialog', { name: 'Add to the price list' });
  await adding.getByLabel('Item', { exact: true }).fill('Vitamin D3 capsules, 60');
  await adding.getByLabel('Kind', { exact: true }).selectOption({ label: 'Supplement' });
  await adding.getByLabel('GST', { exact: true }).selectOption({ label: '18%' });
  await adding.getByLabel('Rate (₹), GST included').fill('450');
  await adding.getByLabel('Barcode on the pack').fill(BARCODE);
  await adding.getByRole('button', { name: 'Save item' }).click();
  await expect(page.getByRole('cell', { name: BARCODE })).toBeVisible();
  await shot(page, '04-price-list');

  // A pack scanned with no bill open starts a new bill; a second scan adds to the same bill.
  await page.getByRole('link', { name: 'Invoices' }).click();
  await expect(page.getByText('No invoices match.')).toBeVisible();
  await scan(page, BARCODE);
  await expect(page.getByRole('heading', { name: /New bill/ })).toBeVisible();
  await scan(page, BARCODE);
  await expect(page.getByLabel('Quantity of Vitamin D3 capsules, 60')).toHaveValue('2');
  await expect(page.getByLabel('Total (₹)')).toHaveValue('900.00');
  await page.getByLabel('Name', { exact: true }).fill('Synthetic Walk-in');
  await shot(page, '04-new-bill');
  await page.getByLabel('Print the bill').uncheck();
  await page.getByRole('button', { name: 'Issue and take payment' }).click();
  await expect(page.getByRole('heading', { name: /Invoice INV\/\d\d-\d\d\/0001/ })).toBeVisible();
  await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();

  // A bill for a patient on record, part paid.
  await page.getByRole('link', { name: '← Billing' }).click();
  await page.getByRole('link', { name: 'New invoice' }).click();
  await page.getByRole('radio', { name: 'Patient on record' }).click();
  await page.getByLabel('Find the patient').fill('Smoke');
  await page.getByRole('button', { name: /Synthetic Smoke-Test/ }).click();
  for (const item of ['Consultation, follow-up', 'Prescribed medicines, per week', 'Vitamin D3 capsules, 60']) {
    await page.getByRole('button', { name: '+ Add from the price list' }).click();
    const list = page.getByRole('dialog', { name: 'Add from the price list' });
    await list.getByLabel('Search the price list').fill(item.slice(0, 12));
    await list.getByRole('option', { name: new RegExp(item) }).click();
  }
  await page.getByLabel('Discount (₹)').fill('50');
  await page.getByLabel('Discount reason').fill('Returning patient');
  await expect(page.getByLabel('Total (₹)')).toHaveValue('1,050.00');
  await page.getByLabel('Print the bill').uncheck();
  await page.getByRole('button', { name: 'Issue', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Invoice INV\/\d\d-\d\d\/0002/ })).toBeVisible();
  await expect(page.getByText(/Total \(GST included: 75\.78\)/)).toBeVisible();

  await page.getByRole('button', { name: 'Record payment' }).first().click();
  const paying = page.getByRole('dialog', { name: /Record payment/ });
  await paying.getByLabel('Amount (₹)').fill('800');
  await paying.getByRole('radio', { name: 'UPI' }).click();
  await paying.getByLabel('Print receipt').uncheck();
  await paying.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.getByText('Payment of ₹800.00 recorded. Invoice is now Partially paid.')).toBeVisible();
  await shot(page, '04-invoice');

  // The bill on paper: A4, one page, with the patient's barcode, the GST table and a UPI code for the balance.
  await page.getByRole('link', { name: 'Print', exact: true }).click();
  const sheet = page.getByLabel(/^Invoice INV/);
  await expect(sheet.getByText('PARTIALLY PAID')).toBeVisible();
  await expect(sheet.getByText('GSTIN 27ABCDE1234F1Z5')).toBeVisible();
  await expect(sheet.getByText('Synthetic Smoke-Test')).toBeVisible();
  await expect(sheet.getByText(/^PAT-[2-9A-Z]{10}$/)).toBeVisible();
  await expect(sheet.getByRole('img', { name: 'Patient barcode' })).toBeVisible();
  await expect(sheet.getByRole('img', { name: 'Scan to pay by UPI' })).toBeVisible();
  await expect(sheet.getByText(/Rupees one thousand fifty only/)).toBeVisible();
  await shot(page, '04-print-bill');
  const bill = await printToPdf(page, '04-bill');
  expect(bill.count).toBe(1);
  expect(Math.round(bill.width)).toBeGreaterThanOrEqual(594);
  expect(Math.round(bill.width)).toBeLessThanOrEqual(596);
  expect(Math.round(bill.height)).toBeGreaterThanOrEqual(841);
  expect(Math.round(bill.height)).toBeLessThanOrEqual(843);

  // The receipt for the payment.
  await page.getByRole('link', { name: 'Back to the invoice' }).click();
  await page.getByRole('link', { name: 'Receipt', exact: true }).click();
  await expect(page.getByLabel(/^Receipt R\//).getByText('₹800.00')).toBeVisible();
  const receipt = await printToPdf(page, '04-receipt');
  expect(receipt.count).toBe(1);

  // A credit note for the supplement, then the day is closed.
  await page.getByRole('link', { name: 'Back to the invoice' }).click();
  await page.getByRole('button', { name: 'More ▾' }).click();
  await page.getByRole('menuitem', { name: 'Issue credit note' }).click();
  const credit = page.getByRole('dialog', { name: /Credit note for/ });
  await credit.getByLabel('Amount (₹)').fill('450');
  await credit.getByLabel('Reason').fill('Returned unopened');
  await credit.getByRole('button', { name: 'Issue credit note' }).click();
  await expect(page.getByText('Credit note issued.')).toBeVisible();
  await expect(page.getByText(/^CN\/\d\d-\d\d\/0001 · ₹450\.00$/)).toBeVisible();

  await page.getByRole('link', { name: '← Billing' }).click();
  await expect(page.getByLabel('Today in figures').getByText('₹1,950.00')).toBeVisible();
  await page.getByRole('button', { name: 'Close the day' }).click();
  const closing = page.getByRole('dialog', { name: /Close the day/ });
  await expect(closing.getByText('₹700.00')).toBeVisible();
  await closing.getByLabel('Cash counted in the drawer (₹)').fill('700');
  await closing.getByRole('button', { name: 'Close the day' }).click();
  await expect(page.getByText('Day closed.')).toBeVisible();
  await page.getByRole('link', { name: 'Day-end report' }).click();
  await expect(page.getByText(/Closed by Dr Synthetic/)).toBeVisible();
  await shot(page, '04-day-end');
  await page.getByRole('link', { name: 'Invoices' }).click();
  await shot(page, '04-billing');
});
