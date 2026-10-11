import uuid

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import transaction
from django.db.models import Prefetch, Q
from django.http import FileResponse
from django.utils import timezone
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from accounts.access import CLINIC_ADMIN, CLINICAL_READ, CLINICAL_WRITE, DEMOGRAPHIC_WRITE, membership, require_role
from audit.models import AuditEvent, record_event

from .models import Encounter, Patient, PatientIdentifier, PatientNote, PatientPhoto, normalize_patient_code
from .serializers import (
    DuplicateCheckSerializer,
    EncounterSerializer,
    NoteSerializer,
    PatientSerializer,
    PhotoSerializer,
    RevisionSerializer,
)
from .storage import photo_store


class ClinicViewSet(viewsets.GenericViewSet):
    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        self.member = membership(request)

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "member": self.member}

    def handle_exception(self, exc):
        if isinstance(exc, ModelValidationError):
            exc = serializers.ValidationError(exc.message_dict if hasattr(exc, "message_dict") else exc.messages)
        if isinstance(exc, PermissionDenied) and self.request.user.is_authenticated:
            self.denied()
        return super().handle_exception(exc)

    def denied(self):
        """Record a refused request: which kind of record and which ID, never its content."""
        member = getattr(self, "member", None)
        try:
            resource_id = uuid.UUID(str(self.kwargs.get("pk")))
        except ValueError:
            resource_id = None
        record_event(
            self.request,
            "access.denied",
            clinic=member.clinic if member else None,
            outcome="denied",
            resource_type=getattr(self, "basename", "") or "",
            resource_id=resource_id,
        )

    def event(self, action_name, resource=None):
        record_event(self.request, action_name, resource, self.member.clinic)


class PatientViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin, mixins.UpdateModelMixin, ClinicViewSet):
    serializer_class = PatientSerializer
    http_method_names = ["get", "post", "patch", "head", "options"]

    def get_queryset(self):
        active_codes = Prefetch(
            "identifiers", queryset=PatientIdentifier.objects.filter(revoked_at__isnull=True), to_attr="active_identifiers"
        )
        queryset = Patient.objects.filter(clinic=self.member.clinic).select_related("address").prefetch_related("photos", active_codes)
        if self.action == "list":
            if self.request.query_params.get("archived") != "true":
                queryset = queryset.filter(archived_at__isnull=True)
            search = self.request.query_params.get("search", "").strip()[:200]
            if search:
                query = (
                    Q(first_name__icontains=search)
                    | Q(middle_name__icontains=search)
                    | Q(last_name__icontains=search)
                    | Q(phone__icontains=search)
                    | Q(whatsapp_number__icontains=search)
                )
                code = normalize_patient_code(search)
                if code:
                    query |= Q(identifiers__code=code, identifiers__revoked_at__isnull=True)
                for word in search.split():
                    query |= Q(first_name__icontains=word) | Q(last_name__icontains=word)
                try:
                    query |= Q(id=uuid.UUID(search))
                except ValueError:
                    pass
                queryset = queryset.filter(query).distinct()
        return queryset

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        self.event("patient.list")
        return response

    def retrieve(self, request, *args, **kwargs):
        patient = self.get_object()
        self.event("patient.view", patient)
        return Response(self.get_serializer(patient).data)

    @transaction.atomic
    def perform_create(self, serializer):
        require_role(self.request, DEMOGRAPHIC_WRITE)
        patient = serializer.save(clinic=self.member.clinic)
        self.event("patient.create", patient)

    @transaction.atomic
    def perform_update(self, serializer):
        require_role(self.request, DEMOGRAPHIC_WRITE)
        patient = serializer.save()
        self.event("patient.update", patient)

    @action(detail=True, methods=["get"])
    def timeline(self, request, pk=None):
        require_role(request, CLINICAL_READ)
        patient = self.get_object()
        # Timeline summary is bounded; full collections have paginated endpoints.
        encounters = patient.encounters.select_related("clinician").prefetch_related("observations", "prescriptions__items")[:50]
        notes = patient.notes.select_related("author").order_by("-created_at", "id")[:50]
        self.event("patient.timeline", patient)
        return Response(
            {
                "encounters": EncounterSerializer(encounters, many=True, context=self.get_serializer_context()).data,
                "notes": NoteSerializer(notes, many=True).data,
                "limit_per_type": 50,
            }
        )

    @action(detail=False, methods=["get"], url_path=r"by-code/(?P<code>[^/]+)")
    def by_code(self, request, code=None):
        """Open the patient for a scanned or typed card code. Only an active code of this clinic resolves."""
        normalized = normalize_patient_code(code)
        patient = (
            self.get_queryset().filter(identifiers__code=normalized, identifiers__revoked_at__isnull=True).first() if normalized else None
        )
        if not patient:
            # The code itself is never written to the audit log.
            record_event(request, "patient.scan", clinic=self.member.clinic, outcome="failed")
            return Response({"detail": "No patient in this clinic has that code."}, status=404)
        self.event("patient.scan", patient)
        return Response(self.get_serializer(patient).data)

    @action(detail=False, methods=["post"], url_path="check-duplicates")
    def check_duplicates(self, request):
        """Possible existing records for a patient about to be registered. Advice only; nothing is blocked.

        A POST so that names and phone numbers never appear in a URL.
        """
        serializer = DuplicateCheckSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        phones = {value.strip() for value in [data.get("phone", ""), data.get("whatsapp_number", "")] if value.strip()}
        first, last, born = data.get("first_name", "").strip(), data.get("last_name", "").strip(), data.get("date_of_birth")
        query = Q(pk__in=[])
        if phones:
            query |= Q(phone__in=phones) | Q(whatsapp_number__in=phones)
        if born and first:
            query |= Q(date_of_birth=born, first_name__iexact=first)
        if first and last:
            query |= Q(first_name__iexact=first, last_name__iexact=last)
        matches = []
        for patient in self.get_queryset().filter(query).distinct()[:5]:
            reasons = []
            if phones & {patient.phone, patient.whatsapp_number}:
                reasons.append("same phone number")
            if born and patient.date_of_birth == born and patient.first_name.lower() == first.lower():
                reasons.append("same first name and date of birth")
            if first and last and patient.first_name.lower() == first.lower() and patient.last_name.lower() == last.lower():
                reasons.append("same name")
            matches.append({**self.get_serializer(patient).data, "reasons": reasons})
        self.event("patient.duplicate_check")
        return Response({"matches": matches})

    @action(detail=True, methods=["get"])
    def revisions(self, request, pk=None):
        patient = self.get_object()
        revisions = patient.revisions.select_related("changed_by")[:50]
        self.event("patient.revisions", patient)
        return Response({"revisions": RevisionSerializer(revisions, many=True).data, "limit": 50})

    @action(detail=True, methods=["post"], url_path="reissue-code")
    def reissue_code(self, request, pk=None):
        """Lost or damaged card: the old code stops working at once and a new one is issued."""
        require_role(request, DEMOGRAPHIC_WRITE)
        patient = self.get_object()
        with transaction.atomic():
            for identifier in patient.identifiers.filter(revoked_at__isnull=True):
                identifier.revoked_at = timezone.now()
                identifier.revoked_by = request.user
                identifier.save()
            PatientIdentifier.issue(patient, request.user)
            self.event("patient.reissue_code", patient)
        return Response(self.get_serializer(self.get_queryset().get(pk=patient.pk)).data)

    @action(detail=True, methods=["post"])
    def archive(self, request, pk=None):
        return self.set_archived(request, True)

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        return self.set_archived(request, False)

    def set_archived(self, request, archived):
        require_role(request, CLINICAL_WRITE)
        patient = self.get_object()
        if bool(patient.archived_at) != archived:
            with transaction.atomic():
                # The server sets the time; a client can neither choose nor backdate it.
                patient.archived_at = timezone.now() if archived else None
                patient.save()
                self.event("patient.archive" if archived else "patient.restore", patient)
        return Response(self.get_serializer(patient).data)

    @action(detail=True, methods=["post"], url_path="photos")
    def upload_photo(self, request, pk=None):
        require_role(request, DEMOGRAPHIC_WRITE)
        patient = self.get_object()
        upload = request.FILES.get("photo")
        if not upload:
            raise serializers.ValidationError({"photo": "Choose an image."})
        stored = photo_store.store(self.member.clinic_id, upload)
        try:
            with transaction.atomic():
                photo = PatientPhoto.objects.create(
                    patient=patient,
                    uploaded_by=request.user,
                    storage_key=stored.key,
                    mime_type=stored.mime_type,
                    byte_size=stored.byte_size,
                    sha256=stored.sha256,
                )
                self.event("photo.create", photo)
        except Exception:
            photo_store.delete(stored.key)
            raise
        return Response(PhotoSerializer(photo).data, status=201)


class ScanViewSet(ClinicViewSet):
    """The one place that answers "what is this barcode?", so every scanner in the clinic behaves the same.

    Today it knows patient card codes. Product barcodes join here when the product list is built; the
    screen then decides where to go (patient record, add to the open visit's bill, or a new bill).
    """

    lookup_field = "code"
    lookup_value_regex = "[^/]+"

    def retrieve(self, request, code=None):
        normalized = normalize_patient_code(code)
        if normalized:
            patient = (
                Patient.objects.filter(clinic=self.member.clinic, identifiers__code=normalized, identifiers__revoked_at__isnull=True)
                .select_related("address")
                .prefetch_related("photos")
                .first()
            )
            if patient:
                self.event("patient.scan", patient)
                data = PatientSerializer(patient, context=self.get_serializer_context()).data
                return Response({"kind": "patient", "patient": data})
        # What was scanned is never written to the audit log.
        record_event(request, "scan.unknown", clinic=self.member.clinic, outcome="failed")
        return Response({"kind": "unknown", "detail": "Nothing in this clinic matches that code."}, status=404)


class PhotoViewSet(mixins.RetrieveModelMixin, ClinicViewSet):
    serializer_class = PhotoSerializer

    def get_queryset(self):
        return PatientPhoto.objects.filter(patient__clinic=self.member.clinic)

    def retrieve(self, request, *args, **kwargs):
        photo = self.get_object()
        self.event("photo.view", photo)
        return FileResponse(photo_store.open(photo.storage_key), content_type=photo.mime_type)


class NoteViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, ClinicViewSet):
    serializer_class = NoteSerializer

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        require_role(request, CLINICAL_READ if request.method in {"GET", "HEAD", "OPTIONS"} else CLINICAL_WRITE)

    def get_queryset(self):
        queryset = PatientNote.objects.filter(patient__clinic=self.member.clinic).select_related("author").order_by("-created_at", "id")
        if self.request.query_params.get("patient"):
            try:
                patient_id = uuid.UUID(self.request.query_params["patient"])
            except ValueError:
                raise serializers.ValidationError({"patient": "Invalid patient ID."}) from None
            queryset = queryset.filter(patient_id=patient_id)
        return queryset

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        self.event("note.list")
        return response

    @transaction.atomic
    def perform_create(self, serializer):
        note = serializer.save(author=self.request.user)
        self.event("note.create", note)


class EncounterViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin, ClinicViewSet):
    serializer_class = EncounterSerializer

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        require_role(request, CLINICAL_READ if request.method in {"GET", "HEAD", "OPTIONS"} else CLINICAL_WRITE)

    def get_queryset(self):
        queryset = (
            Encounter.objects.filter(patient__clinic=self.member.clinic)
            .select_related("clinician")
            .prefetch_related("observations", "prescriptions__items")
        )
        if self.request.query_params.get("patient"):
            try:
                patient_id = uuid.UUID(self.request.query_params["patient"])
            except ValueError:
                raise serializers.ValidationError({"patient": "Invalid patient ID."}) from None
            queryset = queryset.filter(patient_id=patient_id)
        return queryset

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        self.event("encounter.list")
        return response

    def retrieve(self, request, *args, **kwargs):
        encounter = self.get_object()
        self.event("encounter.view", encounter)
        return Response(self.get_serializer(encounter).data)

    @transaction.atomic
    def perform_create(self, serializer):
        encounter = serializer.save(clinician=self.request.user)
        self.event("encounter.create", encounter)


class AuditSerializer(serializers.ModelSerializer):
    actor_username = serializers.CharField(source="actor.username", read_only=True, default="")

    class Meta:
        model = AuditEvent
        fields = [
            "id",
            "actor",
            "actor_username",
            "action",
            "outcome",
            "resource_type",
            "resource_id",
            "source_ip",
            "request_id",
            "occurred_at",
        ]
        read_only_fields = fields


class AuditViewSet(mixins.ListModelMixin, ClinicViewSet):
    serializer_class = AuditSerializer

    def get_queryset(self):
        require_role(self.request, CLINIC_ADMIN)
        queryset = AuditEvent.objects.filter(clinic=self.member.clinic).select_related("actor").order_by("-occurred_at", "id")
        outcome = self.request.query_params.get("outcome")
        if outcome in {"success", "denied", "failed"}:
            queryset = queryset.filter(outcome=outcome)
        return queryset

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        self.event("audit.list")
        return response
