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
