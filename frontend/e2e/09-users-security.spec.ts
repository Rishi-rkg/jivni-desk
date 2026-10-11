import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Page, expect, test } from '@playwright/test';
import { credentials, shot, signIn, signOut } from './helpers';

/** The six-digit code an authenticator app would show for a secret, `ahead` half-minutes from now. */
function appCode(secret: string, ahead = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.replace(/\s/g, '')]
    .map((letter) => alphabet.indexOf(letter).toString(2).padStart(5, '0'))
    .join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + ahead));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[19] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Reads something shown once, says it was written down, and closes the window. */
async function takeShownOnce(page: Page, title: RegExp, label: string, confirm: RegExp) {
  const window_ = page.getByRole('alertdialog', { name: title });
  const value = (await window_.getByLabel(label, { exact: true }).innerText()).trim();
  await expect(window_.getByRole('button', { name: 'Done' })).toBeDisabled();
  await window_.getByLabel(confirm).check();
  await window_.getByRole('button', { name: 'Done' }).click();
  await expect(window_).toBeHidden();
  return value;
}

// The last test in the run: it ends by giving the owner a new password with the recovery key, and
// leaves that password for anything that might follow.
test('users and security: an invitation, a first sign-in, two-step sign-in, a reset, signing out and the recovery key', async ({
  page,
}) => {
  const owner = await signIn(page);
  const chosen = 'synthetic-second-doctor-password';

  // Invite a doctor: the one-time password is shown this once.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await sections.getByRole('link', { name: 'Users and roles' }).click();
  await page.getByRole('button', { name: 'Invite user' }).click();
  const inviting = page.getByRole('dialog', { name: 'Invite a user' });
  await inviting.getByLabel('Full name').fill('Dr Second Synthetic');
  await inviting.getByLabel('Username').fill('second');
  await inviting.getByLabel('Role').selectOption({ label: 'Doctor' });
  await inviting.getByRole('button', { name: 'Create and show one-time password' }).click();
  const oneTime = await takeShownOnce(
    page,
    /One-time password for Dr Second Synthetic/,
    'One-time password',
    /I have given it to them/,
  );
  expect(oneTime).toMatch(/^([2-9A-HJKMNP-TV-Z]{4}-){3}[2-9A-HJKMNP-TV-Z]{4}$/);
  const row = page.getByRole('row').filter({ hasText: 'Dr Second Synthetic' });
  await expect(row.getByText('second · has a one-time password')).toBeVisible();
  await expect(row.getByText('Never')).toBeVisible();
  await shot(page, '09-users');

  // Security: the lock time, and a new recovery key in place of the one from setup.
  await sections.getByRole('link', { name: 'Security' }).click();
  await page.getByLabel('Lock after no activity').selectOption('5');
  await expect(page.getByText('Lock time saved.')).toBeVisible();
  await page.getByLabel('Lock after no activity').selectOption('15');
  await page.getByRole('button', { name: 'Make a new one' }).click();
  const making = page.getByRole('dialog', { name: 'Make a new recovery key' });
  await making.getByLabel('Your password').fill(owner.password);
  await making.getByRole('button', { name: 'Make a new key' }).click();
  const recoveryKey = await takeShownOnce(
    page,
    /Write down the new recovery key/,
    'New recovery key',
    /I have written it down/,
  );
  expect(recoveryKey).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){9}[0-9A-HJKMNP-TV-Z]{4}$/);
  await shot(page, '09-security');
  await signOut(page);

  // The doctor's first sign-in: nothing opens until they have chosen their own password.
  await page.getByLabel('Username').fill('second');
  await page.getByLabel('Password').fill(oneTime);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Clinic workspace' })).toBeHidden();
  await page.getByLabel('One-time password').fill(oneTime);
  await page.getByLabel('New password', { exact: true }).fill(chosen);
  await page.getByLabel('New password again').fill(chosen);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('navigation', { name: 'Clinic workspace' })).toBeVisible();
  // A doctor has no Settings tab; their own account is in the menu.
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeHidden();
  await page.getByRole('button', { name: /^Account: Dr Second Synthetic, Doctor/ }).click();
  await page.getByRole('menuitem', { name: 'My account' }).click();

  // They turn on two-step sign-in: a code to scan, and a code typed back.
  await page.getByRole('button', { name: 'Set up' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up two-step sign-in' });
  await setup.getByLabel('Your password').fill(chosen);
  await setup.getByRole('button', { name: 'Continue' }).click();
  await expect(setup.getByRole('img', { name: 'Code for the authenticator app' })).toBeVisible();
  const secret = (await setup.getByLabel('Secret for the authenticator app').innerText()).replace(/\s/g, '');
  await shot(page, '09-two-step');
  await setup.getByLabel(/Type the 6-digit code/).fill(appCode(secret));
  await setup.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await expect(page.getByText('Two-step sign-in is on.')).toBeVisible();
  await signOut(page);

  // Now the password alone is not enough, and a wrong code is refused.
  await page.getByLabel('Username').fill('second');
  await page.getByLabel('Password').fill(chosen);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const code = page.getByLabel('6-digit code from your authenticator app');
  await expect(code).toBeVisible();
  await code.fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That code is not right. Check the app and try again.');
  // The code that set it up cannot be used twice, so this is the app's next one.
  await code.fill(appCode(secret, 1));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Clinic workspace' })).toBeVisible();

  // The owner, on another computer, sees them signed in, then resets and switches them off.
  const desk = await page.context().browser()!.newContext();
  const other = await desk.newPage();
  await signIn(other);
  await other.goto('/settings/users');
  const second = other.getByRole('row').filter({ hasText: 'Dr Second Synthetic' });
  await expect(second.getByText('Now')).toBeVisible();
  await expect(second.getByText('On', { exact: true })).toBeVisible();
  await second.getByRole('button', { name: 'Manage Dr Second Synthetic' }).click();
  await other.getByRole('menuitem', { name: 'Reset password…' }).click();
  await other
    .getByRole('alertdialog', { name: /Reset the password of Dr Second Synthetic/ })
    .getByRole('button', { name: 'Reset password' })
    .click();
  const second_time = await takeShownOnce(
    other,
    /One-time password for Dr Second Synthetic/,
    'One-time password',
    /I have given it to them/,
  );
  expect(second_time).not.toBe(oneTime);
  await expect(second.getByText('Off', { exact: true })).toBeVisible();
  // The doctor's screen is signed out at the next thing it asks for.
  await page.getByRole('link', { name: 'Patients', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Locked|Sign in to your clinic/ })).toBeVisible();
  await second.getByRole('switch', { name: 'Dr Second Synthetic can sign in' }).click();
  await other
    .getByRole('alertdialog', { name: 'Switch off Dr Second Synthetic?' })
    .getByRole('button', { name: 'Switch off' })
    .click();
  await expect(second.getByText('Switched off')).toBeVisible();
  await desk.close();

  // Every password lost: the recovery key gives the owner a new one, and is itself replaced.
  await page.goto('/');
  if (await page.getByRole('heading', { name: 'Locked' }).isVisible())
    await page.getByRole('button', { name: 'Sign in as someone else' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your clinic' })).toBeVisible();
  await page.getByRole('button', { name: 'Use recovery key' }).click();
  const recovering = page.getByRole('dialog', { name: 'Use the recovery key' });
  const renewed = `${owner.password}-renewed`;
  await recovering.getByLabel('Owner’s username').fill(owner.username);
  await recovering.getByLabel('Recovery key').fill(recoveryKey.toLowerCase());
  await recovering.getByLabel('New password', { exact: true }).fill(renewed);
  await recovering.getByLabel('New password again').fill(renewed);
  await recovering.getByRole('button', { name: 'Reset the owner’s password' }).click();
  const newest = await takeShownOnce(
    page,
    /Write down the new recovery key/,
    'New recovery key',
    /I have written it down/,
  );
  expect(newest).not.toBe(recoveryKey);
  writeFileSync('../.tools/e2e-credentials.json', JSON.stringify({ username: owner.username, password: renewed }));
  expect(credentials().password).toBe(renewed);
  await expect(page.getByText('Password reset. Sign in with the new password.')).toBeVisible();
  // The old password is gone, the new one opens the records, and the switched-off doctor stays out.
  await page.getByLabel('Username').fill(owner.username);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid username or password.');
  await page.getByLabel('Username').fill('second');
  await page.getByLabel('Password').fill(second_time);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('No active clinic membership.');
  await signIn(page);
  await page.getByRole('link', { name: 'Patients', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Synthetic Smoke-Test' })).toBeVisible();
});
