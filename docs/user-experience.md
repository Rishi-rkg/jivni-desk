# Laptop workspace and user flows

The interface is designed first for a clinic laptop at 1366 × 768, with wider layouts up to 1440 pixels and a stacked fallback for smaller screens. The main purpose is to find the right patient, review their history, record the consultation and continue the next task with the patient still identified.

## Two navigation levels

Clinic tabs: **Dashboard → Patients → Billing → More tools → Clinic settings → Audit log**. Clinic settings is read-only unless the user is the owner or an administrator; the audit log is shown only to those two roles. The dashboard begins with patient search and real directory data. It does not invent appointments, unpaid balances or daily activity figures for modules that have not been built.

Patient tabs: **Overview → Visits → Prescriptions → Notes → Billing**. Clinical tabs are available only to clinical roles. The patient banner and details sidebar persist while tabs change; a billing tab identifies which patient it belongs to. Tabs have bookmarkable URLs and use normal browser navigation. They are page-navigation links rather than a keyboard-trapping tab widget.

The Overview summarizes the latest loaded visit, recent measurements and the latest note. Visits are ordered newest first, with expandable details. Prescriptions group medicine snapshots by visit. Notes have their own entry surface so a large note form no longer pushes clinical history down the main screen. Earlier visits/notes can be loaded explicitly; measurements and prescription history are limited to the visits currently loaded.

## Primary flows

| Flow | Steps and outcome |
| --- | --- |
| Returning patient | Dashboard search → patient list → patient Overview → review Visits/Prescriptions → New visit → Save visit → Visits with confirmation |
| New patient | Register patient → save demographics/address → patient Overview with confirmation → New visit |
| Record a consultation | Clinical details on the left; observations and prescription on the right; persistent Save visit bar; one transactional save |
| Record contextual history | Patient Notes → write note → Save note; a draft stays in memory across the same patient's tabs |
| Return to search | Patient list link restores the original search and pagination URL |
| Future billing | Open the patient's Billing tab to retain patient context; invoice/payment actions will be added when the billing module is implemented |

Successful registration, note entry, photo upload and visit saves show explicit feedback. A successful visit save opens the Visits tab so the clinician can check what was recorded. Failed saves retain the form and display the server's validation message.

Unsaved registration, visit and note changes warn before internal navigation away from the form/record or browser unloading. Notes may switch patient tabs without losing their draft. Signing out or switching clinics checks for unsaved changes before changing the session. Drafts are never stored in browser local storage; a refresh discards them after the browser warning. There is no autosave claim.

## Scanning

A barcode scanner behaves like a keyboard that types very fast and presses Enter. Anywhere in the workspace, when no text field is in use, a scanned patient card opens that patient. In the dashboard search box a scanned or typed card code also opens the patient directly. A scan while typing in another field is left alone so it lands where the cursor is. If the open screen has unsaved work, the usual leave warning appears first. A code that matches nothing shows a plain message and changes nothing.

## Lock screen

After 15 minutes without keyboard or pointer activity, or when the server reports that the session has ended, the workspace is covered by a lock screen that asks for the same user's password. The screen underneath stays loaded, so an unsaved visit or note is still there after unlocking. While someone is typing, the session is kept alive in the background, so a long case is not interrupted. "Sign in as a different user" discards the locked screen after a warning if there is unsaved work. The locked page is hidden, not erased: it protects against someone walking past, not against someone with developer tools.

## Archiving

Owners and clinicians can archive a patient from the details panel after a confirmation, and restore them later. Archived patients leave the patient list and cannot receive new visits; nothing is deleted.

## Visual choices

Use native Segoe UI/system typography, compact controls, restrained blue accents, neutral surfaces and simple dividers. Patient identity has priority over raw UUIDs; the permanent ID remains available in a disclosure. No hero graphics, animated charts or oversized metric cards. The distinctive structural element is the patient banner plus tabbed record, reflecting the clinic's workflow rather than decorating it.

The 1366 × 768 browser check covered the dashboard, patient context, tab changes, draft protection, visit entry and save confirmation. Frontend tests cover session login, failed saves, role restrictions, tab drafts and restoring search state.

## Next UX work

- Add patient demographic editing and validated duplicate-patient checks.
- Add appointments and a daily work queue once their models and APIs exist.
- Add a persistent clinician draft/finalization workflow with explicit save state and recovery, backed by protected server storage.
- Implement billing with invoice snapshots, and connect a completed visit to invoice creation without asking for the patient again.
- Provide finer clinical history filters, full observation history and prescription lookup independently of loaded visit pages.
- Test with clinic staff using keyboard navigation, longer clinical notes, larger medicine lists and different roles before expanding the feature set.
