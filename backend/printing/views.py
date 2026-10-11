"""Printing API: layouts, the data each printed page needs, and the record of what was printed."""

import datetime
import uuid

from django.db import transaction
from django.db.models import Max
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from accounts.access import BILLING_READ, CLINIC_ADMIN, CLINICAL_READ, DEMOGRAPHIC_WRITE
from accounts.features import feature_on
from billing.models import Invoice, InvoiceEvent
from billing.serializers import patient_code, patient_name, person_name
from records.models import Encounter, Patient
from records.views import ClinicViewSet

from .models import DEFAULTS, LABEL_SIZES, PrintJob, PrintTemplate, template_in_use

KIND_TITLES = {
    "label": "Envelope label",
    "prescription": "Prescription",
    "invoice": "Invoice",
    "receipt": "Receipt",
    "card": "Patient card",
}
# Which roles may see or make each kind of printed page. Labels and prescriptions carry dosage instructions.
KIND_ROLES = {
    "label": CLINICAL_READ,
    "prescription": CLINICAL_READ,
    "test": {"owner", "admin", "clinician", "assistant", "reception", "billing"},
    "card": DEMOGRAPHIC_WRITE,
    "invoice": BILLING_READ,
    "receipt": BILLING_READ,
    "day_end": BILLING_READ,
    "day_sheet": {"owner", "clinician", "assistant", "reception"},
}


def clean_settings(kind, data):
    """A layout's settings, checked against what that layout has. Unknown names and wrong types are refused."""
    if kind not in DEFAULTS:
        raise serializers.ValidationError({"kind": "Unknown kind of document."})
    if not isinstance(data, dict):
        raise serializers.ValidationError({"settings": "Send the settings as named values."})
    defaults, cleaned = DEFAULTS[kind], {}
    for name, value in data.items():
        if name not in defaults:
            raise serializers.ValidationError({"settings": f"{name} is not a setting of this layout."})
        expected = defaults[name]
        if isinstance(expected, bool):
            if not isinstance(value, bool):
                raise serializers.ValidationError({"settings": f"{name} is on or off."})
        elif isinstance(expected, float):
            if isinstance(value, bool) or not isinstance(value, int | float) or not 20 <= value <= 110:
                raise serializers.ValidationError({"settings": "A label side is between 20 and 110 mm."})
            value = round(float(value), 1)
        else:
            if not isinstance(value, str) or len(value) > 200:
                raise serializers.ValidationError({"settings": f"{name} must be text of at most 200 characters."})
            value = value.strip()
        cleaned[name] = value
    choices = {
        ("label", "size"): {*LABEL_SIZES, "custom"},
        ("label", "dosage_size"): {"large", "medium"},
        ("prescription", "paper"): {"A4", "A5"},
    }
    for (owner, name), allowed in choices.items():
        if owner == kind and name in cleaned and cleaned[name] not in allowed:
            raise serializers.ValidationError({"settings": f"{cleaned[name]} is not a choice for {name}."})
    return cleaned


def template_data(clinic, kind):
    version, settings = template_in_use(clinic, kind)
    saved = PrintTemplate.objects.filter(clinic=clinic, kind=kind, version=version).select_related("saved_by").first()
    return {
        "kind": kind,
        "title": KIND_TITLES[kind],
        "version": version,
        "settings": settings,
        "saved_by_name": person_name(saved.saved_by) if saved else "",
        "saved_at": saved.created_at.isoformat() if saved else None,
    }


def clinic_data(clinic):
    return {
        "name": clinic.name,
        "address": clinic.address,
        "phone": clinic.phone,
        "email": clinic.email,
        "registration_number": clinic.registration_number,
        "has_logo": bool(clinic.logo),
    }


class PrintingViewSet(ClinicViewSet):
    def need(self, roles):
        if self.member.role_id not in roles:
            raise PermissionDenied("Your clinic role does not allow this action.")

    def encounter(self, pk):
        try:
            return (
                Encounter.objects.filter(patient__clinic=self.member.clinic)
                .select_related("patient", "clinician")
                .prefetch_related("prescriptions__items")
                .get(pk=uuid.UUID(str(pk)))
            )
        except (Encounter.DoesNotExist, ValueError):
            raise serializers.ValidationError({"encounter": "That visit was not found."}) from None

    def patient(self, pk):
        try:
            return Patient.objects.select_related("address").get(pk=uuid.UUID(str(pk)), clinic=self.member.clinic)
        except (Patient.DoesNotExist, ValueError):
            raise serializers.ValidationError({"patient": "That patient was not found."}) from None

    def label_data(self, encounter):
        """What every label of a visit shows. Medicine names leave the server only when the layout prints them."""
        clinic = self.member.clinic
        _, settings = template_in_use(clinic, "label")
        return {
            "clinic": clinic_data(clinic),
            "patient": {"id": str(encounter.patient_id), "name": patient_name(encounter.patient), "code": patient_code(encounter.patient)},
            "date": clinic.local_date(encounter.occurred_at).isoformat(),
            "next_visit": encounter.follow_up_date.isoformat() if encounter.follow_up_date else "",
            "envelopes": [
                {
                    "number": number,
                    "dosage_line": envelope.dosage_line,
                    "dosage": envelope.dosage if isinstance(envelope.dosage, dict) else {},
                    "medicines": (
                        [f"{item.medicine_name_snapshot} {item.potency}".strip() for item in envelope.items.all()]
                        if settings["show_medicines"]
                        else []
                    ),
                }
                for number, envelope in enumerate(encounter.prescriptions.all(), start=1)
            ],
            "settings": settings,
        }


class PrintTemplateViewSet(PrintingViewSet):
    """How each printed document is laid out. Everyone reads them (pages are drawn from them); owner and administrator change them."""

    def list(self, request):
        return Response([template_data(self.member.clinic, kind) for kind in KIND_TITLES])

    def create(self, request):
        self.need(CLINIC_ADMIN)
        kind = request.data.get("kind")
        cleaned = clean_settings(kind, request.data.get("settings"))
        clinic = self.member.clinic
        with transaction.atomic():
            _, current = template_in_use(clinic, kind)
            latest = PrintTemplate.objects.filter(clinic=clinic, kind=kind).aggregate(latest=Max("version"))["latest"] or 0
            template = PrintTemplate.objects.create(
                clinic=clinic, kind=kind, version=latest + 1, settings={**current, **cleaned}, saved_by=request.user
            )
            self.event("print_template.save", template)
        return Response(template_data(clinic, kind), status=201)


class PrintDataViewSet(PrintingViewSet):
    """Everything a printed page needs, in one request per page."""

    @action(detail=False, methods=["get"], url_path=r"label/(?P<encounter_id>[^/]+)")
    def label(self, request, encounter_id=None):
        self.need(CLINICAL_READ)
        encounter = self.encounter(encounter_id)
        self.event("print.label_data", encounter)
        return Response(self.label_data(encounter))

    @action(detail=False, methods=["get"], url_path=r"prescription/(?P<encounter_id>[^/]+)")
    def prescription(self, request, encounter_id=None):
        self.need(CLINICAL_READ)
        encounter = self.encounter(encounter_id)
        clinic = self.member.clinic
        _, settings = template_in_use(clinic, "prescription")
        data = self.label_data(encounter)
        if settings["show_medicines"]:
            for envelope, saved in zip(data["envelopes"], encounter.prescriptions.all(), strict=True):
                envelope["medicines"] = [f"{item.medicine_name_snapshot} {item.potency}".strip() for item in saved.items.all()]
        else:
            for envelope in data["envelopes"]:
                envelope["medicines"] = []
        self.event("print.prescription_data", encounter)
        return Response({**data, "doctor": person_name(encounter.clinician), "settings": settings})

    @action(detail=False, methods=["get"], url_path=r"card/(?P<patient_id>[^/]+)")
    def card(self, request, patient_id=None):
        self.need(DEMOGRAPHIC_WRITE)
        patient = self.patient(patient_id)
        clinic = self.member.clinic
        self.event("print.card_data", patient)
        return Response(
            {
                "clinic": clinic_data(clinic),
                "patient": {"id": str(patient.pk), "name": patient_name(patient), "code": patient_code(patient)},
                "settings": template_in_use(clinic, "card")[1],
            }
        )

    @action(detail=False, methods=["get"], url_path="test-label")
    def test_label(self, request):
        """A label with made-up wording, to check a printer and the layout without touching a patient."""
        clinic = self.member.clinic
        return Response(
            {
                "clinic": clinic_data(clinic),
                "patient": {"id": "", "name": "Test Patient", "code": "PAT-TESTLABEL2"},
                "date": clinic.today().isoformat(),
                "next_visit": (clinic.today() + datetime.timedelta(days=14)).isoformat(),
                "envelopes": [
                    {
                        "number": 1,
                        "dosage_line": "4 tabs, twice daily before meals · 14 days",
                        "dosage": {
                            "amount": "4",
                            "unit": "tabs",
                            "frequency": "twice daily",
                            "timing": "before meals",
                            "length": "14",
                            "period": "days",
                        },
                        "medicines": ["Test remedy 30C"] if template_in_use(clinic, "label")[1]["show_medicines"] else [],
                    }
                ],
                "settings": template_in_use(clinic, "label")[1],
            }
        )


class PrintJobViewSet(PrintingViewSet):
    """The print queue: what was sent to a printer today, newest first."""

    def visible_kinds(self):
        return [kind for kind, roles in KIND_ROLES.items() if self.member.role_id in roles]

    def row(self, job):
        return {
            "id": str(job.pk),
            "kind": job.kind,
            "title": job.title,
            "patient": patient_name(job.patient) if job.patient else "",
            "patient_id": str(job.patient_id) if job.patient_id else None,
            "encounter": str(job.encounter_id) if job.encounter_id else None,
            "invoice": str(job.invoice_id) if job.invoice_id else None,
            "copies": job.copies,
            "printer": job.printer,
            "status": "sent",
            "envelopes": job.snapshot.get("numbers") if isinstance(job.snapshot, dict) else None,
            "created_by_name": person_name(job.created_by),
            "created_at": job.created_at.isoformat(),
        }

    def list(self, request):
        clinic = self.member.clinic
        try:
            day = datetime.date.fromisoformat(request.query_params["day"]) if request.query_params.get("day") else clinic.today()
        except ValueError:
            raise serializers.ValidationError({"day": "Use a date like 2026-10-06."}) from None
        start = datetime.datetime.combine(day, datetime.time.min, tzinfo=clinic.tzinfo)
        jobs = (
            PrintJob.objects.filter(
                clinic=clinic, kind__in=self.visible_kinds(), created_at__gte=start, created_at__lt=start + datetime.timedelta(days=1)
            )
            .select_related("patient", "created_by")
            .order_by("-created_at")[:200]
        )
        self.event("print_job.list")
        return Response({"day": day.isoformat(), "results": [self.row(job) for job in jobs]})

    def create(self, request):
        kind = request.data.get("kind")
        if kind not in KIND_ROLES:
            raise serializers.ValidationError({"kind": "Unknown kind of document."})
        self.need(KIND_ROLES[kind])
        clinic = self.member.clinic
        try:
            copies = int(request.data.get("copies", 1))
        except (TypeError, ValueError):
            copies = 0
        if not 1 <= copies <= 50:
            raise serializers.ValidationError({"copies": "Print between 1 and 50 copies."})
        fields = {"clinic": clinic, "kind": kind, "copies": copies, "created_by": request.user}
        if kind in {"label", "prescription"}:
            encounter = self.encounter(request.data.get("encounter"))
            data = self.label_data(encounter)
            numbers = request.data.get("envelopes")
            if kind == "label":
                known = [envelope["number"] for envelope in data["envelopes"]]
                if not isinstance(numbers, list) or not numbers or any(number not in known for number in numbers):
                    raise serializers.ValidationError({"envelopes": "Choose which envelopes to label."})
                data["envelopes"] = [envelope for envelope in data["envelopes"] if envelope["number"] in numbers]
            fields |= {
                "encounter": encounter,
                "patient": encounter.patient,
                "title": f"Envelope label × {copies}" if kind == "label" else "Prescription",
                "snapshot": {**data, "numbers": numbers if kind == "label" else None},
            }
        elif kind == "card":
            patient = self.patient(request.data.get("patient"))
            fields |= {"patient": patient, "title": "Patient card", "snapshot": {"code": patient_code(patient)}}
        elif kind in {"invoice", "receipt"}:
            if not feature_on(clinic, "billing"):
                raise PermissionDenied("Billing is switched off for this clinic.")
            try:
                invoice = Invoice.objects.select_related("patient").get(pk=uuid.UUID(str(request.data.get("invoice"))), clinic=clinic)
            except (Invoice.DoesNotExist, ValueError):
                raise serializers.ValidationError({"invoice": "That bill was not found."}) from None
            if invoice.status == Invoice.Status.DRAFT:
                raise serializers.ValidationError({"invoice": "A draft is not printed as a bill. Issue it first."})
            receipt = str(request.data.get("receipt_number", ""))[:30]
            fields |= {
                "invoice": invoice,
                "patient": invoice.patient,
                "title": f"Receipt {receipt}".strip() if kind == "receipt" else f"Invoice {invoice.number}",
            }
        else:
            fields["title"] = PrintJob.Kind(kind).label
        with transaction.atomic():
            job = PrintJob.objects.create(**fields)
            if kind == "invoice":
                InvoiceEvent.objects.create(invoice=fields["invoice"], action="printed", actor=request.user)
            self.event("print_job.create", job)
        return Response(self.row(job), status=201)
