import { expect, test } from '@playwright/test';
import { shot, signIn } from './helpers';

test('messages: write from a template, send through WhatsApp by hand, fail and retry, a campaign, a reply and the settings', async ({
  page,
}) => {
  // WhatsApp itself is never contacted: a stand-in page answers in its place.
  await page
    .context()
    .route('https://wa.me/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>WhatsApp stand-in</title>' }),
    );
  await signIn(page);

  // A patient with a full number who agreed to both kinds of message.
  await page.getByRole('link', { name: 'Patients', exact: true }).click();
  await page.getByRole('link', { name: 'New patient' }).click();
  await page.getByLabel('First name').fill('Meera');
  await page.getByLabel('Last name').fill('Synthetic-Message');
  await page.getByLabel('Date of birth').fill('1988-05-05');
  await page.getByLabel('Phone', { exact: true }).fill('90000 00155');
  await page.getByRole('switch', { name: 'Care messages' }).click();
  await page.getByRole('switch', { name: 'Greetings and clinic news' }).click();
  await page.getByLabel('Print card after saving').uncheck();
  await page.getByRole('button', { name: 'Save patient' }).click();
  await expect(page.getByRole('heading', { name: 'Meera Synthetic-Message' })).toBeVisible();

  // The Message button: a template fills in the patient's own details, and WhatsApp opens with the wording ready.
  await page.getByRole('button', { name: 'Message', exact: true }).click();
  const writing = page.getByRole('dialog', { name: 'WhatsApp message to Meera Synthetic-Message' });
  await writing.getByLabel('Template').selectOption({ label: 'Follow-up 30 days' });
  await expect(writing.getByLabel('Message')).toHaveValue(/^Hello Meera,\n\nWe hope you are doing well\./);
  await expect(writing.getByText(/Goes to 90000 00155 on WhatsApp\./)).toBeVisible();
  await shot(page, '08-write');
  const [whatsapp] = await Promise.all([
    page.waitForEvent('popup'),
    writing.getByRole('button', { name: 'Approve and send' }).click(),
  ]);
  await whatsapp.waitForLoadState();
  expect(whatsapp.url()).toContain(
    'https://wa.me/919000000155?text=Hello%20Meera%2C%0A%0AWe%20hope%20you%20are%20doing%20well.',
  );
  await whatsapp.close();
  await expect(page.getByText('WhatsApp is opening with the message ready. Press Send there.')).toBeVisible();
  // It is on the patient's timeline and under their Messages tab.
  await expect(page.getByRole('list', { name: 'Timeline' }).getByText('WhatsApp · Follow-up 30 days')).toBeVisible();
  await page.getByRole('navigation', { name: 'Patient record' }).getByRole('link', { name: 'Messages' }).click();
  await expect(page.getByText('Sent by staff')).toBeVisible();

  // Sent, then "did not go", then tried again.
  await page
    .getByRole('navigation', { name: 'Clinic workspace' })
    .getByRole('link', { name: /Messages/ })
    .click();
  await expect(page.getByText(/Nothing is waiting\./)).toBeVisible();
  await page.getByRole('navigation', { name: 'Message sections' }).getByRole('link', { name: 'Sent' }).click();
  const sent = page.getByRole('row').filter({ hasText: 'Meera Synthetic-Message' });
  await expect(sent.getByText('Sent by staff')).toBeVisible();
  await expect(sent.getByText('90000 00155')).toBeVisible();
  await sent.getByRole('button', { name: 'Did not go' }).click();
  const failing = page.getByRole('dialog', { name: 'The message to Meera Synthetic-Message did not go?' });
  await failing.getByLabel('What went wrong').fill('Synthetic: phone was switched off');
  await failing.getByRole('button', { name: 'Mark as failed' }).click();
  await expect(page.getByText('Marked as failed.')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Message sections' })
    .getByRole('link', { name: /Failed/ })
    .click();
  await expect(page.getByText('Synthetic: phone was switched off')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Back in the queue, ready to send.')).toBeVisible();

  // A template of the clinic's own, with a field inserted.
  await page.getByRole('navigation', { name: 'Message sections' }).getByRole('link', { name: 'Templates' }).click();
  await expect(
    page.getByText(/v1 · care message · uses first name, clinic name, appointment date, appointment time/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New template' }).click();
  const template = page.getByRole('dialog', { name: 'New template' });
  await template.getByLabel('Name').fill('Festival greeting');
  await template.getByRole('radio', { name: 'Greeting or clinic news' }).click();
  await template.getByLabel('Wording').fill('Happy Diwali, ');
  await template.getByRole('button', { name: 'first name' }).click();
  await expect(template.getByLabel('Wording')).toHaveValue('Happy Diwali, {first_name}');
  await template.getByLabel('Approved for use').check();
  await template.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText('Template added.')).toBeVisible();
  await expect(page.getByText('v1 · greeting or clinic news · uses first name')).toBeVisible();

  // Rules: the 90 day follow-up is off until someone switches it on.
  await page.getByRole('navigation', { name: 'Message sections' }).getByRole('link', { name: 'Rules' }).click();
  await expect(page.getByText('1 day before · needs approval')).toBeVisible();
  const ninety = page.getByRole('switch', { name: '90 day follow-up' });
  await expect(ninety).toHaveAttribute('aria-checked', 'false');
  await ninety.click();
  await expect(page.getByText('90 days after last visit, if no follow-up is booked · needs approval')).toBeVisible();
  await shot(page, '08-rules');

  // A campaign prepares one message for each patient who agreed to greetings; here that is one person.
  await page.getByRole('button', { name: 'New campaign' }).click();
  const campaign = page.getByRole('dialog', { name: 'New campaign' });
  await campaign.getByLabel('Name').fill('Synthetic Diwali greeting');
  await campaign.getByLabel('Template').selectOption({ label: 'Festival greeting' });
  await expect(campaign.getByText('1 patient will get it.')).toBeVisible();
  await campaign.getByRole('button', { name: 'Prepare messages' }).click();
  await expect(page.getByText('1 message is waiting for approval.')).toBeVisible();

  // The queue: the retried message is ready, the greeting waits; the tab shows how many.
  const queue = page.getByRole('region', { name: 'Messages waiting' });
  await expect(queue.getByText('Campaign: Synthetic Diwali greeting')).toBeVisible();
  await expect(queue.getByText('Ready to send')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Clinic workspace' }).getByLabel('2 waiting for approval'),
  ).toBeVisible();
  await queue.getByRole('button', { name: /Synthetic Diwali greeting/ }).click();
  const preview = page.getByRole('region', { name: 'Message', exact: true });
  await expect(preview.getByText('Happy Diwali, Meera')).toBeVisible();
  await expect(preview.getByText(/Consent: greetings and clinic news, recorded/)).toBeVisible();
  await shot(page, '08-queue');
  await queue.getByLabel('Select all').check();
  await page.getByRole('button', { name: 'Approve selected' }).click();
  await expect(page.getByText('1 message approved. 1 left as it was.')).toBeVisible();
  // Held for later, then let go.
  await preview.getByRole('button', { name: 'Send later…' }).click();
  const later = page.getByRole('dialog', { name: 'Send later' });
  await later.getByRole('button', { name: 'Hold until this day' }).click();
  await expect(page.getByText(/^Held until \d\d \w+ \d{4}\.$/)).toBeVisible();
  await expect(queue.getByText(/held until/)).toBeVisible();
  await preview.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('Message discarded.')).toBeVisible();
  await expect(queue.getByText('Campaign: Synthetic Diwali greeting')).toBeHidden();

  // A reply seen on the phone is noted and dealt with.
  await page.getByRole('navigation', { name: 'Message sections' }).getByRole('link', { name: 'Replies' }).click();
  await page.getByRole('button', { name: 'Note a reply' }).click();
  const reply = page.getByRole('dialog', { name: 'Note a reply' });
  await reply.getByLabel('Find the patient').fill('Meera');
  await reply.getByRole('button', { name: /Meera Synthetic-Message/ }).click();
  await page.getByLabel('What the patient wrote').fill('Synthetic: can I come on Friday instead?');
  await page.getByRole('button', { name: 'Save reply' }).click();
  await expect(page.getByText('“Synthetic: can I come on Friday instead?”')).toBeVisible();
  await page.getByRole('button', { name: 'Mark as dealt with' }).click();
  await expect(page.getByText('Dealt with')).toBeVisible();

  // Settings says plainly how messages are sent, with the same rules and templates.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Messaging' }).click();
  await expect(page.getByText('By a person, from WhatsApp on this computer or the clinic’s phone.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Rules' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible();
});
