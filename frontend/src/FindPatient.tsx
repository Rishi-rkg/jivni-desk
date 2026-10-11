import { KeyboardEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from './api';
import { ageSex, phoneTail } from './format';
import { looksLikePatientCode, resolveScan } from './Scanner';
import { Page, Patient, Role, canWriteDemographics, displayName } from './types';
import { Kbd, Modal } from './ui';

/**
 * Find a patient from anywhere: the search box in the header, Ctrl K, or a card scanned into the box.
 * Names typed here go in the request and are never kept.
 */
export function FindPatient({ role, onClose }: { role: Role; onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [results, setResults] = useState<Patient[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState(0);
  const query = text.trim();

  useEffect(() => {
    setChosen(0);
    setError('');
    if (query.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      api<Page<Patient>>(`patients/?search=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((page) => setResults(page.results.slice(0, 6)))
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const go = (path: string, state?: unknown) => {
    onClose();
    navigate(path, { state });
  };
  const actions = [
    ...(canWriteDemographics(role) && query
      ? [{ label: `Register “${query}” as a new patient`, run: () => go('/patients/new', { name: query }) }]
      : []),
    ...(query ? [{ label: 'See all results', run: () => go(`/patients?search=${encodeURIComponent(query)}`) }] : []),
  ];
  const count = results.length + actions.length;

  function choose(index: number) {
    if (index < results.length) go(`/patients/${results[index].id}`);
    else actions[index - results.length]?.run();
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count) setChosen((chosen + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // A scanned or typed card code opens that patient at once.
      if (looksLikePatientCode(query))
        resolveScan(query)
          .then((result) => {
            if (result.kind === 'patient') go(`/patients/${result.patient.id}`);
          })
          .catch((e) =>
            setError(
              e instanceof ApiError && e.status === 404
                ? 'That code does not match a patient in this clinic.'
                : e.message,
            ),
          );
      else if (count) choose(chosen);
    }
  }

  return (
    <Modal onClose={onClose} size="wide" className="finder">
      <label className="visually-hidden" htmlFor="finder-input">
        Find a patient
      </label>
      <input
        id="finder-input"
        data-autofocus
        type="search"
        autoComplete="off"
        value={text}
        maxLength={200}
        placeholder="Name, phone or patient ID, or scan a card"
        role="combobox"
        aria-expanded={count > 0}
        aria-controls="finder-results"
        aria-activedescendant={count ? `finder-option-${chosen}` : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="menu flat" id="finder-results" role="listbox" aria-label="Matches">
        {query.length < 2 && <div className="hd">Type at least two letters or digits.</div>}
        {query.length >= 2 && (
          <div className="hd">{searching ? 'Searching…' : results.length ? 'Patients' : 'No patients match.'}</div>
        )}
        {results.map((patient, index) => (
          <button
            type="button"
            role="option"
            id={`finder-option-${index}`}
            aria-selected={chosen === index}
            className={chosen === index ? 'hover' : ''}
            key={patient.id}
            onMouseEnter={() => setChosen(index)}
            onClick={() => choose(index)}
          >
            <span>
              <strong>{displayName(patient)}</strong>
              {[ageSex(patient), phoneTail(patient.phone || patient.whatsapp_number)].filter(Boolean).map((part) => (
                <span key={part}> · {part}</span>
              ))}
            </span>
            {chosen === index && <Kbd>Enter</Kbd>}
          </button>
        ))}
        {!!actions.length && (
          <>
            <div className="sep" />
            <div className="hd">Actions</div>
          </>
        )}
        {actions.map((action, at) => {
          const index = results.length + at;
          return (
            <button
              type="button"
              role="option"
              id={`finder-option-${index}`}
              aria-selected={chosen === index}
              className={chosen === index ? 'hover' : ''}
              key={action.label}
              onMouseEnter={() => setChosen(index)}
              onClick={() => choose(index)}
            >
              <span>{action.label}</span>
              {chosen === index && <Kbd>Enter</Kbd>}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
