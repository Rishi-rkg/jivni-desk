from django.db import connection
from django.http import JsonResponse
from django.urls import include, path
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.routers import DefaultRouter

from accounts import views as auth
from accounts.api import ClinicSettingsView
from modules.contracts import MODULES
from records.views import AuditViewSet, EncounterViewSet, NoteViewSet, PatientViewSet, PhotoViewSet, ScanViewSet
from vault import api as backups

router = DefaultRouter()
router.register("patients", PatientViewSet, basename="patient")
router.register("notes", NoteViewSet, basename="note")
router.register("encounters", EncounterViewSet, basename="encounter")
router.register("photos", PhotoViewSet, basename="photo")
router.register("audit-events", AuditViewSet, basename="audit")
router.register("scan", ScanViewSet, basename="scan")


@api_view(["GET"])
def modules(request):
    return Response(MODULES)


def health(request):
    """Ready only when the database answers. Reveals nothing else."""
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
    except Exception:
        return JsonResponse({"status": "unavailable"}, status=503)
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("health/", health),
    path("api/v1/auth/csrf/", auth.csrf),
    path("api/v1/auth/login/", auth.sign_in),
    path("api/v1/auth/logout/", auth.sign_out),
    path("api/v1/auth/me/", auth.me),
    path("api/v1/auth/clinic/", auth.select_clinic),
    path("api/v1/auth/password/", auth.change_password),
    path("api/v1/clinic/", ClinicSettingsView.as_view()),
    path("api/v1/backups/", backups.overview),
    path("api/v1/backups/policy/", backups.policy),
    path("api/v1/backups/places/", backups.places),
    path("api/v1/backups/places/<uuid:place_id>/", backups.place),
    path("api/v1/backups/run/", backups.run),
    path("api/v1/backups/runs/<uuid:run_id>/verify/", backups.verify),
    path("api/v1/modules/", modules),
    path("api/v1/", include(router.urls)),
]
