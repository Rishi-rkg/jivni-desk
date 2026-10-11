# Changelog

What changed in each version, newest first. Versions before 1.0.0 are for synthetic data only: patient fields are not yet encrypted. `docs/verification.md` records how each state was checked, and section 1 of `docs/build_plan.md` lists what is built and what is missing.

## 0.2.3 (2026-10-11)

The first version with installers for everything below. 0.2.0, 0.2.1 and 0.2.2 were tagged but their installer builds failed in the browser tests, so they have no files.

- Licence: Elastic License 2.0 (source available).
- Fixed: the activity log could show an unfiltered list when a filter was picked while the first list was loading.
- Browser tests made independent of how fast the build machine is.

## 0.2.0 (2026-10-11)

Every page and window in the screen designs, except the ones listed as not built in the README.

- Eight tabs, fewer by role, with a patient finder (Ctrl K), a lock screen, and switches that turn whole parts off.
- Patients: list with filters, fuller registration, one record with a timeline, family, consent, alert, documents, change history, spreadsheet import.
- Visits: drafts that save themselves, finalise, amendments, products advised, last-visit panel.
- Billing: price list, bills and walk-in sales, payments, refunds, credit notes, void, day-end, exports.
- Printing through the print window at each page's own paper size: bill, receipt, prescription, 2 inch envelope labels, patient card, day sheet.
- Appointments: work week, booking from a phone number, walk-ins, waiting list, follow-ups due, dashboard.
- Messages: templates, rules, an approval queue, sending by hand through WhatsApp, campaigns, noted replies.
- Users and roles, one-time passwords, two-step sign-in, recovery from the sign-in page, security settings.
- Activity log filters and export; every patient's documents in one list.

## 0.1.1 (2026-10-11)

- Renamed to Jivni, with the J and leaf logo.
- One program with a tray menu; installers and portable builds for Windows, macOS and Linux.
- Prescribing by envelope on the visit page.

## 0.1.0 (2026-10-11)

- Sign-in, roles, clinic settings, audit log, idle lock.
- Patients, visits, notes, prescriptions, patient codes and scan lookup.
- First-time setup with a recovery key; encrypted backups with a read-back check.
- The reference library: Boericke's Materia Medica and Kent's Repertory.
