import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ErrorMessage } from './components';
import { Role, canWriteClinical } from './types';

// The reference library holds no patient data. What is typed into its search may describe a patient, so it is
// kept in memory only and sent in the request body, never in the address.

export interface Remedy {
  id: string;
  name: string;
  abbreviation: string;
}
interface Source {
  id: string;
  title: string;
  author?: string;
  edition?: string;
  year?: number;
}
interface Line {
  kind: 'symptom' | 'modality' | 'rubric';
  section: string;
  text: string;
  grade: number;
  source: string;
  layer: 'shipped' | 'clinic';
}
interface Related {
  kind: string;
  medicine: string;
  name: string;
  in_library: boolean;
  note: string;
  source: string;
  layer: 'shipped' | 'clinic';
}
interface Result extends Remedy {
  matched: { part: string; count: number; lines: Line[] }[];
  missing: string[];
  chosen: number;
  pinned: boolean;
}
interface SearchResponse {
  shortcut: { kind: string; of: Remedy | null; items: Related[]; others: Remedy[] } | null;
  medicines: Remedy[];
  parts: string[];
  results: Result[];
  total: number;
  sources: Record<string, Source>;
}
interface Entry {
  section?: string;
  kind?: string;
  text: string;
  grade?: number;
  source: string;
  layer: 'shipped' | 'clinic';
}
interface Detail extends Remedy {
  aliases: string[];
  layer: 'shipped' | 'clinic';
  symptoms: Entry[];
  modalities: Entry[];
  notes: Entry[];
  relationships: Related[];
  named_by: (Remedy & { kind: string; source: string })[];
  sources: Record<string, Source>;
}
interface Overview {
  medicines: number;
  rubrics: number;
  lines: number;
  sources: Source[];
  problems: { file: string; problem: string }[];
}

const KINDS: Record<string, string> = {
  antidote: 'Antidotes',
  complementary: 'Complementary',
  similar: 'Compare',
  inimical: 'Inimical',
  follows: 'Follows well',
};
const kindLabel = (kind: string) => KINDS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
const cite = (source?: Source) =>
  source ? [source.author, source.title, source.edition, source.year].filter(Boolean).join(', ') : '';
const byKind = (items: Related[]) =>
  Object.entries(
    items.reduce<Record<string, Related[]>>((groups, item) => {
      (groups[item.kind] ??= []).push(item);
      return groups;
    }, {}),
  );

type Load = (id: string) => Promise<Detail>;

/** A remedy's name. Resting on it shows what goes with it and what antidotes it; choosing it opens the entry. */
function RemedyName({ remedy, load, onOpen }: { remedy: Remedy; load: Load; onOpen: (id: string) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [shown, setShown] = useState(false);
  const show = () => {
    setShown(true);
    if (!detail)
      load(remedy.id)
        .then(setDetail)
        .catch(() => undefined);
  };
  const groups = detail ? byKind(detail.relationships.filter((item) => item.kind !== 'similar')) : [];
  return (
    <span className="remedy-name" onMouseEnter={show} onMouseLeave={() => setShown(false)}>
      <button
        type="button"
        className="link"
        onFocus={show}
        onBlur={() => setShown(false)}
        onClick={() => onOpen(remedy.id)}
      >
        {remedy.name}
      </button>
      {shown && detail && (
        <span className="remedy-tip" role="tooltip">
          {groups.length === 0 && 'No relationships listed.'}
          {groups.map(([kind, items]) => (
            <span key={kind}>
              <strong>{kindLabel(kind)}:</strong> {items.map((item) => item.name).join(', ')}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function RelatedList({ items, load, onOpen }: { items: Related[]; load: Load; onOpen: (id: string) => void }) {
  return (
    <ul className="related">
      {items.map((item) => (
        <li key={`${item.kind}-${item.medicine}-${item.name}`}>
          {item.in_library ? (
            <RemedyName remedy={{ id: item.medicine, name: item.name, abbreviation: '' }} load={load} onOpen={onOpen} />
          ) : (
            <span title="Not in the library yet">{item.name}</span>
          )}
          {item.note && <span className="muted"> ({item.note})</span>}
          {item.layer === 'clinic' && <span className="badge">Clinic</span>}
        </li>
      ))}
    </ul>
  );
}

function RemedyEntry({
  detail,
  load,
  onOpen,
  onClose,
}: {
  detail: Detail;
  load: Load;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const sections = detail.symptoms.reduce<Record<string, Entry[]>>((groups, entry) => {
    (groups[entry.section || 'General'] ??= []).push(entry);
    return groups;
  }, {});
  const modalities = (kind: string) => detail.modalities.filter((entry) => entry.kind === kind);
  return (
    <section className="panel remedy-entry" aria-label={detail.name}>
      <div className="heading">
        <div>
          <h2>
            {detail.name} <span className="muted">{detail.abbreviation}</span>
          </h2>
          {detail.aliases.length > 0 && <p className="muted">{detail.aliases.join(' · ')}</p>}
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      {byKind(detail.relationships).map(([kind, items]) => (
        <div key={kind}>
          <h3>{kindLabel(kind)}</h3>
          <RelatedList items={items} load={load} onOpen={onOpen} />
        </div>
      ))}
      {detail.named_by.length > 0 && (
        <div>
          <h3>Named in other entries</h3>
          <ul className="related">
            {detail.named_by.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <RemedyName remedy={item} load={load} onOpen={onOpen} />
                <span className="muted"> lists it under {kindLabel(item.kind).toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(['worse', 'better'] as const).map(
        (kind) =>
          modalities(kind).length > 0 && (
            <p key={kind}>
              <strong>{kind === 'worse' ? 'Worse' : 'Better'}:</strong>{' '}
              {modalities(kind)
                .map((entry) => entry.text)
                .join('; ')}
            </p>
          ),
      )}
      {Object.entries(sections).map(([section, entries]) => (
        <details key={section} open={section === 'General'}>
          <summary>
            {section} <span className="muted">({entries.length})</span>
          </summary>
          <ul>
            {entries.map((entry, index) => (
              <li key={index} className={entry.grade && entry.grade > 1 ? 'graded' : undefined}>
                {entry.text}
                {entry.layer === 'clinic' && <span className="badge">Clinic</span>}
              </li>
            ))}
          </ul>
        </details>
      ))}
      {detail.notes.map((note, index) => (
        <p key={index}>
          <strong>{note.section}:</strong> {note.text}
        </p>
      ))}
      <p className="muted">
        Sources:{' '}
        {Object.values(detail.sources)
          .map((source) => cite(source))
          .join(' · ')}
      </p>
    </section>
  );
}

/**
 * Search the library by symptoms, by a remedy's name, or with a shortcut such as anti+arnica.
 * With `onChoose`, each result can be chosen; the choice is remembered so that remedy ranks higher next time.
 */
export function RemedySearch({
  onChoose,
  chooseLabel = 'Choose',
}: {
  onChoose?: (remedy: Remedy) => void;
  chooseLabel?: string;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<SearchResponse | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const cache = useRef(new Map<string, Promise<Detail>>());
  const load: Load = (id) => {
    if (!cache.current.has(id)) {
      const request = api<Detail>(`knowledge/medicines/${id}/`);
      request.catch(() => cache.current.delete(id));
      cache.current.set(id, request);
    }
    return cache.current.get(id)!;
  };
  const openEntry = (id: string) =>
    load(id)
      .then(setOpen)
      .catch((e) => setError(e.message));

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<SearchResponse>('knowledge/search/', {
        method: 'POST',
        body: JSON.stringify({ q: text }),
        signal: controller.signal,
      })
        .then((data) => {
          setFound(data);
          setError('');
        })
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  function choose(remedy: Remedy) {
    // Learning is a convenience: if it fails, the choice still stands.
    api('knowledge/picks/', { method: 'POST', body: JSON.stringify({ q: query.trim(), medicine: remedy.id }) }).catch(
      () => undefined,
    );
    onChoose?.({ id: remedy.id, name: remedy.name, abbreviation: remedy.abbreviation });
  }
  const chooseButton = (remedy: Remedy) =>
    onChoose && (
      <button
        type="button"
        className="secondary"
        onClick={() => choose(remedy)}
        aria-label={`${chooseLabel}: ${remedy.name}`}
      >
        {chooseLabel}
      </button>
    );

  return (
    <div className="remedy-search">
      <label>
        Symptoms or remedy
        <input
          type="search"
          value={query}
          autoComplete="off"
          placeholder="headache + worse sun + nausea"
          onChange={(e) => setQuery(e.target.value)}
          // Inside the visit form, Enter must not save the visit.
          onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
        />
      </label>
      <p className="muted">
        Put + between symptoms. <code>anti+arnica</code> lists antidotes; <code>comp+</code>, <code>sim+</code> and{' '}
        <code>inim+</code> work the same way.
      </p>
      <ErrorMessage message={error} />
      {found?.shortcut && (
        <div className="remedy-result" role="region" aria-label="Relationships">
          {found.shortcut.of ? (
            <>
              <h3>
                {kindLabel(found.shortcut.kind)} of{' '}
                <RemedyName remedy={found.shortcut.of} load={load} onOpen={openEntry} />
              </h3>
              {found.shortcut.items.length ? (
                <ul className="related">
                  {found.shortcut.items.map((item) => (
                    <li key={`${item.medicine}-${item.name}`}>
                      {item.in_library ? (
                        <RemedyName
                          remedy={{ id: item.medicine, name: item.name, abbreviation: '' }}
                          load={load}
                          onOpen={openEntry}
                        />
                      ) : (
                        <span title="Not in the library yet">{item.name}</span>
                      )}
                      {item.note && <span className="muted"> ({item.note})</span>}
                      <span className="muted"> · {cite(found.sources[item.source])}</span>{' '}
                      {chooseButton({ id: item.medicine, name: item.name, abbreviation: '' })}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">The library lists none.</p>
              )}
            </>
          ) : (
            <p className="muted">No remedy in the library has that name.</p>
          )}
        </div>
      )}
      {found && !found.shortcut && found.medicines.length > 0 && (
        <div className="remedy-result" role="region" aria-label="Remedies by name">
          <ul className="related">
            {found.medicines.map((remedy) => (
              <li key={remedy.id}>
                <RemedyName remedy={remedy} load={load} onOpen={openEntry} />{' '}
                <span className="muted">{remedy.abbreviation}</span> {chooseButton(remedy)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {found && !found.shortcut && (
        <div role="region" aria-label="Remedies by symptom">
          {found.results.length === 0 && found.medicines.length === 0 && (
            <p className="muted">Nothing in the library matches.</p>
          )}
          {found.results.map((result) => (
            <article className="remedy-result" key={result.id}>
              <div className="heading">
                <h3>
                  <RemedyName remedy={result} load={load} onOpen={openEntry} />{' '}
                  <span className="muted">{result.abbreviation}</span>
                </h3>
                <span>
                  {found.parts.length > 1 && (
                    <span className="badge">
                      {result.matched.length} of {found.parts.length} symptoms
                    </span>
                  )}{' '}
                  {result.pinned && <span className="badge">Pinned</span>}{' '}
                  {result.chosen > 0 && (
                    <span className="badge">
                      Chosen {result.chosen} {result.chosen === 1 ? 'time' : 'times'}
                    </span>
                  )}{' '}
                  {chooseButton(result)}
                </span>
              </div>
              <ul className="reasons">
                {result.matched.map((match) => (
                  <li key={match.part}>
                    <span className="matched">✓ {match.part}</span>
                    {match.count > match.lines.length && <span className="muted"> · {match.count} lines</span>}
                    <ul>
                      {match.lines.map((line, index) => (
                        <li key={index} className={line.grade > 1 ? 'graded' : undefined}>
                          {line.text}{' '}
                          <span className="muted">
                            {line.section} ·{' '}
                            {found.sources[line.source]?.author ?? found.sources[line.source]?.title ?? line.source}
                          </span>
                          {line.layer === 'clinic' && <span className="badge">Clinic</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
                {result.missing.map((part) => (
                  <li key={part} className="muted">
                    ○ {part}
                  </li>
                ))}
              </ul>
            </article>
          ))}
          {found.total > found.results.length && (
            <p className="muted">
              Showing {found.results.length} of {found.total}. Add a symptom to narrow the list.
            </p>
          )}
        </div>
      )}
      {open && <RemedyEntry detail={open} load={load} onOpen={openEntry} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function LibraryScreen({ role }: { role: Role }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<Overview>('knowledge/', { signal: controller.signal })
      .then(setOverview)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <>
      <div className="heading">
        <div>
          <h1>Library</h1>
          <p className="muted">A reference to consult. It never prescribes; the decision is the doctor's.</p>
        </div>
        {canWriteClinical(role) && (
          <a className="button secondary" href="/api/v1/knowledge/export/" download>
            Export as zip
          </a>
        )}
      </div>
      <ErrorMessage message={error} />
      {overview?.problems.map((problem) => (
        <div className="error" role="alert" key={problem.file}>
          The library file {problem.file} could not be read and is being left out: {problem.problem}
        </div>
      ))}
      <section className="panel">
        <RemedySearch />
      </section>
      {overview && (
        <p className="muted">
          {overview.medicines} remedies, {overview.rubrics} rubrics. Sources:{' '}
          {overview.sources
            .filter((source) => source.author && source.id !== 'jivni')
            .map((source) => cite(source))
            .join(' · ')}
        </p>
      )}
    </>
  );
}
