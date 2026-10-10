"""Clinic settings. Any member may read them; only the owner or an administrator may change them."""
from django.db import transaction
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView
from audit.models import record_event
from .access import CLINIC_ADMIN, membership
from .models import Clinic


class ClinicSerializer(serializers.ModelSerializer):
    class Meta:
        model = Clinic
        fields = ["id", "name", "time_zone", "address", "phone", "email", "tax_identifier", "currency"]
        read_only_fields = ["id"]

    def validate_currency(self, value):
        return value.upper()


class ClinicSettingsView(APIView):
    def get(self, request):
        return Response(ClinicSerializer(membership(request).clinic).data)

    def patch(self, request):
        member = membership(request)
        if member.role_id not in CLINIC_ADMIN:
            record_event(request, "access.denied", clinic=member.clinic, outcome="denied", resource_type="Clinic", resource_id=member.clinic_id)
            raise PermissionDenied("Your clinic role does not allow this action.")
        serializer = ClinicSerializer(member.clinic, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            clinic = serializer.save()
            record_event(request, "clinic.update", clinic, clinic)
        return Response(ClinicSerializer(clinic).data)
