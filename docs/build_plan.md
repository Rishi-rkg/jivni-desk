# DocHP build plan

A browser-based clinic operating system for a homeopathy practice, from a solo practitioner to a team of five. Patient records are the stable core; billing, messaging, printing, barcode lookup and the homeopathy knowledge library are separate modules around it.

> The database represents the clinic's facts. The UI is only one way of viewing and editing those facts.

**How to read this.** This is the working plan, revised 2026-10-10 after a full review of the repository at commit `8db2774`. The owner's initial plan is kept unchanged in [build_plan_original.md](build_plan_original.md) and remains the reference for the product vision, data sketches, screen mock-ups and engineering principles (its sections 1 to 26, 28 and 29). This document replaces its sections 27, 30 and 31: what is built, what is wrong, what to decide, and the order of work. Section 9 lists every place this plan departs from the original and why.

## 1. Where the project stands

The first two code commits are from 2026-10-06. Work on this plan started on 2026-10-10 with Phase 1 step 1; findings marked *Fixed* in section 2 are done and tested. Current checks: 72 backend tests (69 pass on SQLite, 3 PostgreSQL-only trigger tests skipped because this PC has no PostgreSQL) and 13 frontend tests.

**The build did not follow the original phase order.** It skipped most of Phase 1 (encryption, key handling, backups, restore, clinic settings) and went straight to parts of Phases 2 and 3. That is why the application refuses to start outside development mode. The first job is to go back and finish the foundation.

| Original phase | Built | Missing |
| --- | --- | --- |
| 1 Foundation | Login, sessions, six roles, clinic membership, audit events with outcome and source, PostgreSQL schema with append-only triggers, clinic settings, idle lock, audit log screen | Encryption and key handling, recovery key, backup, restore, second factor, password reset, user management screen |
| 2 Patient MVP | Registration, search, profile, photo upload, notes, timeline, `PatientIdentifier` codes with scan lookup and reissue, `whatsapp_number`, duplicate check and demographic history (API only) | Webcam capture, printed barcode card, screens for editing demographics, duplicate warning and history, spreadsheet import |
| 3 Clinical records | Visits with complaint, symptoms, history, assessment, internal notes, follow-up date, height and weight, prescriptions with snapshots, prescription history | Structured symptoms, `medicine_id` link and `doctor_notes` on prescription items, attachments, prescription PDF, any way to correct a saved visit |
| 4 Billing and printing | Interface stubs only | Everything |
| 5 Appointments and correspondence | Interface stub only | Everything |
| 6 Knowledge library | Interface stub only | Everything |
| 7 AI features | Interface stub only | Everything |

Also: Docker Compose and CI are written but have never run, and the repository has no remote.

## 2. Review findings to fix before building more

These come from reading the code. Each is small now and expensive later.

**Safety of the project itself**

1. **The repository has no remote and sits inside a tool-managed mirror folder.** `../AGENTS.md` states that the surrounding directory "may be replaced the next time a task is created". Local commits protect against bad edits, not against the folder being replaced or the disk failing. Add a private remote and consider moving the repository to an ordinary folder such as `C:\Projects\clinic-management`.

**Correctness**

2. **Dates are judged in UTC.** `TIME_ZONE = "UTC"` in `backend/config/settings.py` and `not_future` in `backend/records/models.py` use the UTC date. A clinic east of UTC cannot enter today's date as a date of birth during its early morning, and follow-up dates are compared against the UTC date of the visit. Add a clinic time zone to clinic settings and use it for every "today" decision. *Fixed 2026-10-10.* `Clinic.time_zone`, `Clinic.today()`.
3. **`archived_at` is a client-writable field.** `PatientSerializer` accepts any timestamp from any role that can edit demographics, including reception, and the same request can un-archive. Replace it with explicit archive and restore actions limited to owner and clinician, stamped by the server and audited under their own action names. *Fixed 2026-10-10.*
4. **Demographic history is lost.** A PATCH overwrites fields, and sending `address: null` hard-deletes the address row. The audit log records that a change happened but not what changed. This breaks the original principle that historical records stay historical. *Fixed 2026-10-10 in the API:* every edit writes a `PatientRevision` with old and new values in the same transaction. A screen to view it is still to come.
5. **A saved visit can never be corrected.** Visits are append-only from the first save, there is no draft state, and only notes support amendments. One typo in a potency is permanent.
6. **`internal_notes` is shown to every clinical reader**, including assistants. The original plan calls these doctor-only notes. *Fixed 2026-10-10.* Returned only to owner and clinician.

**Security and audit**

7. **Failed logins are invisible to the clinic.** They are stored with `clinic = NULL`, and the audit endpoint filters by clinic, so no owner can ever see them. A valid password with no active membership is not recorded at all. *Fixed 2026-10-10.* Both are recorded against the account's clinics and shown in the audit log screen.
8. **Login throttling is per process and not atomic.** It uses the default in-memory cache with a read-then-write counter, keyed on `REMOTE_ADDR`, which will be the proxy address once deployed.
9. **Audit events carry no outcome, source address or request ID, and denied access is not recorded.** Every list call writes a row, so the table grows quickly; plan retention and off-host export. *Partly fixed 2026-10-10:* outcome, source address, request ID and denied access are recorded. Retention and export remain.
10. **Sessions last eight hours with no idle lock.** A shared reception PC needs a short idle lock with quick re-entry. *Fixed 2026-10-10.* 15 minutes by default (`SESSION_IDLE_SECONDS`); the lock screen keeps unsaved work.

**Design gaps that block later phases**

11. **Search will not survive encryption.** Patient search is `icontains` over plaintext columns. The search design must be settled before any field is encrypted.
12. **No short patient identifier.** The UI shows a 36-character UUID. The original plan's `PatientIdentifier` (for example `PAT-W8KQ3G7DP9`) is not built, and barcodes depend on it. *Fixed 2026-10-10:* codes are issued at registration, shown in the list and banner, searchable, resolvable by scan and reissuable.
13. **No duplicate-patient check** at registration. *Fixed 2026-10-10 in the API* (`check-duplicates`); the registration screen does not call it yet. Phone numbers match only when written identically.
14. **`/health/` does not check the database**, so it cannot be used for deployment health checks. *Fixed 2026-10-10.*

**Tooling**

15. **No linting, formatting or type checking** for either side, and no browser end-to-end tests. Frontend components are written as very long single lines, which makes diffs hard to review.
16. **Python versions differ**: the local virtual environment is 3.11, Docker and CI use 3.12. *Addressed 2026-10-10:* CI now tests both.
17. **CI has never run** because nothing has been pushed.

## 3. Decisions

### Made by the owner on 2026-10-11

- **The clinic is in India** (answers D1). Working defaults: time zone `Asia/Kolkata`, currency INR, financial year 1 April to 31 March for invoice numbering, UPI among the payment methods. Legal points to confirm with a qualified adviser and the clinic's accountant before real data and before billing: obligations under the Digital Personal Data Protection Act 2023 and its rules (notice, consent, breach reporting, patient requests), how long patient records must be kept, the practitioner's registration details on printed documents, and GST treatment of consultation, of medicines the doctor dispenses, and of shelf products sold.
- **Medicine names are hidden from the patient.** Labels and bills show dosage instructions only, for example "twice, 4 tabs before meals". The remedy and potency stay in the clinical record.
- **The medication label** carries the clinic logo, clinic address, patient name, dosage instructions, the patient's barcode, the date and the next advised date. It is pasted on an envelope, not a bottle, and is printed on the 2 × 2 inch black-and-white thermal printer.
- **Billing lines.** Medicines the doctor prescribes are made and mixed by the doctor and billed as one single item. Over-the-shelf medicines, consumables and supplements are sold as separate line items. Shelf products appear only on the bill, never on a label.
- **The visit page records more than the complaint.** Alongside the complaint and clinical notes, the doctor keeps personal notes that help remember the patient and build a relationship, such as a hobby, a family member or a story. The page also covers medicines prescribed, medicine search and dosage units.
- **Navigation** is up to eight flat tabs, fewer for roles with less access, with no nested menu. The screen list and mockups live in `mockups/` (`mockups/ui-inventory.md`).

### Still open

Each has a default so work is not blocked.

| # | Decision | Default until answered | Affects |
| --- | --- | --- | --- |
| D1 | ~~Country~~ India, decided. The legal points listed above still need professional confirmation | Follow the working defaults above | Consent, retention, invoice format, tax, WhatsApp rules |
| D2 | Where it runs: a PC inside the clinic, or a hosted server | Hosted server with a managed database, because backups and remote access come almost free | Phase 1 deployment, print agent, outage behaviour |
| D3 | How unattended work reads patient data (see below) | Password-unlocked clinic key as the original plan specifies, plus a narrow messaging key | Phase 1, Phase 5 |
| D4 | One clinic per installation, or many clinics on one server | Keep the multi-clinic data model already built; deploy one clinic per installation at first | Isolation testing, operations |
| D5 | The clinic dispenses its own medicines and sells shelf products (decided). Still open: does it need stock counts now | No stock control yet; a product list with prices is enough for billing | Phase 4 scope |
| D6 | WhatsApp route for the first release | Staff-sent drafts first, automated sending through the official Business Platform second | Phase 5 cost and consent |
| D7 | Languages for the interface, printouts and messages | English first, with all user-facing text kept translatable | Every screen and template |
| D8 | Existing records to bring in: paper, spreadsheet or another program | A spreadsheet import with a dry run | Phase 2, go-live date |
| D9 | Which reference texts go into the knowledge library | Public-domain texts and the clinic's own notes only | Phase 6 |

**D3 in detail.** The original plan unlocks the clinic key from a user's password. That is a strong design, and it has one consequence the original does not address: when nobody is signed in, the server cannot read any patient data. Birthday greetings, 30-day check-ins and appointment reminders cannot be prepared overnight. Two ways to resolve it, which can be combined:

- **Prepare on sign-in.** Rule-driven messages are generated when an authorised user signs in and wait in the approval queue. This fits the original "waiting for doctor approval" flow and needs no extra key.
- **A narrow messaging key.** For messages that must go out unattended, such as "your appointment is tomorrow at 3:00 PM", keep a second key that the server can use at any time and that protects only first name, WhatsApp number and appointment time. A stolen server then exposes a contact list, not clinical records.

Backups are unaffected: they copy ciphertext and never need the key.

## 4. Rules that hold in every phase

The engineering principles in section 28 of the original plan all stand. The rules below are how the code already enforces them, and must not be weakened.

- A modular monolith. Each Django app owns its tables. Other modules call it through the interfaces in `backend/modules/contracts.py`, passing IDs and explicit data objects.
- Every query is scoped to the active clinic membership. The backend decides permissions; the frontend only hides what would be refused.
- Clinical records and audit events are append-only, enforced by PostgreSQL triggers as well as model code. Corrections are new records that point at the old one.
- Record IDs are UUIDv4, never change, and are never proof of permission. Short patient identifiers are a separate, reissuable record.
- Anything issued to a patient, such as a prescription, invoice, label or message, stores a snapshot of what was issued. Later edits to a catalogue or template never rewrite history.
- External effects such as printing, WhatsApp and AI never run inside a patient-record transaction. They go through a durable outbox with an idempotency key and are retried by a worker.
- No patient data in browser storage, URLs, logs, audit text or file names.
- The application fails closed. No setting may claim protection that is not implemented.
- Applied migrations are never rewritten. The API is REST under `/api/v1/`; breaking changes need a new version.
- Synthetic data only until the Phase 1 exit checks pass.

## 5. Phases

The seven phases keep the original's numbering and intent. Each lists the remaining work, what it leaves out, and the checks that end it.

### Phase 1: Foundation (partly built)

Step 1, housekeeping, about a week of small changes:

- Push to a private remote, get CI green, run Docker Compose once on a machine that has Docker.
- ~~Fix findings 2, 3, 6, 7, 14 and 16.~~ Done 2026-10-10, together with finding 10 and most of finding 9.
- Add Ruff for the backend, ESLint and Prettier for the frontend; reformat the frontend once in a single commit.
- Add one Playwright smoke test: sign in, register a patient, record a visit, sign out.

Step 2, the missing foundation:

- **Threat model**, one page, agreed with the owner: lost laptop, stolen backup, curious staff, compromised server, and what each can read.
- **Envelope encryption** as the original sections 10 and 11 and `docs/encryption.md` describe: AES-256-GCM, a data key per record or file, a clinic master key wrapped separately for each authorised user through Argon2id, and associated data binding every ciphertext to its clinic, record and field. Covers names, date of birth, contact details, address, all clinical text, observations, prescriptions and photos.
- **Recovery key** shown once at clinic setup, with a written and rehearsed recovery procedure and a plain statement of what is lost if both passwords and the recovery key are gone.
- **Search over encrypted data** (finding 11). Recommended for a clinic of this size: keyed hashes for exact matches on phone and patient identifier, plus a per-clinic name index decrypted into server memory only while a user has the clinic unlocked. Write down what someone holding only the database could learn.
- **Key lifecycle**: password change rewraps one grant, removing a user revokes their grant, rotation works without re-encrypting every record.
- **Backups**: nightly encrypted backup of database and files together, kept off the machine, with a restore drill that is performed and timed.
- **Accounts**: second factor for owner and clinicians, password reset that respects key grants, idle lock, session revocation, shared-cache login throttling (finding 8), and a user-management screen for the owner.
- **Audit**: outcome, source address and request ID on every event, denied access recorded, scheduled off-host export, retention policy (finding 9).
- **Clinic settings**: name, address, tax identifier, time zone, currency, logo. Later snapshots on invoices and labels read from here. *Built 2026-10-10 except the logo.*
- **Deployment**: HTTPS reverse proxy, Gunicorn, separate database identities for migrations and runtime, a deliberate migration release step, error reporting without request bodies.
- **Independent review** of the encryption and key handling by someone who did not write it.

Exit: every item in "Tests required to remove the startup guard" in `docs/encryption.md` passes, a restore drill has succeeded, the reviewer's findings are closed, and D1 is answered with the resulting obligations written down. Only then is the startup guard replaced by real provider checks.

Phases 2 and 3 may proceed alongside step 2 on synthetic data. Real data waits for this exit.

### Phase 2: Patient MVP (mostly built)

- ~~**Patient identifier** (`PatientIdentifier`, finding 12): a short opaque random code per patient, shown in the banner in place of the UUID and reissuable if a card is lost.~~ Built 2026-10-10.
- **Barcode generation and lookup** (lookup endpoint built 2026-10-10; card printing and the global scan handler remain): the identifier printed as Code 128 or QR on a patient card. Scanners act as keyboards, so the application has one global scan handler. A code resolves only for a signed-in user of the same clinic, every scan is audited, and a revoked code opens nothing. The card is printed with ordinary browser printing; no agent is needed yet.
- **Webcam capture** with crop and resize, through the existing protected photo store.
- **Demographics editing screen** with a revision record for every change (finding 4), explicit archive and restore, and a duplicate check at registration (finding 13).
- ~~**`whatsapp_number`** as its own field, separate from phone.~~ Built 2026-10-10.
- **Import** of existing patients from a spreadsheet, with a dry run and an error report (D8).

Left out: appointments, money, messaging.

Exit: staff can register, find by name, phone or scan, open and update patient records, and every change to demographics can be traced.

### Phase 3: Clinical records (mostly built)

- **Draft, finalise, amend** for visits (finding 5). Drafts are stored on the server under the same protection as records. A finalised visit is immutable; an amendment is a new record that points at it.
- **Homeopathic case-taking.** Sections for the presenting complaint, mentals, physical generals, particulars with modalities, past and family history, and a follow-up form that records the response to the previous prescription. Free text stays available in every section.
- **Structured symptoms** (`Symptom`, `EncounterSymptom`) alongside free text, so later phases can search and link to rubrics.
- **Medicine catalogue, minimal**: the `Medicine` and `MedicineAlias` tables with name, abbreviation and potency scales, used for prescription autocomplete and the `medicine_id` link. Prescriptions still store the snapshot. The full library stays in Phase 6.
- **Personal notes about the patient**: a doctor-only place, visible while taking the visit, for what helps the doctor remember the person, kept apart from clinical notes so it is never mistaken for history or printed.
- **Dosage instructions as their own field** on each prescription, written for the patient ("twice, 4 tabs before meals") with dosage units, because this is the only prescription text that leaves the clinic.
- **`doctor_notes`** on prescription items, and doctor-only visibility for internal notes (finding 6).
- **More observations**: pulse, blood pressure, temperature, with units.
- **Attachments** such as lab reports, through the protected store.
- ~~**Prescription PDF**~~ Dropped as a patient document: medicine names are not given to the patient. An internal visit summary for the clinic's own file can be added if the doctor wants one.
- **Follow-ups due** list driven by the follow-up date already captured.
- **Keyboard-first entry** tested with clinic staff on the 1366 × 768 laptop target.

Left out: money, messaging, label printers.

Exit: the doctor completes a full day of synthetic consultations without leaving the application, and the staff test session produces no blocking problems.

### Phase 4: Billing and printing

- **Job queue and outbox**, built once here and reused by Phases 5 to 7.
- **Billing data**: invoice drafted from a finalised visit without choosing the patient again. The doctor's dispensed medicines are one line with no remedy names. Shelf medicines, consumables and supplements come from a product list with prices and are separate lines. Discounts, and tax from clinic settings once the GST treatment is confirmed.
- **Invoice lifecycle** exactly as the original section 19: draft, issued, partially paid, paid, void, refunded. Issued invoices are immutable snapshots with gapless numbering per clinic and financial year. Corrections are credit notes, never edits.
- **Payments** are recorded, not processed: cash, card, bank transfer or local instant payment, including part payments.
- **Templates separate from data**: invoice, prescription and label templates are versioned, and each issued document records which version rendered it.
- **A4 printing** through the browser from the rendered PDF.
- **Label printing through the print agent**, with one change from the original design. The original has the browser call the agent on `localhost`. Browsers increasingly block a secure page from calling a local address, and any other website open on that PC could call the same port. Instead, the agent connects outward to the server, is paired to the clinic with a revocable device token, pulls finished print files rather than patient data, and reports each job's result once. The clinic's printer is a 2 × 2 inch (about 51 × 51 mm) black-and-white thermal label printer, so that is the first and required label format; design labels in pure black and white with no greys. Label content is fixed by the owner's decision in section 3: logo, clinic address, patient name, dosage instructions, patient barcode, date and next advised date, and never a medicine name. A clinic logo upload is therefore needed in clinic settings before labels.
- **Reports**: day-end collections, outstanding balances, export for the accountant.
- The billing role sees invoices and demographics but no clinical text.

Left out: online payment collection, insurance claims, inventory (D5).

Exit: a month of synthetic invoices reconciles to the day-end reports to the last unit of currency, an issued invoice cannot be altered through the API or by direct SQL, and a medication label prints from a prescription on a real label printer.

### Phase 5: Appointments and correspondence

- **Appointments and a walk-in queue**, with the dashboard counts from the original section 23 now backed by real data.
- **Consent first** (`PatientCommunicationConsent`): separate opt-ins for care messages and for promotional messages, each with date, wording version and who recorded it. Opt-out is honoured immediately.
- **Messaging engine behind the `Correspondence` adapter**, so WhatsApp stays one provider among possible others.
- **Templates and triggers** as the original sections 15 and 16. Triggers create drafts in an approval queue; nothing rule-driven is sent without approval at first.
- **Step one, staff-sent drafts**: approved wording is opened in WhatsApp on the clinic's own device for a person to send. No provider account and no per-message cost.
- **Step two, automated sending** through the official WhatsApp Business Platform: pre-approved templates, outbox delivery with idempotency keys, verified webhooks for delivery status. Unofficial automation libraries are excluded because they get numbers banned.
- **Content rules**: no diagnosis, remedy or symptom text in any message, and documents are not sent as open links.
- **Unattended sending** only for fixed transactional templates, using the narrow messaging key from D3.
- **Greetings, newsletters and campaigns come last** in this phase. They need the promotional consent, cost money per message on the official platform, and carry the highest risk of complaints.
- Inbound replies are stored against the patient and shown to staff. Nothing is parsed or acted on automatically.

Exit: a reminder to a test number is recorded once, a repeated job sends nothing twice, an opted-out patient receives nothing, a forged webhook is rejected, and the delivery history is visible on the patient timeline.

### Phase 6: Homeopathy knowledge library

- The full model from the original sections 7 to 9: medicines, aliases, relationships, symptoms and rubrics, knowledge entries, citations, annotations and version history, built on the Phase 3 catalogue.
- **Sources**: public-domain or properly licensed texts only (D9). Every entry carries its source metadata, and conflicting claims from different sources are shown side by side, never merged.
- **Search by several symptoms with an explainable result.** The original mock-up shows "Match: 87%". Show instead which rubrics matched, how many, and from which sources, so the doctor can see why a medicine is listed. A bare percentage suggests a certainty the data does not have.
- Doctor annotations and edits are separate versions layered over the source text.
- The library informs; it never writes a prescription. A reference opened during a visit may be recorded as consulted.
- An **import workflow** with a dry run, since most of the content will arrive in bulk.

Exit: search answers within a second on the clinic laptop, every result shows its sources, and an annotation never changes the imported text.

### Phase 7: AI features

- Off by default per clinic, and only if the owner wants it.
- Drafting and summarising only, as the original section 17: correspondence drafts, visit summaries, history summaries before a consultation, candidate structured symptoms for the doctor to accept or reject.
- Every output is presented with Edit, Approve and Discard. Nothing is saved or sent without approval.
- The minimum data needed is sent, only to a provider with a suitable data agreement, and the user can see exactly what will be sent. Every request is audited.
- Under password-unlocked encryption, AI can only run while a user has the clinic unlocked. That is a useful limit.
- No remedy recommendations.

Exit: with AI switched off no request leaves the server, and with it on every request appears in the audit log with the approving user.

### Later, optional

Inventory with batch, expiry and stock reduction on dispensing, as the original section 22.

## 6. Design documents

The original section 30 asks for five documents before development. Their state:

| Document | State | When |
| --- | --- | --- |
| Database ERD | Missing. The models are the only description | Before Phase 1 step 2, because encryption changes most tables |
| Screen and workflow specification | Partly: `docs/user-experience.md` covers what is built | Extend at the start of each phase |
| Security architecture | Partly: `docs/encryption.md` and `docs/deployment.md` | Complete with the threat model in Phase 1 |
| MVP requirements | Missing. Phases 1 to 3 above are the working definition | Short version before Phase 2 work |
| Knowledge base specification | Missing | Before Phase 6; the Phase 3 catalogue must not contradict it |

## 7. How work is checked

- Every change ships with tests. Permission and clinic-isolation tests are required for every new endpoint.
- Both backend suites run in CI: fast SQLite and full PostgreSQL. Migration drift is checked on every push.
- Each phase adds browser end-to-end tests for its main flows.
- A phase is finished when its exit checks pass and `README.md`, `AGENTS.md`, this plan and `docs/verification.md` describe the result.
- Commit small and often, push after every working session.

## 8. Main risks

| Risk | Response |
| --- | --- |
| The project folder is lost before a remote exists | Finding 1; do this first |
| Encryption is built but subtly wrong | Independent review and the test list in `docs/encryption.md` are exit conditions |
| Passwords and recovery key are all lost | Recovery procedure rehearsed in Phase 1; the consequence is stated to the owner in writing |
| Real data entered too early | Startup guard stays until the Phase 1 exit; development banner stays in the UI |
| Legal obligations discovered late | The country is known (India); the points listed in section 3 are confirmed with qualified advice before the Phase 1 exit |
| Scope grows faster than a small team can test | "Left out" lists per phase; modules stay behind interfaces |
| WhatsApp number banned or costs rise | Staff-sent drafts first; official platform only; campaigns last |
| Copyrighted reference texts | D9; attribution on every entry |
| Clinic loses internet (if hosted) | Decide acceptable downtime under D2; provide a printable day sheet |

## 9. What changed from the original plan

| Original | This plan | Why |
| --- | --- | --- |
| Phase 1 is complete before patients are built | Phase 1 is reopened and finished first | The code skipped encryption, backups and settings |
| REST or GraphQL | REST under `/api/v1/` | Already built and tested |
| UUIDs or ULIDs | UUIDv4, with a separate short patient identifier | Already built; the short code is what staff and barcodes use |
| Five roles, `UserRole` | Six roles including Owner, `Membership` per clinic | Already built; the owner is the only role that sees the audit log and clinical data together |
| Password-unlocked key, no mention of unattended jobs | Same key design, plus sign-in preparation and a narrow messaging key | Scheduled messages cannot be prepared while nobody is signed in |
| Browser calls the print agent on `localhost` | Agent connects outward to the server | Browser restrictions on local calls, and other websites could reach the local port |
| Thermal label printing and A4 printing together | Browser printing first, agent only for label printers | Prescriptions and invoices can print on day one without installing anything |
| Medicine database arrives in Phase 6 | A minimal catalogue in Phase 3, full library in Phase 6 | Prescription items already need `medicine_id`, and autocomplete saves time at every visit |
| Visits are simply saved | Draft, finalise, amend | A saved visit currently cannot be corrected at all |
| "Match: 87%" ranking | Matched rubrics with counts and sources | Explainable, and does not overstate certainty |
| WhatsApp integration as one item | Staff-sent drafts, then the official platform, campaigns last | Useful early at no cost; lowest risk to the clinic's number |
| One communication consent | Separate care and promotional consents | Promotional messages have different rules almost everywhere |
| No data import | Spreadsheet import in Phase 2 | A working clinic already has patients |
| Prescription PDF and labels show the medicine and potency | Patient documents show dosage instructions only | Owner's decision, 2026-10-11 |
| Inventory optional; billing lines unspecified | Doctor's medicines as one bill line, shelf products as separate lines from a product list | Owner's decision, 2026-10-11 |
| Five design documents before development | Scheduled against phases in section 6 | Development has already started; the ERD and security architecture are the two that cannot wait |
