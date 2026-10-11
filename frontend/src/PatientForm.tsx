/** Register a patient, and the same form to edit their details later. Every change is kept in the patient's history. */
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { Barcode, barcodeText } from './codes';
import { ErrorMessage } from './components';
import { age, isoDay, phoneTail, shortDate } from './format';
import { ConsentSwitches, PatientPicker, PhotoWindow } from './PatientWindows';
import { Patient, Role, canWriteClinical, displayName } from './types';
import { notify } from './ui';
import { useUnsavedChanges } from './useUnsavedChanges';

const STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
];
interface Match extends Patient {
  reasons: string[];
}
type After = 'record' | 'visit' | 'book';

export function PatientForm({ role }: { role: Role }) {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const location = useLocation();
  const start = (location.state as { name?: string } | null)?.name ?? '';
  const [patient, setPatient] = useState<Patient | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [born, setBorn] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [same, setSame] = useState(true);
  const [consent, setConsent] = useState({ care: false, greetings: false });
  const [relative, setRelative] = useState<Patient | null>(null);
  const [relation, setRelation] = useState('');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoAddress, setPhotoAddress] = useState('');
  const [takingPhoto, setTakingPhoto] = useState(false);
  const [printCard, setPrintCard] = useState(!editing);
  const [matches, setMatches] = useState<Match[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const after = useRef<After>('record');
  const { allowNavigation, prompt } = useUnsavedChanges(dirty);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    api<Patient>(`patients/${id}/`, { signal: controller.signal })
      .then((loaded) => {
        setPatient(loaded);
        setBorn(loaded.date_of_birth);
        setPhone(loaded.phone);
        setWhatsapp(loaded.whatsapp_number ?? '');
        setSame(!loaded.whatsapp_number || loaded.whatsapp_number === loaded.phone);
        setConsent({ care: !!loaded.consent?.care?.granted, greetings: !!loaded.consent?.greetings?.granted });
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setLoadError(e.message);
      });
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    if (!photo) return setPhotoAddress('');
    const address = URL.createObjectURL(photo);
    setPhotoAddress(address);
    return () => URL.revokeObjectURL(address);
  }, [photo]);

  const get = (data: FormData, key: string) => String(data.get(key) || '').trim();
  /** Looks for someone already registered with the same name and birthday, or the same phone. Advice only. */
  function checkDuplicates() {
    if (editing || !form.current) return;
    const data = new FormData(form.current);
    const body = {
      first_name: get(data, 'first_name'),
      last_name: get(data, 'last_name'),
      date_of_birth: born || null,
      phone: phone.trim(),
      whatsapp_number: same ? '' : whatsapp.trim(),
    };
    if (!body.first_name && !body.phone) return setMatches([]);
    // Sent in the request body: a name or phone number never goes in an address.
    api<{ matches: Match[] }>('patients/check-duplicates/', { method: 'POST', body: JSON.stringify(body) })
      .then((result) => setMatches(result.matches))
      .catch(() => {});
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const line1 = get(data, 'line1');
    const body: Record<string, unknown> = {
      first_name: get(data, 'first_name'),
      middle_name: get(data, 'middle_name'),
      last_name: get(data, 'last_name'),
      date_of_birth: born,
      gender: get(data, 'gender'),
      phone: phone.trim(),
      whatsapp_number: (same ? phone : whatsapp).trim(),
      email: get(data, 'email'),
      referred_by: get(data, 'referred_by'),
      old_file_number: get(data, 'old_file_number'),
      consent,
    };
    // An address is kept only when its first line is filled in; clearing that line removes it.
    if (line1)
      body.address = {
        line1,
        line2: '',
        city: get(data, 'city'),
        region: get(data, 'region'),
        postal_code: get(data, 'postal_code'),
        country: patient?.address?.country || 'IN',
      };
    else if (editing && patient?.address) body.address = null;
    try {
      const saved = await api<Patient>(editing ? `patients/${id}/` : 'patients/', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      // The photo and the family link are saved after the patient; if one fails the patient is still registered.
      if (photo) {
        const upload = new FormData();
        upload.append('photo', photo, 'photo.jpg');
        await api(`patients/${saved.id}/photos/`, { method: 'POST', body: upload }).catch(() =>
          notify('The patient is saved, but the photo was not. Add it from the record.', { kind: 'failed' }),
        );
      }
      if (relative)
        await api(`patients/${saved.id}/family/`, {
          method: 'POST',
          body: JSON.stringify({ relative: relative.id, relation: relation.trim() }),
        }).catch(() => notify('The patient is saved, but the family link was not.', { kind: 'failed' }));
      allowNavigation.current = true;
      const message = editing ? 'Details saved.' : 'Patient registered.';
      if (after.current === 'visit') navigate(`/patients/${saved.id}/encounters/new`);
      else if (after.current === 'book')
        navigate('/appointments', { state: { book: { id: saved.id, name: displayName(saved) } } });
      else if (!editing && printCard && saved.identifier) navigate(`/print/card/${saved.id}?auto=1`);
      else navigate(`/patients/${saved.id}`, { state: { message } });
      if (after.current !== 'record' || (!editing && printCard)) notify(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (editing && !patient)
    return (
      <>
        <Link to="/patients">← Patient list</Link>
        <ErrorMessage message={loadError} />
        {!loadError && <p role="status">Loading patient…</p>}
      </>
    );
  const years = age(born);
  const today = isoDay();
  return (
    <>
      {prompt}
      <p>
        <Link to={editing ? `/patients/${id}` : '/patients'}>{editing ? '← Patient record' : '← Patient list'}</Link>
      </p>
      <div className="heading">
        <div>
          <h1>{editing ? 'Edit patient details' : 'Register a patient'}</h1>
          <p className="muted">
            {editing
              ? 'Every change is kept in the patient’s history.'
              : 'The same form is used to edit details later. Every change is kept in the patient’s history.'}
          </p>
        </div>
      </div>
      {matches.map((match) => (
        <div className="warning" key={match.id}>
          <strong>Possible duplicate.</strong> {displayName(match)}, born {shortDate(match.date_of_birth)}
          {match.phone && `, phone ending ${phoneTail(match.phone).slice(1)}`}, is already registered (
          {match.reasons.join(', ')}). <Link to={`/patients/${match.id}`}>Open that record</Link> or continue if this is
          a different person.
        </div>
      ))}
      <ErrorMessage message={error} />
      <form ref={form} onChangeCapture={() => setDirty(true)} onSubmit={submit}>
        <div className="cols cols-register">
          <section className="panel">
            <fieldset>
              <legend>Identity</legend>
              <div className="form-grid">
                <label>
                  First name
                  <input
                    name="first_name"
                    required
                    maxLength={100}
                    defaultValue={patient?.first_name ?? start}
                    onBlur={checkDuplicates}
                  />
                </label>
                <label>
                  Middle name
                  <input name="middle_name" maxLength={100} defaultValue={patient?.middle_name} />
                </label>
                <label>
                  Last name
                  <input name="last_name" maxLength={100} defaultValue={patient?.last_name} onBlur={checkDuplicates} />
                </label>
                <label>
                  Date of birth
                  <input
                    name="date_of_birth"
                    type="date"
                    required
                    max={today}
                    value={born}
                    onChange={(e) => setBorn(e.target.value)}
                    onBlur={checkDuplicates}
                  />
                </label>
                <label>
                  Sex
                  <select name="gender" aria-label="Sex" required defaultValue={patient?.gender ?? 'undisclosed'}>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="other">Other</option>
                    <option value="undisclosed">Not stated</option>
                  </select>
                </label>
                <label>
                  Age
                  <input value={years === null ? '' : `${years} year${years === 1 ? '' : 's'}`} disabled readOnly />
                </label>
              </div>
            </fieldset>
            <fieldset>
              <legend>Contact</legend>
              <div className="form-grid">
                <label>
                  Phone
                  <input
                    name="phone"
                    type="tel"
                    maxLength={40}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    onBlur={checkDuplicates}
                  />
                </label>
                <label>
                  WhatsApp number
                  <input
                    name="whatsapp_number"
                    type="tel"
                    maxLength={40}
                    value={same ? phone : whatsapp}
                    disabled={same}
                    onChange={(e) => setWhatsapp(e.target.value)}
                  />
                </label>
                <label>
                  Email
                  <input name="email" type="email" placeholder="Optional" defaultValue={patient?.email} />
                </label>
                <label className="check span-3">
                  <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
                  WhatsApp number is the same as phone
                </label>
                <label className="span-2">
                  Address
                  <input name="line1" maxLength={200} defaultValue={patient?.address?.line1} />
                </label>
                <label>
                  City
                  <input name="city" maxLength={100} defaultValue={patient?.address?.city} />
                </label>
                <label>
                  State
                  <select name="region" aria-label="State" defaultValue={patient?.address?.region ?? ''}>
                    <option value="">Not recorded</option>
                    {STATES.map((state) => (
                      <option key={state}>{state}</option>
                    ))}
                    {patient?.address?.region && !STATES.includes(patient.address.region) && (
                      <option>{patient.address.region}</option>
                    )}
                  </select>
                </label>
                <label>
                  PIN code
                  <input
                    name="postal_code"
                    maxLength={30}
                    inputMode="numeric"
                    defaultValue={patient?.address?.postal_code}
                  />
                </label>
              </div>
            </fieldset>
            <fieldset>
              <legend>Message consent</legend>
              <ConsentSwitches
                value={consent}
                recorded={patient?.consent}
                onChange={(value) => {
                  setDirty(true);
                  setConsent(value);
                }}
              />
              <p className="small muted">
                Recorded with today&apos;s date and your name. Messages never contain a diagnosis, symptoms or medicine
                names.
              </p>
            </fieldset>
            <fieldset className="last">
              <legend>Other</legend>
              <div className="form-grid">
                <label>
                  Referred by
                  <input
                    name="referred_by"
                    maxLength={120}
                    placeholder="Optional"
                    defaultValue={patient?.referred_by}
                  />
                </label>
                <label>
                  Old file number
                  <input
                    name="old_file_number"
                    maxLength={60}
                    placeholder="From paper records"
                    defaultValue={patient?.old_file_number}
                  />
                </label>
              </div>
              {!editing && (
                <div className="family-add">
                  {relative ? (
                    <div className="form-grid">
                      <p className="span-2">
                        Family or guardian: <strong>{displayName(relative)}</strong>{' '}
                        <button type="button" className="link-button" onClick={() => setRelative(null)}>
                          Remove
                        </button>
                      </p>
                      <label>
                        What they are to this patient
                        <input
                          value={relation}
                          maxLength={60}
                          placeholder="For example: mother"
                          onChange={(e) => setRelation(e.target.value)}
                        />
                      </label>
                    </div>
                  ) : (
                    <PatientPicker label="Family or guardian (link to another patient)" onPick={setRelative} />
                  )}
                </div>
              )}
            </fieldset>
          </section>

          <aside>
            <section className="panel">
              <h2>Photo</h2>
              {photoAddress ? (
                <img className="photo-preview" alt="New patient photo" src={photoAddress} />
              ) : patient?.photos.length ? (
                <img
                  className="photo-preview"
                  alt="Patient photo"
                  src={`/api/v1/photos/${[...patient.photos].sort((a, b) => b.created_at.localeCompare(a.created_at))[0].id}/`}
                />
              ) : (
                <div className="camera idle">
                  <span>No photo yet</span>
                </div>
              )}
              <div className="actions photo-actions">
                <button type="button" className="secondary" onClick={() => setTakingPhoto(true)}>
                  {photo || patient?.photos.length ? 'Change photo' : 'Take photo'}
                </button>
              </div>
              <p className="small muted">
                The photo is cropped to the face on this computer. Retake or adjust only if it looks wrong.
              </p>
            </section>
            <section className="panel">
              <h2>Patient card</h2>
              {patient?.identifier ? (
                <>
                  <p className="mono">{patient.identifier}</p>
                  <Barcode className="card-barcode" value={barcodeText(patient.identifier)} />
                  <p className="small muted">The code is random and holds no personal details.</p>
                  <Link className="button secondary btn-sm" to={`/print/card/${patient.id}`}>
                    Print patient card
                  </Link>
                </>
              ) : (
                <>
                  <p className="small muted">
                    A random code, holding no personal details, is created when the patient is saved.
                  </p>
                  <label className="check">
                    <input type="checkbox" checked={printCard} onChange={(e) => setPrintCard(e.target.checked)} />
                    Print card after saving
                  </label>
                </>
              )}
            </section>
          </aside>
        </div>

        <div className="save-bar">
          <span className="muted">
            {dirty ? 'Unsaved changes' : editing ? 'No changes yet' : 'Nothing entered yet'}
          </span>
          <div className="actions">
            <Link to={editing ? `/patients/${id}` : '/patients'}>Cancel</Link>
            {!editing && (
              <button type="submit" className="secondary" disabled={busy} onClick={() => (after.current = 'book')}>
                Save and book appointment
              </button>
            )}
            {!editing && canWriteClinical(role) && (
              <button type="submit" className="secondary" disabled={busy} onClick={() => (after.current = 'visit')}>
                Save and start visit
              </button>
            )}
            <button type="submit" disabled={busy} onClick={() => (after.current = 'record')}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Save patient'}
            </button>
          </div>
        </div>
      </form>
      {takingPhoto && (
        <PhotoWindow
          onClose={() => setTakingPhoto(false)}
          onUse={(blob) => {
            setPhoto(blob);
            setDirty(true);
            setTakingPhoto(false);
          }}
        />
      )}
    </>
  );
}
