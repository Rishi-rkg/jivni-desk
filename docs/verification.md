# Initial MVP verification

Verified on October 6, 2026 (America/New_York) in a Windows development environment.

| Check | Result |
| --- | --- |
| PostgreSQL 16 migrations | All migrations applied to an empty database |
| Backend suite on PostgreSQL | 32 tests passed, no skips |
| Fast SQLite backend suite | 30 passed; 2 PostgreSQL-only trigger checks skipped as designed |
| Migration drift | No changes detected |
| Django system checks | No issues |
| React/TypeScript build | Passed |
| Frontend tests | 5 passed across 2 files |
| npm dependency audit | 0 known vulnerabilities at verification time |
| Browser smoke test against PostgreSQL | Login, patient registration/address, note entry, encounter with height/weight and prescription, search and logout passed |
| Secret/build-file exclusion | Local `.env`, virtual environment, tooling, database, media, npm cache, dependencies and build outputs ignored |

Docker was not installed on the verification host, so Compose image builds and service startup were not executed here. The PostgreSQL checks used the official portable PostgreSQL server in an isolated loopback-only development instance. The temporary preview and database were stopped after verification. CI is configured to repeat PostgreSQL and frontend checks on a future repository push; no remote repository was created or pushed.

Only synthetic data was used. The screenshot below records the verified timeline, with a fictional patient, address, note and prescription. It is not a treatment recommendation.

![Synthetic patient timeline](screenshots/patient-timeline.jpg)

Envelope encryption remains unimplemented. The production startup guard and the documented deployment gates remain in force. Test success does not establish production readiness or regulatory compliance.

## Laptop UX revision

The subsequent laptop interface revision passed the frontend build and seven frontend tests. Browser verification at 1366 × 768 used synthetic fixtures in a temporary local database and covered the dashboard, patient tabs, preserving a note draft across tabs, the unsaved-navigation warning, saving a note, creating a visit and returning to Visits with confirmation. No backend schema or permission changes were made in this revision.

![Laptop patient workspace](screenshots/laptop-patient.jpg)

See [the UX decisions and flows](user-experience.md). Billing remains an inactive placeholder. Temporary preview servers and fixtures were removed after verification.

## Phase 1 step 1 (2026-10-10)

| Check | Result |
| --- | --- |
| Fast SQLite backend suite | 53 tests: 51 passed, 2 PostgreSQL-only trigger checks skipped |
| Backend suite on PostgreSQL | **Not run.** This PC has neither PostgreSQL nor Docker. The three new migrations only add columns and relax one validator; they do not touch triggers |
| Migration drift, Django system checks | No changes detected; no issues |
| TypeScript build | Passed |
| Frontend tests | 13 passed across 3 files |
| Browser check | Throwaway SQLite database with a synthetic clinic set to Asia/Kolkata, at a moment when the clinic's date was one day ahead of UTC |

The browser check confirmed: a date of birth of the clinic's today was accepted and tomorrow refused; `archived_at` sent in a PATCH was ignored; archive and restore worked and were audited; a session ended on the server produced the lock screen on the next save, a wrong password was refused, the right one unlocked, and the unsaved note was still in the field; the failed unlock appeared in the owner's audit log as a failed sign-in; clinic settings loaded and the audit log listed events with outcome, record and source address. The throwaway database and servers were removed afterwards.

CI has still never run because the repository has no remote.

## Tooling and PostgreSQL (2026-10-11)

| Check | Result |
| --- | --- |
| Backend suite on PostgreSQL 16.15 | 73 passed, none skipped. This is the first PostgreSQL run of migrations `accounts.0003`, `audit.0002` and `records.0003` to `0005`, including the guard triggers on patient codes and demographic history |
| Fast SQLite backend suite | 73 tests: 69 passed, 4 PostgreSQL-only checks skipped |
| Ruff lint and format check | Clean. Migration files are byte-identical to before linting |
| ESLint, Prettier check, TypeScript build | Clean |
| Frontend unit tests | 13 passed |
| Browser end-to-end (Playwright, Chromium, 1366 × 768) | 2 passed against a fresh PostgreSQL database: sign in, register a patient and see the card code, record a visit with a prescription, find it in the audit log, sign out; and a refused wrong password |
| Docker Compose | **Not run.** Docker Desktop 4.94 is installed but has not been started; its first launch and licence acceptance are the owner's |
| CI | **Never run.** The repository has not been published to GitHub. The new lint and end-to-end CI jobs are therefore unverified |

PostgreSQL note: the Windows installer placed the programs in `C:\Program Files\PostgreSQL\16` but its step that creates the database service failed, most likely because the generated superuser password began with a character the installer's script read as an option. No service exists. Development uses a private database in `.tools/pgdata` started by `scripts/dev_db.py`, which needs no service or admin rights.

## Backups and a restore drill (2026-10-11)

| Check | Result |
| --- | --- |
| Backend suite | 130 tests pass on PostgreSQL 16 and on SQLite (4 PostgreSQL-only checks skipped there) |
| Frontend unit tests, lint, format, build | 22 passed; clean |
| Browser end-to-end | 3 passed: the owner adds a backup folder, backs up and runs the read-back check through the real screen; the test confirms the file exists and contains neither the clinic name nor the username |
| Restore drill | **Passed.** The backup made through the browser was restored by `scripts/restore_drill.py` into a newly created PostgreSQL database using the owner password: 1 clinic, 1 user, 1 patient, 1 visit and 29 audit events came back in about one second |

The backup tests cover: backup then restore into an empty installation with identical IDs, patient code, visit text, audit count, photo bytes, passwords and clinic key; refusal to restore over existing data; opening by password, by recovery key and by the session's clinic key; a flipped byte anywhere, a cut-short file and appended data all detected; no readable names, clinical text, photo bytes or keys in the file; backups without anyone signed in; removed staff absent from later backups; copying to several places with per-place failures; schedule and overdue rules; retention that never deletes the newest backup or a file the application did not name; owner-only access.

Not yet done: the drill used synthetic data on the development PC and a staff password. Before going live it must be repeated on the clinic's computer, with the recovery key, on a backup of realistic size. Automatic scheduling inside the app does not exist yet.

## Scan routing (2026-10-11)

108 backend tests pass on PostgreSQL 16; 19 frontend tests pass; the browser end-to-end test now types a patient card code at scanner speed on a page with no field in use and lands on that patient. Not tested with a physical scanner; the 50 ms gap between characters is an assumption to confirm with the clinic's device.

## Encryption key system (2026-10-11)

105 backend tests pass on PostgreSQL 16 and on SQLite (4 PostgreSQL-only checks skipped there); Ruff clean; no migration drift; 13 frontend tests and the 2 browser end-to-end tests pass with a clinic key created by the real sign-up command and unlocked at sign-in with production Argon2id settings.

The 32 new tests cover: a tampered cost setting locking instead of stalling the server; round trips for empty, Unicode and one-megabyte values; rejection of any changed byte, truncation, wrong clinic, wrong record, wrong field, wrong key and missing key version; moving a value to a new clinic key without changing its data ciphertext; password and recovery key opening the same clinic key; a grant copied onto another person's row opening nothing; revoking destroying the sealed copy; password change re-sealing the grant without touching data; a spent recovery key no longer working; the session needing both the cookie and the server half; another user's cookie not unlocking; and the four key-management commands.

**Not done and not claimed:** no patient field or file is encrypted yet, and nobody independent has reviewed this code.

## Phase 2 groundwork (2026-10-10)

Patient codes, scan lookup, reissue, WhatsApp number, duplicate check and demographic history: 70 backend tests, 67 passed and 3 PostgreSQL-only trigger checks skipped; 13 frontend tests passed; TypeScript build passed; no migration drift. The data migration that issues codes to existing patients was run forwards and backwards on a throwaway SQLite database. **Not verified on PostgreSQL:** migration `0005_patient_code_guards` attaches the two existing guard functions to the new tables with the same statement form as migration `0002`, but it had not been executed against PostgreSQL at that time. It passed on 2026-10-11; see above.
