"""Billing API: the price list, bills and what is added to them, and the day's figures."""

import csv
import datetime
import math
import uuid
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import DecimalField, F, OuterRef, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import mixins, serializers
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from accounts.access import BILLING_CORRECT, BILLING_READ, BILLING_WRITE, DAY_END, PRICE_LIST_READ, PRICE_LIST_WRITE
from accounts.features import feature_on, require_feature
from records.models import Encounter
from records.views import ClinicViewSet

from . import money
from .models import CreditNote, DayClose, Invoice, InvoiceEvent, InvoiceLine, Payment, PriceItem, ensure_standard_items, next_number
from .serializers import (
    InvoiceListSerializer,
    InvoiceSerializer,
    PaymentSerializer,
    PriceItemSerializer,
    build_snapshot,
    patient_name,
    person_name,
)

READ_METHODS = {"GET", "HEAD", "OPTIONS"}
MONEY_FIELD = DecimalField(max_digits=12, decimal_places=2)
ZERO = Decimal("0.00")


def amount_from(data, field="amount"):
    try:
        value = Decimal(str(data.get(field, ""))).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise serializers.ValidationError({field: "Enter an amount."}) from None
    if value <= 0 or value > Decimal("99999999"):
        raise serializers.ValidationError({field: "Enter an amount above zero."})
    return value


def text_from(data, field, limit, required=False):
    value = data.get(field, "")
    value = value.strip() if isinstance(value, str) else ""
    if required and not value:
        raise serializers.ValidationError({field: "This is required."})
    if len(value) > limit:
        raise serializers.ValidationError({field: f"Keep this under {limit} characters."})
    return value


def date_from(text):
    try:
        return datetime.date.fromisoformat(text) if text else None
    except (TypeError, ValueError):
        raise serializers.ValidationError({"date": "Use a date like 2026-10-06."}) from None


def day_bounds(clinic, first, last):
    """The moments a range of clinic days starts and ends."""
    zone = clinic.tzinfo
    start = datetime.datetime.combine(first, datetime.time.min, tzinfo=zone) if first else None
    end = datetime.datetime.combine(last + datetime.timedelta(days=1), datetime.time.min, tzinfo=zone) if last else None
    return start, end


def total_of(model, **filters):
    rows = model.objects.filter(invoice=OuterRef("pk"), **filters).values("invoice").annotate(sum=Sum("amount")).values("sum")
    return Coalesce(Subquery(rows, output_field=MONEY_FIELD), Value(ZERO), output_field=MONEY_FIELD)


def with_figures(queryset):
    """Adds what has been paid, credited and is still owed, so lists can filter and sort by them."""
    return queryset.annotate(
        paid_in=total_of(Payment, kind=Payment.Kind.PAYMENT),
        paid_back=total_of(Payment, kind=Payment.Kind.REFUND),
        credited_total=total_of(CreditNote),
    ).annotate(owed=F("total") - F("credited_total") - F("paid_in") + F("paid_back"))


STATE_FILTERS = {
    "draft": Q(status="draft"),
    "void": Q(status="void"),
    "refunded": Q(status="issued", total__gt=0, credited_total__gte=F("total")),
    "issued": Q(status="issued", owed__gt=0, paid_in__lte=F("paid_back")) & ~Q(total__gt=0, credited_total__gte=F("total")),
    "partially_paid": Q(status="issued", owed__gt=0, paid_in__gt=F("paid_back")) & ~Q(total__gt=0, credited_total__gte=F("total")),
    "paid": Q(status="issued", owed__lte=0) & ~Q(total__gt=0, credited_total__gte=F("total")),
    "outstanding": Q(status="issued", owed__gt=0),
}


class BillingViewSet(ClinicViewSet):
    """Every billing endpoint needs the Billing switch on and a role that works with bills."""

    read_roles = BILLING_READ
    write_roles = BILLING_WRITE

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        require_feature(self.member, "billing")
        allowed = self.read_roles if request.method in READ_METHODS else self.write_roles
        if self.member.role_id not in allowed:
            raise PermissionDenied("Your clinic role does not allow this action.")

    def need(self, roles):
        if self.member.role_id not in roles:
            raise PermissionDenied("Your clinic role does not allow this action.")


class PriceItemViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, mixins.UpdateModelMixin, BillingViewSet):
    serializer_class = PriceItemSerializer
    http_method_names = ["get", "post", "patch", "head", "options"]
    pagination_class = None
    read_roles = PRICE_LIST_READ
    write_roles = PRICE_LIST_WRITE

    def get_queryset(self):
        queryset = PriceItem.objects.filter(clinic=self.member.clinic)
        if self.action == "list":
            if self.request.query_params.get("active") == "true":
                queryset = queryset.filter(active=True)
            if self.request.query_params.get("group") == "products":
                queryset = queryset.exclude(kind__in=money.CARE_KINDS)
        return queryset

    def list(self, request, *args, **kwargs):
        with transaction.atomic():
            ensure_standard_items(self.member.clinic)
        return super().list(request, *args, **kwargs)

    @transaction.atomic
    def perform_create(self, serializer):
        item = serializer.save(clinic=self.member.clinic)
        self.event("price_item.create", item)

    @transaction.atomic
    def perform_update(self, serializer):
        item = serializer.save()
        self.event("price_item.update", item)


class InvoiceViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    BillingViewSet,
):
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_serializer_class(self):
        return InvoiceListSerializer if self.action in {"list", "find"} else InvoiceSerializer

    def get_queryset(self):
        return (
            Invoice.objects.filter(clinic=self.member.clinic)
            .select_related("clinic", "patient", "encounter", "created_by", "issued_by")
            .prefetch_related("lines", "payments__received_by", "credit_notes__created_by", "events__actor")
        )

    # --- lists

    def filtered(self, options):
        queryset = with_figures(self.get_queryset())
        state = options.get("state") or ""
        if state:
            if state not in STATE_FILTERS:
                raise serializers.ValidationError({"state": "Unknown status."})
            queryset = queryset.filter(STATE_FILTERS[state])
        patient = options.get("patient")
        if patient:
            try:
                queryset = queryset.filter(patient_id=uuid.UUID(str(patient)))
            except ValueError:
                raise serializers.ValidationError({"patient": "Invalid patient ID."}) from None
        start, end = day_bounds(self.member.clinic, date_from(options.get("from")), date_from(options.get("to")))
        when = Coalesce("issued_at", "created_at")
        if start or end:
            queryset = queryset.annotate(dated=when)
            if start:
                queryset = queryset.filter(dated__gte=start)
            if end:
                queryset = queryset.filter(dated__lt=end)
        search = options.get("search")
        search = search.strip()[:100] if isinstance(search, str) else ""
        if search:
            query = Q(number__icontains=search) | Q(buyer_name__icontains=search)
            for word in search.split():
                query |= Q(patient__first_name__icontains=word) | Q(patient__last_name__icontains=word)
            queryset = queryset.filter(query)
        return queryset.order_by(F("issued_at").desc(nulls_first=True), "-created_at", "id")

    def page_of(self, queryset):
        page = self.paginate_queryset(queryset)
        return self.get_paginated_response(self.get_serializer(page, many=True).data)

    def list(self, request, *args, **kwargs):
        response = self.page_of(self.filtered(request.query_params))
        self.event("invoice.list")
        return response

    @action(detail=False, methods=["post"])
    def find(self, request):
        """The same list, searched by number or name. A POST so that a patient's name never appears in a URL."""
        self.need(BILLING_READ)
        response = self.page_of(self.filtered(request.data if isinstance(request.data, dict) else {}))
        self.event("invoice.list")
        return response

    def retrieve(self, request, *args, **kwargs):
        invoice = self.get_object()
        self.event("invoice.view", invoice)
        return Response(self.get_serializer(invoice).data)

    # --- drafts

    @transaction.atomic
    def perform_create(self, serializer):
        invoice = serializer.save(clinic=self.member.clinic, created_by=self.request.user)
        self.event("invoice.create", invoice)

    @transaction.atomic
    def perform_update(self, serializer):
        invoice = serializer.save()
        self.event("invoice.update", invoice)

    def destroy(self, request, *args, **kwargs):
        invoice = self.get_object()
        if invoice.status != Invoice.Status.DRAFT:
            raise serializers.ValidationError("An issued bill is never deleted. Void it or add a credit note.")
        with transaction.atomic():
            # The audit row keeps the ID of the draft that was thrown away, nothing more.
            self.event("invoice.delete_draft", invoice)
            invoice.delete()
        return Response(status=204)

    @action(detail=False, methods=["post"], url_path="from-visit")
    def from_visit(self, request):
        """Start a bill from a visit: the consultation, one line for everything the doctor mixed, and nothing clinical."""
        try:
            encounter = (
                Encounter.objects.filter(patient__clinic=self.member.clinic)
                .select_related("patient", "clinician")
                .prefetch_related("prescriptions")
                .get(pk=uuid.UUID(str(request.data.get("encounter"))))
            )
        except (Encounter.DoesNotExist, ValueError):
            raise serializers.ValidationError({"encounter": "Invalid visit."}) from None
        existing = self.get_queryset().filter(encounter=encounter).exclude(status=Invoice.Status.VOID).first()
        if existing:
            self.event("invoice.view", existing)
            return Response(InvoiceSerializer(existing, context=self.get_serializer_context()).data)
        clinic = self.member.clinic
        ensure_standard_items(clinic)
        items = {item.role: item for item in PriceItem.objects.filter(clinic=clinic, active=True).exclude(role="")}
        lines = []
        consultation = {"first": PriceItem.Role.FIRST_VISIT, "follow_up": PriceItem.Role.FOLLOW_UP}.get(encounter.visit_type)
        if consultation and consultation in items:
            item = items[consultation]
            lines.append({"price_item": item, "kind": item.kind, "description": item.name, "rate": item.rate, "gst_rate": item.gst_rate})
        envelopes = list(encounter.prescriptions.all())
        if envelopes:
            item = items.get(PriceItem.Role.PRESCRIBED_WEEK)
            days = max((envelope_days(envelope.dosage) for envelope in envelopes), default=0)
            weeks = max(1, math.ceil(days / 7)) if days else 1
            lines.append(
                {
                    "price_item": item,
                    "kind": PriceItem.Kind.PRESCRIBED,
                    # One line for everything the doctor mixed; medicine names never reach a bill.
                    "description": f"Prescribed medicines, {days} days" if days else "Prescribed medicines",
                    "rate": (item.rate * weeks) if item else ZERO,
                    "gst_rate": item.gst_rate if item else ZERO,
                }
            )
        with transaction.atomic():
            invoice = Invoice.objects.create(clinic=clinic, patient=encounter.patient, encounter=encounter, created_by=request.user)
            for position, line in enumerate(lines):
                InvoiceLine.objects.create(invoice=invoice, position=position, source="visit", **line)
            invoice.refresh_totals()
            invoice.save()
            self.event("invoice.create", invoice)
        return Response(InvoiceSerializer(self.get_queryset().get(pk=invoice.pk), context=self.get_serializer_context()).data, status=201)

    # --- issuing and what follows

    def locked(self, pk):
        """The bill, held for this transaction so two people cannot issue or pay it at the same moment."""
        try:
            return (
                Invoice.objects.select_for_update(of=("self",))
                .select_related("clinic", "patient", "encounter")
                .get(pk=uuid.UUID(str(pk)), clinic=self.member.clinic)
            )
        except (Invoice.DoesNotExist, ValueError):
            raise serializers.ValidationError("That bill was not found.") from None

    def fresh(self, invoice, status=200):
        return Response(
            InvoiceSerializer(self.get_queryset().get(pk=invoice.pk), context=self.get_serializer_context()).data, status=status
        )

    def take_payment(self, invoice, data, kind=Payment.Kind.PAYMENT):
        amount = amount_from(data)
        method = data.get("method")
        if method not in Payment.Method.values:
            raise serializers.ValidationError({"method": "Choose cash, UPI, card or bank transfer."})
        if kind == Payment.Kind.PAYMENT and amount > invoice.balance:
            raise serializers.ValidationError({"amount": "The payment is more than the balance due."})
        if kind == Payment.Kind.REFUND and amount > invoice.paid:
            raise serializers.ValidationError({"amount": "The refund is more than was paid."})
        payment = Payment.objects.create(
            invoice=invoice,
            kind=kind,
            amount=amount,
            method=method,
            reference=text_from(data, "reference", 100),
            note=text_from(data, "reason", 300, required=kind == Payment.Kind.REFUND),
            received_by=self.request.user,
            receipt_number=next_number(invoice.clinic, "receipt"),
        )
        InvoiceEvent.objects.create(invoice=invoice, action=kind, actor=self.request.user, detail=payment.receipt_number)
        self.event(f"invoice.{kind}", invoice)
        return payment

    @action(detail=True, methods=["post"])
    def issue(self, request, pk=None):
        with transaction.atomic():
            invoice = self.locked(pk)
            if invoice.status != Invoice.Status.DRAFT:
                raise serializers.ValidationError("This bill has already been issued.")
            if not invoice.lines.exists():
                raise serializers.ValidationError("Add at least one line before issuing the bill.")
            if invoice.patient_id and invoice.patient.archived_at:
                raise serializers.ValidationError("This patient is archived. Restore the record before billing.")
            invoice.refresh_totals()
            invoice.number = next_number(invoice.clinic, "invoice")
            invoice.status = Invoice.Status.ISSUED
            invoice.issued_at, invoice.issued_by = timezone.now(), request.user
            invoice.snapshot = build_snapshot(invoice, request.user)
            invoice.save()
            InvoiceEvent.objects.create(invoice=invoice, action="issued", actor=request.user, detail=invoice.number)
            self.event("invoice.issue", invoice)
            payment = request.data.get("payment")
            if isinstance(payment, dict) and invoice.total > 0:
                self.take_payment(invoice, {**payment, "amount": payment.get("amount", invoice.total)})
        return self.fresh(invoice)

    @action(detail=True, methods=["post"])
    def payments(self, request, pk=None):
        with transaction.atomic():
            invoice = self.locked(pk)
            if invoice.status != Invoice.Status.ISSUED:
                raise serializers.ValidationError("Payments are recorded on issued bills only.")
            self.take_payment(invoice, request.data)
        return self.fresh(invoice, 201)

    @action(detail=True, methods=["post"])
    def refund(self, request, pk=None):
        self.need(BILLING_CORRECT)
        with transaction.atomic():
            invoice = self.locked(pk)
            if invoice.status != Invoice.Status.ISSUED:
                raise serializers.ValidationError("Refunds are recorded on issued bills only.")
            self.take_payment(invoice, request.data, Payment.Kind.REFUND)
        return self.fresh(invoice, 201)

    @action(detail=True, methods=["post"], url_path="credit-note")
    def credit_note(self, request, pk=None):
        """Take an amount off an issued bill. The bill itself stays as it was printed."""
        self.need(BILLING_CORRECT)
        reason = text_from(request.data, "reason", 300, required=True)
        amount = amount_from(request.data)
        with transaction.atomic():
            invoice = self.locked(pk)
            if invoice.status != Invoice.Status.ISSUED:
                raise serializers.ValidationError("A credit note corrects an issued bill only.")
            if amount > invoice.total - invoice.credited:
                raise serializers.ValidationError({"amount": "The credit is more than what is left of the bill."})
            note = CreditNote.objects.create(
                invoice=invoice, number=next_number(invoice.clinic, "credit"), amount=amount, reason=reason, created_by=request.user
            )
            InvoiceEvent.objects.create(invoice=invoice, action="credit_note", actor=request.user, detail=f"{note.number} · {reason}")
            self.event("invoice.credit_note", invoice)
            # Money already taken beyond the new total goes back to the customer in the same step.
            overpaid = invoice.paid - (invoice.total - invoice.credited)
            if overpaid > 0 and request.data.get("refund_method"):
                self.take_payment(
                    invoice,
                    {"amount": overpaid, "method": request.data["refund_method"], "reason": f"Credit note {note.number}"},
                    Payment.Kind.REFUND,
                )
        return self.fresh(invoice, 201)

    @action(detail=True, methods=["post"])
    def void(self, request, pk=None):
        """Cancel an issued bill. It stays in the list marked Void and its number is not reused."""
        self.need(BILLING_CORRECT)
        reason = text_from(request.data, "reason", 300, required=True)
        with transaction.atomic():
            invoice = self.locked(pk)
            if invoice.status != Invoice.Status.ISSUED:
                raise serializers.ValidationError("Only an issued bill can be made void.")
            if invoice.paid != 0:
                raise serializers.ValidationError("Refund the payments on this bill before making it void.")
            invoice.status = Invoice.Status.VOID
            invoice.voided_at, invoice.voided_by, invoice.void_reason = timezone.now(), request.user, reason
            invoice.save(update_fields=["status", "voided_at", "voided_by", "void_reason", "updated_at"])
            InvoiceEvent.objects.create(invoice=invoice, action="void", actor=request.user, detail=reason)
            self.event("invoice.void", invoice)
        return self.fresh(invoice)

    @action(detail=True, methods=["post"])
    def printed(self, request, pk=None):
        """Note in the bill's history that it was sent to a printer or saved as a PDF."""
        invoice = self.get_object()
        if invoice.status == Invoice.Status.DRAFT:
            raise serializers.ValidationError("A draft is not printed as a bill. Issue it first.")
        with transaction.atomic():
            InvoiceEvent.objects.create(invoice=invoice, action="printed", actor=request.user)
            self.event("invoice.print", invoice)
        return Response({"detail": "Noted."})


def envelope_days(dosage):
    """How many days an envelope covers, from the parts its dosage line was built from."""
    if not isinstance(dosage, dict):
        return 0
    try:
        length = int(str(dosage.get("length", "")).strip())
    except ValueError:
        return 0
    return length * {"days": 1, "weeks": 7}.get(dosage.get("period"), 0) if 0 < length < 400 else 0


class PaymentViewSet(mixins.ListModelMixin, BillingViewSet):
    """Every payment and refund the clinic recorded, newest first."""

    serializer_class = PaymentSerializer

    def get_queryset(self):
        queryset = Payment.objects.filter(invoice__clinic=self.member.clinic).select_related("invoice__patient", "received_by")
        start, end = day_bounds(
            self.member.clinic, date_from(self.request.query_params.get("from")), date_from(self.request.query_params.get("to"))
        )
        if start:
            queryset = queryset.filter(received_at__gte=start)
        if end:
            queryset = queryset.filter(received_at__lt=end)
        return queryset.order_by("-received_at", "-created_at", "id")

    def list(self, request, *args, **kwargs):
        page = self.paginate_queryset(self.get_queryset())
        rows = [
            {
                **PaymentSerializer(payment).data,
                "invoice": str(payment.invoice_id),
                "invoice_number": payment.invoice.number,
                "patient": patient_name(payment.invoice.patient) if payment.invoice.patient else payment.invoice.buyer_name,
            }
            for payment in page
        ]
        self.event("payment.list")
        return self.get_paginated_response(rows)


def collected(clinic, start, end):
    """Money in less money out between two moments, by method."""
    methods = {method: ZERO for method in Payment.Method.values}
    for payment in Payment.objects.filter(invoice__clinic=clinic, received_at__gte=start, received_at__lt=end):
        methods[payment.method] += payment.amount if payment.kind == Payment.Kind.PAYMENT else -payment.amount
    return methods


class BillingReportViewSet(BillingViewSet):
    """Figures across bills: today's totals, who owes what, the day-end report and exports."""

    def issued_between(self, start, end):
        return Invoice.objects.filter(clinic=self.member.clinic, issued_at__gte=start, issued_at__lt=end).exclude(
            status=Invoice.Status.VOID
        )

    @action(detail=False, methods=["get"])
    def summary(self, request):
        clinic = self.member.clinic
        start, end = day_bounds(clinic, clinic.today(), clinic.today())
        issued = self.issued_between(start, end)
        owing = with_figures(Invoice.objects.filter(clinic=clinic)).filter(STATE_FILTERS["outstanding"])
        self.event("billing.summary")
        return Response(
            {
                "day": clinic.today().isoformat(),
                "billed_today": str(sum((invoice.total for invoice in issued), ZERO)),
                "invoices_today": issued.count(),
                "collected_today": str(sum(collected(clinic, start, end).values(), ZERO)),
                "outstanding": str(sum((invoice.owed for invoice in owing), ZERO)),
                "outstanding_count": owing.count(),
                "drafts": Invoice.objects.filter(clinic=clinic, status=Invoice.Status.DRAFT).count(),
            }
        )

    @action(detail=False, methods=["get", "post"], url_path="day-end")
    def day_end(self, request):
        clinic = self.member.clinic
        if request.method == "POST":
            self.need(DAY_END)
            day = date_from(request.data.get("day")) or clinic.today()
            if day > clinic.today():
                raise serializers.ValidationError({"day": "A day that has not happened yet cannot be closed."})
            start, end = day_bounds(clinic, day, day)
            try:
                counted = Decimal(str(request.data.get("cash_counted", ""))).quantize(Decimal("0.01"))
            except (InvalidOperation, ValueError):
                raise serializers.ValidationError({"cash_counted": "Enter the cash counted in the drawer."}) from None
            if counted < 0:
                raise serializers.ValidationError({"cash_counted": "Enter the cash counted in the drawer."})
            with transaction.atomic():
                close = DayClose.objects.create(
                    clinic=clinic,
                    day=day,
                    expected_cash=collected(clinic, start, end)["cash"],
                    cash_counted=counted,
                    note=text_from(request.data, "note", 300),
                    closed_by=request.user,
                )
                self.event("billing.day_close", close)
        else:
            day = date_from(request.query_params.get("day")) or clinic.today()
            start, end = day_bounds(clinic, day, day)
        methods = collected(clinic, start, end)
        issued = self.issued_between(start, end)
        closed = DayClose.objects.filter(clinic=clinic, day=day).select_related("closed_by").first()
        self.event("billing.day_end")
        return Response(
            {
                "day": day.isoformat(),
                "methods": {method: str(total) for method, total in methods.items()},
                "collected": str(sum(methods.values(), ZERO)),
                "billed": str(sum((invoice.total for invoice in issued), ZERO)),
                "invoices": issued.count(),
                "closed": (
                    {
                        "cash_counted": str(closed.cash_counted),
                        "expected_cash": str(closed.expected_cash),
                        "difference": str(closed.cash_counted - closed.expected_cash),
                        "note": closed.note,
                        "closed_by_name": person_name(closed.closed_by),
                        "closed_at": closed.created_at.isoformat(),
                    }
                    if closed
                    else None
                ),
            }
        )

    @action(detail=False, methods=["get"])
    def export(self, request):
        """A spreadsheet of bills, payments, or tax by rate for the accountant, for a range of days."""
        self.need(DAY_END)
        clinic = self.member.clinic
        kind = request.query_params.get("kind", "invoices")
        if kind not in {"invoices", "payments", "accountant"}:
            raise serializers.ValidationError({"kind": "Choose invoices, payments or accountant."})
        first = date_from(request.query_params.get("from")) or clinic.today().replace(day=1)
        last = date_from(request.query_params.get("to")) or clinic.today()
        start, end = day_bounds(clinic, first, last)
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        # The file name says what and when, never who.
        response["Content-Disposition"] = f'attachment; filename="jivni-{kind}-{first.isoformat()}-to-{last.isoformat()}.csv"'
        response.write("﻿")
        writer = csv.writer(response)
        show_gst = bool(clinic.tax_identifier) and feature_on(clinic, "show_gst")
        if kind == "payments":
            writer.writerow(["Date", "Receipt", "Invoice", "Customer", "Kind", "Method", "Amount", "Reference"])
            payments = (
                Payment.objects.filter(invoice__clinic=clinic, received_at__gte=start, received_at__lt=end)
                .select_related("invoice__patient")
                .order_by("received_at")
            )
            for payment in payments:
                invoice = payment.invoice
                writer.writerow(
                    [
                        clinic.local_date(payment.received_at).isoformat(),
                        payment.receipt_number,
                        invoice.number,
                        safe_cell(patient_name(invoice.patient) if invoice.patient else invoice.buyer_name),
                        payment.kind,
                        payment.get_method_display(),
                        payment.amount if payment.kind == Payment.Kind.PAYMENT else -payment.amount,
                        safe_cell(payment.reference),
                    ]
                )
        else:
            invoices = (
                with_figures(Invoice.objects.filter(clinic=clinic, issued_at__gte=start, issued_at__lt=end))
                .select_related("patient")
                .prefetch_related("lines", "payments", "credit_notes")
                .order_by("issued_at")
            )
            if kind == "invoices":
                writer.writerow(
                    ["Date", "Number", "Customer", "Status", "Subtotal", "Discount", "Total", "GST included", "Paid", "Balance"]
                )
                for invoice in invoices:
                    writer.writerow(
                        [
                            clinic.local_date(invoice.issued_at).isoformat(),
                            invoice.number,
                            safe_cell(patient_name(invoice.patient) if invoice.patient else invoice.buyer_name),
                            invoice.state.replace("_", " "),
                            invoice.subtotal,
                            invoice.discount,
                            invoice.total,
                            invoice.tax_total if show_gst else "",
                            invoice.paid,
                            invoice.balance,
                        ]
                    )
            else:
                writer.writerow(["Date", "Number", "Status", "GST rate %", "Taxable value", "CGST", "SGST", "Exempt value", "Total"])
                for invoice in invoices:
                    figures = invoice.figures()
                    taxed = sum((row["taxable"] + row["tax"] for row in figures["tax_summary"]), ZERO)
                    rows = figures["tax_summary"] or [None]
                    for index, row in enumerate(rows):
                        writer.writerow(
                            [
                                clinic.local_date(invoice.issued_at).isoformat(),
                                invoice.number,
                                invoice.state.replace("_", " "),
                                format(row["rate"].normalize(), "f") if row else "",
                                row["taxable"] if row else "",
                                row["cgst"] if row else "",
                                row["sgst"] if row else "",
                                figures["total"] - taxed if index == 0 else "",
                                figures["total"] if index == 0 else "",
                            ]
                        )
        self.event("billing.export")
        return response


def safe_cell(text):
    """A spreadsheet treats a cell starting with = + - or @ as a formula; a leading apostrophe makes it plain text."""
    text = str(text or "")
    return f"'{text}" if text[:1] in "=+-@\t\r" else text
