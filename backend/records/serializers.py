from django.db import transaction
from rest_framework import serializers
from accounts.access import CLINICAL_WRITE
from .models import Patient, PatientAddress, PatientPhoto, PatientNote, Encounter, Observation, Prescription, PrescriptionItem


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


class PatientSerializer(serializers.ModelSerializer):
    address = AddressSerializer(required=False, allow_null=True)
    photos = PhotoSerializer(many=True, read_only=True)

    class Meta:
        model = Patient
        fields = ["id", "first_name", "middle_name", "last_name", "date_of_birth", "gender", "phone", "email", "address", "photos", "archived_at", "created_at", "updated_at"]
        # archived_at changes only through the archive and restore actions.
        read_only_fields = ["id", "archived_at", "created_at", "updated_at"]

    @transaction.atomic
    def create(self, validated_data):
        address = validated_data.pop("address", None)
        patient = Patient.objects.create(**validated_data)
        if address:
            PatientAddress.objects.create(patient=patient, **address)
        return patient

    @transaction.atomic
    def update(self, instance, validated_data):
        sentinel = object()
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
        return instance


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
