"""Contracts for future envelope encryption. No plaintext fallback in encrypted mode."""
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID


@dataclass(frozen=True)
class CiphertextEnvelope:
    version: int
    algorithm: str
    wrapping_key_id: str
    wrapped_data_key: bytes
    nonce: bytes
    ciphertext: bytes


class KeyManager(Protocol):
    def generate_data_key(self, clinic_id: UUID) -> tuple[bytes, bytes, str]: ...
    def unwrap_data_key(self, clinic_id: UUID, wrapped_key: bytes, key_id: str) -> bytes: ...


class RecordProtector(Protocol):
    def encrypt(self, clinic_id: UUID, resource_id: UUID, plaintext: bytes) -> CiphertextEnvelope: ...
    def decrypt(self, clinic_id: UUID, resource_id: UUID, envelope: CiphertextEnvelope) -> bytes: ...


class UnconfiguredEnvelopeEncryption:
    def encrypt(self, *args, **kwargs):
        raise NotImplementedError("Configure and verify envelope encryption before handling real patient data.")

    def decrypt(self, *args, **kwargs):
        raise NotImplementedError("Configure and verify envelope encryption before handling real patient data.")
