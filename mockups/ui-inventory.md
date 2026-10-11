# DocHP UI inventory

Every page, floating window, menu, switch and printed item the application is planned to have, drawn from `docs/build_plan.md` and the owner's `docs/build_plan_original.md`. The mockups are a clickable prototype: tabs, floating windows, menus, switches and the "View as" role picker work, but nothing is saved, sent or printed. The owner's decisions of 11 Oct 2026 are recorded in section 8 and are already reflected in the screens.

- **Mockup** column: a link means the item is drawn. "Listed" means it is described here but not drawn yet.
- **Phase** is the build-plan phase the item belongs to. "Built" means a working version already exists in `frontend/src/` and the mockup shows where it is heading.
- **Who** uses the six roles in the code: Owner, Doctor, Assistant (clinical assistant), Reception, Billing, Admin.

Open the mockups from [index.html](index.html).

## 1. The frame around every page

| # | Element | What it does | Mockup |
| --- | --- | --- | --- |
| F1 | Brand link | Returns to the dashboard | every page |
| F2 | Find-a-patient box | Search by name, phone or patient ID from anywhere; `Ctrl K` focuses it; a scanned card is caught here | every page, [overlays 1](overlays.html) |
| F3 | Clinic switcher | Only for people who belong to more than one clinic | [overlays 18](overlays.html) |
| F4 | Lock button | Locks the screen at once; also `Ctrl L` | every page |
| F5 | Account menu | My account, change password, shortcuts, lock, sign out | [overlays 17](overlays.html) |
| F6 | Clinic tabs | Dashboard, Patients, Appointments, Messages, Billing, Library, Printing, Settings. A tab is hidden when the role cannot use it or the module is switched off | every page |
| F7 | Count on a tab | For example messages waiting for approval | every page |
| F8 | Development banner | "Development build. Use synthetic patient data only". Stays until encryption is finished | Built, not drawn |
| F9 | Offline and error notices | Bottom corner | [overlays 26](overlays.html) |
| F10 | Patient banner | Photo, name, age, sex, phone, patient ID, last visit, follow-up, balance, consent; actions New visit, New invoice, Message, More | [patient record](patient-overview.html) |
| F11 | Patient tabs | Overview, Visits, Prescriptions, Notes, Billing, Messages, Documents | [patient record](patient-overview.html) |
| F12 | Save bar | Sticks to the bottom of any form: save state on the left, actions on the right | [visit](visit.html) |

The original plan's navigation (section 29) groups Visits, Prescriptions and Library under "Clinical" and three items under "Communications". The mockups flatten this to eight tabs because visits and prescriptions are always reached through a patient. This is a choice for the owner.

## 2. Pages

### Getting in

| # | Page | Purpose | Who | Phase | Mockup |
| --- | --- | --- | --- | --- | --- |
| P1 | Sign in | Username and password; password also unlocks the records | All | 1, built | [login](login.html) |
| P2 | Verification code | Second step for owners and doctors | Owner, Doctor | 1 | [login](login.html) |
| P3 | Choose clinic | After sign-in, if more than one | Some | 1, built as a dropdown | [login](login.html) |
| P4 | Lock screen | Appears after idle time; quick re-entry | All | 1 | [login](login.html) |
| P5 | Forgot password | Reset by the owner; explains what the recovery key is for | All | 1 | Listed |
| P6 | Use recovery key | Enter the key, set a new owner password | Owner | 1 | Listed |
| P7 | First-time clinic setup | Clinic details, owner account, recovery key | Owner | 1 | Listed |
| P8 | Set your password | First sign-in from an invitation | All | 1 | Listed |

### Daily work

| # | Page | Purpose | Who | Phase | Mockup |
| --- | --- | --- | --- | --- | --- |
| P9 | Dashboard | Today's queue, counts, needs attention, recent patients | All, content varies by role | 5, simple version built | [dashboard](dashboard.html) |
| P10 | Patients | Search, filters, list | All | 2, built | [patients](patients.html) |
| P11 | Register patient | Identity, contact, consent, photo, card | Reception, Assistant, Doctor, Owner | 2, built in part | [register](patient-register.html) |
| P12 | Edit patient details | Same form; every change kept | Same | 2 | [register](patient-register.html) |
| P13 | Patient: Overview | Details panel, alerts, timeline of everything | All; clinical text hidden from Reception and Billing | 2, built | [patient record](patient-overview.html) |
| P14 | Patient: Visits | List of visits, newest first, expandable | Clinical roles | 3, built | Listed |
| P15 | New or draft visit | "Remember about the patient" notes, complaint, doctor's notes, envelopes with medicines and a dosage builder, products, next visit | Doctor, Owner | 3, built in simpler form | [visit](visit.html) |
| P16 | Finalised visit | Read-only view with amendments beside it | Clinical roles | 3 | Listed |
| P17 | Patient: Prescriptions | Every prescription, search by medicine, repeat, print, label | Clinical roles | 3, built | Listed |
| P18 | Patient: Notes | Add and read general notes | By role | 2, built | Listed |
| P19 | Patient: Billing | That patient's invoices, payments and balance | Billing, Reception, Owner | 4 | [invoice](invoice.html) |
| P20 | Patient: Messages | Message history, replies, consent | By role | 5 | Listed |
| P21 | Patient: Documents | Lab reports and other files; upload and view | Clinical roles | 3 | Listed |
| P22 | Patient: Change history | Who changed which detail and when | Owner | 2 | Listed |
| P23 | Measurements history | Height, weight, blood pressure over time | Clinical roles | 3 | Listed |
| P24 | Appointments: Day | Calendar by time, waiting list, follow-ups due | All | 5 | [appointments](appointments.html) |
| P25 | Appointments: Week and List | Other views of the same data | All | 5 | Listed |
| P26 | Follow-ups due | Full list with Book and Message | Doctor, Reception | 3 | Listed, part shown in [appointments](appointments.html) |
| P27 | Draft visits | Visits not yet finalised | Doctor | 3 | Listed |
| P28 | Dispense | A walk-in collecting medicine: prescription, labels, bill | Assistant | 4 | Listed |

### Money

| # | Page | Purpose | Who | Phase | Mockup |
| --- | --- | --- | --- | --- | --- |
| P29 | Billing: Invoices | List with status filters and today's totals | Billing, Reception, Owner | 4 | [billing](billing.html) |
| P29b | New bill (walk-in sale) | Where a product scan lands when no visit is open; no patient record needed | Billing, Reception, Owner | 4 | [new bill](bill-new.html) |
| P30 | Invoice: draft | Edit lines, discount, note; Issue | Same | 4 | [invoice](invoice.html) |
| P31 | Invoice: issued | Read-only, payments, history | Same | 4 | [invoice](invoice.html) |
| P32 | Billing: Payments | Every payment received | Same | 4 | Listed |
| P33 | Billing: Outstanding | Who owes what, with age | Same | 4 | Listed |
| P34 | Day-end report | Collections by method, cash count | Billing, Owner | 4 | [billing](billing.html) |
| P35 | Price list | Items, prices, tax, active switch | Owner, Admin | 4 | [billing](billing.html) |
| P36 | Credit note | View of a correction to an issued invoice | Billing, Owner | 4 | Listed |

### Messages

| # | Page | Purpose | Who | Phase | Mockup |
| --- | --- | --- | --- | --- | --- |
| P37 | Waiting for approval | Queue on the left, message preview on the right | Doctor, Owner | 5 | [messages](messages.html) |
| P38 | Replies | Messages patients sent back | Reception, Doctor | 5 | Listed |
| P39 | Sent and Failed | Delivery history | Same | 5 | Listed |
| P40 | Templates | List and editor with insertable fields | Owner, Admin | 5 | [messages](messages.html), list only |
| P41 | Rules | When a message is prepared, on/off per rule | Owner, Admin | 5 | [messages](messages.html) |
| P42 | Campaigns | Greetings and newsletters to a chosen group | Owner | 5, last | Listed |

### Library

| # | Page | Purpose | Who | Phase | Mockup |
| --- | --- | --- | --- | --- | --- |
| P43 | Search by symptoms | Matched symptoms per medicine, with sources | Doctor | 6 | [library](library.html) |
| P44 | Medicine page | Symptoms, description, relationships, notes, versions | Doctor | 6 | [library](library.html) |
| P45 | Medicines A to Z | Catalogue; also feeds prescription autocomplete | Doctor | 3 minimal, 6 full | Listed |
| P46 | Rubrics | Browse symptoms and rubrics | Doctor | 6 | Listed |
| P47 | Sources | Books and texts with edition and import date | Owner | 6 | Listed |
| P48 | Import texts | Trial run, then import | Owner | 6 | Listed |

### Printing and documents

| # | Page | Purpose | Who | Phase | Mockup |
| --- | --- | --- | --- | --- | --- |
| P49 | Print queue | What printed, what is waiting, retry | All | 4 | [printing](printing.html) |
| P50 | Printers | Pair a label printer, test, remove | Owner, Admin | 4 | [printing](printing.html) |
| P51 | Template settings | One page per template: invoice, receipt, prescription, label, patient card | Owner, Admin | 4 | [printing](printing.html), label only |
| P52 | All documents | Files across patients | Clinical roles | 3 | Listed |

### Settings

| # | Page | Purpose | Who | Phase | Mockup |
| --- | --- | --- | --- | --- | --- |
| P53 | Clinic details | Name, address, tax number, time zone, currency, logo, invoice numbering | Owner, Admin | 1 | [settings](settings.html) |
| P54 | Work week | Month and year pickers, tap dates on or off, quick-set buttons for regular and weekend times, up to 4 saved work weeks | Owner, Admin | 5 | [work week](work-week.html) |
| P55 | Users and roles | Invite, change role, deactivate | Owner | 1 | [settings](settings.html) |
| P56 | My account | Name, password, PIN, two-step sign-in | All | 1 | Listed |
| P57 | Switches | Turn modules and features on or off | Owner | all | [settings](settings.html) |
| P58 | Messaging setup | WhatsApp connection, sender number, consent wording | Owner | 5 | Listed |
| P59 | Security | Lock time, two-step rule, recovery key, sessions | Owner | 1 | [settings](settings.html) |
| P60 | Backups | Places to save to (local folder, NAS, mounted cloud folder), schedule, kept backups, restore test, restore; always encrypted with the clinic key | Owner | 1 | [backups](backups.html) |
| P61 | Activity log | Who opened or changed what; filters; export | Owner | 1, basic version built | Listed |
| P62 | Import and export | Patient import, full export | Owner | 2 | Listed |
| P63 | Stock | Batches, expiry, counts. Only if stock control is switched on | Assistant, Owner | later, optional | Listed |

### Other

| # | Page | Purpose |
| --- | --- | --- |
| P64 | Not found, no permission | Plain message and a way back |
| P65 | Keyboard shortcuts | One page listing them |

## 3. Floating windows

All drawn on [overlays.html](overlays.html) unless marked.

| # | Window | Opens from | Phase |
| --- | --- | --- | --- |
| W1 | Find a patient | Search box, `Ctrl K`, a scan | 2 |
| W2 | Product scanned during a visit: add to this patient, or new bill for someone else | Scanning a product while a visit is open | 4 |
| W2b | Barcode not recognised, or card no longer valid | Any unknown scan | 2 |
| W3 | Record payment | Invoice, billing list, patient banner | 4 |
| W4 | Print envelope labels | Finalising a visit, any prescription | 4 |
| W4b | Add a product to the bill | Draft invoice, visit page | 4 |
| W5 | New appointment: phone number lookup (or new patient), tap-a-day calendar, tap-a-time slots | Dashboard, free slot, patient record, visit | 5 |
| W6 | Take patient photo, cropped to the face automatically | Registration, details panel | 2 |
| W7 | Amend a finalised visit | Visit view, timeline | 3 |
| W8 | Void invoice, credit note, refund | Invoice More menu | 4 |
| W9 | Edit message before sending | Approval queue, patient Message button | 5 |
| W10 | Invite or edit a user | Users and roles | 1 |
| W11 | Recovery key, shown once | Clinic setup, Security | 1 |
| W12 | Import patients, three steps | Patients, Settings | 2 |
| W13 | Unsaved changes | Leaving a form | Built |
| W14 | Finalise visit | Visit save bar | 3 |
| W15 | Archive or restore patient | Patient More menu | 2 |
| W16 | Locked after no activity | Idle timer, Lock button | 1 |
| W17 | Reschedule or cancel appointment, with reason | Appointment menu | 5, listed |
| W18 | Add walk-in | Dashboard, Appointments | 5, listed |
| W19 | Add note | Timeline, Notes tab | Built, listed |
| W20 | Add document | Timeline, Documents tab | 3, listed |
| W21 | Document or PDF viewer | Any document link | 3, listed |
| W22 | Print preview (prescription, invoice, receipt, card) | Any Print action | 3 and 4, listed |
| W23 | Message consent | Patient More menu | 5, listed |
| W24 | Replace lost card | Patient More menu | 2, listed |
| W25 | Link family member | Register, details panel | 2, listed |
| W26 | Patient alerts editor | Details panel | 3, listed |
| W27 | Rule editor | Messages, Rules | 5, listed |
| W28 | Template editor | Messages, Templates | 5, listed |
| W29 | Price list item | Price list | 4, listed |
| W30 | Pair a label printer | Printers | 4, listed |
| W31 | Close the day | Billing | 4, listed |
| W32 | Change password, set PIN, set up two-step sign-in | Account menu | 1, listed |
| W33 | "What will be sent to the AI service" | Any AI draft | 7, listed |
| W34 | Save prescription set | Prescription set menu | 3, listed |
| W35 | Session about to end | Before automatic sign-out | 1, listed |

**Side panels** (slide in from the right, page stays usable): Last visit (drawn, overlays 25), Library lookup during a visit, Message history.

**Notices** (bottom corner, overlays 26): saved, printed with Undo, failed with Retry, offline.

## 4. Menus

| # | Menu | Items | Mockup |
| --- | --- | --- | --- |
| M1 | Account | My account, Change password, Keyboard shortcuts, Lock, Sign out | overlays 17 |
| M2 | Clinic switcher | Your clinics | overlays 18 |
| M3 | Patient More | Edit details, Book appointment, Print patient card, Replace lost card, Message consent, Change history, Archive | overlays 19 |
| M4 | Invoice More | Print receipt, Download PDF, Issue credit note, Refund payment, Void | overlays 20 |
| M5 | List row | Open, Open in new tab, Start visit, Book appointment, New invoice | overlays 21 |
| M6 | Appointment | Mark arrived, Start visit, Reschedule, Send reminder now, No-show, Cancel | overlays 22 |
| M7 | Export | Spreadsheet, PDF, Accountant export | overlays 23 |
| M8 | Prescription sets | Saved sets, Save current as a set | overlays 24 |
| M9 | Medicine autocomplete | Matches by name and short code as the doctor types | [visit](visit.html) |
| M10 | Symptom autocomplete | Same, for symptoms | Listed |
| M11 | User Manage | Reset password, Sign out everywhere, Deactivate | Listed |
| M12 | Sort and date-range pickers | On every list | [patients](patients.html), [billing](billing.html) |

## 5. Switches and other choices

**Clinic-wide switches** ([settings](settings.html)): Appointments · Billing · Product sales · Show GST on bills · WhatsApp messages · Send reminders without approval · Homeopathy library · Stock control · AI drafting (off by default) · Two-step sign-in for owners and doctors.

**Per patient**: Care messages consent · Greetings and clinic news consent · WhatsApp number same as phone · Print card after saving · Active or archived.

**Per visit**: Visit type (First visit, Follow-up, Medicine only) · Since last visit (five choices) · Dosage builder per envelope (amount, unit, how often, when, how long) · Next visit quick picks · Add notes to "Remember" · Book the appointment · Print envelope label · Create the bill.

**Per rule, template, price item, user**: an on/off switch on each row.

**Label settings** ([printing](printing.html)): label size · dosage text size · show clinic phone · show clinic logo · show patient barcode · show next visit date. There is no switch for medicine names: they are never printed.

**List filters** (chips): patients by Active, Archived, Follow-up due, Balance due, Seen this month; invoices by status; timeline by type; print queue by state; library by source.

**View choices**: appointments Day, Week, List; "This is a shared computer" at sign-in; lock time 2, 5 or 15 minutes.

## 5b. Barcode scan routing

One scan service listens on every screen. A scanner types quickly and ends with Enter, which is how a scan is told apart from typing. In the prototype, "Simulate a scan" at the top of every screen does the same, and a real scanner works too.

| What is scanned | Where | What happens |
| --- | --- | --- |
| Patient ID (card, bill, envelope label, any take-home print) | Anywhere | Opens that patient's profile; the doctor starts a visit from there |
| Product | A visit is open | Window W2: add to this patient's visit, or start a new bill for someone else |
| Product | A bill is already open | Adds a line to that bill |
| Product | Anywhere else | Opens a new bill (P29b) with the product on it |
| Anything else | Anywhere | Window W2b: not recognised; nothing opens |

## 6. Printed items

Every item a patient takes home carries the patient ID as a barcode, so anything brought back opens the right record without asking for a phone number (one number can belong to several people in a household).

| # | Item | Size | Printer | Mockup |
| --- | --- | --- | --- | --- |
| D1 | Invoice (bill): prescribed medicines as one line, products as separate lines, ₹, optional GST | A4 | Any, through the browser | [print-bill](print-bill.html) |
| D2 | Envelope label: logo, clinic address, patient name, dosage, patient barcode, date, next visit | 2 × 2 in, black and white thermal | Label printer | [print-label](print-label.html) |
| D3 | Receipt | A4 half page | Any | Listed |
| D4 | Prescription | A4 or A5 | Any | Listed |
| D5 | Patient card with barcode | Card size | Any, or label printer | Listed |
| D6 | Day sheet (today's appointments) | A4 | Any | Listed |
| D7 | Day-end report | A4 | Any | Listed |
| D8 | Recovery key sheet | A4 | Any | Listed |

## 7. Small parts used everywhere

Drawn at the bottom of [overlays.html](overlays.html): main, secondary, destructive and text buttons; on/off switch; choice strip; filter chip; shortcut key; status labels for invoices, appointments and messages; success, information, warning and error bars; empty-list message. Also: tables with a sticky header and Previous/Next, form fields with the label above, date fields that accept typing, and the sticky save bar.

## 8. Decisions and open questions

**Decided by the owner on 11 Oct 2026**

1. Navigation is eight flat tabs, fewer for roles with less access.
2. Medicine names are never printed for the patient. Labels carry dosage instructions only, such as "4 tabs, twice daily, before meals".
3. On the bill, everything the doctor prescribed and mixed is one line. Shelf medicines, supplements and other consumables are separate lines.
4. The label carries the clinic logo and address, patient name, dosage instructions, patient barcode, the date and the next advised date.
5. Labels are pasted on the medicine envelope. Products and supplements are not labelled; they appear only on the bill.
6. The visit page is built around the complaint and free notes, including personal details that help the doctor remember the patient (a hobby, family, a story), plus prescribing with medicine search and dosage units.
7. The clinic is in India: rupees, GST, UPI, April to March financial year.

**Added on 11 Oct 2026 (second round)**

8. The clinic is GST-registered. The GSTIN, GST column and GST box print on every bill; if no GSTIN is entered in Settings, none of them print.
9. A visit can have several envelopes, each with its own label.
10. "Remember about the patient" notes are for doctors only.
11. Wanted later, not now: two patients open side by side, for a parent who brings a child who is also a patient.

**Added on 11 Oct 2026 (third round)**

12. Every printed item the patient takes home shows the patient ID barcode, the bill included.
13. Scan routing as in section 5b.
14. New appointments start from a phone number, which finds or adds the patient. Date and time are picked by tapping, as on a phone.
15. "Opening hours" is called Work week: month and year dropdowns, tap dates on or off, quick-set buttons for regular and weekend times, at most 4 saved work weeks.
16. The patient photo is cropped automatically around the detected face, using the lightest method that works, on the clinic's own computer.
17. Recognising patients by face is a possible future plugin and is out of scope now.

**Added on 11 Oct 2026 (fourth round)**

18. The owner reviewed the UI, pages and prints and found them fine for now.
19. A product scanned while a bill is already open is added to that bill.
20. Backups are built in: saved to a local folder, a NAS or a mounted cloud folder, and encrypted with the same clinic key.

**Still open**

1. GST rates per kind of item, for the accountant to confirm.
2. Should product stock be counted (stock control), or only sold from a price list?
3. Is the prescribed-medicines charge per week, per envelope, or typed in each time?

## 9. Viewing the prototype

Run `node mockups/serve.js` from the repository folder and open http://localhost:4173. Previous and Next at the top of each screen, or the left and right arrow keys, flip through all 19 screens.
