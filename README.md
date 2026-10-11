# Clinic Management MVP

A new, independent repository for a browser-based clinic record system. Django 5.2 LTS and Django REST Framework own the clinical data and API; PostgreSQL 16 owns persistence; React + TypeScript provide the interface. Docker Compose is the standard local development environment.

**This is a production-oriented foundation, not a production deployment. Use synthetic patient data only. Patient fields, photos, local volumes and backups are currently plaintext. Startup rejects production mode until envelope encryption has been implemented and verified.** Passwords are hashed with Argon2; that does not encrypt patient records.

## Included

- Session login/logout, CSRF protection, clinic selection and clinic membership checks on every record request.
- Clinic, custom UUID user, seeded roles, memberships and immutable patient UUIDs.
- Patient demographics, address, protected photo upload/storage metadata, append-only notes and amendments.
- Encounters with symptoms, history, assessment, internal notes, follow-up date, time-stamped height/weight observations, prescriptions and structured medicine snapshots.
- Versioned REST API, pagination, name/phone/UUID search, audit events for access, writes, refused access and failed sign-ins, each with outcome, source address and request ID.
- Clinic settings (time zone, address, tax identifier, currency). Dates of birth and follow-ups are judged by the clinic's local date.
- Idle lock after 15 minutes without activity (`SESSION_IDLE_SECONDS`); the lock screen keeps unsaved work, and active typing keeps the session alive.
- Clinic settings and audit log screens; archive and restore actions for patients.
- Login, searchable patient list, registration, patient profile/timeline, photo upload, notes and encounter/prescription entry.
- Separate, inactive interfaces for billing, WhatsApp correspondence, knowledge, printing, barcode lookup and AI drafting.
- Committed migrations, model/API tests, frontend workflow tests and PostgreSQL-backed CI configuration.

No messaging, AI requests, library-based treatment suggestions, billing or printing are enabled. Photo upload is implemented; browser webcam capture is a future addition.

The interface now uses a laptop workspace with clinic navigation and patient-specific tabs. See [user flows and UX decisions](docs/user-experience.md) for the dashboard, visit workflow, navigation and draft behavior.

## Start with Docker Compose

Install Docker Desktop with Compose v2 and Python 3.11+ to generate the local configuration. From this repository:

```sh
python scripts/init_env.py
docker compose up --build
```

The configuration generator creates ignored `.env` secrets without printing them. Do not commit this file. The example contains no usable keys or passwords.

In another terminal, create the first clinic and its owner:

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

## Checks

See [initial verification results](docs/verification.md) for the checks actually run and the Docker limitation on the verification host.

Without Docker, from the repository root (PostgreSQL 16 installed; the script keeps a private development database in `.tools/`):

```sh
python scripts/dev_db.py test          # backend suite on PostgreSQL, including trigger tests
python scripts/dev_db.py stop          # stop the development database
cd backend && ruff check . && ruff format --check .
cd frontend && npm run lint && npm run format:check && npm test && npm run build
cd frontend && npm run e2e             # browser test: starts its own backend, database and frontend
```

With Docker Compose:

```sh
docker compose exec backend python manage.py test --settings=config.test_settings
docker compose exec -e TEST_DATABASE=postgres backend python manage.py test --settings=config.test_settings
docker compose exec backend python manage.py makemigrations --check --dry-run
docker compose exec frontend npm run build
docker compose exec frontend npm test
```

The first command is a fast SQLite test suite. The second uses real PostgreSQL, including database triggers; the local Compose database user can create the temporary test database. CI uses PostgreSQL and also checks migration drift. SQLite is only a test convenience and is not the application database.

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

| Role | View demographics | Edit demographics/photos | View clinical history | Create notes/encounters | View audit |
| --- | --- | --- | --- | --- | --- |
| Owner | Yes | Yes | Yes | Yes | Yes |
| Clinician | Yes | Yes | Yes | Yes | No |
| Clinical assistant | Yes | Yes | Yes | No | No |
| Reception | Yes | Yes | No | No | No |
| Billing | Yes | No | No | No | No |
| Administrator | Yes | No | No | No | Yes |

Role permissions are centrally defined in `accounts/access.py`; frontend checks only improve usability. The backend remains authoritative. Administrators are not automatically clinicians. Production will need more granular permissions and operator provisioning controls.

## API quick reference

| Endpoint | Methods | Purpose |
| --- | --- | --- |
| `/api/v1/auth/csrf/` | GET | Obtain CSRF token before login |
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
| `/api/v1/audit-events/` | GET | Clinic-scoped audit; owner/admin only; `outcome`, `page` filters |
| `/api/v1/clinic/` | GET, PATCH | Clinic settings; any member reads, owner/admin change |
| `/api/v1/modules/` | GET | Planned module metadata |
| `/health/` | GET | 200 when the database answers, otherwise 503 |

Unsafe requests require `X-CSRFToken` and the session cookie. Login is protected by Django CSRF middleware even for anonymous requests. Django rotates CSRF/session identifiers at login, and the frontend adopts the returned token. Session cookies are HttpOnly and never stored in browser local storage; API responses use `Cache-Control: no-store`. Authentication endpoints return JSON. Requests without a signed-in session return HTTP 401, which the browser treats as "locked"; a signed-in user without permission gets 403. Encounter `internal_notes` is returned only to owner and clinician. These APIs intentionally do not expose deletion of clinical records.

## Before real patient data

Read [the security architecture](docs/security-architecture.md), [the envelope-encryption design](docs/encryption.md) and [the deployment checklist](docs/deployment.md). Current startup accepts only `DJANGO_DEBUG=true` with `DATA_PROTECTION_MODE=development-only`; there is no setting that enables unimplemented encryption. The contracts do not protect fields by themselves. There is no compliance certification or production-readiness claim.

## Next milestones

1. Implement and independently review authenticated envelope encryption for fields and files; key wrapping, rotation, recovery, encrypted backups and restore drills. Remove the production startup guard only after those gates pass.
2. Add MFA, password reset/account recovery, shared throttling cache, stricter provisioning, patient access authorization and granular role controls.
3. Introduce formal encounter finalization/amendments, encrypted demographic revisions, concurrency controls, consent records, document attachments and webcam capture.
4. Add clinic settings, appointments, validated patient import/export and tested backup/restore operations.
5. Implement billing with immutable issued snapshots, document rendering and private delivery.
6. Add consent-aware WhatsApp drafts/approval queues, source-attributed medicine reference revisions, printing and opaque barcode identifiers through the existing interfaces.
7. Consider AI drafting only after provider contracts, data minimization and clinician approval workflows exist.

## Technical references

- [Django 5.2 LTS release notes](https://docs.djangoproject.com/en/5.2/releases/5.2/)
- [Django REST Framework session authentication and CSRF](https://www.django-rest-framework.org/api-guide/authentication/)
- [Vite setup and Node requirements](https://vite.dev/guide/)
