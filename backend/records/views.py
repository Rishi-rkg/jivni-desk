import uuid
from django.core.exceptions import ValidationError as ModelValidationError
from django.db import transaction
from django.db.models import Q
from django.http import FileResponse
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from accounts.access import membership, require_role, CLINICAL_READ, CLINICAL_WRITE, DEMOGRAPHIC_WRITE
from audit.models import AuditEvent, record_event
from .models import Patient, PatientPhoto, PatientNote, Encounter
from .serializers import PatientSerializer, PhotoSerializer, NoteSerializer, EncounterSerializer
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
        return super().handle_exception(exc)

    def event(self, action_name, resource=None):
        record_event(self.request, action_name, resource, self.member.clinic)


class PatientViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin, mixins.UpdateModelMixin, ClinicViewSet):
    serializer_class = PatientSerializer
    http_method_names = ["get", "post", "patch", "head", "options"]

    def get_queryset(self):
        queryset = Patient.objects.filter(clinic=self.member.clinic).select_related("address").prefetch_related("photos")
        if self.action == "list":
            if self.request.query_params.get("archived") != "true":
                queryset = queryset.filter(archived_at__isnull=True)
            search = self.request.query_params.get("search", "").strip()[:200]
            if search:
                query = Q(first_name__icontains=search) | Q(middle_name__icontains=search) | Q(last_name__icontains=search) | Q(phone__icontains=search)
                for word in search.split():
                    query |= Q(first_name__icontains=word) | Q(last_name__icontains=word)
                try:
                    query |= Q(id=uuid.UUID(search))
                except ValueError:
                    pass
                queryset = queryset.filter(query)
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
        return Response({"encounters": EncounterSerializer(encounters, many=True).data, "notes": NoteSerializer(notes, many=True).data, "limit_per_type": 50})

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
                photo = PatientPhoto.objects.create(patient=patient, uploaded_by=request.user, storage_key=stored.key, mime_type=stored.mime_type, byte_size=stored.byte_size, sha256=stored.sha256)
                self.event("photo.create", photo)
        except Exception:
            photo_store.delete(stored.key)
            raise
        return Response(PhotoSerializer(photo).data, status=201)


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
                raise serializers.ValidationError({"patient": "Invalid patient ID."})
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
        queryset = Encounter.objects.filter(patient__clinic=self.member.clinic).select_related("clinician").prefetch_related("observations", "prescriptions__items")
        if self.request.query_params.get("patient"):
            try:
                patient_id = uuid.UUID(self.request.query_params["patient"])
            except ValueError:
                raise serializers.ValidationError({"patient": "Invalid patient ID."})
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
    class Meta:
        model = AuditEvent
        fields = ["id", "actor", "action", "resource_type", "resource_id", "occurred_at"]
        read_only_fields = fields


class AuditViewSet(mixins.ListModelMixin, ClinicViewSet):
    serializer_class = AuditSerializer

    def get_queryset(self):
        require_role(self.request, {"owner", "admin"})
        return AuditEvent.objects.filter(clinic=self.member.clinic).order_by("-occurred_at", "id")

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        self.event("audit.list")
        return response
