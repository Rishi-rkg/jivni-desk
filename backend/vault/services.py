"""Who can open a clinic's key, and how.

The clinic master key exists in plaintext only in memory, during a request made by someone who
unlocked it with their password. It is sealed separately for each such person ("grant"), and once
more for the recovery key the owner keeps offline. Changing a password re-seals that person's
grants; it never touches patient data.
"""

import secrets

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from accounts.models import Membership

from . import crypto
from .models import ClinicKey, KeyGrant

RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32: no I, L, O or U
RECOVERY_BYTES = 25  # 200 bits, shown as ten groups of four


class VaultError(Exception):
    """A key operation that cannot proceed. Messages are safe to show to the person asking."""


def kdf_params():
    return {"alg": "argon2id", **settings.VAULT_KDF}


# --- recovery key text


def new_recovery_key():
    number = int.from_bytes(secrets.token_bytes(RECOVERY_BYTES), "big")
    symbols = [RECOVERY_ALPHABET[(number >> shift) & 31] for shift in range(195, -1, -5)]
    return "-".join("".join(symbols[index : index + 4]) for index in range(0, 40, 4))


@sensitive_variables()
def recovery_secret(text):
    """The bytes behind a typed recovery key. Forgives case, spaces, dashes and look-alike letters."""
    cleaned = "".join(str(text).upper().split()).replace("-", "")
    cleaned = cleaned.replace("O", "0").replace("I", "1").replace("L", "1")
    if len(cleaned) != 40 or any(symbol not in RECOVERY_ALPHABET for symbol in cleaned):
        raise VaultError("That is not a valid recovery key.")
    number = 0
    for symbol in cleaned:
        number = (number << 5) | RECOVERY_ALPHABET.index(symbol)
    return number.to_bytes(RECOVERY_BYTES, "big")


# --- grants


def _grant_aad(clinic_key, kind, user_id):
    return crypto.associated_data("grant", clinic_key.clinic_id, clinic_key.version, kind, user_id)


@sensitive_variables()
def _seal_grant(clinic_key, master, kind, secret, user=None, created_by=None):
    salt, params = crypto.random_salt(), kdf_params()
    wrapping = crypto.derive_key(secret, salt, params)
    return KeyGrant.objects.create(
        clinic_key=clinic_key,
        kind=kind,
        user=user,
        salt=salt,
        kdf=params,
        sealed_key=crypto.seal(wrapping, master, _grant_aad(clinic_key, kind, user.pk if user else None)),
        created_by=created_by,
    )


@sensitive_variables()
def _open_grant(grant, secret):
    wrapping = crypto.derive_key(secret, bytes(grant.salt), grant.kdf)
    return crypto.unseal(wrapping, bytes(grant.sealed_key), _grant_aad(grant.clinic_key, grant.kind, grant.user_id))


def _revoke(grants):
    # The sealed copy is destroyed, not just marked, so a later database copy cannot be used with an old password.
    return grants.filter(revoked_at__isnull=True).update(revoked_at=timezone.now(), sealed_key=b"", salt=b"")


@transaction.atomic
@sensitive_variables()
def create_clinic_key(clinic, owner, password):
    """First key for a clinic. Returns the recovery key, which is shown once and never stored."""
    if ClinicKey.objects.filter(clinic=clinic).exists():
        raise VaultError("This clinic already has an encryption key.")
    clinic_key = ClinicKey.objects.create(clinic=clinic, version=1)
    master = crypto.random_key()
    _seal_grant(clinic_key, master, KeyGrant.Kind.USER, password, user=owner, created_by=owner)
    recovery = new_recovery_key()
    _seal_grant(clinic_key, master, KeyGrant.Kind.RECOVERY, recovery_secret(recovery), created_by=owner)
    from . import backup  # local import: backup builds on this module

    backup.ensure_backup_key(clinic_key, master)
    return recovery


@sensitive_variables()
def unlock(user, password):
    """Clinic keys this password opens: {clinic_id: {version: key}}. Only clinics with an active membership."""
    clinics = Membership.objects.filter(user=user, is_active=True).values_list("clinic_id", flat=True)
    grants = KeyGrant.objects.filter(
        user=user, kind=KeyGrant.Kind.USER, revoked_at__isnull=True, clinic_key__clinic_id__in=list(clinics)
    ).select_related("clinic_key")
    unlocked = {}
    for grant in grants:
        try:
            master = _open_grant(grant, password)
        except (crypto.DecryptionError, ValueError, KeyError):
            continue  # sealed for an earlier password; the clinic stays locked until access is granted again
        unlocked.setdefault(grant.clinic_key.clinic_id, {})[grant.clinic_key.version] = master
    return unlocked


@transaction.atomic
@sensitive_variables()
def grant_access(clinic, clinic_keys, user, password, granted_by=None):
    """Seal every version of the clinic key for another member. `clinic_keys` comes from someone already unlocked."""
    if not Membership.objects.filter(user=user, clinic=clinic, is_active=True).exists():
        raise VaultError("Only an active member of the clinic can be given access.")
    versions = {key.version: key for key in ClinicKey.objects.filter(clinic=clinic)}
    if not versions or set(versions) - set(clinic_keys):
        raise VaultError("The clinic's records must be unlocked before access can be granted.")
    _revoke(KeyGrant.objects.filter(user=user, kind=KeyGrant.Kind.USER, clinic_key__clinic=clinic))
    for version, clinic_key in versions.items():
        _seal_grant(clinic_key, clinic_keys[version], KeyGrant.Kind.USER, password, user=user, created_by=granted_by)


@transaction.atomic
def revoke_access(clinic, user):
    return _revoke(KeyGrant.objects.filter(user=user, kind=KeyGrant.Kind.USER, clinic_key__clinic=clinic))


@transaction.atomic
@sensitive_variables()
def change_password(user, old_password, new_password):
    """Re-seal this person's grants for a new password. Patient data is not read or rewritten."""
    resealed = 0
    grants = KeyGrant.objects.select_for_update().filter(user=user, kind=KeyGrant.Kind.USER, revoked_at__isnull=True)
    for grant in grants.select_related("clinic_key"):
        try:
            master = _open_grant(grant, old_password)
        except crypto.DecryptionError:
            continue
        salt, params = crypto.random_salt(), kdf_params()
        grant.salt, grant.kdf = salt, params
        grant.sealed_key = crypto.seal(
            crypto.derive_key(new_password, salt, params), master, _grant_aad(grant.clinic_key, grant.kind, user.pk)
        )
        grant.save(update_fields=["salt", "kdf", "sealed_key"])
        resealed += 1
    return resealed


@sensitive_variables()
def recover(clinic, recovery_key):
    """Open the clinic's keys with the recovery key: {version: key}."""
    secret = recovery_secret(recovery_key)
    grants = KeyGrant.objects.filter(kind=KeyGrant.Kind.RECOVERY, revoked_at__isnull=True, clinic_key__clinic=clinic)
    opened = {}
    for grant in grants.select_related("clinic_key"):
        try:
            opened[grant.clinic_key.version] = _open_grant(grant, secret)
        except crypto.DecryptionError:
            raise VaultError("That recovery key does not open this clinic's records.") from None
    if not opened:
        raise VaultError("This clinic has no recovery key.")
    return opened


@transaction.atomic
@sensitive_variables()
def replace_recovery_key(clinic, clinic_keys, replaced_by=None):
    """Issue a new recovery key and destroy the old one, for example after it has been used or seen."""
    versions = {key.version: key for key in ClinicKey.objects.filter(clinic=clinic)}
    if not versions or set(versions) - set(clinic_keys):
        raise VaultError("The clinic's records must be unlocked before the recovery key can be replaced.")
    _revoke(KeyGrant.objects.filter(kind=KeyGrant.Kind.RECOVERY, clinic_key__clinic=clinic))
    recovery = new_recovery_key()
    for version, clinic_key in versions.items():
        _seal_grant(clinic_key, clinic_keys[version], KeyGrant.Kind.RECOVERY, recovery_secret(recovery), created_by=replaced_by)
    return recovery


def current_version(clinic_keys):
    return max(clinic_keys)
