"""Six-digit codes from an authenticator app (RFC 6238 with the usual settings: SHA-1, 30 seconds, 6 digits).

Written out here rather than taken from a package: it is a few lines, and the tests check it against the
published examples.
"""

import base64
import hashlib
import hmac
import secrets
import struct
from urllib.parse import quote

STEP_SECONDS = 30
DIGITS = 6
# A code is accepted for the step it was made in and one either side, for clocks that disagree a little.
WINDOW = 1


def new_secret():
    """A fresh secret as authenticator apps expect it: 160 random bits in base32."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii")


def _key(secret):
    text = "".join(str(secret).upper().split())
    return base64.b32decode(text + "=" * (-len(text) % 8))


def code_at(secret, step, digits=DIGITS):
    digest = hmac.new(_key(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    number = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(number % 10**digits).zfill(digits)


def step_at(moment):
    return int(moment) // STEP_SECONDS


def verify(secret, code, moment, last_step=0):
    """The time step the code belongs to, or None. A step at or before `last_step` was used already and is refused."""
    typed = "".join(char for char in str(code) if char.isdigit())
    if len(typed) != DIGITS:
        return None
    now = step_at(moment)
    for step in range(now - WINDOW, now + WINDOW + 1):
        if step > last_step and hmac.compare_digest(code_at(secret, step), typed):
            return step
    return None


def uri(secret, username, issuer="Jivni"):
    """What the QR code holds, so an authenticator app can add the account by scanning."""
    label = quote(f"{issuer}:{username}", safe="")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer, safe='')}&digits={DIGITS}&period={STEP_SECONDS}"
