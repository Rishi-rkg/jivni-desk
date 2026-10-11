import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// The same browser tests, run against the installed-app stack: one program (backend/launcher.py) serving the
// built screens and the API from a brand-new SQLite data folder. Run `npm run build` first.
const PORT = 8791;
const APP = `http://127.0.0.1:${PORT}`;
const venvPython = ['../.venv/Scripts/python.exe', '../.venv/bin/python']
  .map((path) => resolve(path))
  .find((path) => existsSync(path));
const python = venvPython ? `"${venvPython}"` : 'python';
const dataDir = mkdtempSync(join(tmpdir(), 'jivni-e2e-app-'));
// Set JIVNI_APP to a packaged program (for example ../dist/Jivni/Jivni.exe) to test the real installed application.
const program = process.env.JIVNI_APP
  ? `"${resolve(process.env.JIVNI_APP)}"`
  : `${python} "${resolve('../backend/launcher.py')}"`;

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: APP, viewport: { width: 1366, height: 768 }, trace: 'retain-on-failure' },
  webServer: {
    command: `${program} --no-browser --port ${PORT} --data-dir "${dataDir}"`,
    url: `${APP}/health/`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
