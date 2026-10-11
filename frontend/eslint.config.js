import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Patient data must never reach browser storage; drafts live in memory only.
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Patient data must not be stored in the browser.' },
        { name: 'sessionStorage', message: 'Patient data must not be stored in the browser.' },
        { name: 'indexedDB', message: 'Patient data must not be stored in the browser.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'localStorage', message: 'Patient data must not be stored in the browser.' },
        { object: 'window', property: 'sessionStorage', message: 'Patient data must not be stored in the browser.' },
      ],
    },
  },
  { files: ['*.config.{js,ts}', 'e2e/**/*.ts'], languageOptions: { globals: globals.node } },
);
