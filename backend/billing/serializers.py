from decimal import Decimal

from django.db import transaction
from rest_framework import serializers

from accounts.features import feature_on
from records.models import Encounter, Patient, PatientIdentifier

from . import money
from .models import CreditNote, Invoice, InvoiceEvent, InvoiceLine, Payment, PriceItem

VISIT_TYPES = dict(Encounter._meta.get_field("visit_type").choices)


def person_name(user):
    return (user.get_full_name() or user.username) if user else ""


def patient_name(patient):
    return " ".join(part for part in [patient.first_name, patient.middle_name, patient.last_name] if part)


def patient_code(patient):
    identifier = PatientIdentifier.objects.filter(patient=patient, revoked_at__isnull=True).first()
    return identifier.code if identifier else ""


def build_snapshot(invoice, user):
    """Everything a printed bill shows that could change later, fixed as it is today."""
    clinic, patient, encounter = invoice.clinic, invoice.patient, invoice.encounter
    snapshot = {
        "clinic": {
            "name": clinic.name,
            "address": clinic.address,
            "phone": clinic.phone,
            "email": clinic.email,
            "gstin": clinic.tax_identifier,
            "registration_number": clinic.registration_number,
            "upi_id": clinic.upi_id,
        },
        # The clinic is GST-registered; with no GSTIN entered, nothing about GST is printed.
        "show_gst": bool(clinic.tax_identifier) and feature_on(clinic, "show_gst"),
        "issued_by": person_name(user),
        "patient": None,
        "visit": None,
    }
    if patient:
        address = getattr(patient, "address", None)
        snapshot["patient"] = {
            "name": patient_name(patient),
            "phone": patient.phone or patient.whatsapp_number,
            "address": (
                "\n".join(
                    part for part in [address.line1, address.line2, " ".join(p for p in [address.city, address.postal_code] if p)] if part
                )
                if address
                else ""
            ),
            "code": patient_code(patient),
        }
    if encounter:
        snapshot["visit"] = {
            "date": clinic.local_date(encounter.occurred_at).isoformat(),
            "doctor": person_name(encounter.clinician),
            "type": VISIT_TYPES.get(encounter.visit_type, ""),
            "next_visit": encounter.follow_up_date.isoformat() if encounter.follow_up_date else "",
        }
    return snapshot


class PriceItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = PriceItem
        fields = ["id", "name", "kind", "role", "rate", "gst_rate", "barcode", "active", "updated_at"]
        read_only_fields = ["id", "role", "updated_at"]

    def validate_barcode(self, value):
        value = "".join(value.split())
        if not value:
            return value
        clinic = self.context["member"].clinic
        clash = PriceItem.objects.filter(clinic=clinic, barcode=value)
        if self.instance:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError("Another item in the price list already has this barcode.")
        return value

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", None))
        role = getattr(self.instance, "role", "")
        if role and "kind" in attrs and attrs["kind"] != self.instance.kind:
            raise serializers.ValidationError({"kind": "This item is used when a bill is made from a visit; its kind is fixed."})
        if kind in money.CARE_KINDS and attrs.get("barcode"):
            raise serializers.ValidationError({"barcode": "Only products have a barcode."})
        return attrs


class LineSerializer(serializers.ModelSerializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    group = serializers.CharField(read_only=True)

    class Meta:
        model = InvoiceLine
        fields = ["id", "kind", "group", "description", "quantity", "rate", "gst_rate", "amount", "price_item", "source", "position"]
        read_only_fields = ["id", "position"]
        extra_kwargs = {"kind": {"required": False}, "description": {"required": False}, "rate": {"required": False}}

    def get_fields(self):
        fields = super().get_fields()
        member = self.context.get("member")
        if member:
            fields["price_item"].queryset = PriceItem.objects.filter(clinic=member.clinic)
        return fields

    def validate_source(self, value):
        if value not in {"", "visit", "scan"}:
            raise serializers.ValidationError("Unknown line source.")
        return value

    def validate(self, attrs):
        item = attrs.get("price_item")
        if item:
            # A line picked from the price list starts from that item; the person may still change the rate.
            attrs.setdefault("kind", item.kind)
            attrs.setdefault("description", item.name)
            attrs.setdefault("rate", item.rate)
            attrs.setdefault("gst_rate", item.gst_rate)
        for field in ["kind", "description", "rate"]:
            if field not in attrs or attrs[field] in ("", None):
                raise serializers.ValidationError({field: "This is needed for a line that is not from the price list."})
        return attrs


class PaymentSerializer(serializers.ModelSerializer):
    received_by_name = serializers.SerializerMethodField()

    class Meta:
        model = Payment
        fields = ["id", "kind", "amount", "method", "reference", "note", "received_at", "received_by_name", "receipt_number"]
        read_only_fields = fields

    def get_received_by_name(self, payment):
        return person_name(payment.received_by)


class CreditNoteSerializer(serializers.ModelSerializer):
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        model = CreditNote
        fields = ["id", "number", "amount", "reason", "created_by_name", "created_at"]
        read_only_fields = fields

    def get_created_by_name(self, note):
        return person_name(note.created_by)


class InvoiceEventSerializer(serializers.ModelSerializer):
    actor_name = serializers.SerializerMethodField()

    class Meta:
        model = InvoiceEvent
        fields = ["id", "action", "detail", "actor_name", "created_at"]
        read_only_fields = fields

    def get_actor_name(self, event):
        return person_name(event.actor)


def patient_summary(patient):
    if not patient:
        return None
    return {"id": str(patient.pk), "name": patient_name(patient), "archived": bool(patient.archived_at)}


class InvoiceListSerializer(serializers.ModelSerializer):
    """One row of a list of bills."""

    state = serializers.CharField(read_only=True)
    paid = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    credited = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    balance = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    patient = serializers.SerializerMethodField()
    date = serializers.SerializerMethodField()

    class Meta:
        model = Invoice
        fields = ["id", "number", "status", "state", "date", "patient", "buyer_name", "total", "paid", "credited", "balance", "encounter"]
        read_only_fields = fields

    def get_patient(self, invoice):
        return patient_summary(invoice.patient)

    def get_date(self, invoice):
        return invoice.clinic.local_date(invoice.issued_at or invoice.created_at).isoformat()


class InvoiceSerializer(InvoiceListSerializer):
    """A whole bill, and what may be sent to make or change a draft."""

    lines = LineSerializer(many=True)
    payments = PaymentSerializer(many=True, read_only=True)
    credit_notes = CreditNoteSerializer(many=True, read_only=True)
    history = serializers.SerializerMethodField()
    tax_summary = serializers.SerializerMethodField()
    snapshot = serializers.SerializerMethodField()
    created_by_name = serializers.SerializerMethodField()
    issued_by_name = serializers.SerializerMethodField()
    patient_id = serializers.PrimaryKeyRelatedField(source="patient", queryset=Patient.objects.none(), required=False, allow_null=True)

    class Meta:
        model = Invoice
        fields = [
            *InvoiceListSerializer.Meta.fields,
            "patient_id",
            "buyer_phone",
            "discount",
            "discount_reason",
            "note",
            "subtotal",
            "tax_total",
            "tax_summary",
            "lines",
            "payments",
            "credit_notes",
            "history",
            "snapshot",
            "created_at",
            "created_by_name",
            "issued_at",
            "issued_by_name",
            "voided_at",
            "void_reason",
        ]
        read_only_fields = [
            "id",
            "number",
            "status",
            "state",
            "date",
            "patient",
            "total",
            "paid",
            "credited",
            "balance",
            "subtotal",
            "tax_total",
            "created_at",
            "issued_at",
            "voided_at",
            "void_reason",
        ]

    def get_fields(self):
        fields = super().get_fields()
        member = self.context.get("member")
        if member:
            fields["patient_id"].queryset = Patient.objects.filter(clinic=member.clinic)
            fields["encounter"] = serializers.PrimaryKeyRelatedField(
                queryset=Encounter.objects.filter(patient__clinic=member.clinic), required=False, allow_null=True
            )
        return fields

    def get_history(self, invoice):
        rows = InvoiceEventSerializer(invoice.events.all(), many=True).data
        # A draft keeps no history rows (it can still be deleted); its first line is read from the bill.
        created = {
            "id": f"{invoice.pk}-created",
            "action": "created_from_visit" if invoice.encounter_id else "created",
            "detail": "",
            "actor_name": person_name(invoice.created_by),
            "created_at": serializers.DateTimeField().to_representation(invoice.created_at),
        }
        return [*rows, created]

    def get_tax_summary(self, invoice):
        return [
            {
                "rate": format(row["rate"].normalize(), "f"),
                "taxable": str(row["taxable"]),
                "cgst": str(row["cgst"]),
                "sgst": str(row["sgst"]),
            }
            for row in invoice.figures()["tax_summary"]
        ]

    def get_snapshot(self, invoice):
        # A draft shows today's details; an issued bill shows the ones fixed on the day it was issued.
        return invoice.snapshot if invoice.status != Invoice.Status.DRAFT else build_snapshot(invoice, invoice.created_by)

    def get_created_by_name(self, invoice):
        return person_name(invoice.created_by)

    def get_issued_by_name(self, invoice):
        return person_name(invoice.issued_by)

    # --- writing a draft

    def validate(self, attrs):
        member = self.context["member"]
        patient = attrs.get("patient", getattr(self.instance, "patient", None))
        encounter = attrs.get("encounter", getattr(self.instance, "encounter", None))
        if encounter and (not patient or encounter.patient_id != patient.pk):
            raise serializers.ValidationError({"encounter": "The visit must belong to the patient on the bill."})
        if patient and patient.archived_at and "patient" in attrs:
            raise serializers.ValidationError({"patient_id": "This patient is archived. Restore the record before billing."})
        lines = attrs.get("lines")
        if lines is not None:
            if len(lines) > 60:
                raise serializers.ValidationError({"lines": "A bill holds at most 60 lines."})
            if any(line["kind"] not in money.CARE_KINDS for line in lines) and not feature_on(member.clinic, "product_sales"):
                raise serializers.ValidationError({"lines": "Product sales are switched off for this clinic."})
        current = (
            lines
            if lines is not None
            else [{"kind": x.kind, "quantity": x.quantity, "rate": x.rate} for x in (self.instance.lines.all() if self.instance else [])]
        )
        subtotal = sum((money.line_amount(line.get("quantity", 1), line["rate"]) for line in current), Decimal("0"))
        discount = attrs.get("discount", getattr(self.instance, "discount", Decimal("0")))
        if discount > subtotal:
            raise serializers.ValidationError({"discount": "The discount is more than the bill."})
        return attrs

    def write_lines(self, invoice, lines):
        InvoiceLine.objects.filter(invoice=invoice).delete()
        for position, line in enumerate(lines):
            InvoiceLine.objects.create(invoice=invoice, position=position, **line)

    @transaction.atomic
    def create(self, validated_data):
        lines = validated_data.pop("lines", [])
        invoice = Invoice.objects.create(**validated_data)
        self.write_lines(invoice, lines)
        invoice.refresh_totals()
        invoice.save()
        return invoice

    @transaction.atomic
    def update(self, instance, validated_data):
        if instance.status != Invoice.Status.DRAFT:
            raise serializers.ValidationError("An issued bill cannot be edited. Add a credit note to correct it.")
        lines = validated_data.pop("lines", None)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        if lines is not None:
            self.write_lines(instance, lines)
        # The lines were just rewritten; read them again rather than from an earlier prefetch.
        instance._prefetched_objects_cache = {}
        instance.refresh_totals()
        instance.save()
        return instance
