# DocHP build plan

A workspace for a small homeopathy clinic, from a solo practitioner to a team of five: patient records, case notes, prescriptions, dispensing, billing, correspondence, printing and a reference library.

**Status of this document.** Revised 2026-10-10 after a full review of the repository at commit `8db2774`. The owner's original `build_plan.md` attachment could not be read during this revision, so the phase list below was rebuilt from its outline (Django, PostgreSQL, React/TypeScript, envelope encryption, audit log, barcodes, WhatsApp adapter, print agent, knowledge library, seven phases) and from the code. Reconcile against the original when it is available and delete this paragraph.

## 1. Where the project stands

Two commits exist, both from 2026-10-06. The fast backend suite was re-run on 2026-10-10: 32 tests, 30 passed and 2 PostgreSQL-only trigger tests skipped as designed.

| Area | State |
| --- | --- |
| Login, sessions, CSRF, clinic membership, six seeded roles | Built and tested |
| Patient registry, address, photo upload | Built and tested |
| Visits with height/weight and prescriptions saved in one transaction | Built and tested |
| Append-only notes with amendments | Built and tested |
| Audit events for reads, writes and login | Built, with gaps listed in section 2 |
| Append-only and identity guards as PostgreSQL triggers | Built and tested on PostgreSQL |
| Laptop workspace UI with patient tabs and unsaved-change warnings | Built and tested |
| Envelope encryption | Interfaces only; startup refuses anything except development mode |
| Billing, WhatsApp, knowledge library, printing, barcodes, AI drafting | Protocol stubs in `backend/modules/contracts.py`; nothing implemented |
| Appointments, patient editing UI, user management UI, backups, deployment | Not started |
| Docker Compose | Written but never run; the verification host had no Docker |
| Git remote | None. The only copy of the project is this folder |

## 2. Review findings to fix before building more

These come from reading the code, not from the earlier documents. Each is small now and expensive later.

**Safety of the project itself**

1. **The repository has no remote and sits inside a tool-managed mirror folder.** `../AGENTS.md` states that the surrounding directory "may be replaced the next time a task is created". Local commits protect against bad edits, not against the folder being replaced or the disk failing. Add a private remote and consider moving the repository to an ordinary folder such as `C:\Projects\clinic-management`.

**Correctness**

2. **Dates are judged in UTC.** `TIME_ZONE = "UTC"` in `backend/config/settings.py` and `not_future` in `backend/records/models.py` use the UTC date. A clinic east of UTC cannot enter today's date as a date of birth during its early morning, and follow-up dates are compared against the UTC date of the visit. Add a clinic time zone and use it for every "today" decision.
3. **`archived_at` is a client-writable field.** `PatientSerializer` accepts any timestamp from any role that can edit demographics, including reception, and the same request can un-archive. Replace it with explicit archive and restore actions limited to owner and clinician, stamped by the server and audited under their own action names.
4. **Demographic history is lost.** A PATCH overwrites fields, and sending `address: null` hard-deletes the address row. The audit log records that a change happened but not what changed. Add a demographic revision table before real data is entered.
5. **A saved visit can never be corrected.** Visits are append-only from the first save, there is no draft state, and only notes support amendments. One typo in a potency is permanent. Add draft, finalise and amend states (Phase 3).
6. **`internal_notes` is shown to every clinical reader**, including assistants. Decide who may read it and enforce that in the serializer.

**Security and audit**

7. **Failed logins are invisible to the clinic.** They are stored with `clinic = NULL`, and the audit endpoint filters by clinic, so no owner can ever see them. A valid password with no active membership is not recorded at all.
8. **Login throttling is per process and not atomic.** It uses the default in-memory cache with a read-then-write counter, keyed on `REMOTE_ADDR`, which will be the proxy address once deployed.
9. **Audit events carry no outcome, source address or request ID, and denied access is not recorded.** Every list call writes a row, so the table grows quickly; plan retention and off-host export.
10. **Sessions last eight hours with no idle lock.** A shared reception PC needs a short idle lock with quick re-entry.

**Design gaps that block later phases**

11. **Search will not survive encryption.** Patient search is `icontains` over plaintext columns. The search design must be settled before any field is encrypted (Phase 2).
12. **No human-friendly patient number.** The UI shows a 36-character UUID. Staff need a short per-clinic number for phone calls, cards, invoices and barcodes.
13. **No duplicate-patient check** at registration.
14. **`/health/` does not check the database**, so it cannot be used for deployment health checks.

**Tooling**

15. **No linting, formatting or type checking** for either side, and no browser end-to-end tests. Frontend components are written as very long single lines, which makes diffs hard to review.
16. **Python versions differ**: the local virtual environment is 3.11, Docker and CI use 3.12.
17. **CI has never run** because nothing has been pushed.

## 3. Decisions the owner needs to make

Each has a recommended default so work is not blocked. Changing one later is possible but costs rework in the phase noted.

| # | Decision | Recommended default | Affects |
| --- | --- | --- | --- |
| D1 | Country and applicable privacy, medical-records and tax rules | None assumed. Needed before Phase 2 exit and Phase 5 | Consent, retention, invoice format, tax, WhatsApp rules |
| D2 | Where it runs: a PC inside the clinic, or a hosted server | Hosted server with a managed database, because backups and remote access come almost free | Phase 2 entirely, print agent, outage behaviour |
| D3 | Who holds the encryption key: the server, or unlocked by a user's password | Server-held key in a key service, with an offline recovery key kept by the owner. Password-unlock prevents unattended jobs such as reminders and backups | Phase 2, Phase 6 |
| D4 | One clinic per installation, or many clinics on one server | Keep the multi-clinic data model already built, deploy one clinic per installation at first | Isolation testing, pricing, operations |
| D5 | Does the clinic dispense its own medicines | Assume yes; it is common in homeopathy and drives labels, stock and billing lines | Phases 4 and 5 |
| D6 | WhatsApp route: staff sends from the clinic phone, or automated sending through the official Business Platform | Start with staff-sent drafts, automate later | Phase 6 cost and consent |
| D7 | Languages for the interface, printouts and messages | English first, with all user-facing text kept translatable | Every screen and template |
| D8 | Existing records to bring in: paper, spreadsheet or another program | Plan a spreadsheet import in Phase 3 | Phase 3, go-live date |

## 4. Rules that hold in every phase

These already exist in the code and must not be weakened.

- A modular monolith. Each Django app owns its tables. Other modules call it through the interfaces in `modules/contracts.py`, passing IDs and explicit data objects.
- Every query is scoped to the active clinic membership. The backend decides permissions; the frontend only hides what would be refused.
- Clinical records and audit events are append-only, enforced by PostgreSQL triggers as well as model code. Corrections are new records that point at the old one.
- Patient UUIDs never change and are never used as proof of permission.
- Anything issued to a patient, such as a prescription, invoice, label or message, stores a snapshot of what was issued. Later edits to a catalogue or template never rewrite history.
- External effects such as printing, WhatsApp and AI never run inside a patient-record transaction. They go through a durable outbox with an idempotency key and are retried by a worker.
- No patient data in browser storage, URLs, logs, audit text or file names.
- The application fails closed. No setting may claim protection that is not implemented.
- Applied migrations are never rewritten. Breaking API changes need a new API version.
- Synthetic data only until the Phase 2 exit criteria are met.

## 5. Phases

There are seven phases. Each lists what it delivers, what it deliberately leaves out, and the checks that end it. The order differs from the README's earlier milestone list in three ways: daily clinical workflow comes before the add-on modules, the medicine catalogue moves forward because it speeds up every prescription, and printing starts with ordinary browser printing so the print agent is only built where it is truly needed.

### Phase 1: Records foundation (built; close-out remaining)

Delivered: everything in the "Built and tested" rows of section 1.

Close-out work:

- Fix findings 2, 3, 6, 7, 14 and 16.
- Add Ruff for the backend, ESLint and Prettier for the frontend, and reformat the frontend once in a single commit.
- Push to a private remote, get CI green, run Docker Compose end to end on a machine that has Docker.
- Add one Playwright smoke test: sign in, register a patient, record a visit, sign out.

Exit: CI green on the remote, Compose verified, findings above closed with tests.

### Phase 2: Safe for real patient data

Goal: a real clinic can enter real records without the project relying on luck.

- **Threat model first**, one page, agreed with the owner: who the attackers are (lost laptop, stolen backup, curious staff, compromised server) and what stays readable.
- **Envelope encryption** as designed in `docs/encryption.md`: AES-256-GCM, a data key per record or file, clinic key held outside the database, associated data binding ciphertext to clinic, record and field. Covers names, date of birth, contact details, address, all clinical text, observations, prescriptions and photos.
- **Search over encrypted data.** Recommended approach for a clinic of this size: exact-match keyed hashes for phone and patient number, plus a per-clinic name index decrypted into server memory for authorised sessions. This leaks less than prefix hashes and is simple at tens of thousands of patients. Document what an attacker with the database alone could learn.
- **Key lifecycle**: rotation without re-encrypting payloads, an offline recovery key with a written procedure, and a stated consequence if both are lost.
- **Backups**: nightly encrypted backup of database and files together, kept off the machine, with a restore drill that is actually performed and timed.
- **Accounts**: second factor for owner and clinicians, password reset, idle lock, session revocation, a user-management screen for the owner, shared-cache login throttling (finding 8).
- **Audit**: outcome, source address and request ID on every event, denied access recorded, demographic revisions (finding 4), scheduled off-host export, retention policy (finding 9).
- **Deployment**: HTTPS reverse proxy, Gunicorn, separate database identities for migrations and runtime, a deliberate migration release step, and error reporting that never includes request bodies.
- **Independent review** of the encryption and key handling by someone who did not write it.

Left out: any new clinical feature.

Exit: every item in "Tests required to remove the startup guard" in `docs/encryption.md` passes, a restore drill has succeeded, the reviewer's findings are closed, and D1 has been answered with the resulting obligations written down. Only then is the startup guard replaced by real provider checks.

Phases 2 and 3 can proceed side by side, with Phase 3 on synthetic data. Real data waits for the Phase 2 exit.

### Phase 3: The daily clinic workflow

Goal: the clinician prefers this to paper for a full working day.

- **Homeopathic case-taking.** Structured sections for the presenting complaint, mentals, physical generals, particulars with modalities, past and family history, and a follow-up form that records the response to the previous prescription. Free text stays available in every section.
- **Draft, finalise, amend** for visits (finding 5), with drafts stored on the server under the same protection as records.
- **Medicine catalogue**: remedy name, abbreviation, potency scales (X, C, M, LM, Q), form and common dosing phrases, used for prescription autocomplete and saved phrases. Prescriptions still store snapshots.
- **Patient number** per clinic (finding 12), **duplicate check** at registration (finding 13), a **demographics editing** screen, and explicit archive and restore.
- **Appointments and a walk-in queue**, with a "follow-ups due" list driven by the follow-up date already captured.
- **Consent records** for treatment, for messaging and for photos, each with date, wording version and who recorded it.
- **Attachments** such as lab reports, plus webcam capture for photos, through the same protected store as photos.
- **More observations**: pulse, blood pressure, temperature, with units.
- **Import** of existing patients from a spreadsheet, with a dry run and an error report (D8).
- **Keyboard-first entry** tested with clinic staff on the 1366 × 768 laptop target.

Left out: money, messaging, labels.

Exit: one clinician completes a full day of synthetic consultations without leaving the application, and the staff test session produces no blocking problems.

### Phase 4: Dispensing, barcodes and printing

Goal: what is prescribed is what is handed over, and paper leaves the clinic correctly.

- **Outbox and worker** for external effects, built once here and reused by Phases 5 to 7.
- **Document rendering** to PDF from versioned templates: prescription, patient card, medicine label.
- **Printing, step one**: ordinary browser printing of the rendered PDF. This needs no installed software and covers A4 and A5 prescriptions.
- **Printing, step two, the print agent**: a small program on the reception PC, needed only for label printers and one-click printing. It makes outbound connections only, is paired to the clinic with a revocable device token, pulls finished print files rather than patient data, and reports each job's result exactly once.
- **Barcodes**: opaque random codes that mean nothing without the database, never a UUID, name or patient number. They resolve only for a signed-in user of the same clinic, every scan is audited, and a lost card can be revoked and reissued. Use Code 128 on labels and QR on cards. Scanners act as keyboards, so the application needs a single global scan handler.
- **Dispensing record** (D5): what was handed over against which prescription item, by whom, with a printed label. Simple stock counts for remedies and potencies.

Left out: pricing.

Exit: a prescription can be printed from any clinic PC, a label prints through the agent, scanning a card opens the right patient, and a revoked card opens nothing.

### Phase 5: Billing

Goal: every visit and every dispensed item can be charged, collected and reported.

- A price list for consultation types and medicines, and an invoice drafted from a finalised visit without choosing the patient again.
- Issued invoices are immutable snapshots with gapless numbering per clinic and financial year. Corrections are credit notes, never edits.
- Payments are recorded, not processed: cash, card, bank transfer or local instant payment, including part payments and balances.
- Receipts printed and available as PDF, a day-end collection report, an outstanding-balances list, and export for the accountant.
- Tax handling is configuration driven by D1.
- The billing role sees invoices and demographics but still no clinical text.

Left out: online payment collection and insurance claims.

Exit: a month of synthetic invoices reconciles to the day-end reports to the last unit of currency, and an issued invoice cannot be altered through the API or by direct SQL.

### Phase 6: Correspondence through WhatsApp

Goal: reminders and notices reach patients without exposing clinical details and without risking the clinic's number.

- **Consent first**: nothing is sent to a patient without a recorded messaging opt-in, and opt-out is honoured immediately.
- **Step one, staff-sent drafts**: the application prepares approved wording and opens it in WhatsApp on the clinic's own device for a person to send. No provider account, no cost, full human control.
- **Step two, automated sending** through the official WhatsApp Business Platform behind the `Correspondence` interface: pre-approved templates, outbox delivery with idempotency keys, verified webhooks for delivery status, and a clinician approval queue for anything that is not a fixed template. Unofficial automation libraries are excluded because they get numbers banned.
- **Content rules**: appointment reminders, follow-up due, medicine ready, receipt available. No diagnosis, remedy or symptom text in any message. Documents are not sent as open links.
- Inbound replies are stored against the patient as correspondence and shown to staff. Nothing is parsed or acted on automatically.

Left out: marketing broadcasts and chatbots.

Exit: a reminder sent to a test number is recorded once, a repeated job sends nothing twice, an opted-out patient receives nothing, and a forged webhook is rejected.

### Phase 7: Knowledge library, then AI drafting

Goal: reference material at the point of prescribing, and optional drafting help that the clinician fully controls.

- **Library**: materia medica and repertory entries linked to the Phase 3 catalogue, searchable from the prescription screen. Only public-domain or properly licensed sources, each entry carrying its source and revision. Clinic-authored notes on remedies are kept separate from source text.
- The library informs; it never writes a prescription. A reference opened during a visit may be recorded as consulted.
- **AI drafting, only if the owner wants it**: off by default per clinic, limited to drafting text the clinician asked for, such as a visit summary or a patient letter. It sends the minimum data needed, only to a provider with a suitable data agreement, shows exactly what will be sent, and saves nothing without clinician approval. Every request is audited. It gives no remedy recommendations.

Exit: library search answers within a second on the clinic laptop, every entry shows its source, and with AI switched off no request leaves the server.

## 6. How work is checked

- Every change ships with tests. Permission and clinic-isolation tests are required for every new endpoint.
- Both backend suites run in CI: fast SQLite and full PostgreSQL. Migration drift is checked on every push.
- Each phase adds browser end-to-end tests for its main flows.
- A phase is finished when its exit checks pass and `README.md`, `AGENTS.md`, this plan and `docs/verification.md` describe the result.
- Commit small and often, push after every working session.

## 7. Main risks

| Risk | Response |
| --- | --- |
| The project folder is lost before a remote exists | Finding 1; do this first |
| Encryption is built but subtly wrong | Independent review and the test list in `docs/encryption.md` are exit conditions, not suggestions |
| Encryption key is lost | Offline recovery key and a rehearsed restore in Phase 2 |
| Real data entered too early | Startup guard stays until the Phase 2 exit; development banner stays in the UI |
| Legal obligations discovered late | D1 answered before the Phase 2 exit, with qualified advice |
| Scope grows faster than a small team can test | Seven phases with stated "left out" lists; add-on modules stay behind interfaces |
| WhatsApp number banned or costs rise | Staff-sent drafts first; official platform only |
| Copyrighted reference texts | Public-domain or licensed sources only, with attribution |
| Clinic loses internet (if hosted) | Decide acceptable downtime under D2; provide a printable day sheet as fallback |
