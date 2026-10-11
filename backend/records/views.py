import datetime
import uuid

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import transaction
from django.db.models import F, Prefetch, Q
from django.http import FileResponse, HttpResponse
from django.utils import timezone
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from accounts.access import BILLING_READ, CLINIC_ADMIN, CLINICAL_READ, CLINICAL_WRITE, DEMOGRAPHIC_WRITE, membership, require_role
from accounts.features import feature_on
from audit.models import AuditEvent, record_event

from . import patient_extras
from .models import (
    Encounter,
    EncounterAmendment,
    EncounterDraft,
    FamilyLink,
    Patient,
    PatientDocument,
    PatientIdentifier,
    PatientNote,
    PatientPhoto,
    PrescriptionSet,
    normalize_patient_code,
)
from .serializers import (
    AmendmentSerializer,
    DocumentSerializer,
    DraftSerializer,
    DuplicateCheckSerializer,
    EncounterSerializer,
    FamilyLinkSerializer,
    NoteSerializer,
    PatientSerializer,
    PhotoSerializer,
    PrescriptionSetSerializer,
    RevisionSerializer,
)
from .storage import document_store, photo_store


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
    # DELETE exists only for unlinking a family member; a patient is archived, never deleted.
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

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
            queryset = self.narrowed(queryset)
        return queryset

    def narrowed(self, queryset):
        """The list's chips and sort order: follow-up due, balance due, seen this month."""
        params, clinic = self.request.query_params, self.member.clinic
        queryset = patient_extras.with_visit_dates(queryset)
        if params.get("follow_up") == "due":
            queryset = queryset.filter(next_advised__lte=clinic.today())
        if params.get("seen") == "month":
            first = clinic.today().replace(day=1)
            queryset = queryset.filter(last_visit_at__gte=datetime.datetime.combine(first, datetime.time.min, tzinfo=clinic.tzinfo))
        if params.get("balance") == "due":
            if self.member.role_id not in BILLING_READ or not feature_on(clinic, "billing"):
                raise PermissionDenied("Your clinic role does not allow this action.")
            queryset = queryset.filter(pk__in=patient_extras.patients_with_a_balance(clinic))
        order = {
            "last_visit": [F("last_visit_at").desc(nulls_last=True), "last_name", "first_name", "id"],
            "registered": ["-created_at", "id"],
        }.get(params.get("sort"))
        return queryset.order_by(*order) if order else queryset

    def with_extras(self, patients):
        return {**self.get_serializer_context(), "extras": patient_extras.extras(self.member, patients)}

    def one(self, patient, status=200):
        """A patient as the record page shows them: details, dates, balance, consent and family."""
        data = PatientSerializer(patient, context=self.with_extras([patient])).data
        return Response(
            {**data, "consent": patient_extras.consent_data(patient), "family": patient_extras.family_data(patient)}, status=status
        )

    def list(self, request, *args, **kwargs):
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        response = self.get_paginated_response(PatientSerializer(page, many=True, context=self.with_extras(page)).data)
        # How many patients the clinic has in all, so "4 of 312" can be shown beside a search.
        response.data["clinic_total"] = Patient.objects.filter(clinic=self.member.clinic, archived_at__isnull=True).count()
        self.event("patient.list")
        return response

    def retrieve(self, request, *args, **kwargs):
        patient = self.get_object()
        self.event("patient.view", patient)
        return self.one(patient)

    def consent_choices(self):
        choices = self.request.data.get("consent")
        if choices is None:
            return {}
        if not isinstance(choices, dict) or any(
            key not in {"care", "greetings"} or not isinstance(value, bool) for key, value in choices.items()
        ):
            raise serializers.ValidationError({"consent": "Say yes or no to care messages and to greetings."})
        return choices

    def create(self, request, *args, **kwargs):
        require_role(request, DEMOGRAPHIC_WRITE)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        choices = self.consent_choices()
        with transaction.atomic():
            patient = serializer.save(clinic=self.member.clinic)
            patient_extras.record_consent(patient, request.user, choices)
            self.event("patient.create", patient)
        return self.one(self.get_queryset().get(pk=patient.pk), 201)

    def partial_update(self, request, *args, **kwargs):
        require_role(request, DEMOGRAPHIC_WRITE)
        patient = self.get_object()
        serializer = self.get_serializer(patient, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        choices = self.consent_choices()
        with transaction.atomic():
            patient = serializer.save()
            patient_extras.record_consent(patient, request.user, choices)
            self.event("patient.update", patient)
        return self.one(self.get_queryset().get(pk=patient.pk))

    @action(detail=True, methods=["post"])
    def consent(self, request, pk=None):
        """Record the patient's yes or no to each kind of message, with who recorded it and when."""
        require_role(request, DEMOGRAPHIC_WRITE)
        patient = self.get_object()
        choices = {key: value for key, value in request.data.items() if key in {"care", "greetings"}}
        if not choices or any(not isinstance(value, bool) for value in choices.values()):
            raise serializers.ValidationError({"consent": "Say yes or no to care messages and to greetings."})
        with transaction.atomic():
            patient_extras.record_consent(patient, request.user, choices)
            self.event("patient.consent", patient)
        return Response(patient_extras.consent_data(patient))

    @action(detail=True, methods=["get", "post"])
    def family(self, request, pk=None):
        patient = self.get_object()
        if request.method == "POST":
            require_role(request, DEMOGRAPHIC_WRITE)
            serializer = FamilyLinkSerializer(data=request.data, context=self.get_serializer_context())
            serializer.is_valid(raise_exception=True)
            relative = serializer.validated_data["relative"]
            if relative.pk == patient.pk:
                raise serializers.ValidationError({"relative": "A patient cannot be linked to themselves."})
            with transaction.atomic():
                link, _ = FamilyLink.objects.update_or_create(
                    patient=patient, relative=relative, defaults={"relation": serializer.validated_data.get("relation", "")}
                )
                self.event("patient.family_link", patient)
        return Response(patient_extras.family_data(patient))

    @action(detail=True, methods=["delete"], url_path=r"family/(?P<link_id>[^/]+)")
    def unlink(self, request, pk=None, link_id=None):
        require_role(request, DEMOGRAPHIC_WRITE)
        patient = self.get_object()
        try:
            link = FamilyLink.objects.filter(Q(patient=patient) | Q(relative=patient)).get(pk=uuid.UUID(str(link_id)))
        except (FamilyLink.DoesNotExist, ValueError):
            return Response({"detail": "That link was not found."}, status=404)
        with transaction.atomic():
            link.delete()
            self.event("patient.family_unlink", patient)
        return Response(patient_extras.family_data(patient))

    @action(detail=True, methods=["get"])
    def measurements(self, request, pk=None):
        """Height, weight, blood pressure and pulse over time, newest first."""
        require_role(request, CLINICAL_READ)
        patient = self.get_object()
        rows = {}
        for observation in patient.observations.select_related("encounter").order_by("-measured_at")[:400]:
            day = self.member.clinic.local_date(observation.measured_at).isoformat()
            rows.setdefault((day, observation.encounter_id), {"date": day})[observation.kind] = str(observation.value.normalize())
        self.event("patient.measurements", patient)
        return Response({"results": list(rows.values())})

    @action(detail=True, methods=["get", "post"])
    def documents(self, request, pk=None):
        require_role(request, CLINICAL_READ)
        patient = self.get_object()
        if request.method == "POST":
            upload = request.FILES.get("file")
            title = " ".join(str(request.data.get("title", "")).split())[:200]
            if not upload:
                raise serializers.ValidationError({"file": "Choose a file."})
            if not title:
                raise serializers.ValidationError({"title": "Give the document a short title, such as “Blood report”."})
            stored = document_store.store(self.member.clinic_id, upload)
            try:
                with transaction.atomic():
                    document = PatientDocument.objects.create(
                        patient=patient,
                        title=title,
                        uploaded_by=request.user,
                        storage_key=stored.key,
                        mime_type=stored.mime_type,
                        byte_size=stored.byte_size,
                        sha256=stored.sha256,
                    )
                    self.event("document.create", document)
            except Exception:
                document_store.delete(stored.key)
                raise
            return Response(DocumentSerializer(document).data, status=201)
        self.event("document.list", patient)
        return Response({"results": DocumentSerializer(patient.documents.select_related("uploaded_by"), many=True).data})

    @action(detail=True, methods=["get"])
    def feed(self, request, pk=None):
        """Everything that happened with a patient, newest first, as far as this role may see it."""
        patient = self.get_object()
        try:
            before = datetime.datetime.fromisoformat(request.query_params["before"]) if request.query_params.get("before") else None
            limit = min(max(int(request.query_params.get("limit", 30)), 1), 100)
        except ValueError:
            raise serializers.ValidationError({"before": "Use a full date and time."}) from None
        items = timeline_items(self.member, patient, before, limit + 1, self.get_serializer_context())
        self.event("patient.timeline", patient)
        return Response({"items": items[:limit], "more": len(items) > limit})

    @action(detail=False, methods=["post"], url_path="import")
    def import_rows(self, request):
        """Bring patients in from a spreadsheet. A trial run reports what would happen and saves nothing."""
        require_role(request, {"owner"})
        rows = request.data.get("rows")
        if not isinstance(rows, list) or not 1 <= len(rows) <= 2000 or any(not isinstance(row, dict) for row in rows):
            raise serializers.ValidationError({"rows": "Send between 1 and 2,000 rows."})
        trial = request.data.get("dry_run") is not False
        include_duplicates = request.data.get("include_duplicates") is True
        clinic = self.member.clinic
        known = set()
        for first, last, born, phone in Patient.objects.filter(clinic=clinic).values_list(
            "first_name", "last_name", "date_of_birth", "phone"
        ):
            known.add((first.lower(), last.lower(), born.isoformat() if born else ""))
            if phone:
                known.add(("phone", phone))
        ready, duplicates, errors, created = [], 0, [], 0
        for number, row in enumerate(rows, start=2):  # row 1 of a spreadsheet is its headings
            data, problems = patient_extras.clean_import_row(row, clinic.today())
            if not problems:
                serializer = PatientSerializer(data=data, context=self.get_serializer_context())
                if not serializer.is_valid():
                    problems = [
                        f"{field}: {' '.join(str(message) for message in messages)}" for field, messages in serializer.errors.items()
                    ]
            if problems:
                errors.append({"row": number, "problem": "; ".join(problems)})
                continue
            keys = {(data["first_name"].lower(), data["last_name"].lower(), data["date_of_birth"])}
            if data["phone"]:
                keys.add(("phone", data["phone"]))
            if keys & known:
                duplicates += 1
                if not include_duplicates:
                    continue
            known |= keys
            ready.append(serializer)
        if not trial:
            with transaction.atomic():
                for serializer in ready:
                    serializer.save(clinic=clinic)
                    created += 1
                # One audit row for the whole import: how many, never who.
                self.event("patient.import")
        return Response(
            {
                "dry_run": trial,
                "ready": len(ready),
                "duplicates": duplicates,
                "errors": errors[:200],
                "error_count": len(errors),
                "created": created,
            }
        )

    @action(detail=False, methods=["get"])
    def export(self, request):
        """Every patient's details as a spreadsheet, for the owner."""
        require_role(request, {"owner"})
        patients = (
            Patient.objects.filter(clinic=self.member.clinic).prefetch_related("identifiers").order_by("last_name", "first_name", "id")
        )
        response = HttpResponse(patient_extras.export_csv(patients), content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = 'attachment; filename="jivni-patients.csv"'
        self.event("patient.export")
        return response

    @action(detail=True, methods=["get"])
    def timeline(self, request, pk=None):
        require_role(request, CLINICAL_READ)
        patient = self.get_object()
        # Timeline summary is bounded; full collections have paginated endpoints.
        encounters = patient.encounters.select_related("clinician").prefetch_related(*VISIT_PARTS)[:50]
        notes = patient.notes.select_related("author").order_by("-created_at", "id")
        if self.member.role_id not in CLINICAL_WRITE:
            notes = notes.exclude(kind=PatientNote.Kind.REMEMBER)
        notes = notes[:50]
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

    It knows patient card codes and the barcodes of products in the price list. The screen then decides
    where to go: the patient record, a line on the open bill or visit, or a new bill.
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
        product = self.product(code)
        if product:
            self.event("scan.product", product)
            return Response({"kind": "product", "product": product_data(product)})
        # What was scanned is never written to the audit log.
        record_event(request, "scan.unknown", clinic=self.member.clinic, outcome="failed")
        if normalized and PatientIdentifier.objects.filter(code=normalized, patient__clinic=self.member.clinic).exists():
            # A card that was replaced: say so, but open nothing.
            return Response({"kind": "revoked", "detail": "This card is no longer valid."}, status=404)
        return Response({"kind": "unknown", "detail": "Nothing in this clinic matches that code."}, status=404)

    def product(self, code):
        """A pack from the price list, when the clinic sells products and the person works with bills."""
        from billing.models import PriceItem

        clinic, barcode = self.member.clinic, "".join(str(code).split())
        if not (barcode and feature_on(clinic, "billing") and feature_on(clinic, "product_sales")):
            return None
        if self.member.role_id not in BILLING_READ | CLINICAL_READ:
            return None
        return PriceItem.objects.filter(clinic=clinic, barcode=barcode, active=True).first()


def product_data(item):
    return {"id": str(item.pk), "name": item.name, "kind": item.kind, "rate": str(item.rate), "gst_rate": str(item.gst_rate)}


class PhotoViewSet(mixins.RetrieveModelMixin, ClinicViewSet):
    serializer_class = PhotoSerializer

    def get_queryset(self):
        return PatientPhoto.objects.filter(patient__clinic=self.member.clinic)

    def retrieve(self, request, *args, **kwargs):
        photo = self.get_object()
        self.event("photo.view", photo)
        return FileResponse(photo_store.open(photo.storage_key), content_type=photo.mime_type)


class DocumentViewSet(ClinicViewSet):
    """A patient's document itself, for viewing. Clinical roles only."""

    def retrieve(self, request, pk=None):
        require_role(request, CLINICAL_READ)
        try:
            document = PatientDocument.objects.get(pk=uuid.UUID(str(pk)), patient__clinic=self.member.clinic)
        except (PatientDocument.DoesNotExist, ValueError):
            return Response({"detail": "That document was not found."}, status=404)
        self.event("document.view", document)
        response = FileResponse(document_store.open(document.storage_key), content_type=document.mime_type)
        # Shown in the page, under a name that says nothing about the patient, and never guessed to be anything else.
        response["Content-Disposition"] = f'inline; filename="document.{"pdf" if document.mime_type == "application/pdf" else "jpg"}"'
        response["X-Content-Type-Options"] = "nosniff"
        return response


def timeline_items(member, patient, before, limit, context):
    """The patient's history as one list. Each role gets only the kinds, and the detail, it may read."""
    from billing.models import Invoice

    clinic, role = member.clinic, member.role_id
    clinical = role in CLINICAL_READ

    def older(queryset, field):
        return queryset.filter(**{f"{field}__lt": before}) if before else queryset

    items = []
    visits = older(patient.encounters.select_related("clinician").prefetch_related(*VISIT_PARTS), "occurred_at").order_by("-occurred_at")
    for visit in visits[:limit]:
        item = {
            "kind": "visit",
            "id": str(visit.pk),
            "at": visit.occurred_at.isoformat(),
            "visit_type": visit.visit_type,
            "clinician_name": visit.clinician.get_full_name() or visit.clinician.username,
            "amended_at": max((a.created_at for a in visit.amendments.all()), default=None),
        }
        if clinical:
            item["visit"] = EncounterSerializer(visit, context=context).data
        items.append(item)
    if role in BILLING_READ and feature_on(clinic, "billing"):
        bills = Invoice.objects.filter(clinic=clinic, patient=patient).exclude(status=Invoice.Status.DRAFT)
        for bill in older(bills, "issued_at").prefetch_related("payments", "credit_notes").order_by("-issued_at")[:limit]:
            payments = [payment for payment in bill.payments.all() if payment.kind == "payment"]
            items.append(
                {
                    "kind": "invoice",
                    "id": str(bill.pk),
                    "at": bill.issued_at.isoformat(),
                    "number": bill.number,
                    "state": bill.state,
                    "total": str(bill.total),
                    "paid": str(bill.paid),
                    "balance": str(bill.balance),
                    "method": payments[-1].method if payments else "",
                }
            )
    notes = patient.notes.filter(kind__in=patient_extras.visible_note_kinds(role)).exclude(kind=PatientNote.Kind.REMEMBER)
    for note in older(notes.select_related("author"), "created_at").order_by("-created_at")[:limit]:
        items.append(
            {
                "kind": "note",
                "id": str(note.pk),
                "at": note.created_at.isoformat(),
                "note_kind": note.kind,
                "body": note.body,
                "author_name": note.author.get_full_name() or note.author.username,
            }
        )
    if clinical:
        for document in older(patient.documents.all(), "created_at").order_by("-created_at")[:limit]:
            items.append(
                {
                    "kind": "document",
                    "id": str(document.pk),
                    "at": document.created_at.isoformat(),
                    "title": document.title,
                    "mime_type": document.mime_type,
                    "byte_size": document.byte_size,
                }
            )
    for extra in TIMELINE_SOURCES:
        items.extend(extra(member, patient, before, limit))
    items.sort(key=lambda item: item["at"], reverse=True)
    return items[:limit]


# Other parts of the application (appointments, messages) add their own kinds of timeline item here.
TIMELINE_SOURCES = []


class NoteViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, ClinicViewSet):
    serializer_class = NoteSerializer

    def get_queryset(self):
        queryset = PatientNote.objects.filter(patient__clinic=self.member.clinic).select_related("author").order_by("-created_at", "id")
        if self.request.query_params.get("patient"):
            try:
                patient_id = uuid.UUID(self.request.query_params["patient"])
            except ValueError:
                raise serializers.ValidationError({"patient": "Invalid patient ID."}) from None
            queryset = queryset.filter(patient_id=patient_id)
        # Everyone reads general notes; clinical roles the clinical ones; "Remember" notes are for doctors only.
        queryset = queryset.filter(kind__in=patient_extras.visible_note_kinds(self.member.role_id))
        kind = self.request.query_params.get("kind")
        if kind in PatientNote.Kind.values:
            queryset = queryset.filter(kind=kind)
        return queryset

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        self.event("note.list")
        return response

    @transaction.atomic
    def perform_create(self, serializer):
        # A general note is front-desk work; anything clinical is written by a doctor.
        general = serializer.validated_data.get("kind") == PatientNote.Kind.GENERAL
        require_role(self.request, DEMOGRAPHIC_WRITE if general else CLINICAL_WRITE)
        note = serializer.save(author=self.request.user)
        self.event("note.create", note)


class EncounterViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin, ClinicViewSet):
    serializer_class = EncounterSerializer

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        require_role(request, CLINICAL_READ if request.method in {"GET", "HEAD", "OPTIONS"} else CLINICAL_WRITE)

    def get_queryset(self):
        queryset = Encounter.objects.filter(patient__clinic=self.member.clinic).select_related("clinician").prefetch_related(*VISIT_PARTS)
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
        # Whoever was waiting for this visit has now been seen.
        from scheduling.views import mark_seen

        mark_seen(self.member.clinic, encounter.patient, self.request.user)

    @action(detail=True, methods=["post"])
    def amendments(self, request, pk=None):
        """Correct a finalised visit by adding beside it. The visit itself is never rewritten."""
        encounter = self.get_object()
        serializer = AmendmentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            amendment = EncounterAmendment.objects.create(encounter=encounter, author=request.user, **serializer.validated_data)
            self.event("encounter.amend", encounter)
        return Response(AmendmentSerializer(amendment).data, status=201)


# Everything a visit is shown with, fetched together.
VISIT_PARTS = ["observations", "prescriptions__items", "products", "amendments__author", "invoices__payments", "invoices__credit_notes"]


class DoctorsOnlyViewSet(ClinicViewSet):
    """Working material of the doctors: nobody else reads or writes it."""

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        require_role(request, CLINICAL_WRITE)


class VisitDraftViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin, mixins.DestroyModelMixin, DoctorsOnlyViewSet
):
    """Visits being written. A draft can be changed and thrown away; finalising it is `POST encounters/` with its ID."""

    serializer_class = DraftSerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    pagination_class = None

    def get_queryset(self):
        queryset = EncounterDraft.objects.filter(patient__clinic=self.member.clinic).select_related("patient", "author")
        if self.action == "list" and self.request.query_params.get("patient"):
            try:
                queryset = queryset.filter(patient_id=uuid.UUID(self.request.query_params["patient"]))
            except ValueError:
                raise serializers.ValidationError({"patient": "Invalid patient ID."}) from None
        return queryset

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        self.event("visit_draft.list")
        return response

    def create(self, request):
        """Save the signed-in doctor's draft for a patient, replacing their earlier one."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            draft, created = EncounterDraft.objects.get_or_create(
                patient=serializer.validated_data["patient"],
                author=request.user,
                defaults={"data": serializer.validated_data.get("data", {})},
            )
            if not created:
                draft.data = serializer.validated_data.get("data", {})
                draft.save()
            self.event("visit_draft.save", draft)
        return Response(self.get_serializer(draft).data, status=201 if created else 200)

    @transaction.atomic
    def perform_update(self, serializer):
        if serializer.instance.author_id != self.request.user.pk:
            raise PermissionDenied("Another doctor is writing this draft.")
        if "patient" in serializer.validated_data and serializer.validated_data["patient"].pk != serializer.instance.patient_id:
            raise serializers.ValidationError({"patient": "A draft stays with its patient."})
        draft = serializer.save()
        self.event("visit_draft.save", draft)

    def perform_destroy(self, instance):
        if instance.author_id != self.request.user.pk and self.member.role_id != "owner":
            raise PermissionDenied("Another doctor is writing this draft.")
        with transaction.atomic():
            self.event("visit_draft.discard", instance)
            instance.delete()


class PrescriptionSetViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, mixins.DestroyModelMixin, DoctorsOnlyViewSet):
    """Saved starting points for a prescription. They hold no patient data."""

    serializer_class = PrescriptionSetSerializer
    pagination_class = None

    def get_queryset(self):
        return PrescriptionSet.objects.filter(clinic=self.member.clinic)

    @transaction.atomic
    def perform_create(self, serializer):
        saved = serializer.save(clinic=self.member.clinic, created_by=self.request.user)
        self.event("prescription_set.create", saved)

    def perform_destroy(self, instance):
        with transaction.atomic():
            self.event("prescription_set.delete", instance)
            instance.delete()


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
