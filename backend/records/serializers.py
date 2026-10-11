from django.db import transaction
from rest_framework import serializers

from accounts.access import CLINICAL_WRITE

from .models import (
    Encounter,
    Observation,
    Patient,
    PatientAddress,
    PatientIdentifier,
    PatientNote,
    PatientPhoto,
    PatientRevision,
    Prescription,
    PrescriptionItem,
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


DEMOGRAPHIC_FIELDS = ["first_name", "middle_name", "last_name", "date_of_birth", "gender", "phone", "whatsapp_number", "email"]
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
        fields = ["id", "identifier", "first_name", "middle_name", "last_name", "date_of_birth", "gender", "phone", "whatsapp_number", "email", "address", "photos", "archived_at", "created_at", "updated_at"]
        # archived_at changes only through the archive and restore actions.
        read_only_fields = ["id", "archived_at", "created_at", "updated_at"]

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
        fields = ["id", "patient", "body", "author_name", "amends", "created_at"]
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
        if attrs["unit"] != {"height": "cm", "weight": "kg"}[attrs["kind"]]:
            raise serializers.ValidationError("Height uses cm; weight uses kg.")
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
        fields = ["id", "instructions", "items", "created_at"]
        read_only_fields = ["id", "created_at"]


class EncounterSerializer(serializers.ModelSerializer):
    observations = ObservationSerializer(many=True, required=False)
    prescriptions = PrescriptionSerializer(many=True, required=False)
    clinician_name = serializers.CharField(source="clinician.get_full_name", read_only=True)

    class Meta:
        model = Encounter
        fields = ["id", "patient", "clinician_name", "occurred_at", "chief_complaint", "symptoms", "history", "assessment", "internal_notes", "follow_up_date", "observations", "prescriptions", "created_at"]
        read_only_fields = ["id", "clinician_name", "created_at"]

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
        encounter = Encounter.objects.create(**validated_data)
        for data in observations:
            Observation.objects.create(patient=encounter.patient, encounter=encounter, **data)
        for data in prescriptions:
            items = data.pop("items")
            prescription = Prescription.objects.create(encounter=encounter, prescriber=encounter.clinician, **data)
            for item in items:
                PrescriptionItem.objects.create(prescription=prescription, **item)
        return encounter
