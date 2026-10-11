<p align="center">
  <a href="https://jivnidesk.com"><img src="packaging/icons/jivni-256.png" width="128" height="128" alt="Jivni logo: a white J with a green leaf and a yellow plus"></a>
</p>

<h1 align="center">Jivni</h1>

<p align="center">
  Everything you need to run your clinic.<br>
  <a href="https://jivnidesk.com"><strong>jivnidesk.com</strong></a> ·
  <a href="https://jivnidesk.com/features">Features</a> ·
  <a href="https://jivnidesk.com/download">Download</a> ·
  <a href="https://jivnidesk.com/pricing">Pricing</a>
</p>

Jivni is a clinic workspace for a small homeopathy practice, from one practitioner to a team of five: patients, visits and prescriptions by envelope, appointments, billing, printing, WhatsApp messages sent by staff, a reference library and encrypted backups, running on the clinic's own computer. Django 5.2 LTS and Django REST Framework own the data and the API; SQLite (the installed app) or PostgreSQL 16 (Docker) owns persistence; React and TypeScript provide the interface.

**Use synthetic patient data only.** The key system, the recovery key and encrypted backups are built, but patient fields and photos are still stored unencrypted in the database and in storage. The application refuses to start outside development mode, and shows a banner on every screen, until field encryption has been built and reviewed. Passwords are hashed with Argon2; that does not encrypt patient records.

## Included

Eight tabs, fewer by role: Dashboard, Patients, Appointments, Messages, Billing, Library, Printing, Settings. The owner can switch whole parts off.

- **Getting in.** First-time setup with the recovery key shown once; sign-in that also unlocks the clinic's key; two-step sign-in with an authenticator app; a lock screen that keeps unsaved work; "Use recovery key" for an owner who has lost every password.
- **Patients.** Registration with a duplicate check, photo, message consent and a printed barcode card; a list with filters; one record with a banner, details, alert, family links, documents and a single timeline; every change to details kept; spreadsheet import with a trial run.
- **Visits.** A draft that saves itself and is seen by doctors only, then finalised and never edited (corrections are amendments beside it). Prescribing by envelope: one mix, one dosage line, one label. Doctor-only "remember about the patient" notes. Height, weight, blood pressure, pulse.
- **Appointments.** Booking starts from a phone number, then a tapped day and a tapped time inside the clinic's work week; walk-ins and a waiting list; follow-ups due; a day sheet on paper.
- **Billing.** Price list with product barcodes; bills for a patient or a walk-in buyer; prices that include GST; payments, refunds, credit notes and void; day-end; exports. An issued bill is frozen in the database.
- **Printing.** Through the computer's own print window, each page at its own paper size: A4 bill, receipt and prescription, 2 inch envelope labels, the patient card, the day sheet. "Save as PDF" gives a PDF.
- **Messages.** Prepared by rule, from a template or by hand; approved by a doctor or the owner; then opened in WhatsApp for a person to press Send. Nothing is sent by itself. Consent is checked twice; a sent message is frozen.
- **Library.** Boericke's Materia Medica and Kent's Repertory as searchable text, with the clinic's own layer over them.
- **Settings.** Clinic details and logo, work week, price list, users and roles, switches, messaging, print layouts, security, encrypted backups with a read-back check, activity log with filters and export, import and export.
- **One scan service.** A patient card opens the patient from anywhere; a product pack goes to the open bill or starts one.

Not built: encryption of patient fields; sending WhatsApp messages automatically, with delivery status and incoming replies; a helper for a label printer (the print window is used instead); a PIN for unlocking; a separate Dispense page; stock control; AI drafting. The last two have switches that stay off.

## Run it as one program

The application can run as a single program on one computer, with its database in a file (SQLite) and no other software to install:

```sh
cd frontend && npm ci && npm run build
cd ../backend && python launcher.py
```

Jivni puts a **J+ icon in the system tray**. Its menu opens Jivni, the admin console and the backups screen, starts, stops and restarts the application, backs up now, opens the data folder and the log, and quits. `--no-tray` runs it in a terminal instead (servers, Docker, tests); a computer without a tray falls back to that by itself.

It keeps its database, stored files and logs in one data folder (`%LOCALAPPDATA%\Jivni` on Windows, `~/Library/Application Support/Jivni` on a Mac, `~/.local/share/jivni` on Linux; `--data-dir` to choose another), listens on this computer only, opens the browser on the first-time setup screen, and makes the scheduled backups while it runs. `--no-browser` and `--port` are available.

To build the installer and the portable build for the system you are on:

```sh
pip install -r backend/requirements-dev.txt
python packaging/build.py                         # results in dist/release
cd frontend && JIVNI_APP=../dist/Jivni/Jivni.exe npm run e2e:app   # browser tests against the built program
```

| System | Installer | Portable | State |
| --- | --- | --- | --- |
| Windows x64 | `Jivni-<version>-windows-x64-setup.exe` (needs Inno Setup 6) | `…-portable.zip` | Built and tested |
| Linux x64 | `jivni_<version>_amd64.deb` | `…-portable.tar.gz` | Built and tested |
| macOS Intel and Apple silicon | `.dmg` | zipped `Jivni.app` | Recipe only; must be built on a Mac |
| Windows arm64, Linux arm64 | as above | as above | Recipe only; must be built on that processor |

The installer is per-user and needs no administrator password. A portable build keeps the clinic's data in a `Jivni-Data` folder beside the program; an installed one keeps it in the user's application-data folder. Neither is code-signed yet, so Windows and macOS warn about an unknown publisher. `.github/workflows/package.yml` builds every row on GitHub's machines.

## Start with Docker Compose

Install Docker Desktop with Compose v2 and Python 3.11+ to generate the local configuration. From this repository:

```sh
python scripts/init_env.py
docker compose up --build
```

The configuration generator creates ignored `.env` secrets without printing them. Do not commit this file. The example contains no usable keys or passwords.

Open **http://localhost:5173**. A new installation shows **Set up your clinic**: name the clinic, create the owner account, and write down the recovery key it shows once. Encryption is switched on as part of this.

The same can be done from a terminal instead:

```sh
docker compose exec backend python manage.py bootstrap_clinic --clinic "Synthetic Demo Clinic" --username owner
```

A new clinic defaults to the `Asia/Kolkata` time zone and INR (`--time-zone`, `--currency` to override). Enter a password at the prompt (12 characters minimum). The command also creates the clinic's encryption key and prints a **recovery key once**; write it down. Open **http://localhost:5173** and sign in. The API runs at **http://localhost:8000/api/v1/**. Both host ports bind to loopback; the database has no published host port. Use `localhost` consistently for the browser session.

Add another user by copying the clinic UUID printed at bootstrap:

```sh
docker compose exec backend python manage.py add_clinic_user --clinic-id CLINIC_UUID --username reception --role reception --authorized-by owner
```

`--authorized-by` names someone who can already open the clinic's records; their password is asked for, because an operator alone cannot hand out access to encrypted records. Other key commands: `init_clinic_keys` (a clinic created before keys existed), `grant_clinic_access` (an existing member), `recover_clinic_access` (use the recovery key). See [the security architecture](docs/security-architecture.md).

Provisioning is currently an operator command; there is no public signup or user-management UI. Bootstrap refuses to change existing accounts. Multiple memberships can be provisioned by a trusted operator through Django; the UI supports clinic selection. Django superuser status does not bypass clinic membership or clinical-role checks in the API.

Compose applies migrations on development startup. Named volumes preserve PostgreSQL data and photos. `docker compose down` stops the application while retaining those volumes. Back up and restore both together. After frontend dependency changes, run `docker compose exec frontend npm ci` to synchronize its dependency volume.

## Backups

The owner sets up backups on the **Backups** screen: add one or more folders (a local or USB drive, a NAS share, a cloud drive that appears as a folder), then **Back up now**. Every backup is one encrypted `.jivni` file; there is no unencrypted option. **Check** reads a backup back in full.

```sh
python manage.py backup_now --if-due        # for the computer's scheduler; does nothing unless a backup is due
python manage.py restore_backup FILE --check # prove a backup opens and reads back; changes nothing
python manage.py restore_backup FILE         # restore into a new, empty installation (run migrate first)
python scripts/restore_drill.py FILE         # restore into a scratch database and report what came back
```

Opening a backup needs a staff password, or the recovery key with `--recovery-key`. Without one of those nobody can open it.

## Checks

See [the verification record](docs/verification.md) for the checks actually run, newest first, and what was not checked.

Without Docker, from the repository root (PostgreSQL 16 installed; the script keeps a private development database in `.tools/`):

```sh
python scripts/dev_db.py test          # backend suite on PostgreSQL, including trigger tests
python scripts/dev_db.py stop          # stop the development database
cd backend && ruff check . && ruff format --check .
cd frontend && npm run lint && npm run format:check && npm test && npm run build
cd frontend && npm run e2e             # browser test: starts its own backend, database and frontend
cd frontend && npm run build && npm run e2e:app   # the same tests against the one-program app on SQLite
```

With Docker Compose:

```sh
docker compose exec backend python manage.py test --settings=config.test_settings
docker compose exec -e TEST_DATABASE=postgres backend python manage.py test --settings=config.test_settings
docker compose exec backend python manage.py makemigrations --check --dry-run
docker compose exec frontend npm run build
docker compose exec frontend npm test
```

The first command is the suite on SQLite. The second uses real PostgreSQL, including database triggers; the local Compose database user can create the temporary test database. CI uses PostgreSQL and also checks migration drift. Both databases are supported and carry the same safeguards: PostgreSQL for Docker and servers, SQLite for the installed app (`DATABASE_ENGINE=sqlite`, `DATABASE_PATH`).

For development without Docker: create a Python virtual environment, install `backend/requirements.lock`, provision a local PostgreSQL 16 database, and export the variables from `.env` into your shell (Django does not auto-load dotenv). Set `POSTGRES_HOST=127.0.0.1`, run migrations and bootstrap, then run `python manage.py runserver` from `backend/`. From `frontend/`, use Node 22.12+ or 24, run `npm ci` and `npm run dev`. Vite proxies `/api` to port 8000 so session cookies and CSRF stay on the same browser origin.

## Architecture decisions

This is a modular monolith. Each feature has a clear owner while transactions and migrations stay in one system. The UI owns presentation, not persistence rules. `/api/v1/` is the independent API boundary; additive changes are preferred, and breaking changes require a new API version. Schema changes require migrations and preservation of existing UUIDs and historical snapshots.

| Area | Owner and rule |
| --- | --- |
| Identity and access | `accounts`: users, clinics, roles, memberships and sessions |
| Patient registry | `records.Patient`: permanent UUID, demographics, active/archive state |
| Clinical history | `records`: append-only notes, encounters, observations, prescriptions |
| Audit | `audit`: append-only actor/action/resource/time; no clinical content or search text |
| Files | `records.storage.PatientPhotoStore`: private opaque keys; no public media routes |
| Encryption | `vault`: clinic keys, per-user password grants, recovery key, session unlock and value envelopes are built. Patient fields are not yet encrypted, so the startup guard remains |
| Future modules | `modules.contracts`: independently replaceable providers accepting clinic/resource IDs |
| Browser | `frontend`: typed API client, role-aware screens, no patient data in local storage |

Patient IDs are random UUIDv4, read-only in the API and protected from mutation by model validation and PostgreSQL triggers. Staff use a separate short code (`PAT-` plus ten characters) that is random, carries no information, and can be revoked and reissued. UUIDs are identifiers, not authorization tokens. The patient’s clinic cannot change. Every related record derives its clinic from the patient/encounter; all querysets and writable relationship choices are scoped to the active membership.

Height and weight are observations with units (`cm`, `kg`) and measurement dates, not mutable columns on the patient. An encounter and its nested observations, prescriptions, items and write audit event are committed in one transaction. Invalid nested data rolls the transaction back. Prescriptions preserve medicine name/potency/dose snapshots independently of any future medicine library.

Clinical records and audit events cannot be updated/deleted through the API or ordinary model methods. PostgreSQL triggers enforce append-only behavior even for raw SQL updates/deletes. Corrections use additional patient notes (`amends` may reference an earlier note); a formal encounter amendment/finalization workflow is a next milestone. Demographics remain editable through PATCH; patients can be archived rather than deleted. Audit records preserve who changed demographics, but complete encrypted before/after demographic revisions are not yet implemented.

Photo storage uses Django's replaceable storage backend. JPEG/PNG uploads are size/dimension checked, re-encoded to JPEG with EXIF removed, named with opaque random keys and served only through authenticated, clinic-scoped endpoints. Metadata responses exclude storage paths. The current filesystem adapter is plaintext and must be replaced/wrapped with authenticated encryption before real data is used. Configure `PATIENT_STORAGE_ROOT` and `PATIENT_STORAGE_BACKEND` for later private object-storage adapters; adapter-specific credentials/options must come from a secret manager. Failed metadata writes clean up newly uploaded files; an eventual orphan reconciliation job is needed for process crashes.

## Roles

| Role | Patients' details | Clinical records | Visits and prescriptions | Appointments | Bills and payments | Messages | Settings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Owner | Edit | Read | Write | Yes | Everything, including corrections | Approve and send | Everything |
| Doctor (`clinician`) | Edit | Read | Write | Yes | Bills | Approve and send | Own account |
| Clinical assistant | Edit | Read | No | Yes | No | No | Own account |
| Reception | Edit | No | No | Yes | Bills and payments | Prepare, send what was approved | Own account |
| Billing | Read | No | No | No | Everything, including corrections and day-end | No | Own account |
| Administrator | No patient records | No | No | No | Price list only | Templates and rules | Clinic details, work week, layouts, activity log |

Role sets live in `backend/accounts/access.py`; the screens only hide what the server would refuse. Users and roles, switches, security, backups and import are the owner's alone. A clinic always keeps at least one owner.

## API quick reference

| Endpoint | Methods | Purpose |
| --- | --- | --- |
| `/api/v1/auth/csrf/` | GET | Obtain CSRF token before login |
| `/api/v1/auth/setup/` | GET, POST | Whether first-time setup is needed; create the clinic, owner and encryption key and return the recovery key once. Closed once a clinic exists |
| `/api/v1/auth/login/`, `/logout/` | POST | Create/destroy Django session |
| `/api/v1/auth/me/` | GET | Current user, memberships and refreshed CSRF token |
| `/api/v1/auth/clinic/` | POST | Select an active authorized clinic |
| `/api/v1/auth/password/` | POST | Change your password; re-seals your access to the clinic's encryption key |
| `/api/v1/patients/` | GET, POST | Paginated registry; `search`, `page`, `archived=true` |
| `/api/v1/patients/{id}/` | GET, PATCH | Demographics; `archived_at` is read-only |
| `/api/v1/scan/{code}/` | GET | Identify any scanned barcode; today a patient card returns `{kind: "patient", patient}`. The workspace routes on the answer |
| `/api/v1/patients/by-code/{code}/` | GET | Open a patient from a scanned or typed card code; active codes of this clinic only |
| `/api/v1/patients/check-duplicates/` | POST | Possible existing records before registering; advice only |
| `/api/v1/patients/{id}/revisions/` | GET | Latest 50 demographic changes with old and new values |
| `/api/v1/patients/{id}/reissue-code/` | POST | Revoke the patient's card code and issue a new one |
| `/api/v1/patients/{id}/archive/`, `/restore/` | POST | Archive or restore; owner and clinician only; time set by the server |
| `/api/v1/patients/{id}/timeline/` | GET | Latest 50 encounters and 50 notes; clinical roles only |
| `/api/v1/patients/{id}/photos/` | POST | Multipart field `photo` |
| `/api/v1/photos/{id}/` | GET | Protected image stream |
| `/api/v1/notes/` | GET, POST | Append notes/amendments; `patient`, `page` filters |
| `/api/v1/encounters/` | GET, POST | Nested encounter entry; `patient`, `page` filters |
| `/api/v1/encounters/{id}/` | GET | Encounter with observations/prescriptions |
| `/api/v1/audit-events/` | GET | Clinic-scoped audit; owner/admin only; `outcome`, `actor`, `about`, `from`, `to`, `page` filters |
| `/api/v1/auth/two-step/start/`, `/confirm/`, `/off/` | POST | Set up or turn off your own two-step sign-in |
| `/api/v1/auth/recover/` | POST | An owner's new password from the recovery key, which is then replaced; no sign-in needed, few attempts allowed |
| `/api/v1/clinic/users/`, `/users/{id}/`, `/users/{id}/{reset-password,sign-out,two-step-off}/` | GET, POST, PATCH | Users and roles; owner only. An invitation or reset answers once with a one-time password |
| `/api/v1/clinic/security/`, `/recovery-key/`, `/sessions/end/` | GET, POST | The Security page: a new recovery key, sign everyone out |
| `/api/v1/dashboard/` | GET | The day's figures and queue, by role |
| `/api/v1/patients/{id}/feed/`, `/consent/`, `/family/`, `/documents/`, `/measurements/` | GET, POST | The record's timeline and its parts |
| `/api/v1/patients/import/`, `/export/` | POST, GET | Spreadsheet import with a trial run; export. Owner only |
| `/api/v1/visit-drafts/`, `/api/v1/encounters/{id}/amendments/`, `/api/v1/prescription-sets/` | GET, POST, PUT, DELETE | Drafts, amendments and saved sets |
| `/api/v1/work-days/`, `/work-days/templates/` | GET, POST, PUT | The work week, a month at a time, and up to four saved weeks |
| `/api/v1/appointments/` and its `slots/`, `by-phone/`, `quick-patient/`, `follow-ups/`, `{id}/{arrive,seen,cancel,no-show,reschedule}/` | GET, POST | The diary |
| `/api/v1/price-items/`, `/api/v1/invoices/` and its `find/`, `from-visit/`, `{id}/{issue,payments,refund,credit-note,void}/`, `/api/v1/payments/`, `/api/v1/billing/{summary,day-end,export}/` | GET, POST, PATCH | Billing |
| `/api/v1/print-templates/`, `/api/v1/print-data/...`, `/api/v1/print-jobs/` | GET, POST, PUT | Layouts, what each print page needs, and the print queue |
| `/api/v1/messages/` and its `counts/`, `preview/`, `bulk/`, `replies/`, `{id}/{approve,send,discard,failed,retry,handled}/` | GET, POST, PATCH | The message queue. `send/` marks a message sent and answers with the WhatsApp link |
| `/api/v1/message-templates/`, `/message-rules/`, `/message-campaigns/` | GET, POST, PATCH | Wording, when messages are prepared, and campaigns |
| `/api/v1/documents/`, `/api/v1/documents/{id}/` | GET | Patients' documents across the clinic, and one document |
| `/api/v1/audit-events/people/`, `/export/` | GET | The people in the log, and the log as a spreadsheet |
| `/api/v1/knowledge/...` | GET, POST | The reference library; see `knowledge/README.md` |
| `/api/v1/clinic/` | GET, PATCH | Clinic settings; any member reads, owner/admin change |
| `/api/v1/backups/` | GET | Backup status, schedule, places and recent backups; owner only |
| `/api/v1/backups/places/`, `/places/{id}/` | POST, DELETE | Add or remove a folder to save backups to; files already there are kept |
| `/api/v1/backups/policy/` | PATCH | Schedule, retention and warning settings |
| `/api/v1/backups/run/` | POST | Back up now |
| `/api/v1/backups/runs/{id}/verify/` | POST | Read a backup back in full; changes nothing |
| `/api/v1/modules/` | GET | Planned module metadata |
| `/health/` | GET | 200 when the database answers, otherwise 503 |

Unsafe requests require `X-CSRFToken` and the session cookie. Login is protected by Django CSRF middleware even for anonymous requests. Django rotates CSRF/session identifiers at login, and the frontend adopts the returned token. Session cookies are HttpOnly and never stored in browser local storage; API responses use `Cache-Control: no-store`. Authentication endpoints return JSON. Requests without a signed-in session return HTTP 401, which the browser treats as "locked"; a signed-in user without permission gets 403. Encounter `internal_notes` is returned only to owner and clinician. These APIs intentionally do not expose deletion of clinical records.

## Before real patient data

Read [the security architecture](docs/security-architecture.md), [the envelope-encryption design](docs/encryption.md) and [the deployment checklist](docs/deployment.md). Startup accepts only `DATA_PROTECTION_MODE=development-only`, which puts a banner on every screen; there is no setting that enables unimplemented encryption. The contracts do not protect fields by themselves. There is no compliance certification or production-readiness claim.

## Next milestones

1. Encrypt patient fields and files with the key system that is already built, settle how search works over encrypted data, and have the encryption reviewed by someone who did not write it. Only then is the startup guard removed.
2. Run Docker Compose end to end and write the deployment up as rehearsed steps.
3. Sign the installers, and build macOS and arm64 on those machines.
4. Send WhatsApp messages automatically through the official Business Platform, with delivery status and incoming replies.
5. Smaller pieces left from the screen designs: a PIN for unlocking, a Dispense page for the assistant, stock control.
6. AI drafting, only if the owner wants it, and only with a provider agreement and a view of exactly what is sent.

## Licence

Jivni is source available under the [Elastic License 2.0](LICENSE). You may read, use and change the code. You may not offer it to others as a hosted or managed service, and you may not remove or get around its licence limits. It is not an open-source licence. The reference texts in `knowledge/` (Boericke's Materia Medica and Kent's Repertory) are in the public domain.

## Technical references

- [Django 5.2 LTS release notes](https://docs.djangoproject.com/en/5.2/releases/5.2/)
- [Django REST Framework session authentication and CSRF](https://www.django-rest-framework.org/api-guide/authentication/)
- [Vite setup and Node requirements](https://vite.dev/guide/)
