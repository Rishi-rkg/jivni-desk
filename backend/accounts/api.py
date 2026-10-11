"""Clinic settings. Any member may read them; only the owner or an administrator may change them.

The switches (which parts of the application the clinic uses) are the owner's alone.
"""

import io
import warnings

from django.db import transaction
from django.http import HttpResponse
from PIL import Image, UnidentifiedImageError
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from audit.models import record_event

from .access import CLINIC_ADMIN, membership
from .features import FEATURES, NOT_BUILT, features_of
from .models import Clinic

LOGO_MAX_BYTES = 1024 * 1024
LOGO_MAX_SIDE = 512


class ClinicSerializer(serializers.ModelSerializer):
    features = serializers.SerializerMethodField()
    has_logo = serializers.SerializerMethodField()

    class Meta:
        model = Clinic
        fields = [
            "id",
            "name",
            "time_zone",
            "address",
            "phone",
            "email",
            "tax_identifier",
            "currency",
            "registration_number",
            "upi_id",
            "invoice_prefix",
            "lock_after_minutes",
            "features",
            "has_logo",
        ]
        read_only_fields = ["id"]

    def get_features(self, clinic):
        return features_of(clinic)

    def get_has_logo(self, clinic):
        return bool(clinic.logo)

    def validate_currency(self, value):
        return value.upper()

    def validate_invoice_prefix(self, value):
        return value.upper()

    def validate_tax_identifier(self, value):
        return value.strip().upper()


def switch_changes(data):
    """The switches a request asks to change, checked. Unknown names and half-built parts are refused."""
    if not isinstance(data, dict):
        raise serializers.ValidationError({"features": "Send the switches as named on/off values."})
    changes = {}
    for name, value in data.items():
        if name not in FEATURES or not isinstance(value, bool):
            raise serializers.ValidationError({"features": f"{name} is not a switch."})
        if value and name in NOT_BUILT:
            raise serializers.ValidationError({"features": f"{FEATURES[name][0]} is not available in this version."})
        changes[name] = value
    return changes


class ClinicSettingsView(APIView):
    def get(self, request):
        return Response(ClinicSerializer(membership(request).clinic).data)

    def patch(self, request):
        member = membership(request)
        wants_switches = "features" in request.data
        # Switches are the owner's alone; the other details may also be kept by an administrator.
        allowed = member.role_id in CLINIC_ADMIN and (not wants_switches or member.role_id == "owner")
        if not allowed:
            record_event(
                request, "access.denied", clinic=member.clinic, outcome="denied", resource_type="Clinic", resource_id=member.clinic_id
            )
            raise PermissionDenied("Your clinic role does not allow this action.")
        serializer = ClinicSerializer(member.clinic, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        changes = switch_changes(request.data["features"]) if wants_switches else {}
        with transaction.atomic():
            clinic = serializer.save()
            if changes:
                clinic.features = {**(clinic.features if isinstance(clinic.features, dict) else {}), **changes}
                clinic.save(update_fields=["features"])
                record_event(request, "clinic.switches", clinic, clinic)
            record_event(request, "clinic.update", clinic, clinic)
        return Response(ClinicSerializer(clinic).data)


class ClinicLogoView(APIView):
    """The clinic's logo for bills, labels and cards. Any member may see it; owner or administrator sets it."""

    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get(self, request):
        clinic = membership(request).clinic
        if not clinic.logo:
            return Response({"detail": "No logo has been added."}, status=404)
        return HttpResponse(bytes(clinic.logo), content_type=clinic.logo_mime or "image/png")

    def change(self, request, data, mime):
        member = membership(request)
        if member.role_id not in CLINIC_ADMIN:
            record_event(
                request, "access.denied", clinic=member.clinic, outcome="denied", resource_type="Clinic", resource_id=member.clinic_id
            )
            raise PermissionDenied("Your clinic role does not allow this action.")
        with transaction.atomic():
            member.clinic.logo, member.clinic.logo_mime = data, mime
            member.clinic.save(update_fields=["logo", "logo_mime"])
            record_event(request, "clinic.logo", member.clinic, member.clinic)
        return Response(ClinicSerializer(member.clinic).data)

    def post(self, request):
        upload = request.FILES.get("logo")
        if not upload:
            raise serializers.ValidationError({"logo": "Choose an image."})
        if upload.size > LOGO_MAX_BYTES:
            raise serializers.ValidationError({"logo": "Maximum logo size is 1 MiB."})
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                image = Image.open(upload)
                if image.format not in {"JPEG", "PNG"}:
                    raise serializers.ValidationError({"logo": "Use a JPEG or PNG image."})
                image.load()
                image = image.convert("RGBA")
                image.thumbnail((LOGO_MAX_SIDE, LOGO_MAX_SIDE))
                # Re-encoding drops file names and any hidden data in the upload.
                buffer = io.BytesIO()
                image.save(buffer, "PNG", optimize=True)
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise serializers.ValidationError({"logo": "Invalid image."}) from None
        return self.change(request, buffer.getvalue(), "image/png")

    def delete(self, request):
        return self.change(request, None, "")
