# Deployment boundary

Compose is local development infrastructure. Its development web servers, database-owner credentials, localhost HTTP and plaintext media volumes are not a production recipe. The application deliberately refuses any mode other than `development-only` until encryption is complete. The installed app (`backend/launcher.py`) is the other way to run it: one program with SQLite, listening on 127.0.0.1 only, with debug pages off.

Before deployment, add and test:

- A same-origin HTTPS reverse proxy serving the React build and forwarding `/api` to Gunicorn. Restrict trusted proxy headers, allowed hosts and CSRF origins. Use secure cookies, TLS and appropriate HSTS only after verifying the deployment domain.
- Managed secrets, a working envelope provider, independent encryption review and secure key recovery. Django's secret key remains a separate application signing secret.
- Separate migration and runtime database identities. Runtime privileges must not allow schema changes, disabling triggers, truncating clinical/audit tables or bypassing record protections. PostgreSQL table owners/superusers can disable triggers; these safeguards do not defend against a database owner. Add transaction-scoped tenant RLS if required by the final threat model; current isolation is enforced in the application, not PostgreSQL RLS.
- A deliberate release step for migrations (backup, review, staged migration, rollback/roll-forward), not automatic development startup migrations. Never rewrite applied migrations.
- Shared Redis or another reviewed cache for atomic login throttling across processes, plus IP/account/global edge rate limits. The included local cache limits repeated username/IP failures for development but is neither distributed nor sufficient against credential stuffing.
- MFA, account recovery, session revocation, access reviews and hardened operator provisioning. No open registration. Sessions expire after eight hours, and after `SESSION_IDLE_SECONDS` (default 15 minutes) without a request; the browser keeps an active user's session alive.
- Encrypted backups of both database and objects, retention rules, immutable off-host audit export, restore drills and recovery objectives. Audit triggers protect ordinary row updates/deletes, not truncation or owner actions.
- PHI-safe observability. Current audit includes record reads/writes, failed and refused sign-ins and refused access, with outcome, source address (`REMOTE_ADDR`; make the proxy set it from a trusted header) and request ID. Encrypted demographic change revisions, retention and off-host export remain future work. Do not log request/response bodies or raw patient search query strings. Generic Django DEBUG error pages are acceptable only for synthetic development.
- Durable asynchronous jobs with outbox/idempotency patterns for future external effects. Never send WhatsApp, AI, invoice or print requests inside patient-record transactions.
- Upload malware scanning where appropriate, orphan-object cleanup/reconciliation, object access monitoring, storage quotas and disaster recovery. Local photos are re-encoded and private, but do not yet have a full document-service lifecycle.
- Dependency/image patching, secret scanning, authorization regression tests, migration compatibility checks, browser integration tests and security assessment.

Determine applicable healthcare/privacy rules with the clinic and qualified advisers before processing real patient data. This foundation is not a claim of regulatory compliance.
