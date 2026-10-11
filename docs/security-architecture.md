# Security architecture

How DocHP protects patient records, what is built today, and what is not. Written to be read by the clinic owner as well as by developers. It complements [encryption.md](encryption.md), which lists the conditions for removing the startup guard.

**Status, 2026-10-11.** The key system is built and tested: clinic keys, password and recovery-key access, session unlock, password change, recovery. **No patient field or file is encrypted yet.** That is the next step, and until it and the checks in section 7 are complete the application still refuses to run outside development mode. Use synthetic data only.

## 1. What we are protecting against

This threat model is a draft for the owner to confirm. Each row says what the design does about it once field encryption is finished.

| Threat | Outcome with the finished design |
| --- | --- |
| A backup or copy of the database is stolen or leaked | The thief gets ciphertext. Opening it needs a staff password or the recovery key, and guessing a password is slowed by Argon2id |
| The server's disk or the whole PC is stolen while nobody is signed in | Same as above. There is no key on the disk |
| A laptop is left unattended while signed in | The workspace locks after 15 idle minutes and the server forgets its half of the key |
| A staff member opens records they have no reason to | Roles limit what each person can read. Every read, refusal and failed sign-in is in the audit log, which nobody can edit |
| A former staff member tries to get back in | Their membership is switched off and their sealed copy of the key is destroyed |
| Someone with database access swaps or copies encrypted values between patients or clinics | Every value is bound to its clinic, record and field, so a moved value fails to open |
| The clinic forgets every password | The recovery key, kept offline by the owner, restores access |
| The clinic loses every password and the recovery key | The records cannot be recovered by anyone. This is the price of the protection above and must be understood before real use |

Not protected by encryption, by design or by nature:

- **A person signed in with a valid password** can read what their role allows. Encryption does not limit an authorised user.
- **A compromised server while staff are signed in.** During a session the server can open records. An attacker who fully controls the running server at that moment can too.
- **Metadata.** Record IDs, timestamps, how many visits a patient has, and who accessed what remain readable to someone holding the database.
- **A weak password.** Argon2id slows guessing; it does not rescue "clinic123". Second-factor sign-in for owners and doctors is planned for this reason.

## 2. The keys

```text
Staff password ──Argon2id──► wrapping key ──opens──► Clinic key ──opens──► Data key ──opens──► one value
Recovery key  ──Argon2id──► wrapping key ──opens──┘   (one per clinic)      (one per value)
```

- **Clinic key.** 32 random bytes per clinic. Never written anywhere in the clear. Versioned, so it can be replaced.
- **Grant.** A copy of the clinic key sealed for one person, using a key derived from their password with Argon2id (64 MiB, 3 passes, 4 lanes; the settings are stored with each grant so they can be raised later). There is one extra grant for the recovery key.
- **Data key.** 32 random bytes made for each stored value, sealed under the clinic key and stored next to the value.
- **Sealing** is AES-256-GCM with a fresh random nonce every time. Each seal also authenticates a label saying what it is: a grant names its clinic, key version and person; a value names its clinic, record and field.

Changing a password re-seals that one person's grants. It does not read or rewrite any patient data. Removing a person destroys their grant. Replacing the clinic key re-seals the small data keys, not the data itself.

A password is never used directly as an encryption key, and passwords are stored only as Argon2 hashes, as before.

## 3. Staying unlocked during a session

At sign-in the password opens the person's grants. The clinic keys are then sealed again under a random session key:

- the sealed copies are kept in the server-side session;
- the session key is sent to the browser in its own cookie (`clinic_unlock`: HttpOnly, SameSite=Strict, sent only to `/api/`).

Each request brings the cookie, and only then can the server open the clinic key, in memory, for that request. A copy of the database alone or of the cookie alone opens nothing. Signing out, the idle lock and session expiry destroy the server's half.

One consequence, already recorded as decision D3 in the build plan: **when nobody is signed in, the server cannot read patient data.** Overnight jobs cannot prepare messages. The plan's answer is to prepare them at sign-in, plus a separate narrow key for fixed reminders.

## 4. The recovery key

Shown once when the clinic is created, as ten groups of four characters. It is not stored anywhere. The owner writes it down and keeps it offline. Using it (`recover_clinic_access`) gives an owner a new password and access, then destroys that recovery key and issues a new one. Whoever holds the recovery key can open the clinic's records, so it deserves the same care as the clinic's cheque book.

## 5. What exists in the code

| Part | Where | State |
| --- | --- | --- |
| Sealing, envelopes, key derivation, key replacement for a value | `backend/vault/crypto.py` | Built, tested |
| Clinic keys and grants | `backend/vault/models.py`, `services.py` | Built, tested |
| Session unlock, the two halves | `backend/vault/session.py` | Built, tested |
| Unlock at sign-in, removal at sign-out | `backend/accounts/views.py` | Built, tested |
| Change password with re-sealing | `POST /api/v1/auth/password/` | Built, tested; no screen yet |
| Create clinic with key and recovery key | `bootstrap_clinic` command | Built, tested |
| Add a user with access | `add_clinic_user --authorized-by` | Built, tested |
| Keys for a clinic created earlier; access for an existing member | `init_clinic_keys`, `grant_clinic_access` | Built, tested |
| Recovery | `recover_clinic_access` command | Built, tested; no screen yet |
| Encrypting patient fields, notes, visits, prescriptions, history, photos | not started | **Next** |
| Searching encrypted names and phone numbers | not started | Needs the design in section 6 |
| Screens: first-time setup, show recovery key, change password, manage staff access | not started | Mockups P5 to P8 |
| Second factor, clinic key replacement procedure, narrow messaging key | not started | Planned |
| Independent review | not done | Required before real data |

## 6. Decisions still needed before fields are encrypted

1. **Search.** Names and phone numbers cannot be searched with SQL once encrypted. Proposed: exact-match keyed hashes for phone and patient code, and a per-clinic name index opened in server memory while the clinic is unlocked. What someone holding only the database could learn from the hashes (that two patients share a phone number, for example) must be written down and accepted.
2. **Existing synthetic rows.** Clinical tables are append-only by database trigger, so existing plaintext rows cannot simply be rewritten. As only synthetic data exists, the proposal is to start encrypted tables empty.
3. **What stays readable.** Proposed plaintext: record IDs, timestamps, which clinic, who wrote it, archived state, and the patient code. Everything else about a patient is encrypted.

## 7. Before real patient data

All of the following, none of which is done:

- every sensitive field and file encrypted, with the tests listed in [encryption.md](encryption.md);
- the search design above built and its leakage documented;
- encrypted backups and a restore that has actually been performed and timed, including recovery with the recovery key;
- second-factor sign-in for owners and doctors;
- a review of this design and its code by someone qualified who did not write it;
- the legal points for India listed in the build plan confirmed with an adviser;
- a written, rehearsed recovery procedure in the owner's hands.
