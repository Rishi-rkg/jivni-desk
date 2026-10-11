from django.db import transaction
from rest_framework import serializers

from accounts.access import CLINICAL_READ, CLINICAL_WRITE

from .models import (
    OBSERVATION_UNITS,
    Encounter,
    EncounterAmendment,
    EncounterDraft,
    EncounterProduct,
    FamilyLink,
    Observation,
    Patient,
    PatientAddress,
    PatientDocument,
    PatientIdentifier,
    PatientNote,
    PatientPhoto,
    PatientRevision,
    Prescription,
    PrescriptionItem,
    PrescriptionSet,
)


class AddressSerializer(serializers.ModelSerializer):
    class Meta:
        model = PatientAddress
        fields = ["line1", "line2", "city", "region", "postal_code", "country"]

    def validate_country(self, value):
        if len(value) != 2 or not value.isascii() or not value.isalpha():
            raise serializers.ValidationError("Use a two-letter country code.")
        return value.upper()


class PhotoSerializer(serializers.ModelSerializer):
    class Meta:
        model = PatientPhoto
        fields = ["id", "mime_type", "byte_size", "created_at"]
        read_only_fields = fields


DEMOGRAPHIC_FIELDS = [
    "first_name",
    "middle_name",
    "last_name",
    "date_of_birth",
    "gender",
    "phone",
    "whatsapp_number",
    "email",
    "referred_by",
    "old_file_number",
]
ADDRESS_FIELDS = ["line1", "line2", "city", "region", "postal_code", "country"]


def demographic_snapshot(patient):
    """Flat text view of everything a demographic edit can change."""
    snapshot = {field: str(getattr(patient, field) or "") for field in DEMOGRAPHIC_FIELDS}
    address = PatientAddress.objects.filter(patient=patient).first()
    for field in ADDRESS_FIELDS:
        snapshot[f"address.{field}"] = getattr(address, field, "") or ""
    return snapshot


class PatientSerializer(serializers.ModelSerializer):
    address = AddressSerializer(required=False, allow_null=True)
    photos = PhotoSerializer(many=True, read_only=True)
    identifier = serializers.SerializerMethodField()

    class Meta:
        model = Patient
        fields = [
            "id",
            "identifier",
            "first_name",
            "middle_name",
            "last_name",
            "date_of_birth",
            "gender",
            "phone",
            "whatsapp_number",
            "email",
            "referred_by",
            "old_file_number",
            "alert",
            "address",
            "photos",
            "archived_at",
            "created_at",
            "updated_at",
        ]
        # archived_at changes only through the archive and restore actions.
        read_only_fields = ["id", "archived_at", "created_at", "updated_at"]

    def validate_alert(self, value):
        member = self.context.get("member")
        if value != getattr(self.instance, "alert", "") and (not member or member.role_id not in CLINICAL_WRITE):
            raise serializers.ValidationError("Only a doctor writes a patient's alert.")
        return value.strip()

    def to_representation(self, instance):
        data = super().to_representation(instance)
        member = self.context.get("member")
        # The alert is clinical; roles that do not read clinical records do not receive it.
        if not member or member.role_id not in CLINICAL_READ:
            data.pop("alert", None)
        # Last visit, next advised date and balance, when the view worked them out for this page of patients.
        data.update(self.context.get("extras", {}).get(instance.pk, {}))
        return data

    @transaction.atomic
    def create(self, validated_data):
        address = validated_data.pop("address", None)
        patient = Patient.objects.create(**validated_data)
        if address:
            PatientAddress.objects.create(patient=patient, **address)
        PatientIdentifier.issue(patient, self.context["request"].user)
        return patient

    def get_identifier(self, patient):
        active = getattr(patient, "active_identifiers", None)
        if active is None:
            active = list(patient.identifiers.filter(revoked_at__isnull=True)[:1])
        return active[0].code if active else None

    @transaction.atomic
    def update(self, instance, validated_data):
        sentinel = object()
        before = demographic_snapshot(instance)
        address = validated_data.pop("address", sentinel)
        instance = super().update(instance, validated_data)
        if address is None:
            PatientAddress.objects.filter(patient=instance).delete()
        elif address is not sentinel:
            current = PatientAddress.objects.filter(patient=instance).first()
            if current:
                for field, value in address.items():
                    setattr(current, field, value)
                current.save()
            else:
                PatientAddress.objects.create(patient=instance, **address)
        # Discard one-to-one relation cache after nested updates.
        instance._state.fields_cache.pop("address", None)
        after = demographic_snapshot(instance)
        changes = {field: {"from": before[field], "to": after[field]} for field in before if before[field] != after[field]}
        if changes:
            # Same transaction as the edit: the history can never be missing for a saved change.
            PatientRevision.objects.create(patient=instance, changed_by=self.context["request"].user, changes=changes)
        return instance


class RevisionSerializer(serializers.ModelSerializer):
    changed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = PatientRevision
        fields = ["id", "changed_by_name", "changes", "created_at"]
        read_only_fields = fields

    def get_changed_by_name(self, revision):
        return revision.changed_by.get_full_name() or revision.changed_by.username


class DuplicateCheckSerializer(serializers.Serializer):
    first_name = serializers.CharField(max_length=100, required=False, allow_blank=True)
    last_name = serializers.CharField(max_length=100, required=False, allow_blank=True)
    date_of_birth = serializers.DateField(required=False, allow_null=True)
    phone = serializers.CharField(max_length=40, required=False, allow_blank=True)
    whatsapp_number = serializers.CharField(max_length=40, required=False, allow_blank=True)


class NoteSerializer(serializers.ModelSerializer):
    author_name = serializers.CharField(source="author.get_full_name", read_only=True)

    class Meta:
        model = PatientNote
        fields = ["id", "patient", "kind", "body", "author_name", "amends", "created_at"]
        read_only_fields = ["id", "author_name", "created_at"]

    def validate(self, attrs):
        member = self.context["member"]
        if attrs["patient"].clinic_id != member.clinic_id:
            raise serializers.ValidationError({"patient": "Invalid patient."})
        if attrs.get("amends") and attrs["amends"].patient_id != attrs["patient"].id:
            raise serializers.ValidationError({"amends": "Invalid amendment reference."})
        return attrs

    def get_fields(self):
        fields = super().get_fields()
        member = self.context.get("member")
        if member:
            fields["patient"].queryset = Patient.objects.filter(clinic=member.clinic)
            fields["amends"].queryset = PatientNote.objects.filter(patient__clinic=member.clinic)
        return fields


class ObservationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Observation
        fields = ["id", "kind", "value", "unit", "measured_at"]
        read_only_fields = ["id"]

    def validate(self, attrs):
        if attrs["unit"] != OBSERVATION_UNITS[attrs["kind"]]:
            raise serializers.ValidationError(f"{attrs['kind'].capitalize()} is written in {OBSERVATION_UNITS[attrs['kind']]}.")
        return attrs


class PrescriptionItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = PrescriptionItem
        fields = ["id", "medicine_name_snapshot", "potency", "dose", "frequency", "duration", "instructions", "quantity"]
        read_only_fields = ["id"]


class PrescriptionSerializer(serializers.ModelSerializer):
    items = PrescriptionItemSerializer(many=True, allow_empty=False)

    class Meta:
        model = Prescription
        fields = ["id", "instructions", "dosage_line", "dosage", "items", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate_dosage(self, value):
        if not isinstance(value, dict) or len(value) > 12 or any(len(str(key)) > 40 or len(str(item)) > 100 for key, item in value.items()):
            raise serializers.ValidationError("Dosage parts must be a short set of named values.")
        return value


class ProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = EncounterProduct
        fields = ["id", "price_item_id", "name", "kind", "quantity", "rate", "gst_rate", "note"]
        read_only_fields = ["id"]

    def validate_kind(self, value):
        if value not in {"supplement", "shelf", "consumable"}:
            raise serializers.ValidationError("A visit product is a supplement, a shelf medicine or a consumable.")
        return value


class AmendmentSerializer(serializers.ModelSerializer):
    author_name = serializers.SerializerMethodField()

    class Meta:
        model = EncounterAmendment
        fields = ["id", "section", "correction", "reason", "author_name", "created_at"]
        read_only_fields = ["id", "author_name", "created_at"]

    def get_author_name(self, amendment):
        return amendment.author.get_full_name() or amendment.author.username


class EncounterSerializer(serializers.ModelSerializer):
    observations = ObservationSerializer(many=True, required=False)
    prescriptions = PrescriptionSerializer(many=True, required=False)
    products = ProductSerializer(many=True, required=False)
    amendments = AmendmentSerializer(many=True, read_only=True)
    clinician_name = serializers.CharField(source="clinician.get_full_name", read_only=True)
    # The draft this visit was written in; it is removed in the same step that makes the visit final.
    draft = serializers.UUIDField(write_only=True, required=False, allow_null=True)
    invoice = serializers.SerializerMethodField()

    class Meta:
        model = Encounter
        fields = [
            "id",
            "patient",
            "clinician_name",
            "occurred_at",
            "chief_complaint",
            "symptoms",
            "history",
            "assessment",
            "internal_notes",
            "follow_up_date",
            "visit_type",
            "progress",
            "observations",
            "prescriptions",
            "products",
            "amendments",
            "draft",
            "invoice",
            "created_at",
        ]
        read_only_fields = ["id", "clinician_name", "created_at"]

    def get_invoice(self, encounter):
        """The bill made from this visit, if there is one: enough to link to it and show its state."""
        bills = [bill for bill in encounter.invoices.all() if bill.status != "void"]
        return {"id": str(bills[0].pk), "number": bills[0].number, "state": bills[0].state} if bills else None

    def validate_products(self, value):
        if len(value) > 30:
            raise serializers.ValidationError("A visit holds at most 30 products.")
        return value

    def validate_prescriptions(self, value):
        if len(value) > 12:
            raise serializers.ValidationError("A visit holds at most 12 envelopes.")
        return value

    def get_fields(self):
        fields = super().get_fields()
        member = self.context.get("member")
        if member:
            fields["patient"].queryset = Patient.objects.filter(clinic=member.clinic, archived_at__isnull=True)
        return fields

    def to_representation(self, instance):
        data = super().to_representation(instance)
        member = self.context.get("member")
        # Internal notes are for the treating doctors only; absent unless the reader may write clinically.
        if not member or member.role_id not in CLINICAL_WRITE:
            data.pop("internal_notes", None)
        return data

    @transaction.atomic
    def create(self, validated_data):
        observations = validated_data.pop("observations", [])
        prescriptions = validated_data.pop("prescriptions", [])
        products = validated_data.pop("products", [])
        draft = validated_data.pop("draft", None)
        encounter = Encounter.objects.create(**validated_data)
        for position, data in enumerate(products):
            EncounterProduct.objects.create(encounter=encounter, position=position, **data)
        if draft:
            # Only the draft of this patient in this clinic; anything else is quietly left alone.
            EncounterDraft.objects.filter(pk=draft, patient=encounter.patient).delete()
        for data in observations:
            Observation.objects.create(patient=encounter.patient, encounter=encounter, **data)
        for position, data in enumerate(prescriptions):
            items = data.pop("items")
            prescription = Prescription.objects.create(encounter=encounter, prescriber=encounter.clinician, position=position, **data)
            for at, item in enumerate(items):
                PrescriptionItem.objects.create(prescription=prescription, position=at, **item)
        return encounter


MAX_DRAFT_BYTES = 200_000


def bounded_json(value, limit=MAX_DRAFT_BYTES):
    import json

    if not isinstance(value, dict | list):
        raise serializers.ValidationError("Send the contents as named values.")
    if len(json.dumps(value)) > limit:
        raise serializers.ValidationError("This is too large to save.")
    return value


class DraftSerializer(serializers.ModelSerializer):
    author_name = serializers.SerializerMethodField()
    patient_name = serializers.SerializerMethodField()
    mine = serializers.SerializerMethodField()

    class Meta:
        model = EncounterDraft
        fields = ["id", "patient", "patient_name", "author_name", "mine", "data", "created_at", "updated_at"]
        read_only_fields = ["id", "patient_name", "author_name", "mine", "created_at", "updated_at"]

    def get_fields(self):
        fields = super().get_fields()
        member = self.context.get("member")
        if member:
            fields["patient"].queryset = Patient.objects.filter(clinic=member.clinic, archived_at__isnull=True)
        return fields

    def get_author_name(self, draft):
        return draft.author.get_full_name() or draft.author.username

    def get_patient_name(self, draft):
        patient = draft.patient
        return " ".join(part for part in [patient.first_name, patient.middle_name, patient.last_name] if part)

    def get_mine(self, draft):
        return draft.author_id == self.context["request"].user.pk

    def validate_data(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("Send the draft as named values.")
        return bounded_json(value)


class PrescriptionSetSerializer(serializers.ModelSerializer):
    class Meta:
        model = PrescriptionSet
        fields = ["id", "name", "envelopes", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate_name(self, value):
        value = value.strip()
        clinic = self.context["member"].clinic
        if PrescriptionSet.objects.filter(clinic=clinic, name__iexact=value).exists():
            raise serializers.ValidationError("A set with this name already exists.")
        return value

    def validate_envelopes(self, value):
        if not isinstance(value, list) or not 1 <= len(value) <= 12:
            raise serializers.ValidationError("A set holds between 1 and 12 envelopes.")
        return bounded_json(value, 20_000)


class FamilyLinkSerializer(serializers.ModelSerializer):
    class Meta:
        model = FamilyLink
        fields = ["id", "relative", "relation"]
        read_only_fields = ["id"]

    def get_fields(self):
        fields = super().get_fields()
        member = self.context.get("member")
        if member:
            fields["relative"].queryset = Patient.objects.filter(clinic=member.clinic)
        return fields


class DocumentSerializer(serializers.ModelSerializer):
    uploaded_by_name = serializers.SerializerMethodField()

    class Meta:
        model = PatientDocument
        fields = ["id", "patient", "title", "mime_type", "byte_size", "uploaded_by_name", "created_at"]
        read_only_fields = fields

    def get_uploaded_by_name(self, document):
        return document.uploaded_by.get_full_name() or document.uploaded_by.username
