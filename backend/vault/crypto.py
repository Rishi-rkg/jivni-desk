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
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.views.decorators.debug import sensitive_variables

KEY_BYTES = 32
NONCE_BYTES = 12
TAG_BYTES = 16
SALT_BYTES = 16
SEALED_KEY_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES
MAGIC = b"JVN1"  # envelope format 1
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
    out = [b"jivni"]
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


# --- sealing to a public key, so something can be locked while the clinic key is not available


def new_keypair():
    """(private, public) X25519 keys as raw 32-byte strings."""
    private = X25519PrivateKey.generate()
    return (
        private.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()),
        private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw),
    )


def _shared_key(shared, ephemeral_public, recipient_public):
    info = b"jivni-seal-to-public" + ephemeral_public + recipient_public
    return HKDF(algorithm=hashes.SHA256(), length=KEY_BYTES, salt=None, info=info).derive(shared)


@sensitive_variables()
def seal_to_public(recipient_public, plaintext, aad):
    """Anyone can seal; only the holder of the private key can open. Returns ephemeral public key + sealed data."""
    ephemeral = X25519PrivateKey.generate()
    ephemeral_public = ephemeral.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    shared = ephemeral.exchange(X25519PublicKey.from_public_bytes(recipient_public))
    return ephemeral_public + seal(_shared_key(shared, ephemeral_public, recipient_public), plaintext, aad)


@sensitive_variables()
def open_with_private(private, sealed, aad):
    if len(private) != KEY_BYTES or len(sealed) < KEY_BYTES + NONCE_BYTES + TAG_BYTES:
        raise DecryptionError()
    ephemeral_public, body = sealed[:KEY_BYTES], sealed[KEY_BYTES:]
    key = X25519PrivateKey.from_private_bytes(private)
    recipient_public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    try:
        shared = key.exchange(X25519PublicKey.from_public_bytes(ephemeral_public))
    except ValueError:
        raise DecryptionError() from None
    return unseal(_shared_key(shared, ephemeral_public, recipient_public), body, aad)


# --- large data in chunks (the STREAM construction): each chunk is sealed with its position, and the last
# chunk is marked, so chunks cannot be reordered, dropped or cut off without detection.

STREAM_PREFIX_BYTES = 7
STREAM_CHUNK_BYTES = 1024 * 1024


def _stream_nonce(prefix, counter, final):
    return prefix + counter.to_bytes(4, "big") + (b"\x01" if final else b"\x00")


class StreamSealer:
    def __init__(self, key, prefix, aad):
        if len(key) != KEY_BYTES or len(prefix) != STREAM_PREFIX_BYTES:
            raise ValueError("Bad stream key or prefix.")
        self._cipher, self._prefix, self._aad, self._counter, self._done = AESGCM(key), prefix, aad, 0, False

    def seal(self, chunk, final=False):
        if self._done:
            raise ValueError("The stream is already finished.")
        sealed = self._cipher.encrypt(_stream_nonce(self._prefix, self._counter, final), chunk, self._aad)
        self._counter += 1
        self._done = final
        return sealed


class StreamOpener:
    def __init__(self, key, prefix, aad):
        if len(key) != KEY_BYTES or len(prefix) != STREAM_PREFIX_BYTES:
            raise DecryptionError()
        self._cipher, self._prefix, self._aad, self._counter = AESGCM(key), prefix, aad, 0

    def open(self, sealed, final=False):
        try:
            chunk = self._cipher.decrypt(_stream_nonce(self._prefix, self._counter, final), sealed, self._aad)
        except InvalidTag:
            raise DecryptionError() from None
        self._counter += 1
        return chunk
