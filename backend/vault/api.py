"""Backups, for the clinic owner: where they go, when they run, what exists, and checking that one reads back."""

import shutil

from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from accounts.access import membership
from audit.models import record_event

from . import backup
from .models import BackupPlace, BackupPolicy, BackupRun
from .session import ClinicLocked

OWNER = {"owner"}


def owner(request):
    member = membership(request)
    if member.role_id not in OWNER:
        record_event(request, "access.denied", clinic=member.clinic, outcome="denied", resource_type="backup")
        raise PermissionDenied("Only the clinic owner can manage backups.")
    return member


class PolicySerializer(serializers.ModelSerializer):
    class Meta:
        model = BackupPolicy
        fields = ["automatic", "frequency", "at", "keep_daily_days", "keep_monthly_months", "warn_after_days"]

    def validate_keep_daily_days(self, value):
        if not 1 <= value <= 3650:
            raise serializers.ValidationError("Keep daily backups for between 1 day and 10 years.")
        return value

    def validate_warn_after_days(self, value):
        if not 1 <= value <= 60:
            raise serializers.ValidationError("Choose between 1 and 60 days.")
        return value


class PlaceSerializer(serializers.ModelSerializer):
    reachable = serializers.SerializerMethodField()
    free_bytes = serializers.SerializerMethodField()

    class Meta:
        model = BackupPlace
        fields = ["id", "name", "kind", "folder", "last_ok_at", "last_error", "reachable", "free_bytes"]
        read_only_fields = ["id", "last_ok_at", "last_error"]

    def _free(self, place):
        try:
            return shutil.disk_usage(place.folder).free
        except OSError:
            return None

    def get_reachable(self, place):
        return self._free(place) is not None

    def get_free_bytes(self, place):
        return self._free(place)

    def validate_folder(self, value):
        value = value.strip()
        try:
            backup.check_folder(value)
        except backup.BackupError as error:
            raise serializers.ValidationError(str(error)) from None
        return value


class RunSerializer(serializers.ModelSerializer):
    class Meta:
        model = BackupRun
        fields = [
            "id",
            "kind",
            "started_at",
            "finished_at",
            "file_name",
            "byte_size",
            "places",
            "ok",
            "error",
            "verified_at",
            "verified_ok",
        ]
        read_only_fields = fields


def status(clinic):
    last = backup.last_success(clinic)
    problem = ""
    try:
        backup._current_backup_key(clinic)
    except backup.BackupError as error:
        problem = str(error)
    return {
        "last_ok_at": last.finished_at if last else None,
        "overdue": backup.is_overdue(clinic),
        "due": backup.is_due(clinic),
        "problem": problem,
    }


@api_view(["GET"])
def overview(request):
    clinic = owner(request).clinic
    record_event(request, "backup.view", clinic=clinic)
    return Response(
        {
            "status": status(clinic),
            "policy": PolicySerializer(backup.policy_for(clinic)).data,
            "places": PlaceSerializer(BackupPlace.objects.filter(clinic=clinic), many=True).data,
            "runs": RunSerializer(BackupRun.objects.filter(clinic=clinic)[:30], many=True).data,
        }
    )


@api_view(["PATCH"])
def policy(request):
    clinic = owner(request).clinic
    serializer = PolicySerializer(backup.policy_for(clinic), data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    serializer.save()
    record_event(request, "backup.policy_changed", clinic=clinic)
    return Response(serializer.data)


@api_view(["POST"])
def places(request):
    clinic = owner(request).clinic
    serializer = PlaceSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    if BackupPlace.objects.filter(clinic=clinic, folder=serializer.validated_data["folder"]).exists():
        raise ValidationError({"folder": "That folder is already a backup place."})
    place = serializer.save(clinic=clinic)
    record_event(request, "backup.place_added", clinic=clinic, resource_type="BackupPlace", resource_id=place.pk)
    return Response(PlaceSerializer(place).data, status=201)


@api_view(["DELETE"])
def place(request, place_id):
    """Stop saving backups to a place. Backup files already there are left untouched."""
    clinic = owner(request).clinic
    found = get_object_or_404(BackupPlace, pk=place_id, clinic=clinic)
    record_event(request, "backup.place_removed", clinic=clinic, resource_type="BackupPlace", resource_id=found.pk)
    found.delete()
    return Response(status=204)


@api_view(["POST"])
def run(request):
    clinic = owner(request).clinic
    try:
        result = backup.run_backup(clinic, BackupRun.Kind.MANUAL, request.user)
    except backup.BackupError as error:
        record_event(request, "backup.run", clinic=clinic, outcome="failed")
        raise ValidationError({"detail": str(error)}) from None
    record_event(
        request, "backup.run", clinic=clinic, outcome="success" if result.ok else "failed", resource_type="BackupRun", resource_id=result.pk
    )
    return Response(RunSerializer(result).data, status=201 if result.ok else 500)


@api_view(["POST"])
def verify(request, run_id):
    """Read a backup back in full with the clinic key from this session. Nothing is restored or changed."""
    clinic = owner(request).clinic
    found = get_object_or_404(BackupRun, pk=run_id, clinic=clinic, ok=True)
    path = backup.find_file(found)
    if path is None:
        raise ValidationError({"detail": "That backup file is no longer in any backup place."})
    try:
        manifest = backup.verify_backup(path, clinic_keys=request.vault.keys(clinic.pk))
        found.verified_ok, detail = True, ""
    except ClinicLocked:
        raise ValidationError({"detail": "Sign in again to unlock the clinic's records, then try the check again."}) from None
    except backup.BackupError as error:
        manifest, found.verified_ok, detail = None, False, str(error)
    found.verified_at = timezone.now()
    found.save(update_fields=["verified_at", "verified_ok"])
    record_event(
        request,
        "backup.verify",
        clinic=clinic,
        outcome="success" if found.verified_ok else "failed",
        resource_type="BackupRun",
        resource_id=found.pk,
    )
    return Response({"run": RunSerializer(found).data, "counts": manifest["counts"] if manifest else None, "detail": detail})
