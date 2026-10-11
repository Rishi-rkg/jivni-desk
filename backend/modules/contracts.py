"""Future modules use IDs and explicit DTOs, never reach into React or each other's tables.
No provider is enabled and no patient data is transmitted by these interfaces.
"""

from typing import Protocol
from uuid import UUID


class Billing(Protocol):
    def draft_invoice(self, clinic_id: UUID, patient_id: UUID, encounter_id: UUID) -> UUID: ...


class Correspondence(Protocol):
    def draft_message(self, clinic_id: UUID, patient_id: UUID, template_id: UUID) -> UUID: ...


class MedicineKnowledge(Protocol):
    def search(self, clinic_id: UUID, query: str) -> list[dict]: ...


class Printing(Protocol):
    def enqueue(self, clinic_id: UUID, document_id: UUID, printer_id: str) -> UUID: ...


class BarcodeLookup(Protocol):
    def resolve(self, clinic_id: UUID, opaque_identifier: str) -> UUID | None: ...


class AIDrafting(Protocol):
    def draft(self, clinic_id: UUID, approved_context: dict) -> str: ...


MODULES = [
    {"code": code, "label": label, "status": "planned"}
    for code, label in [
        ("billing", "Billing"),
        ("correspondence", "WhatsApp correspondence"),
        ("knowledge", "Medicine knowledge library"),
        ("printing", "Printing"),
        ("barcodes", "Barcode scanning"),
        ("ai", "AI drafting"),
    ]
]
