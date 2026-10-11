"""Built-in backups: the whole database and every stored file in one encrypted file.

A backup can be made at any time, even when nobody is signed in, because it is locked with the
clinic's backup *public* key. It can be opened only with the matching private key, which is itself
sealed under the clinic key. So restoring needs the backup file plus an owner or staff password,
or the recovery key: the same things that open the records. There is no unencrypted mode.

File layout:

    "JVNB1\\n" | 4-byte header length | header (JSON, readable) | sealed chunks

The readable header holds only what is needed to open the file: key identifiers and the sealed
copies of the keys. Everything else, including how many patients there are, is inside the sealed part.
"""

import base64
import datetime
import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path

from django.apps import apps
from django.core import serializers
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.management.color import no_style
from django.db import connection, transaction
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from accounts.models import Clinic

from . import crypto, services
from .models import BackupKey, BackupPlace, BackupPolicy, BackupRun, ClinicKey, KeyGrant

MAGIC = b"JVNB1\n"
FORMAT = 1
EXTENSION = ".jivni"
PREFIX = "jivni-backup-"
STAMP = "%Y%m%d-%H%M%S"
APPS = ["accounts", "records", "audit", "vault", "billing", "printing", "scheduling", "messaging"]
BLOCK_BYTES = 64 * 1024
MAX_HEADER_BYTES = 1024 * 1024

ENTRY_END, ENTRY_MANIFEST, ENTRY_DATABASE, ENTRY_FILE = 0, 1, 2, 3


class BackupError(Exception):
    """A backup or restore that cannot proceed. Messages are safe to show and never contain patient data."""


def _b64(data):
    return base64.b64encode(bytes(data)).decode("ascii")


def _unb64(text):
    return base64.b64decode(text.encode("ascii"))


def _private_aad(clinic_id, version):
    return crypto.associated_data("backup-private", clinic_id, version)


def _file_key_aad(clinic_id, version):
    return crypto.associated_data("backup-file-key", clinic_id, version)


# --- keys


@sensitive_variables()
def ensure_backup_key(clinic_key, master):
    """Create the backup key pair for a clinic key if it has none. Needs the clinic key, so call it while unlocked."""
    existing = BackupKey.objects.filter(clinic_key=clinic_key).first()
    if existing:
        return existing
    private, public = crypto.new_keypair()
    sealed = crypto.seal(master, private, _private_aad(clinic_key.clinic_id, clinic_key.version))
    return BackupKey.objects.create(clinic_key=clinic_key, public_key=public, sealed_private=sealed)


@sensitive_variables()
def ensure_backup_keys(unlocked):
    """After sign-in: `unlocked` is {clinic_id: {version: key}} from services.unlock()."""
    for clinic_id, versions in unlocked.items():
        for clinic_key in ClinicKey.objects.filter(clinic_id=clinic_id, backup_key__isnull=True):
            if clinic_key.version in versions:
                ensure_backup_key(clinic_key, versions[clinic_key.version])


def _current_backup_key(clinic):
    clinic_key = ClinicKey.objects.filter(clinic=clinic, retired_at__isnull=True).order_by("-version").first()
    if not clinic_key:
        raise BackupError("This clinic has no encryption key yet, so a backup cannot be encrypted.")
    backup_key = BackupKey.objects.filter(clinic_key=clinic_key).first()
    if not backup_key:
        raise BackupError("Sign in once as someone who can open the records to finish setting up backups.")
    return clinic_key, backup_key


# --- writing


class _SealedWriter:
    """Buffers plaintext into chunks, seals each, and writes length-prefixed sealed chunks."""

    def __init__(self, raw, sealer, digest):
        self._raw, self._sealer, self._digest, self._buffer = raw, sealer, digest, bytearray()
        self.size = 0

    def write(self, data):
        self._buffer += data
        # Strictly greater: something is always left for the final, marked chunk.
        while len(self._buffer) > crypto.STREAM_CHUNK_BYTES:
            self._emit(bytes(self._buffer[: crypto.STREAM_CHUNK_BYTES]), final=False)
            del self._buffer[: crypto.STREAM_CHUNK_BYTES]

    def close(self):
        self._emit(bytes(self._buffer), final=True)
        self._buffer.clear()

    def _emit(self, chunk, final):
        sealed = self._sealer.seal(chunk, final=final)
        framed = len(sealed).to_bytes(4, "big") + sealed
        self._raw.write(framed)
        self._digest.update(framed)
        self.size += len(framed)


class _EntryWriter:
    """One named item inside the sealed stream, written as length-prefixed blocks."""

    def __init__(self, sealed, kind, name):
        self._sealed = sealed
        encoded = name.encode("utf-8")
        sealed.write(bytes([kind]) + len(encoded).to_bytes(2, "big") + encoded)

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        for start in range(0, len(data), BLOCK_BYTES):
            block = data[start : start + BLOCK_BYTES]
            self._sealed.write(len(block).to_bytes(4, "big") + block)

    def close(self):
        self._sealed.write((0).to_bytes(4, "big"))


def _backup_models():
    return [model for app in APPS for model in apps.get_app_config(app).get_models() if model is not BackupRun]


def _database_objects():
    for model in _backup_models():
        yield from model._base_manager.order_by("pk").iterator(chunk_size=500)


def _stored_files():
    from records.models import PatientDocument, PatientPhoto

    return [
        *PatientPhoto.objects.order_by("pk").values_list("storage_key", flat=True),
        *PatientDocument.objects.order_by("pk").values_list("storage_key", flat=True),
    ]


def _manifest(clinic, files):
    from records.models import Encounter, Patient

    return {
        "format": FORMAT,
        "created_at": timezone.now().isoformat(),
        "clinic_name": clinic.name,
        "database": connection.vendor,
        "counts": {
            "patients": Patient.objects.count(),
            "visits": Encounter.objects.count(),
            "files": len(files),
            "records": sum(model._base_manager.count() for model in _backup_models()),
        },
    }


def write_backup(clinic, target):
    """Write one backup file to `target` (a path). Returns (byte_size, sha256, manifest)."""
    clinic_key, backup_key = _current_backup_key(clinic)
    file_key, prefix = crypto.random_key(), os.urandom(crypto.STREAM_PREFIX_BYTES)
    grants = KeyGrant.objects.filter(clinic_key=clinic_key, revoked_at__isnull=True)
    header = json.dumps(
        {
            "format": FORMAT,
            "clinic_id": str(clinic.pk),
            "key_version": clinic_key.version,
            "sealed_private": _b64(backup_key.sealed_private),
            "sealed_file_key": _b64(
                crypto.seal_to_public(bytes(backup_key.public_key), file_key, _file_key_aad(clinic.pk, clinic_key.version))
            ),
            "stream_prefix": _b64(prefix),
            # Sealed copies of the clinic key, so the file can be opened on a computer that has nothing else.
            "grants": [
                {
                    "kind": grant.kind,
                    "user_id": str(grant.user_id) if grant.user_id else None,
                    "salt": _b64(grant.salt),
                    "kdf": grant.kdf,
                    "sealed_key": _b64(grant.sealed_key),
                }
                for grant in grants
            ],
        },
        sort_keys=True,
    ).encode("utf-8")
    opening = MAGIC + len(header).to_bytes(4, "big") + header
    digest = hashlib.sha256(opening)
    files = _stored_files()
    manifest = _manifest(clinic, files)
    with open(target, "wb") as raw:
        raw.write(opening)
        sealed = _SealedWriter(raw, crypto.StreamSealer(file_key, prefix, hashlib.sha256(opening).digest()), digest)
        entry = _EntryWriter(sealed, ENTRY_MANIFEST, "manifest.json")
        entry.write(json.dumps(manifest))
        entry.close()
        entry = _EntryWriter(sealed, ENTRY_DATABASE, "database.jsonl")
        serializers.serialize("jsonl", _database_objects(), stream=entry)
        entry.close()
        for name in files:
            entry = _EntryWriter(sealed, ENTRY_FILE, name)
            with default_storage.open(name, "rb") as stored:
                for block in iter(lambda stored=stored: stored.read(BLOCK_BYTES), b""):
                    entry.write(block)
            entry.close()
        sealed.write(bytes([ENTRY_END]))
        sealed.close()
        raw.flush()
        os.fsync(raw.fileno())
    return len(opening) + sealed.size, digest.hexdigest(), manifest


# --- reading


def read_header(raw):
    if raw.read(len(MAGIC)) != MAGIC:
        raise BackupError("This is not a Jivni backup file.")
    length = int.from_bytes(raw.read(4), "big")
    if not 0 < length <= MAX_HEADER_BYTES:
        raise BackupError("The backup file is damaged.")
    encoded = raw.read(length)
    try:
        header = json.loads(encoded)
    except ValueError:
        raise BackupError("The backup file is damaged.") from None
    if header.get("format") != FORMAT:
        raise BackupError("This backup was made by a newer version of the application.")
    return header, hashlib.sha256(MAGIC + length.to_bytes(4, "big") + encoded).digest()


@sensitive_variables()
def _master_from_secret(header, password=None, recovery_key=None):
    clinic_id, version = uuid.UUID(header["clinic_id"]), header["key_version"]
    kind = KeyGrant.Kind.RECOVERY if recovery_key is not None else KeyGrant.Kind.USER
    secret = services.recovery_secret(recovery_key) if recovery_key is not None else password
    for grant in header["grants"]:
        if grant["kind"] != kind:
            continue
        user_id = uuid.UUID(grant["user_id"]) if grant["user_id"] else None
        try:
            wrapping = crypto.derive_key(secret, _unb64(grant["salt"]), grant["kdf"])
            return crypto.unseal(wrapping, _unb64(grant["sealed_key"]), crypto.associated_data("grant", clinic_id, version, kind, user_id))
        except (crypto.DecryptionError, ValueError, KeyError):
            continue
    raise BackupError("That password or recovery key does not open this backup.")


@sensitive_variables()
def _file_key(header, master):
    clinic_id, version = uuid.UUID(header["clinic_id"]), header["key_version"]
    try:
        private = crypto.unseal(master, _unb64(header["sealed_private"]), _private_aad(clinic_id, version))
        return crypto.open_with_private(private, _unb64(header["sealed_file_key"]), _file_key_aad(clinic_id, version))
    except (crypto.DecryptionError, ValueError, KeyError):
        raise BackupError("This backup cannot be opened with that key.") from None


class _SealedReader:
    def __init__(self, raw, opener):
        self._raw, self._opener, self._buffer, self._finished = raw, opener, bytearray(), False
        self._next = self._read_frame()

    def _read_frame(self):
        length = self._raw.read(4)
        if not length:
            return None
        if len(length) != 4:
            raise BackupError("The backup file is cut short.")
        sealed = self._raw.read(int.from_bytes(length, "big"))
        if len(sealed) != int.from_bytes(length, "big"):
            raise BackupError("The backup file is cut short.")
        return sealed

    def _fill(self):
        if self._next is None:
            raise BackupError("The backup file is cut short.")
        current, self._next = self._next, self._read_frame()
        final = self._next is None
        try:
            self._buffer += self._opener.open(current, final=final)
        except crypto.DecryptionError:
            raise BackupError("The backup file is damaged or was changed.") from None
        self._finished = final

    def read(self, size):
        while len(self._buffer) < size:
            if self._finished:
                raise BackupError("The backup file is cut short.")
            self._fill()
        data = bytes(self._buffer[:size])
        del self._buffer[:size]
        return data

    def finish(self):
        """After the end marker nothing may follow, and the last chunk must have been the marked final one."""
        while not self._finished:
            self._fill()
        if self._buffer:
            raise BackupError("The backup file is damaged.")


def _entries(reader):
    """Yield (kind, name, blocks). Each `blocks` iterator must be used up before asking for the next entry."""
    while True:
        kind = reader.read(1)[0]
        if kind == ENTRY_END:
            reader.finish()
            return
        name = reader.read(int.from_bytes(reader.read(2), "big")).decode("utf-8")

        def blocks():
            while True:
                size = int.from_bytes(reader.read(4), "big")
                if not size:
                    return
                yield reader.read(size)

        yield kind, name, blocks()


def _lines(blocks):
    rest = b""
    for block in blocks:
        *complete, rest = (rest + block).split(b"\n")
        for line in complete:
            if line.strip():
                yield line.decode("utf-8")
    if rest.strip():
        yield rest.decode("utf-8")


@sensitive_variables()
def _open(raw, clinic_keys=None, password=None, recovery_key=None):
    header, header_hash = read_header(raw)
    try:
        if clinic_keys is not None:
            master = clinic_keys.get(header["key_version"])
            if master is None:
                raise BackupError("This backup belongs to a different key than the one that is unlocked.")
        else:
            master = _master_from_secret(header, password=password, recovery_key=recovery_key)
        opener = crypto.StreamOpener(_file_key(header, master), _unb64(header["stream_prefix"]), header_hash)
    except (ValueError, KeyError, TypeError, crypto.DecryptionError):
        # The readable header is not trusted: anything malformed in it is simply a damaged file.
        raise BackupError("The backup file is damaged.") from None
    return header, _SealedReader(raw, opener)


@sensitive_variables()
def verify_backup(path, clinic_keys=None, password=None, recovery_key=None):
    """Read the whole backup back: every chunk, every record, every file. Changes nothing. Returns the manifest."""
    with open(path, "rb") as raw:
        _, reader = _open(raw, clinic_keys, password, recovery_key)
        manifest, records, files = None, 0, 0
        for kind, _name, blocks in _entries(reader):
            if kind == ENTRY_MANIFEST:
                manifest = json.loads(b"".join(blocks))
            elif kind == ENTRY_DATABASE:
                for line in _lines(blocks):
                    json.loads(line)
                    records += 1
            else:
                for _block in blocks:
                    pass
                files += 1
    if manifest is None or records != manifest["counts"]["records"] or files != manifest["counts"]["files"]:
        raise BackupError("The backup does not contain everything it says it does.")
    return manifest


@sensitive_variables()
def restore_backup(path, password=None, recovery_key=None):
    """Restore into an empty installation. Refuses if any clinic already exists. Returns the manifest."""
    if Clinic.objects.exists():
        raise BackupError("This installation already has data. A backup can only be restored into an empty one.")
    restored_files, manifest = [], None
    with open(path, "rb") as raw:
        _, reader = _open(raw, None, password, recovery_key)
        try:
            with transaction.atomic():
                for kind, name, blocks in _entries(reader):
                    if kind == ENTRY_MANIFEST:
                        manifest = json.loads(b"".join(blocks))
                    elif kind == ENTRY_DATABASE:
                        deferred = []
                        for item in serializers.deserialize("jsonl", _lines(blocks), handle_forward_references=True):
                            item.save()
                            if item.deferred_fields:
                                deferred.append(item)
                        for item in deferred:
                            item.save_deferred_fields()
                    else:
                        if default_storage.exists(name):
                            raise BackupError("A stored file already exists where the backup would put one.")
                        saved = default_storage.save(name, ContentFile(b"".join(blocks)))
                        restored_files.append(saved)
                        if saved != name:
                            raise BackupError("A stored file could not be put back under its own name.")
                statements = connection.ops.sequence_reset_sql(no_style(), _backup_models())
                with connection.cursor() as cursor:
                    for statement in statements:
                        cursor.execute(statement)
        except Exception:
            for name in restored_files:
                default_storage.delete(name)
            raise
    if manifest is None:
        raise BackupError("The backup file is damaged.")
    return manifest


# --- places, schedule and housekeeping


def check_folder(folder):
    """Make sure backups can really be written to and read from this folder. Returns free bytes."""
    path = Path(folder)
    if not path.is_absolute():
        raise BackupError("Give the full path of the folder.")
    if not path.is_dir():
        raise BackupError("That folder cannot be reached from this computer.")
    probe = path / f".jivni-write-test-{uuid.uuid4().hex}"
    try:
        probe.write_bytes(b"jivni")
        if probe.read_bytes() != b"jivni":
            raise BackupError("A test file could not be read back from that folder.")
    except OSError:
        raise BackupError("A test file could not be written to that folder.") from None
    finally:
        try:
            probe.unlink()
        except OSError:
            pass
    return shutil.disk_usage(path).free


def backup_files(folder):
    """[(when, path)] for backup files in a folder, newest first. Only files this application named."""
    found = []
    try:
        candidates = list(Path(folder).glob(f"{PREFIX}*{EXTENSION}"))
    except OSError:
        return []
    for path in candidates:
        try:
            when = datetime.datetime.strptime(path.name[len(PREFIX) : -len(EXTENSION)], STAMP).replace(tzinfo=datetime.UTC)
        except ValueError:
            continue
        found.append((when, path))
    return sorted(found, reverse=True)


def prune(folder, policy, now=None):
    """Delete backups the policy no longer keeps. Never the newest, and never a file this application did not name."""
    now = now or timezone.now()
    files = backup_files(folder)
    first_of_month = {}
    for when, path in files:
        first_of_month[(when.year, when.month)] = path  # newest first, so the last one seen is the earliest
    removed = []
    for index, (when, path) in enumerate(files):
        age_days = (now - when).days
        if index == 0 or age_days <= policy.keep_daily_days:
            continue
        monthly = first_of_month[(when.year, when.month)] == path
        if monthly and (policy.keep_monthly_months == 0 or age_days <= policy.keep_monthly_months * 31):
            continue
        try:
            path.unlink()
            removed.append(path.name)
        except OSError:
            pass
    return removed


def policy_for(clinic):
    return BackupPolicy.objects.get_or_create(clinic=clinic)[0]


def last_success(clinic):
    return BackupRun.objects.filter(clinic=clinic, ok=True).order_by("-finished_at").first()


def is_due(clinic, now=None):
    """True when the schedule calls for a backup that has not been made yet."""
    policy = policy_for(clinic)
    if not policy.automatic or not BackupPlace.objects.filter(clinic=clinic).exists():
        return False
    last = last_success(clinic)
    if last is None:
        return True
    now = (now or timezone.now()).astimezone(clinic.tzinfo)
    done = last.finished_at.astimezone(clinic.tzinfo)
    if policy.frequency == BackupPolicy.Frequency.WEEKLY:
        return now - done >= datetime.timedelta(days=7)
    slot = datetime.datetime.combine(now.date(), policy.at, tzinfo=clinic.tzinfo)
    step = datetime.timedelta(hours=12 if policy.frequency == BackupPolicy.Frequency.TWICE_DAILY else 24)
    while slot > now:
        slot -= step
    while slot + step <= now:
        slot += step
    return done < slot


def is_overdue(clinic, now=None):
    """For the dashboard warning: no successful backup for longer than the policy tolerates."""
    last = last_success(clinic)
    if last is None:
        return True
    return (now or timezone.now()) - last.finished_at > datetime.timedelta(days=policy_for(clinic).warn_after_days)


def _describe(error):
    """An operating-system error without paths that might be private; never patient data."""
    return f"{type(error).__name__}: {error.strerror or 'could not write'}"[:300] if isinstance(error, OSError) else str(error)[:300]


def run_backup(clinic, kind=BackupRun.Kind.MANUAL, user=None):
    """Make one backup and copy it to every place. Returns the BackupRun, which says what happened where."""
    if Clinic.objects.count() != 1:
        raise BackupError("Backups are available when this installation holds exactly one clinic.")
    places = list(BackupPlace.objects.filter(clinic=clinic))
    if not places:
        raise BackupError("Add a place to save backups to first.")
    _current_backup_key(clinic)
    run = BackupRun.objects.create(clinic=clinic, kind=kind, started_by=user)
    name = f"{PREFIX}{timezone.now().astimezone(datetime.UTC).strftime(STAMP)}{EXTENSION}"
    policy, results, source = policy_for(clinic), [], None
    for place in places:
        target = Path(place.folder) / name
        partial = target.with_name(target.name + ".partial")
        try:
            if source is None:
                run.byte_size, run.sha256, _ = write_backup(clinic, partial)
            else:
                shutil.copyfile(source, partial)
            os.replace(partial, target)
            source = source or target
            place.last_ok_at, place.last_error = timezone.now(), ""
            results.append({"place": str(place.pk), "name": place.name, "ok": True})
            prune(place.folder, policy)
        except (OSError, BackupError) as error:
            try:
                partial.unlink()
            except OSError:
                pass
            place.last_error = _describe(error)
            results.append({"place": str(place.pk), "name": place.name, "ok": False, "error": place.last_error})
        place.save(update_fields=["last_ok_at", "last_error"])
    run.places, run.ok = results, any(result["ok"] for result in results)
    run.file_name = name if run.ok else ""
    run.error = "" if run.ok else "The backup could not be saved to any place."
    run.finished_at = timezone.now()
    run.save()
    return run


def find_file(run):
    """Path of a run's backup file in the first place that still has it."""
    for place in BackupPlace.objects.filter(clinic=run.clinic):
        path = Path(place.folder) / run.file_name
        if run.file_name and path.is_file():
            return path
    return None
