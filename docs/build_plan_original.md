# Homeopathy Clinic Management App — Build Plan

## 1. Product Vision

Build a browser-based **clinic operating system** for a homeopathy practice, with patient records as the stable core and billing, messaging, printing, barcode lookup, and the homeopathy knowledge library as separate modules around it.

The central architecture principle is:

> **The database represents the clinic’s facts. The UI is only one way of viewing and editing those facts.**

This helps ensure that future changes to the interface, workflows, branding, or document templates do not require destructive database changes.

---

## 2. High-Level Architecture

```text
                    ┌────────────────────────────┐
                    │       Browser App          │
                    │ Patients / Visits / Billing│
                    │ Library / Messages / Admin │
                    └─────────────┬──────────────┘
                                  │ HTTPS
                           Versioned API
                                  │
                ┌─────────────────┴────────────────┐
                │          Application Server      │
                │                                  │
                │ Authentication / Permissions     │
                │ Patient Records                  │
                │ Clinical Encounters              │
                │ Billing                          │
                │ Messaging                        │
                │ Medicine Knowledge Base          │
                │ Document Generation              │
                │ Audit Logging                    │
                └───────┬─────────┬─────────┬──────┘
                        │         │         │
                  PostgreSQL   Files     Job Queue
                  Database     Photos    Messages
                               PDFs
                        │
          ┌─────────────┼───────────────┐
          │             │               │
      WhatsApp       AI Provider    Local Print Agent
      Business                      A4 / Thermal
```

### Recommended Technology Direction

Use mature, boring, well-supported technologies rather than highly experimental ones.

Suggested stack:

- **Database:** PostgreSQL
- **Backend:** Django / Python
- **Frontend:** React + TypeScript
- **API:** Versioned REST or GraphQL API
- **File storage:** Encrypted object/file storage
- **Background tasks:** Job queue for messaging, PDFs, printing, imports, and scheduled follow-ups
- **Deployment:** Browser-based application over HTTPS

The frontend should be replaceable without changing the meaning of core database records.

---

# 3. Main Application Modules

| Module | Responsibility |
|---|---|
| Patient Registry | Permanent patient identity and demographic information |
| Clinical Record | Visits, symptoms, history, observations, and notes |
| Prescriptions | What the doctor prescribed during each visit |
| Knowledge Library | Homeopathy reference library, repertory, and medicine lookup |
| Appointments | Upcoming visits, follow-ups, and patient queue |
| Correspondence | WhatsApp messages, reminders, newsletters, and greetings |
| Billing | Invoices, payments, taxes, and financial records |
| Documents | PDFs, reports, attachments, and scanned documents |
| Printing | A4 documents and medication labels |
| Barcode System | Fast retrieval of patient records |
| Administration | Users, permissions, templates, and settings |
| Audit & Security | Who accessed or changed what and when |

---

# 4. Patient Information Management

## 4.1 Core Patient Data

Permanent patient information should live in a stable patient record.

Example:

```text
Patient
-------
patient_id
first_name
middle_name
last_name
date_of_birth
gender
address
phone
whatsapp_number
email
profile_photo
created_at
archived_at
```

### Important Design Rule

Not all patient information should live directly on the patient table.

For example, height and weight change over time and should be stored as observations linked to a date or visit.

Recommended conceptual structure:

```text
Patient
   │
   ├── Addresses
   ├── Observations
   │      ├── Height
   │      └── Weight
   │
   ├── Encounters
   │      ├── Symptoms
   │      ├── Clinical notes
   │      ├── History
   │      └── Prescriptions
   │
   ├── General Notes
   ├── Documents
   ├── Invoices
   ├── Messages
   └── Appointments
```

---

# 5. Clinical Encounters

Every patient visit should create an **Encounter**.

An encounter should contain information such as:

| Field | Description |
|---|---|
| Encounter ID | Permanent unique identifier |
| Patient | Linked patient |
| Date/time | Visit date and time |
| Doctor | Treating clinician |
| Chief complaint | Main reason for visit |
| Symptoms | Structured and free-text symptoms |
| History | Relevant medical or illness history |
| Observations | Height, weight, and other measurements |
| Assessment | Doctor's clinical notes |
| Prescription | One or more prescribed items |
| Follow-up date | Optional planned follow-up |
| Internal notes | Doctor-only notes |
| Attachments | Photos, PDFs, reports, etc. |

### Patient Timeline

The patient profile should present visits and related activity chronologically.

Example:

```text
Oct 6 2026
Visit
Symptoms...
Prescription...
Invoice...
Follow-up...

Aug 22 2026
Visit
Symptoms...
Prescription...

Jun 9 2026
Initial consultation
...
```

The patient timeline should become the main mental model for clinicians.

---

# 6. Prescriptions

Prescription information should be structured rather than stored only as free text.

Recommended structure:

```text
PrescriptionItem
----------------
medicine_id
medicine_name_snapshot
potency
dose
frequency
duration
instructions
quantity
doctor_notes
```

A free-text instruction field can still be included.

Structured prescriptions allow future features such as:

- Show what was prescribed at the last visit
- Search when a medicine was last prescribed
- Print medication labels
- Generate prescription PDFs
- Review full prescription history
- Find patients who received a specific medicine

---

# 7. Homeopathy Knowledge Library

The homeopathy knowledge library should be a separate data domain from patient clinical records.

Recommended conceptual structure:

```text
Medicine
    ├── Names / aliases
    ├── Description
    ├── Source information
    ├── Symptoms / rubrics
    ├── Notes
    └── Relationships
           ├── Antidote
           ├── Complementary
           ├── Similar
           └── Other clinician-defined relationships

Symptom / Rubric
    ├── Name
    ├── Category
    ├── Synonyms
    └── Associated medicines
```

## Search Experience

A doctor could search using multiple symptoms:

```text
headache + worse from sunlight + nausea
```

The system could return relevant medicine entries with explanations.

Example:

```text
Medicine A        Match: 87%

✓ Headache
✓ Worse from sunlight
✓ Nausea
○ Thirst
```

The system should function as **clinical reference and retrieval software**, not as an autonomous prescribing system.

The final treatment decision remains with the doctor.

---

# 8. Knowledge Source Provenance

Every imported or externally sourced knowledge entry should support source metadata.

Recommended fields:

```text
Source
Author
Book / Website
Edition
Publication year
Page / section
URL
Date imported
Who imported it
Doctor's annotation
```

This allows the system to preserve provenance when sources disagree.

The application should never silently merge conflicting source claims into one unquestioned fact.

---

# 9. Knowledge Base Versioning

Doctors should be able to modify or annotate the knowledge base without destroying the original source data.

Example:

```text
Version 1
Imported Jan 2027
Source: ABC

Version 2
Modified Feb 2027
Dr. Patel
Changed relationship from X → Y
Reason: ...
```

The same principle should apply to significant clinical records.

Important patient notes should preferably be amended with history rather than silently overwritten.

---

# 10. Encryption and Authentication

The desired user experience is:

> Encrypt patient data securely and unlock it after authenticated login.

However, the system should **not** directly use the user's password as the database encryption key.

A stronger model is envelope encryption.

```text
User password
      ↓
Argon2id key derivation
      ↓
Key Encryption Key
      ↓
decrypts
      ↓
Clinic Master Encryption Key
      ↓
encrypts
      ↓
Patient data / files
```

## Benefits

When a user changes their password, the system does not need to decrypt and re-encrypt the entire database.

Only the encrypted copy of the clinic master key needs to be updated.

For a multi-user clinic, each authorized user can receive secure access to the clinic encryption key based on their permissions.

## Recommended Security Technologies

- Password hashing: Argon2id
- Sensitive data encryption: AES-256-GCM or equivalent authenticated encryption
- Transport security: TLS / HTTPS
- Encrypted backups
- Secure session management

Passwords themselves should never be stored reversibly.

---

# 11. Recovery Key Strategy

Strong encryption means there may be no way to recover data if all decryption credentials are permanently lost.

Therefore the system should provide a clinic recovery key during setup.

Example:

```text
CLINIC RECOVERY KEY

XXXX-XXXX-XXXX
XXXX-XXXX-XXXX
XXXX-XXXX-XXXX

STORE THIS IN A SECURE LOCATION.
```

The clinic should store this securely in a physical safe, enterprise password manager, or equivalent protected location.

Recovery procedures should be designed before production use.

---

# 12. Security Beyond Encryption

The system should support role-based access control.

Suggested roles:

| Role | Example Permissions |
|---|---|
| Doctor | Full clinical access |
| Clinical Assistant | Patients plus limited clinical functions |
| Reception | Demographics and appointments |
| Billing | Patient identity and invoices with limited clinical access |
| Administrator | Users, settings, permissions, and system administration |

Every sensitive action should generate an audit event.

Example:

```text
2026-10-06 14:34
User: reception01
Action: Viewed patient
Patient: PAT-82D...

2026-10-06 14:37
User: doctor01
Action: Modified clinical note
Encounter: ENC-92...

2026-10-06 14:42
User: billing01
Action: Generated invoice
Invoice: INV-2026-1042
```

Audit records should not be editable through the normal application.

---

# 13. Patient Profile Photo

Patient registration should allow webcam capture in the browser.

Suggested workflow:

```text
[ Start Camera ]

        Camera preview

[ Take Photo ]   [ Retake ]

          ↓

crop → resize → encrypt → store
```

The actual encrypted image should be stored in file or object storage.

The patient table should store only metadata and a secure reference.

Example:

```text
patient_photo_id
storage_object_id
mime_type
created_at
```

---

# 14. Barcode Lookup

Most commercial barcode scanners can function as keyboard-wedge devices.

The scanner types the barcode value into the focused computer and sends Enter.

Example workflow:

```text
SCAN

     ↓

P7J4A8X2QF

     ↓

GET /patients/by-barcode/P7J4A8X2QF

     ↓

Patient found

     ↓

Open Patient Profile
```

## Barcode Security Rule

The barcode should never directly encode:

- Patient name
- Phone number
- Medical condition
- Prescription
- Other sensitive medical data

It should contain only an opaque random identifier.

Example:

```text
PAT-W8KQ3G7DP9
```

---

# 15. WhatsApp Correspondence

Messaging should be designed as its own application service.

Recommended abstraction:

```text
Messaging Engine
       ↓
Communication Provider Adapter
       ↓
WhatsApp Business
```

This prevents WhatsApp-specific code from becoming tightly coupled to the patient database.

## Message Templates

Create reusable templates with variables.

Example:

```text
FOLLOW-UP 30 DAYS AFTER VISIT

Hello {{first_name}},

We hope you are doing well. It has been approximately
one month since your visit with Dr. {{doctor_name}}.

Would you like to schedule a follow-up appointment?

{{clinic_name}}
```

Patient-specific values should be inserted from the database.

---

# 16. Automated Correspondence Triggers

Correspondence should be event or rule driven.

Example:

```text
Trigger:
30 days after most recent visit

Conditions:
Patient has WhatsApp consent
Patient is active
No follow-up appointment already booked

Action:
Generate follow-up message

Status:
Waiting for doctor approval
```

Potential triggers include:

- Birthday
- 30-day check-in
- 90-day follow-up
- Appointment reminder
- Invoice generated
- Payment received
- Festival or holiday greeting
- Clinic announcement
- Newsletter

Promotional communication should respect patient consent and opt-out preferences.

---

# 17. AI Assistance

AI can be useful for message drafting, summaries, and search assistance.

Example:

```text
Patient:
John

Last encounter:
14 days ago

Doctor note:
Check progress in 2 weeks.

AI draft:
"Hello John, Dr. Sharma wanted to check how you've
been doing since your recent consultation..."
```

Then present:

```text
[ Edit ] [ Approve & Send ] [ Discard ]
```

## AI Safety Rule

AI should initially produce suggestions and drafts rather than automatically making clinical decisions or sending clinical correspondence.

Predictable transactional messages may eventually support automatic sending.

Example:

```text
"Your appointment is tomorrow at 3:00 PM."
```

Any third-party AI provider that receives patient data must be evaluated for privacy, security, contractual, and healthcare compliance requirements.

---

# 18. Billing

Billing data should be stored separately from the visual invoice template.

Recommended invoice structure:

```text
Invoice
-------
invoice_number
patient_id
issue_date
subtotal
tax
discount
total
payment_status
currency
```

Recommended line-item structure:

```text
InvoiceLine
-----------
description
quantity
unit_price
tax_rate
amount
```

Invoice layout should exist separately.

```text
InvoiceTemplate
---------------
template_name
logo
layout
font settings
footer
payment instructions
```

PDF generation then becomes:

```text
Invoice Data + Template
           ↓
       PDF Renderer
           ↓
      invoice.pdf
```

This allows invoice branding and graphics to change without changing accounting data.

---

# 19. Invoice Snapshots and Immutability

Issued financial documents should preserve the information that was true at issuance time.

For example:

```text
patient_name_at_issue
patient_address_at_issue
clinic_address_at_issue
tax_identifier_at_issue
```

Updating the patient's current address should not rewrite historical invoices.

Suggested invoice lifecycle:

```text
Draft
Issued
Paid
Partially Paid
Void
Refunded
```

Issued invoices should generally be immutable rather than deleted or overwritten.

---

# 20. Printing System

## A4 Printing

Standard documents can use browser/system printing.

```text
Invoice
    ↓
PDF
    ↓
Browser/System Print
    ↓
A4 printer
```

## Thermal and Label Printing

Direct browser access to commercial printers can be inconsistent.

A small **Clinic Print Agent** installed on the clinic computer is recommended.

Architecture:

```text
Browser
   │
   │ localhost print request
   ▼
Print Agent
   │
   ├── Windows/macOS printer
   ├── ESC/POS printer
   └── Label printer
```

The main clinic application can remain browser based.

---

# 21. Medication Label Printing

Medication labels should use prescription variables plus a configurable template.

Example:

```text
────────────────────────────
SUNRISE CLINIC

Patient:
John Smith

Medicine:
XXXXXXXX

Potency:
30C

Instructions:
5 pills twice daily

Prescribed:
06 Oct 2026

Dr. XXXXX
────────────────────────────
```

Supported label formats may include:

```text
50 × 25 mm
50 × 30 mm
58 mm roll
80 mm roll
Custom
```

Printer languages such as ESC/POS or ZPL may be supported later.

---

# 22. Optional Future Inventory Module

If the clinic dispenses medicines, add inventory management later.

Possible structure:

```text
Medicine Inventory
        ↓
Remedy
Potency
Form
Batch/Lot
Supplier
Expiry date
Quantity
Storage location
```

Dispensing a prescription could automatically reduce stock.

This should not be included in the first MVP unless the clinic needs inventory control immediately.

---

# 23. Doctor Dashboard

The dashboard should focus on daily clinic work rather than exposing every system feature at once.

Example:

```text
Good morning, Dr. Patel

TODAY

8 appointments

3 patients awaiting follow-up

2 unpaid invoices

6 messages awaiting approval


RECENT PATIENTS

John Smith
Last visit: yesterday

Mary Jones
Last visit: Oct 3


[ Find Patient ]

[ Scan Barcode ]

[ New Patient ]
```

---

# 24. Patient Profile Layout

The patient profile should become the center of the workflow.

Example:

```text
┌──────────────────────────────────────────────┐
│ PHOTO   JOHN SMITH            PAT-W82K39    │
│         Male · 42 · +1 ...                  │
├──────────────────────────────────────────────┤
│ Overview | Visits | Rx | Billing | Messages │
├──────────────────────────────────────────────┤
│                                              │
│                  TIMELINE                    │
│                                              │
│ Oct 6   Consultation                         │
│         Symptoms...                          │
│         Prescription...                      │
│                                              │
│ Sep 4   WhatsApp follow-up                   │
│                                              │
│ Aug 30  Consultation                         │
│                                              │
└──────────────────────────────────────────────┘
```

The design objective is:

> Everything involving one patient should be easy to find inside that patient's record.

---

# 25. Initial Database Entity Set

The first database design should likely include:

```text
Clinic
User
Role
UserRole

Patient
PatientIdentifier
PatientAddress
PatientPhoto
PatientNote

Appointment

Encounter
EncounterObservation
Symptom
EncounterSymptom

Prescription
PrescriptionItem

Medicine
MedicineAlias
MedicineRelation
KnowledgeEntry
KnowledgeCitation

Invoice
InvoiceLine
Payment

MessageTemplate
MessageCampaign
Message
PatientCommunicationConsent

Document
DocumentTemplate

PrintTemplate
PrintJob

AuditEvent
```

This provides enough structure to support the core clinic workflow while remaining extensible.

---

# 26. Permanent IDs

All important records should have permanent unique identifiers.

Example:

```text
Patient ID:
01K7D6A8JQH1R...

Encounter ID:
01K7D...

Invoice ID:
01K7E...
```

Names, phone numbers, addresses, doctors, and labels may change.

IDs should not.

All database relationships should use stable IDs rather than mutable information such as patient names.

UUIDs or ULIDs are appropriate choices.

---

# 27. Development Phases

## Phase 1 — Foundation

Build:

- Authentication
- Encryption and key handling
- Roles and permissions
- Audit logging
- PostgreSQL schema
- Backup system
- Restore procedure
- Clinic settings

Success criterion:

The application can securely create users and clinic records and safely store encrypted data.

---

## Phase 2 — Patient MVP

Build:

- Patient registration
- Patient search
- Profile photo capture
- Patient profile
- Patient notes
- Barcode generation
- Barcode lookup
- Basic patient timeline

Success criterion:

Clinic staff can register, find, open, and update patient records reliably.

---

## Phase 3 — Clinical Records

Build:

- Encounters
- Medical / illness history
- Symptoms
- Observations
- Clinical notes
- Prescriptions
- Prescription history
- Follow-up dates
- Prescription PDF generation

Success criterion:

The doctor can complete the core consultation workflow digitally.

---

## Phase 4 — Billing and Printing

Build:

- Invoice creation
- Invoice items
- Tax calculations
- Payments
- Invoice status workflow
- A4 invoice PDFs
- Document templates
- Thermal label templates
- Local print agent

Success criterion:

The clinic can bill patients and print invoices and medication labels.

---

## Phase 5 — Appointments and Correspondence

Build:

- Appointment scheduling
- Follow-up queue
- Reminder rules
- Message templates
- WhatsApp integration
- Communication consent
- Automated message triggers
- Message review and approval
- Delivery history

Success criterion:

The clinic can manage scheduled communication and patient follow-ups from within the system.

---

## Phase 6 — Homeopathy Knowledge Library

Build:

- Medicine database
- Aliases
- Medicine relationships
- Symptoms / rubrics
- Citations
- External source metadata
- Search
- Relevance ranking
- Doctor annotations
- Version history

Success criterion:

Doctors can search and maintain a traceable clinical reference library.

---

## Phase 7 — AI Features

Potential features:

- Draft patient correspondence
- Summarize previous visits
- Generate visit summaries
- Suggest message wording
- Improve knowledge library search
- Extract candidate structured symptoms from doctor-entered text
- Summarize patient history before consultation

AI output should remain reviewable and should not independently prescribe treatment.

---

# 28. Engineering Principles

These principles should be written into the architecture documentation before development.

## Patient data is not the UI

UI redesigns should not require database redesigns.

## Clinical encounters are historical

Corrections should preserve audit history.

## Invoice data is not invoice appearance

Templates may change without changing accounting records.

## Prescription data is not label appearance

Label designs should remain replaceable.

## WhatsApp is not the messaging system

WhatsApp should be one communication adapter.

## The knowledge library is not the patient record

These are separate data domains.

## AI is not the authority

AI may generate drafts, summaries, and suggestions. Clinicians remain responsible for clinical decisions.

## Barcode is not medical information

Barcodes should contain opaque identifiers only.

## Passwords are not encryption keys

Passwords should unlock encryption keys rather than directly encrypting all stored data.

## Backups are part of the product

A medical record system is not reliable unless backup restoration has been tested.

## Historical records should stay historical

Changing current patient, clinic, or billing information should not rewrite previously issued clinical or financial documents.

---

# 29. Proposed Product Navigation

```text
Clinic
│
├── Dashboard
├── Patients
│   └── Patient 360°
├── Appointments
├── Clinical
│   ├── Visits
│   ├── Prescriptions
│   └── Homeopathy Library
├── Communications
│   ├── WhatsApp
│   ├── Follow-ups
│   └── Campaigns
├── Billing
├── Documents & Printing
└── Administration
```

This structure can support a single-doctor practice initially and later grow into a multi-doctor, multi-staff, or multi-clinic platform.

---

# 30. Recommended Next Design Artifacts

The next documents to create are:

1. **Database ERD**
   - Tables
   - Fields
   - Relationships
   - Indexes
   - Constraints
   - Revision/audit rules

2. **Screen and Workflow Specification**
   - Patient registration
   - Patient profile
   - New encounter
   - Prescription workflow
   - Invoice workflow
   - WhatsApp message approval
   - Barcode scan behavior
   - Print behavior

3. **Security Architecture**
   - Authentication
   - Key lifecycle
   - Recovery key
   - Encryption boundaries
   - Roles and permissions
   - Audit event model
   - Backup and restore

4. **MVP Product Requirements Document**
   - In-scope features
   - Out-of-scope features
   - Acceptance criteria
   - User roles
   - Major workflows

5. **Homeopathy Knowledge Base Specification**
   - Medicine schema
   - Symptom/rubric model
   - Source provenance
   - Relationship types
   - Search behavior
   - Versioning rules
   - Import workflow

---

# 31. Recommended Build Order Summary

```text
Foundation
    ↓
Patient Registry
    ↓
Clinical Encounters
    ↓
Prescriptions
    ↓
Billing + PDFs
    ↓
Printing
    ↓
Appointments
    ↓
WhatsApp Correspondence
    ↓
Knowledge Library
    ↓
AI Assistance
    ↓
Optional Inventory / Advanced Features
```

The objective is to produce a useful clinic application early, while keeping the architecture stable enough to support more advanced features later.
