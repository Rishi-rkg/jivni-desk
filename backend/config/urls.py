from django.http import JsonResponse
from django.urls import include, path
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.routers import DefaultRouter
from accounts import views as auth
from records.views import PatientViewSet, NoteViewSet, EncounterViewSet, PhotoViewSet, AuditViewSet
from modules.contracts import MODULES

router = DefaultRouter()
router.register("patients", PatientViewSet, basename="patient")
router.register("notes", NoteViewSet, basename="note")
router.register("encounters", EncounterViewSet, basename="encounter")
router.register("photos", PhotoViewSet, basename="photo")
router.register("audit-events", AuditViewSet, basename="audit")


@api_view(["GET"])
def modules(request):
    return Response(MODULES)


urlpatterns = [
    path("health/", lambda request: JsonResponse({"status": "ok"})),
    path("api/v1/auth/csrf/", auth.csrf),
    path("api/v1/auth/login/", auth.sign_in),
    path("api/v1/auth/logout/", auth.sign_out),
    path("api/v1/auth/me/", auth.me),
    path("api/v1/auth/clinic/", auth.select_clinic),
    path("api/v1/modules/", modules),
    path("api/v1/", include(router.urls)),
]
