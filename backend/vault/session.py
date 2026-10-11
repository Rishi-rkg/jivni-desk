"""Keeping a clinic key available for the length of a signed-in session, and no longer.

At sign-in the clinic keys are sealed under a random session key. The sealed copies go into the
server-side session; the session key goes to the browser in its own HttpOnly cookie. A request
needs both halves. A copy of the database alone, or of the cookie alone, opens nothing. Signing
out, the idle timeout, or the session expiring destroys the server half.
"""

import base64
import uuid

from django.conf import settings
from django.views.decorators.debug import sensitive_variables

from . import crypto

COOKIE = "clinic_unlock"
COOKIE_PATH = "/api/"
SESSION_KEY = "vault"


class ClinicLocked(Exception):
    """The signed-in person has not unlocked this clinic's records in this session."""


def _aad(clinic_id, version, user_id):
    return crypto.associated_data("session", clinic_id, version, user_id)


@sensitive_variables()
def start(request, response, unlocked):
    """Call after login(). `unlocked` is the result of services.unlock()."""
    if not unlocked:
        end(request, response)
        return
    session_key = crypto.random_key()
    request.session[SESSION_KEY] = {
        str(clinic_id): {
            str(version): base64.b64encode(crypto.seal(session_key, master, _aad(clinic_id, version, request.user.pk))).decode("ascii")
            for version, master in versions.items()
        }
        for clinic_id, versions in unlocked.items()
    }
    response.set_cookie(
        COOKIE,
        base64.urlsafe_b64encode(session_key).decode("ascii"),
        httponly=True,
        secure=settings.SESSION_COOKIE_SECURE,
        samesite="Strict",
        path=COOKIE_PATH,
    )


def end(request, response):
    request.session.pop(SESSION_KEY, None)
    response.delete_cookie(COOKIE, path=COOKIE_PATH, samesite="Strict")


class RequestVault:
    """Per-request access to the clinic keys this session has unlocked. Opened lazily, never cached beyond the request."""

    def __init__(self, request):
        self._request = request
        self._opened = {}

    @sensitive_variables()
    def keys(self, clinic_id):
        """{version: key} for a clinic, or raise ClinicLocked."""
        clinic_id = uuid.UUID(str(clinic_id))
        if clinic_id in self._opened:
            return self._opened[clinic_id]
        request = self._request
        sealed = request.session.get(SESSION_KEY, {}).get(str(clinic_id)) if request.user.is_authenticated else None
        cookie = request.COOKIES.get(COOKIE)
        if not sealed or not cookie:
            raise ClinicLocked()
        try:
            session_key = base64.urlsafe_b64decode(cookie.encode("ascii"))
            opened = {
                int(version): crypto.unseal(session_key, base64.b64decode(blob), _aad(clinic_id, int(version), request.user.pk))
                for version, blob in sealed.items()
            }
        except (ValueError, crypto.DecryptionError):
            raise ClinicLocked() from None
        self._opened[clinic_id] = opened
        return opened

    def is_unlocked(self, clinic_id):
        try:
            return bool(self.keys(clinic_id))
        except ClinicLocked:
            return False


class VaultMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.vault = RequestVault(request)
        return self.get_response(request)
