import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Page, expect } from '@playwright/test';

// Written by 00-setup for this run only. Synthetic clinic, synthetic people.
export function credentials(): { username: string; password: string } {
  return JSON.parse(readFileSync('../.tools/e2e-credentials.json', 'utf-8'));
}

export async function signIn(page: Page) {
  const who = credentials();
  await page.goto('/');
  await page.getByLabel('Username').fill(who.username);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Clinic workspace' })).toBeVisible();
  return who;
}

export async function signOut(page: Page) {
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your clinic' })).toBeVisible();
}

/** A barcode scanner types very fast and ends with Enter. */
export async function scan(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
}

/** Keeps a picture of the screen when JIVNI_SHOTS is set, for looking at the screens after a run. */
export async function shot(page: Page, name: string) {
  if (!process.env.JIVNI_SHOTS) return;
  mkdirSync('../.tools/shots', { recursive: true });
  await page.screenshot({ path: `../.tools/shots/${name}.png`, fullPage: true });
}

/**
 * Prints the page to a PDF the way "Save as PDF" does, and reports its page count and paper size in
 * points (72 to the inch). With JIVNI_SHOTS set the file is kept in .tools/shots for a look.
 */
export async function printToPdf(page: Page, name: string) {
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  if (process.env.JIVNI_SHOTS) {
    mkdirSync('../.tools/shots', { recursive: true });
    writeFileSync(`../.tools/shots/${name}.pdf`, pdf);
  }
  const text = pdf.toString('latin1');
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
  return {
    count: (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length,
    width: box ? Number(box[3]) - Number(box[1]) : 0,
    height: box ? Number(box[4]) - Number(box[2]) : 0,
  };
}
