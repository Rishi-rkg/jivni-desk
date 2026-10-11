from django.conf import settings
from django.db import connection
from django.http import HttpResponse, JsonResponse
from django.urls import include, path, re_path
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.routers import DefaultRouter

from accounts import views as auth
from accounts.api import ClinicLogoView, ClinicSettingsView
from billing.views import BillingReportViewSet, InvoiceViewSet, PaymentViewSet, PriceItemViewSet
from modules.contracts import MODULES
from printing.views import PrintDataViewSet, PrintJobViewSet, PrintTemplateViewSet
from records.views import (
    AuditViewSet,
    DocumentViewSet,
    EncounterViewSet,
    NoteViewSet,
    PatientViewSet,
    PhotoViewSet,
    PrescriptionSetViewSet,
    ScanViewSet,
    VisitDraftViewSet,
)
from vault import api as backups

router = DefaultRouter()
router.register("patients", PatientViewSet, basename="patient")
router.register("notes", NoteViewSet, basename="note")
router.register("encounters", EncounterViewSet, basename="encounter")
router.register("photos", PhotoViewSet, basename="photo")
router.register("documents", DocumentViewSet, basename="document")
router.register("audit-events", AuditViewSet, basename="audit")
router.register("scan", ScanViewSet, basename="scan")
router.register("visit-drafts", VisitDraftViewSet, basename="visit-draft")
router.register("prescription-sets", PrescriptionSetViewSet, basename="prescription-set")
router.register("price-items", PriceItemViewSet, basename="price-item")
router.register("invoices", InvoiceViewSet, basename="invoice")
router.register("payments", PaymentViewSet, basename="payment")
router.register("billing", BillingReportViewSet, basename="billing")
router.register("print-templates", PrintTemplateViewSet, basename="print-template")
router.register("print-jobs", PrintJobViewSet, basename="print-job")
router.register("print-data", PrintDataViewSet, basename="print-data")


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
    path("api/v1/auth/setup/", auth.setup),
    path("api/v1/auth/login/", auth.sign_in),
    path("api/v1/auth/logout/", auth.sign_out),
    path("api/v1/auth/me/", auth.me),
    path("api/v1/auth/clinic/", auth.select_clinic),
    path("api/v1/auth/password/", auth.change_password),
    path("api/v1/auth/account/", auth.account),
    path("api/v1/clinic/", ClinicSettingsView.as_view()),
    path("api/v1/clinic/logo/", ClinicLogoView.as_view()),
    path("api/v1/backups/", backups.overview),
    path("api/v1/backups/policy/", backups.policy),
    path("api/v1/backups/places/", backups.places),
    path("api/v1/backups/places/<uuid:place_id>/", backups.place),
    path("api/v1/backups/run/", backups.run),
    path("api/v1/backups/runs/<uuid:run_id>/verify/", backups.verify),
    path("api/v1/modules/", modules),
    path("api/v1/", include("knowledge.urls")),
    path("api/v1/", include(router.urls)),
]


def single_page_app(request):
    """Any path that is not the API is a screen of the application; the browser code decides which."""
    response = HttpResponse((settings.FRONTEND_DIST / "index.html").read_bytes(), content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-store"
    return response


if settings.SERVE_FRONTEND:
    urlpatterns.append(re_path(r"^(?!api/|health/).*$", single_page_app))
