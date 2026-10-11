"""Envelope encryption primitives.

Three layers, each AES-256-GCM with a fresh random nonce:

    data          sealed under a data key (DEK) made for that one value
    data key      sealed under the clinic master key (CMK)
    clinic key    sealed separately for each person who may open it (see services.py)

Every seal authenticates "associated data" that names what the ciphertext is and where it belongs.
A value copied to another clinic, record or field, or altered in any way, fails to open.

Nothing here falls back to plaintext, and no exception carries key material or plaintext.
"""

import os
import uuid
from dataclasses import dataclass

from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.views.decorators.debug import sensitive_variables

KEY_BYTES = 32
NONCE_BYTES = 12
TAG_BYTES = 16
SALT_BYTES = 16
SEALED_KEY_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES
MAGIC = b"DHP1"  # envelope format 1
FORMAT = 1
MAX_TIME_COST = 10
MAX_MEMORY_KIB = 1024 * 1024


class DecryptionError(Exception):
    """Wrong key, wrong context, or the ciphertext was changed. Deliberately carries no detail."""


def random_key():
    return os.urandom(KEY_BYTES)


def random_salt():
    return os.urandom(SALT_BYTES)


def associated_data(label, *parts):
    """Unambiguous byte string for a fixed sequence of values: each part is length-prefixed."""
    out = [b"dochp"]
    for part in (label, *parts):
        if isinstance(part, uuid.UUID):
            raw = part.bytes
        elif isinstance(part, bool):
            raise TypeError("Booleans are not valid associated data.")
        elif isinstance(part, int):
            raw = part.to_bytes(8, "big")
        elif isinstance(part, str):
            raw = part.encode("utf-8")
        elif part is None:
            raw = b""
        else:
            raise TypeError(f"Unsupported associated data type: {type(part).__name__}")
        out.append(len(raw).to_bytes(4, "big") + raw)
    return b"".join(out)


@sensitive_variables()
def seal(key, plaintext, aad):
    if len(key) != KEY_BYTES:
        raise ValueError("Keys are 32 bytes.")
    nonce = os.urandom(NONCE_BYTES)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


@sensitive_variables()
def unseal(key, sealed, aad):
    if len(key) != KEY_BYTES or len(sealed) < NONCE_BYTES + TAG_BYTES:
        raise DecryptionError()
    try:
        return AESGCM(key).decrypt(sealed[:NONCE_BYTES], sealed[NONCE_BYTES:], aad)
    except InvalidTag:
        raise DecryptionError() from None


@sensitive_variables()
def derive_key(secret, salt, params):
    """Argon2id. `params` is stored beside the salt so the cost can be raised later."""
    if isinstance(secret, str):
        secret = secret.encode("utf-8")
    if params.get("alg") != "argon2id":
        raise ValueError("Unsupported key derivation.")
    # The cost is read from the database; refuse values that would stall the server.
    if not (
        1 <= params["time_cost"] <= MAX_TIME_COST and 8 <= params["memory_cost"] <= MAX_MEMORY_KIB and 1 <= params["parallelism"] <= 16
    ):
        raise ValueError("Key derivation cost is out of range.")
    return hash_secret_raw(
        secret=secret,
        salt=salt,
        time_cost=params["time_cost"],
        memory_cost=params["memory_cost"],
        parallelism=params["parallelism"],
        hash_len=KEY_BYTES,
        type=Type.ID,
    )


@dataclass(frozen=True)
class Envelope:
    key_version: int
    sealed_key: bytes
    sealed_data: bytes

    def to_bytes(self):
        return MAGIC + self.key_version.to_bytes(4, "big") + self.sealed_key + self.sealed_data

    @classmethod
    def from_bytes(cls, blob):
        blob = bytes(blob)
        header = len(MAGIC) + 4
        if len(blob) < header + SEALED_KEY_BYTES + NONCE_BYTES + TAG_BYTES or blob[: len(MAGIC)] != MAGIC:
            raise DecryptionError()
        return cls(
            key_version=int.from_bytes(blob[len(MAGIC) : header], "big"),
            sealed_key=blob[header : header + SEALED_KEY_BYTES],
            sealed_data=blob[header + SEALED_KEY_BYTES :],
        )


def _key_aad(clinic_id, key_version, record_id, purpose):
    return associated_data("data-key", clinic_id, key_version, record_id, purpose)


def _data_aad(clinic_id, record_id, purpose):
    return associated_data("data", FORMAT, clinic_id, record_id, purpose)


@sensitive_variables()
def encrypt(clinic_key, key_version, clinic_id, record_id, purpose, plaintext):
    """Seal one value. `purpose` names the field, for example "note.body"."""
    data_key = random_key()
    envelope = Envelope(
        key_version=key_version,
        sealed_key=seal(clinic_key, data_key, _key_aad(clinic_id, key_version, record_id, purpose)),
        sealed_data=seal(data_key, plaintext, _data_aad(clinic_id, record_id, purpose)),
    )
    return envelope.to_bytes()


@sensitive_variables()
def decrypt(clinic_keys, clinic_id, record_id, purpose, blob):
    """Open one value. `clinic_keys` maps key version to clinic key; a missing version fails closed."""
    envelope = Envelope.from_bytes(blob)
    clinic_key = clinic_keys.get(envelope.key_version)
    if clinic_key is None:
        raise DecryptionError()
    data_key = unseal(clinic_key, envelope.sealed_key, _key_aad(clinic_id, envelope.key_version, record_id, purpose))
    return unseal(data_key, envelope.sealed_data, _data_aad(clinic_id, record_id, purpose))


@sensitive_variables()
def rewrap(clinic_keys, new_key, new_version, clinic_id, record_id, purpose, blob):
    """Move a value to a new clinic key version without touching, or seeing, its data."""
    envelope = Envelope.from_bytes(blob)
    old_key = clinic_keys.get(envelope.key_version)
    if old_key is None:
        raise DecryptionError()
    data_key = unseal(old_key, envelope.sealed_key, _key_aad(clinic_id, envelope.key_version, record_id, purpose))
    sealed_key = seal(new_key, data_key, _key_aad(clinic_id, new_version, record_id, purpose))
    return Envelope(new_version, sealed_key, envelope.sealed_data).to_bytes()
