"""Two-step sign-in: a code from an authenticator app, asked for after the password.

The app's secret is sealed under a key made from the person's password, the same way their clinic key is.
A copy of the database alone therefore gives nobody the codes. The price is that the secret can only be
opened while the password is in hand: at sign-in, when it is set up, and when the password changes.
When someone else resets the password, two-step is removed and set up again at the next sign-in.
"""

import time

from django.db import transaction
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from vault import crypto
from vault.services import kdf_params

from . import totp
from .features import feature_on
from .models import Membership, TwoStep

# The clinic's switch asks it of the people who can open clinical records and change the clinic.
REQUIRED_ROLES = {"owner", "clinician"}


def _aad(user):
    return crypto.associated_data("two-step", user.pk)


def enrolled(user):
    return TwoStep.objects.filter(user=user, confirmed_at__isnull=False).exists()


def required_for(user):
    """Whether any clinic this person works in asks their role to use two-step sign-in."""
    members = Membership.objects.filter(user=user, is_active=True, role_id__in=REQUIRED_ROLES).select_related("clinic")
    return any(feature_on(member.clinic, "two_step") for member in members)


@sensitive_variables()
def _seal(row, password, secret):
    row.salt, row.kdf = crypto.random_salt(), kdf_params()
    row.sealed_secret = crypto.seal(crypto.derive_key(password, row.salt, row.kdf), secret.encode("ascii"), _aad(row.user))


@sensitive_variables()
def _open(row, password):
    key = crypto.derive_key(password, bytes(row.salt), row.kdf)
    return crypto.unseal(key, bytes(row.sealed_secret), _aad(row.user)).decode("ascii")


@transaction.atomic
@sensitive_variables()
def start(user, password):
    """Begin setting up: a new secret that does nothing until a code made from it has been typed back."""
    TwoStep.objects.filter(user=user).delete()
    secret = totp.new_secret()
    row = TwoStep(user=user)
    _seal(row, password, secret)
    row.save()
    return secret


@transaction.atomic
@sensitive_variables()
def check(user, password, code, confirming=False):
    """True when the code is right now and has not been used before. Marks it used."""
    row = TwoStep.objects.select_for_update().filter(user=user).first()
    if not row or (bool(row.confirmed_at) == confirming):
        return False
    try:
        secret = _open(row, password)
    except crypto.DecryptionError:
        return False
    step = totp.verify(secret, code, time.time(), row.last_step)
    if step is None:
        return False
    row.last_step = step
    if confirming:
        row.confirmed_at = timezone.now()
    row.save(update_fields=["last_step", "confirmed_at"])
    return True


@sensitive_variables()
def reseal(user, old_password, new_password):
    """Keep two-step working across a change of password made by the person themselves."""
    row = TwoStep.objects.filter(user=user).first()
    if not row:
        return
    try:
        secret = _open(row, old_password)
    except crypto.DecryptionError:
        row.delete()
        return
    _seal(row, new_password, secret)
    row.save(update_fields=["salt", "kdf", "sealed_secret"])


def remove(user):
    return TwoStep.objects.filter(user=user).delete()[0]
