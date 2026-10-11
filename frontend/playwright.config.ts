import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const BACKEND = 'http://127.0.0.1:8010';
const FRONTEND = 'http://127.0.0.1:5183';
// Use the project's virtual environment when it exists (local runs); CI installs into the system Python.
const venvPython = ['../.venv/Scripts/python.exe', '../.venv/bin/python']
  .map((path) => resolve(path))
  .find((path) => existsSync(path));
const python = venvPython ? `"${venvPython}"` : 'python';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 60_000,
  // GitHub's build machines are several times slower than a desk computer; five seconds was not always enough.
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: FRONTEND, viewport: { width: 1366, height: 768 }, trace: 'retain-on-failure' },
  webServer: [
    {
      command: `${python} "${resolve('../scripts/e2e_server.py')}"`,
      url: `${BACKEND}/health/`,
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5183 --strictPort',
      url: FRONTEND,
      env: { API_PROXY_TARGET: BACKEND },
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
