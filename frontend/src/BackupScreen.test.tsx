import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { BackupOverview, BackupRun, Role, Session } from './types';

const sessionFor = (role: Role): Session => ({
  user: { id: 'user-id', username: 'owner', name: '' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role }],
  csrf_token: 'token',
});
const place = {
  id: 'place-id',
  name: 'Clinic NAS',
  kind: 'nas' as const,
  folder: '\\\\clinic-nas\\backups',
  last_ok_at: null,
  last_error: '',
  reachable: true,
  free_bytes: 5 * 1024 ** 3,
};
const run: BackupRun = {
  id: 'run-id',
  kind: 'manual',
  started_at: '2026-10-11T02:00:00Z',
  finished_at: '2026-10-11T02:00:05Z',
  file_name: 'jivni-backup-20261011-020000.jivni',
  byte_size: 3 * 1024 ** 2,
  places: [{ place: 'place-id', name: 'Clinic NAS', ok: true }],
  ok: true,
  error: '',
  verified_at: null,
  verified_ok: null,
};
const policy = {
  automatic: true,
  frequency: 'daily' as const,
  at: '02:00:00',
  keep_daily_days: 30,
  keep_monthly_months: 12,
  warn_after_days: 2,
};
const response = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

function mount(path: string) {
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] })} />);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('backups', () => {
  it('lets the owner add a place, back up, and check that the backup reads back', async () => {
    const state: BackupOverview = {
      status: { last_ok_at: null, overdue: true, due: false, problem: '' },
      policy,
      places: [],
      runs: [],
    };
    const posts: { path: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const path = String(url);
      if (path.endsWith('me/')) return response(sessionFor('owner'));
      if (options?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(options.body)) });
        if (path.endsWith('places/')) {
          state.places = [place];
          return response(place, 201);
        }
        if (path.endsWith('run/')) {
          state.runs = [run];
          state.status = { ...state.status, last_ok_at: run.finished_at, overdue: false };
          return response(run, 201);
        }
        state.runs = [{ ...run, verified_ok: true, verified_at: '2026-10-11T02:05:00Z' }];
        return response({ run: state.runs[0], counts: { patients: 312, visits: 1840, files: 298 }, detail: '' });
      }
      return response(state);
    });
    mount('/backups');
    expect(await screen.findByRole('alert')).toHaveTextContent('No backup has succeeded in the last 2 days.');
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'nas');
    await userEvent.type(screen.getByLabelText('Name'), 'Clinic NAS');
    await userEvent.type(screen.getByLabelText('Folder'), '\\\\clinic-nas\\backups');
    await userEvent.click(screen.getByRole('button', { name: 'Add a place' }));
    expect(await screen.findByText(/A test file was written and read back/)).toBeInTheDocument();
    expect(posts[0].body).toEqual({ kind: 'nas', name: 'Clinic NAS', folder: '\\\\clinic-nas\\backups' });
    expect(screen.getByText('OK · 5.0 GB free')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    expect(await screen.findByText('Backup saved to 1 of 1 place.')).toBeInTheDocument();
    const row = screen.getByText('3.0 MB').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Check' }));
    expect(await screen.findByText(/reads back in full: 312 patients, 1840 visits, 298 files/)).toBeInTheDocument();
    expect(within(screen.getByText('3.0 MB').closest('tr')!).getByText(/^Verified/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows where a backup was missed and what is wrong with a place', async () => {
    const state: BackupOverview = {
      status: { last_ok_at: run.finished_at, overdue: false, due: false, problem: '' },
      policy,
      places: [
        place,
        { ...place, id: 'cloud', name: 'Cloud drive', kind: 'cloud', reachable: false, free_bytes: null },
      ],
      runs: [{ ...run, places: [...run.places, { place: 'cloud', name: 'Cloud drive', ok: false, error: 'x' }] }],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).endsWith('me/') ? response(sessionFor('owner')) : response(state),
    );
    mount('/backups');
    expect(await screen.findByText('Not reachable from this computer')).toBeInTheDocument();
    expect(screen.getByText('Cloud drive (missed)')).toBeInTheDocument();
  });

  it('is hidden from everyone but the owner', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).endsWith('me/')
        ? response(sessionFor('admin'))
        : response({ count: 0, next: null, previous: null, results: [] }),
    );
    mount('/backups');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Backups' })).not.toBeInTheDocument();
  });
});
