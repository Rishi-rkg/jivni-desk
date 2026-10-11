# Envelope encryption: implementation gate

**Status 2026-10-11:** the key hierarchy described here is implemented in `backend/vault/`, using the password-unlocked design. See [security-architecture.md](security-architecture.md) for what exists. The rest of this document is unchanged and still describes the conditions for removing the startup guard.

This document describes the planned system. **None of the patient fields or files are encrypted by this MVP.** `RecordProtector`, `KeyManager` and `CiphertextEnvelope` define interfaces, and the unconfigured implementation raises rather than pretending to encrypt. Django password hashing, TLS and volume encryption are separate controls and do not implement these interfaces.

## Key hierarchy

Use random per-record/per-file 256-bit data encryption keys (DEKs). Encrypt sensitive payloads with AES-256-GCM using a unique nonce for each encryption under a given key. Authenticate associated data that binds the ciphertext to the clinic UUID, record UUID, field/payload type and envelope version. Store nonce, authenticated ciphertext/tag, algorithm/version, wrapped DEK and wrapping-key reference in the envelope. A wrong clinic/record context must fail authentication.

Wrap each DEK under a clinic key encryption key (KEK). Keep the wrapping key in a KMS/HSM or a reviewed local key service; do not put it in Django settings, the patient database, source control, container images or application logs. Keys must be obtained only in authorized server operations, and access to the key service must be restricted and audited. Use separate development and production key domains. Do not use the user's password as a patient-data encryption key.

For a password-unlocked local clinic design, random clinic KEKs may be wrapped separately for each authorized user using a reviewed Argon2id password-derived key. Password changes rewrap that user's key grant; they do not re-encrypt every patient record. This introduces unlock state, secure server memory/session lifetimes, revoked grants, multi-user recovery and unattended-job tradeoffs. Decide explicitly whether deployment uses managed KMS access or user-unlocked grants; the MVP implements neither. Do not claim that login currently decrypts data.

## Required implementation work

1. Decide the threat model and which operational metadata may remain plaintext. Encrypt names, birth dates, gender, contact information, addresses, note/encounter content, observations, prescriptions and photos according to that design. UUID relationships and timestamps still reveal metadata; address that explicitly.
2. Add versioned encrypted payload fields and file envelopes. Keep envelope parsing and cryptography in a reviewed implementation of `RecordProtector`; authorization stays mandatory before decryption. No plaintext fallback on missing keys or invalid tags.
3. Replace plaintext search. Define minimal per-clinic keyed search indexes with a documented leakage model (exact/prefix matching exposes equality/frequency), or decrypt bounded authorized sets. Existing SQL `icontains` searches cannot operate on ciphertext and must not be silently retained over plaintext copies.
4. Encrypt private object storage and database/backups where appropriate, plus application-level payload encryption. Prevent PHI in filenames, URLs, logs, telemetry, exception traces, browser storage and audit metadata. Avoid logging patient search query strings at the reverse proxy.
5. Implement key rotation: new writes use the current wrapping-key version; old envelopes remain readable during migration; rewrap DEKs without exposing the key or re-encrypting all payloads. Audit progress, failures and completion; make migration restartable.
6. Implement clinic recovery grants and an offline recovery procedure, including identity checks, independent recovery custody, tested restores and explicit loss-of-key consequences. Never print an encryption recovery key to normal application logs.
7. Revoke access through both membership changes and key grants. In KMS mode, the application can decrypt during authorized operations; encryption at rest alone does not restrict a compromised authorized server.
8. Add transaction-safe encrypted writes, schema migrations for already stored synthetic fixtures, redacted error handling and memory/key lifetime controls. Limit decrypted data to the authorized operation and never persist plaintext temporary files.

## Tests required to remove the startup guard

- Round trips for every sensitive field/file and Unicode/empty/large payloads.
- Rejection of ciphertext/tag/nonce/associated-data tampering and wrong clinic/record contexts.
- Missing/unavailable KMS and revoked grants fail closed.
- Rotation and recovery remain compatible with old envelopes and backups.
- Password changes do not rewrite patient payloads; unauthorized users cannot unwrap clinic keys.
- Database snapshots, object storage, backups, logs and browser persistence contain no selected plaintext identifiers or clinical content.
- Encrypted search and tenant isolation tests; restores include encrypted objects plus protected key recovery material.
- Independent security review of the implementation and key lifecycle.

The production startup guard should be replaced by verified provider configuration checks only after these tests and operational procedures exist. A variable named `encrypted` is not sufficient evidence.
