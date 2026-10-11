import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { RemedySearch } from './Library';
import { Role, Session } from './types';

const sessionFor = (role: Role): Session => ({
  user: { id: 'user-id', username: 'doctor', name: '' },
  clinic_id: 'clinic-id',
  memberships: [{ clinic_id: 'clinic-id', clinic_name: 'Test clinic', role }],
  csrf_token: 'token',
});
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

const book = { id: 'book', title: 'Materia Medica', author: 'William Boericke', year: 1927 };
const arnica = { id: 'arnica-montana', name: 'Arnica montana', abbreviation: 'Arn.' };
const bellis = { id: 'bellis-perennis', name: 'Bellis perennis', abbreviation: 'Bell-p.' };
const related = (kind: string, id: string, name: string, in_library = true) => ({
  kind,
  medicine: id,
  name,
  in_library,
  note: '',
  source: 'book',
  layer: 'shipped',
});
const line = {
  kind: 'symptom',
  section: 'General',
  text: 'Sore, lame, bruised feeling.',
  grade: 2,
  source: 'book',
  layer: 'shipped',
};
const detail = {
  ...arnica,
  aliases: ['Leopard’s Bane'],
  layer: 'shipped',
  symptoms: [line],
  modalities: [{ kind: 'worse', text: 'least touch', source: 'book', layer: 'shipped' }],
  notes: [],
  relationships: [
    related('antidote', 'camphora', 'Camphora'),
    related('complementary', 'aconitum-napellus', 'Aconitum napellus', false),
    related('similar', 'bellis-perennis', 'Bellis perennis'),
  ],
  named_by: [],
  sources: { book },
};
const symptomSearch = {
  shortcut: null,
  medicines: [],
  parts: ['bruised', 'thirst'],
  results: [
    {
      ...arnica,
      matched: [{ part: 'bruised', count: 4, lines: [line] }],
      missing: ['thirst'],
      chosen: 2,
      pinned: false,
    },
    {
      ...bellis,
      matched: [{ part: 'bruised', count: 1, lines: [{ ...line, text: 'Bruised soreness.', grade: 1 }] }],
      missing: ['thirst'],
      chosen: 0,
      pinned: false,
    },
  ],
  total: 2,
  sources: { book },
};
const antidotes = {
  shortcut: { kind: 'antidote', of: arnica, items: [related('antidote', 'camphora', 'Camphora')], others: [] },
  medicines: [],
  parts: [],
  results: [],
  total: 0,
  sources: { book },
};

let calls: { path: string; method: string; body: { q?: string } | null }[];
function serve(session?: Session) {
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
    const path = String(url);
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ path, method: options?.method ?? 'GET', body });
    if (path.endsWith('me/')) return response(session);
    if (path.endsWith('knowledge/search/'))
      return response(String(body.q).startsWith('anti+') ? antidotes : symptomSearch);
    if (path.endsWith('knowledge/medicines/arnica-montana/')) return response(detail);
    if (path.endsWith('knowledge/picks/')) return response({ learned: ['bruised'] });
    if (path.endsWith('knowledge/'))
      return response({
        medicines: 35,
        rubrics: 0,
        lines: 4000,
        sources: [book],
        problems: [{ file: 'medicines/x.toml', problem: 'line 3' }],
      });
    return response({ count: 0, results: [] });
  });
}
const mount = (path: string) =>
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] })} />);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the reference library', () => {
  it('explains each result, learns a choice and never puts the search in the address', async () => {
    serve();
    const chosen: string[] = [];
    render(<RemedySearch chooseLabel="Add to prescription" onChoose={(remedy) => chosen.push(remedy.name)} />);
    await userEvent.type(screen.getByLabelText('Symptoms or remedy'), 'bruised + thirst');
    const results = await screen.findByRole('region', { name: 'Remedies by symptom' });
    const first = within(results).getAllByRole('article')[0];
    expect(within(first).getByRole('button', { name: 'Arnica montana' })).toBeInTheDocument();
    expect(within(first).getByText('1 of 2 symptoms')).toBeInTheDocument();
    expect(within(first).getByText('Chosen 2 times')).toBeInTheDocument();
    expect(within(first).getByText('✓ bruised')).toBeInTheDocument();
    expect(within(first).getByText('○ thirst')).toBeInTheDocument();
    expect(within(first).getByText('Sore, lame, bruised feeling.')).toBeInTheDocument();
    expect(within(first).getByText('General · William Boericke')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add to prescription: Bellis perennis' }));
    expect(chosen).toEqual(['Bellis perennis']);
    const pick = calls.find((call) => call.path.endsWith('knowledge/picks/'));
    expect(pick?.body).toEqual({ q: 'bruised + thirst', medicine: 'bellis-perennis' });
    const searches = calls.filter((call) => call.path.includes('knowledge/search'));
    expect(searches.every((call) => call.method === 'POST' && !call.path.includes('?'))).toBe(true);
    expect(searches.at(-1)?.body).toEqual({ q: 'bruised + thirst' });
  });

  it('answers anti+arnica and shows what goes with a remedy when resting on its name', async () => {
    serve();
    render(<RemedySearch />);
    await userEvent.type(screen.getByLabelText('Symptoms or remedy'), 'anti+arnica');
    const answer = await screen.findByRole('region', { name: 'Relationships' });
    expect(within(answer).getByRole('heading')).toHaveTextContent('Antidotes of Arnica montana');
    expect(within(answer).getByRole('button', { name: 'Camphora' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Choose/ })).not.toBeInTheDocument();

    await userEvent.hover(within(answer).getByRole('button', { name: 'Arnica montana' }));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Complementary: Aconitum napellus');
    expect(tip).toHaveTextContent('Antidotes: Camphora');

    await userEvent.click(within(answer).getByRole('button', { name: 'Arnica montana' }));
    const entry = await screen.findByRole('region', { name: 'Arnica montana' });
    expect(within(entry).getByText('Leopard’s Bane')).toBeInTheDocument();
    expect(within(entry).getByText('least touch')).toBeInTheDocument();
    // A remedy the library has no entry for is named but cannot be opened.
    expect(within(entry).getByText('Aconitum napellus').tagName).toBe('SPAN');
    await userEvent.click(within(entry).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Arnica montana' })).not.toBeInTheDocument();
  });

  it('is a tab for clinical roles, with export for those who may change it', async () => {
    serve(sessionFor('clinician'));
    mount('/library');
    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export as zip' })).toHaveAttribute('href', '/api/v1/knowledge/export/');
    expect(await screen.findByRole('alert')).toHaveTextContent('medicines/x.toml could not be read');
    expect(await screen.findByText(/35 remedies, 0 rubrics/)).toBeInTheDocument();
  });

  it('is not offered to reception', async () => {
    serve(sessionFor('reception'));
    mount('/library');
    expect(await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), / })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Library' })).not.toBeInTheDocument();
  });
});
