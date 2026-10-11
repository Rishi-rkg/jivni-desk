"""Appointments, the work week, and the dashboard that gathers the day."""

import datetime
import uuid
from decimal import Decimal

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from accounts.access import APPOINTMENTS, BILLING_READ, CLINIC_ADMIN, CLINICAL_WRITE, DEMOGRAPHIC_WRITE
from accounts.features import feature_on, require_feature
from accounts.models import Membership
from records import patient_extras
from records.models import Encounter, EncounterDraft, Patient, PatientIdentifier
from records.views import ClinicViewSet

from .models import DURATIONS, Appointment, WorkDay, WorkTemplate, clean_sessions, sessions_on, slot_times


def person(user):
    return (user.get_full_name() or user.username) if user else ""


def full_name(patient):
    return " ".join(part for part in [patient.first_name, patient.middle_name, patient.last_name] if part)


def day_from(text, field="day"):
    try:
        return datetime.date.fromisoformat(str(text))
    except ValueError:
        raise serializers.ValidationError({field: "Use a date like 2026-10-06."}) from None


def month_from(text):
    try:
        year, month = str(text).split("-")
        first = datetime.date(int(year), int(month), 1)
    except ValueError:
        raise serializers.ValidationError({"month": "Use a month like 2026-10."}) from None
    return first, (first + datetime.timedelta(days=32)).replace(day=1)


def patient_codes(patient_ids):
    return dict(PatientIdentifier.objects.filter(patient_id__in=patient_ids, revoked_at__isnull=True).values_list("patient_id", "code"))


def billed_patients(clinic, day, patient_ids):
    """Patients with a bill issued that day, so a seen appointment can say "Seen, billed"."""
    from billing.models import Invoice

    start = datetime.datetime.combine(day, datetime.time.min, tzinfo=clinic.tzinfo)
    bills = Invoice.objects.filter(
        clinic=clinic, patient_id__in=patient_ids, issued_at__gte=start, issued_at__lt=start + datetime.timedelta(days=1)
    )
    return set(bills.exclude(status=Invoice.Status.VOID).values_list("patient_id", flat=True))


def appointment_rows(clinic, appointments):
    appointments = list(appointments)
    codes = patient_codes([appointment.patient_id for appointment in appointments])
    now = timezone.now()
    billed = {}
    for day in {appointment.day for appointment in appointments if appointment.status == Appointment.Status.SEEN}:
        ids = [appointment.patient_id for appointment in appointments if appointment.day == day]
        billed[day] = billed_patients(clinic, day, ids) if feature_on(clinic, "billing") else set()
    rows = []
    for appointment in appointments:
        waiting = appointment.status == Appointment.Status.ARRIVED and appointment.arrived_at
        rows.append(
            {
                "id": str(appointment.pk),
                "day": appointment.day.isoformat(),
                "time": appointment.time.strftime("%H:%M") if appointment.time else None,
                "duration_minutes": appointment.duration_minutes,
                "visit_type": appointment.visit_type,
                "reason": appointment.reason,
                "status": appointment.status,
                "walk_in": appointment.walk_in,
                "arrived_at": appointment.arrived_at.isoformat() if appointment.arrived_at else None,
                "waiting_minutes": max(int((now - appointment.arrived_at).total_seconds() // 60), 0) if waiting else None,
                "billed": appointment.patient_id in billed.get(appointment.day, set()),
                "remind": appointment.remind,
                "reminder_at": appointment.reminder_at.isoformat() if appointment.reminder_at else None,
                "cancel_reason": appointment.cancel_reason,
                "patient": {
                    "id": str(appointment.patient_id),
                    "name": full_name(appointment.patient),
                    "code": codes.get(appointment.patient_id, ""),
                    "phone": appointment.patient.phone or appointment.patient.whatsapp_number,
                },
                "doctor": {"id": str(appointment.doctor_id), "name": person(appointment.doctor)} if appointment.doctor_id else None,
            }
        )
    return rows


class SchedulingViewSet(ClinicViewSet):
    roles = APPOINTMENTS

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        require_feature(self.member, "appointments")
        if self.member.role_id not in self.roles:
            raise PermissionDenied("Your clinic role does not allow this action.")

    def need(self, roles):
        if self.member.role_id not in roles:
            raise PermissionDenied("Your clinic role does not allow this action.")


class WorkWeekViewSet(SchedulingViewSet):
    """When the clinic sees patients. Everyone who books reads it; owner and administrator set it."""

    roles = APPOINTMENTS | {"admin"}

    def month(self, first, last):
        clinic = self.member.clinic
        known = dict(WorkDay.objects.filter(clinic=clinic, day__gte=first, day__lt=last).values_list("day", "sessions"))
        days, day = {}, first
        while day < last:
            sessions = sessions_on(clinic, day, known)
            if sessions:
                days[day.isoformat()] = sessions
            day += datetime.timedelta(days=1)
        return {"month": first.strftime("%Y-%m"), "saved": bool(known), "days": days}

    def list(self, request):
        first, last = month_from(request.query_params.get("month") or self.member.clinic.today().strftime("%Y-%m"))
        return Response(self.month(first, last))

    def create(self, request):
        """Replace a month: the dates listed are working days, every other date of the month is closed."""
        self.need(CLINIC_ADMIN)
        first, last = month_from(request.data.get("month"))
        days = request.data.get("days")
        if not isinstance(days, dict):
            raise serializers.ValidationError({"days": "Send the working dates with their sessions."})
        cleaned = {}
        for text, sessions in days.items():
            day = day_from(text, "days")
            if not first <= day < last:
                raise serializers.ValidationError({"days": f"{text} is not in that month."})
            try:
                sessions = clean_sessions(sessions)
            except ModelValidationError as error:
                raise serializers.ValidationError({"days": f"{text}: {' '.join(error.messages)}"}) from None
            if sessions:
                cleaned[day] = sessions
        clinic = self.member.clinic
        with transaction.atomic():
            WorkDay.objects.filter(clinic=clinic, day__gte=first, day__lt=last).delete()
            # Every date of the month gets a row, closed ones with no sessions, so a saved month never
            # falls back to the usual week, not even when every date is closed.
            day = first
            while day < last:
                WorkDay.objects.create(clinic=clinic, day=day, sessions=cleaned.get(day, []))
                day += datetime.timedelta(days=1)
            self.event("work_week.save")
        return Response(self.month(first, last))

    @action(detail=False, methods=["get"], url_path="templates")
    def templates(self, request):
        saved = {template.slot: template for template in WorkTemplate.objects.filter(clinic=self.member.clinic)}
        return Response(
            [
                {"slot": slot, "name": saved[slot].name, "hours": saved[slot].hours}
                if slot in saved
                else {"slot": slot, "name": "", "hours": None}
                for slot in range(1, WorkTemplate.MAX + 1)
            ]
        )

    @action(detail=False, methods=["put", "delete"], url_path=r"templates/(?P<slot>[0-9]+)")
    def template(self, request, slot=None):
        self.need(CLINIC_ADMIN)
        clinic, slot = self.member.clinic, int(slot)
        if not 1 <= slot <= WorkTemplate.MAX:
            raise serializers.ValidationError({"slot": f"A clinic keeps at most {WorkTemplate.MAX} saved work weeks."})
        with transaction.atomic():
            WorkTemplate.objects.filter(clinic=clinic, slot=slot).delete()
            if request.method == "PUT":
                name = " ".join(str(request.data.get("name", "")).split())[:60]
                if not name:
                    raise serializers.ValidationError({"name": "Give the work week a name."})
                try:
                    WorkTemplate.objects.create(clinic=clinic, slot=slot, name=name, hours=request.data.get("hours"))
                except ModelValidationError as error:
                    raise serializers.ValidationError(error.message_dict if hasattr(error, "message_dict") else error.messages) from None
            self.event("work_week.template")
        return self.templates(request)


class AppointmentViewSet(SchedulingViewSet):
    def queryset(self):
        return Appointment.objects.filter(clinic=self.member.clinic).select_related("patient", "doctor")

    def find(self, pk):
        try:
            return self.queryset().get(pk=uuid.UUID(str(pk)))
        except (Appointment.DoesNotExist, ValueError):
            raise serializers.ValidationError("That appointment was not found.") from None

    def doctor(self, value):
        """A doctor of this clinic, by user ID. None when no doctor was chosen."""
        if not value:
            return None
        try:
            member = Membership.objects.select_related("user").get(
                clinic=self.member.clinic, user_id=uuid.UUID(str(value)), is_active=True, role_id__in=CLINICAL_WRITE
            )
        except (Membership.DoesNotExist, ValueError):
            raise serializers.ValidationError({"doctor": "Choose a doctor of this clinic."}) from None
        return member.user

    def patient(self, value):
        try:
            return Patient.objects.get(pk=uuid.UUID(str(value)), clinic=self.member.clinic, archived_at__isnull=True)
        except (Patient.DoesNotExist, ValueError):
            raise serializers.ValidationError({"patient": "Choose a patient of this clinic."}) from None

    def one(self, appointment, status=200):
        return Response(appointment_rows(self.member.clinic, [self.queryset().get(pk=appointment.pk)])[0], status=status)

    # --- reading

    def list(self, request):
        clinic, params = self.member.clinic, request.query_params
        first = day_from(params.get("from") or params.get("day") or clinic.today().isoformat())
        last = day_from(params.get("to") or first.isoformat(), "to")
        if last < first or (last - first).days > 62:
            raise serializers.ValidationError({"to": "Ask for at most two months at a time."})
        appointments = self.queryset().filter(day__gte=first, day__lte=last)
        if params.get("doctor"):
            appointments = appointments.filter(doctor=self.doctor(params["doctor"]))
        self.event("appointment.list")
        return Response({"from": first.isoformat(), "to": last.isoformat(), "results": appointment_rows(clinic, appointments)})

    @action(detail=False, methods=["get"])
    def doctors(self, request):
        """The clinic's doctors, for the doctor filter and the booking window."""
        members = Membership.objects.filter(clinic=self.member.clinic, is_active=True, role_id__in=CLINICAL_WRITE).select_related("user")
        return Response([{"id": str(member.user_id), "name": person(member.user)} for member in members])

    @action(detail=False, methods=["get"])
    def slots(self, request):
        """The times of a day that can be booked, and which are already taken."""
        clinic = self.member.clinic
        day = day_from(request.query_params.get("day"))
        doctor = self.doctor(request.query_params.get("doctor"))
        sessions = sessions_on(clinic, day)
        taken = self.taken(day, doctor)
        now = timezone.now().astimezone(clinic.tzinfo)
        slots = []
        for time in slot_times(sessions):
            start = time.hour * 60 + time.minute
            past = day < now.date() or (day == now.date() and time <= now.time())
            slots.append({"time": time.strftime("%H:%M"), "free": not past and not any(a <= start < b for a, b in taken)})
        return Response({"day": day.isoformat(), "sessions": sessions, "slots": slots})

    def taken(self, day, doctor, ignore=None):
        """(start, end) minutes already booked that day, for one doctor or, with no doctor, for the clinic."""
        booked = (
            self.queryset()
            .filter(day=day, time__isnull=False)
            .exclude(status__in=[Appointment.Status.CANCELLED, Appointment.Status.NO_SHOW])
        )
        if doctor:
            booked = booked.filter(Q(doctor=doctor) | Q(doctor__isnull=True))
        if ignore:
            booked = booked.exclude(pk=ignore.pk)
        return [appointment.minutes() for appointment in booked]

    @action(detail=False, methods=["post"], url_path="by-phone")
    def by_phone(self, request):
        """Everyone registered on a phone number. A POST so the number never appears in an address."""
        digits = "".join(char for char in str(request.data.get("phone", "")) if char.isdigit())
        if len(digits) < 5:
            return Response({"patients": []})
        tail = digits[-10:]
        found = []
        candidates = Patient.objects.filter(clinic=self.member.clinic, archived_at__isnull=True).filter(
            Q(phone__contains=tail[-5:]) | Q(whatsapp_number__contains=tail[-5:])
        )
        for patient in candidates[:200]:
            numbers = ["".join(char for char in value if char.isdigit()) for value in [patient.phone, patient.whatsapp_number]]
            if any(number and (number.endswith(tail) or tail.endswith(number)) for number in numbers):
                found.append(patient)
        codes = patient_codes([patient.pk for patient in found])
        self.event("appointment.phone_lookup")
        return Response(
            {
                "patients": [
                    {
                        "id": str(patient.pk),
                        "name": full_name(patient),
                        "date_of_birth": patient.date_of_birth.isoformat() if patient.date_of_birth else None,
                        "gender": patient.gender,
                        "code": codes.get(patient.pk, ""),
                    }
                    for patient in found[:8]
                ]
            }
        )

    @action(detail=False, methods=["post"], url_path="quick-patient")
    def quick_patient(self, request):
        """Add a patient from the booking window with only a name and a phone number; the rest is filled in at the desk."""
        self.need(DEMOGRAPHIC_WRITE)
        name = " ".join(str(request.data.get("name", "")).split())
        phone = " ".join(str(request.data.get("phone", "")).split())[:40]
        if not name:
            raise serializers.ValidationError({"name": "Enter the patient's name."})
        first, _, last = name.partition(" ")
        with transaction.atomic():
            patient = Patient.objects.create(
                clinic=self.member.clinic,
                first_name=first[:100],
                last_name=last[:100],
                gender="undisclosed",
                phone=phone,
                whatsapp_number=phone,
            )
            identifier = PatientIdentifier.issue(patient, request.user)
            self.event("patient.create", patient)
        return Response(
            {"id": str(patient.pk), "name": full_name(patient), "date_of_birth": None, "gender": patient.gender, "code": identifier.code},
            status=201,
        )

    @action(detail=False, methods=["get"], url_path="follow-ups")
    def follow_ups(self, request):
        """Patients whose next advised visit is due within a week or overdue, and whether they are booked."""
        clinic = self.member.clinic
        today = clinic.today()
        horizon = today + datetime.timedelta(days=7)
        due = patient_extras.with_visit_dates(Patient.objects.filter(clinic=clinic, archived_at__isnull=True)).filter(
            next_advised__lte=horizon
        )
        patients = list(due.order_by("next_advised")[:60])
        booked = {}
        upcoming = (
            self.queryset()
            .filter(patient__in=patients, day__gte=today)
            .exclude(status__in=[Appointment.Status.CANCELLED, Appointment.Status.NO_SHOW])
        )
        for appointment in upcoming.order_by("-day", "-time"):
            booked[appointment.patient_id] = appointment
        rows = []
        for patient in patients:
            appointment = booked.get(patient.pk)
            # Someone already seen since the advice was given is no longer due: their latest visit decides.
            rows.append(
                {
                    "patient": {"id": str(patient.pk), "name": full_name(patient)},
                    "due": patient.next_advised.isoformat(),
                    "booked": (
                        {"day": appointment.day.isoformat(), "time": appointment.time.strftime("%H:%M") if appointment.time else None}
                        if appointment
                        else None
                    ),
                }
            )
        self.event("appointment.follow_ups")
        return Response({"count": len(rows), "results": rows})

    # --- booking and what follows

    def create(self, request):
        clinic, data = self.member.clinic, request.data
        patient = self.patient(data.get("patient"))
        doctor = self.doctor(data.get("doctor"))
        visit_type = data.get("visit_type") or "follow_up"
        if visit_type not in DURATIONS:
            raise serializers.ValidationError({"visit_type": "Choose first visit, follow-up or medicine only."})
        reason = " ".join(str(data.get("reason", "")).split())[:120]
        fields = {
            "clinic": clinic,
            "patient": patient,
            "doctor": doctor,
            "visit_type": visit_type,
            "reason": reason,
            "created_by": request.user,
        }
        if data.get("walk_in") is True:
            fields |= {"day": clinic.today(), "walk_in": True, "status": Appointment.Status.ARRIVED, "arrived_at": timezone.now()}
        else:
            day = day_from(data.get("day"))
            time = self.free_time(day, data.get("time"), DURATIONS[visit_type], doctor)
            fields |= {"day": day, "time": time, "duration_minutes": DURATIONS[visit_type], "remind": data.get("remind") is True}
        with transaction.atomic():
            appointment = Appointment.objects.create(**fields)
            self.event("appointment.create", appointment)
        return self.one(appointment, 201)

    def free_time(self, day, text, duration, doctor, ignore=None):
        """The time asked for, checked: inside the work week, not in the past, and not on top of another appointment."""
        clinic = self.member.clinic
        try:
            time = datetime.time.fromisoformat(str(text))
        except ValueError:
            raise serializers.ValidationError({"time": "Choose a time."}) from None
        now = timezone.now().astimezone(clinic.tzinfo)
        if day < now.date() or (day == now.date() and time <= now.time()):
            raise serializers.ValidationError({"time": "That time has already passed."})
        start, end = time.hour * 60 + time.minute, time.hour * 60 + time.minute + duration
        inside = False
        for opening, closing in sessions_on(clinic, day):
            opens, closes = (int(part[:2]) * 60 + int(part[3:]) for part in (opening, closing))
            inside = inside or (opens <= start and end <= closes)
        if not inside:
            raise serializers.ValidationError({"time": "The clinic is closed then. Choose a time inside the work week."})
        if any(a < end and start < b for a, b in self.taken(day, doctor, ignore)):
            raise serializers.ValidationError({"time": "That time is already booked."})
        return time

    def change(self, pk, name, work):
        with transaction.atomic():
            appointment = (
                Appointment.objects.select_for_update(of=("self",)).filter(clinic=self.member.clinic).filter(pk=self.find(pk).pk).get()
            )
            work(appointment)
            appointment.save()
            self.event(f"appointment.{name}", appointment)
        return self.one(appointment)

    @action(detail=True, methods=["post"])
    def arrive(self, request, pk=None):
        def work(appointment):
            if appointment.status != Appointment.Status.BOOKED:
                raise serializers.ValidationError("Only a booked appointment can be marked as arrived.")
            appointment.status, appointment.arrived_at = Appointment.Status.ARRIVED, timezone.now()

        return self.change(pk, "arrive", work)

    @action(detail=True, methods=["post"])
    def seen(self, request, pk=None):
        def work(appointment):
            if appointment.status not in {Appointment.Status.BOOKED, Appointment.Status.ARRIVED}:
                raise serializers.ValidationError("This appointment is already closed.")
            appointment.status, appointment.seen_at = Appointment.Status.SEEN, timezone.now()

        return self.change(pk, "seen", work)

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        reason = " ".join(str(request.data.get("reason", "")).split())[:200]

        def work(appointment):
            if appointment.status not in {Appointment.Status.BOOKED, Appointment.Status.ARRIVED}:
                raise serializers.ValidationError("This appointment is already closed.")
            if not reason:
                raise serializers.ValidationError({"reason": "Say in a few words why it is cancelled."})
            appointment.status, appointment.cancelled_at, appointment.cancel_reason = Appointment.Status.CANCELLED, timezone.now(), reason

        return self.change(pk, "cancel", work)

    @action(detail=True, methods=["post"], url_path="no-show")
    def no_show(self, request, pk=None):
        def work(appointment):
            if appointment.status != Appointment.Status.BOOKED:
                raise serializers.ValidationError("Only a booked appointment can be marked as a no-show.")
            appointment.status = Appointment.Status.NO_SHOW

        return self.change(pk, "no_show", work)

    @action(detail=True, methods=["post"])
    def reschedule(self, request, pk=None):
        day = day_from(request.data.get("day"))

        def work(appointment):
            if appointment.status != Appointment.Status.BOOKED:
                raise serializers.ValidationError("Only a booked appointment can be moved.")
            appointment.time = self.free_time(day, request.data.get("time"), appointment.duration_minutes, appointment.doctor, appointment)
            appointment.day, appointment.reminder_at = day, None

        return self.change(pk, "reschedule", work)


def mark_seen(clinic, patient, user):
    """When a visit is finalised, the patient's open appointment for today is closed as seen."""
    today = clinic.today()
    for appointment in Appointment.objects.filter(
        clinic=clinic, patient=patient, day=today, status__in=[Appointment.Status.BOOKED, Appointment.Status.ARRIVED]
    ):
        appointment.status, appointment.seen_at = Appointment.Status.SEEN, timezone.now()
        appointment.save()


def appointment_timeline(member, patient, before, limit):
    """A patient's appointments as timeline items, for roles that work with the diary."""
    clinic = member.clinic
    if member.role_id not in APPOINTMENTS or not feature_on(clinic, "appointments"):
        return []
    items = []
    for appointment in (
        Appointment.objects.filter(clinic=clinic, patient=patient).select_related("doctor").order_by("-day", "-time")[: limit * 2]
    ):
        # A walk-in has no booked time; it sits on the timeline at the moment the person arrived.
        if appointment.time is None and appointment.arrived_at:
            moment = timezone.localtime(appointment.arrived_at, clinic.tzinfo)
        else:
            moment = datetime.datetime.combine(appointment.day, appointment.time or datetime.time(0, 0), tzinfo=clinic.tzinfo)
        if before and moment >= before:
            continue
        items.append(
            {
                "kind": "appointment",
                "id": str(appointment.pk),
                "at": moment.isoformat(),
                "status": appointment.status,
                "visit_type": appointment.visit_type,
                "walk_in": appointment.walk_in,
                "doctor_name": person(appointment.doctor),
            }
        )
    return items[:limit]


class DashboardViewSet(ClinicViewSet):
    """The day at a glance. Each part appears only for the roles that work with it."""

    def list(self, request):
        clinic, role, today = self.member.clinic, self.member.role_id, self.member.clinic.today()
        data = {
            "day": today.isoformat(),
            "appointments": None,
            "follow_ups_due": None,
            "unpaid": None,
            "queue": [],
            "attention": [],
            "recent": [],
        }
        if role in APPOINTMENTS and feature_on(clinic, "appointments"):
            todays = Appointment.objects.filter(clinic=clinic, day=today).select_related("patient", "doctor")
            active = [appointment for appointment in todays if appointment.active]
            data["appointments"] = {
                "total": len(active),
                "seen": sum(appointment.status == Appointment.Status.SEEN for appointment in active),
            }
            order = {Appointment.Status.ARRIVED: 0, Appointment.Status.BOOKED: 1, Appointment.Status.SEEN: 2}
            rows = appointment_rows(clinic, active)
            data["queue"] = sorted(rows, key=lambda row: (order.get(row["status"], 3), row["arrived_at"] or "", row["time"] or ""))
            due = patient_extras.with_visit_dates(Patient.objects.filter(clinic=clinic, archived_at__isnull=True)).filter(
                next_advised__lte=today
            )
            data["follow_ups_due"] = due.count()
        if role in BILLING_READ and feature_on(clinic, "billing"):
            from billing.models import Invoice
            from billing.views import STATE_FILTERS, with_figures

            owing = list(with_figures(Invoice.objects.filter(clinic=clinic)).filter(STATE_FILTERS["outstanding"]))
            total = sum((invoice.owed for invoice in owing), Decimal("0"))
            data["unpaid"] = {"count": len(owing), "total": str(total.quantize(Decimal("0.01")))}
        if role in CLINICAL_WRITE:
            drafts = EncounterDraft.objects.filter(patient__clinic=clinic).count()
            if drafts:
                data["attention"].append({"kind": "drafts", "count": drafts})
        if role == "owner":
            from vault.api import status as backup_status

            state = backup_status(clinic)
            data["attention"].append(
                {
                    "kind": "backup",
                    "last_ok_at": state["last_ok_at"].isoformat() if state["last_ok_at"] else None,
                    "overdue": state["overdue"],
                    "problem": state["problem"],
                }
            )
        recent, seen = [], set()
        for encounter in (
            Encounter.objects.filter(patient__clinic=clinic, patient__archived_at__isnull=True)
            .select_related("patient")
            .order_by("-occurred_at")[:40]
        ):
            if encounter.patient_id not in seen:
                seen.add(encounter.patient_id)
                recent.append(
                    {
                        "id": str(encounter.patient_id),
                        "name": full_name(encounter.patient),
                        "last_visit": clinic.local_date(encounter.occurred_at).isoformat(),
                    }
                )
            if len(recent) == 5:
                break
        if not recent:
            for patient in Patient.objects.filter(clinic=clinic, archived_at__isnull=True).order_by("-created_at")[:5]:
                recent.append({"id": str(patient.pk), "name": full_name(patient), "last_visit": None})
        data["recent"] = recent
        self.event("dashboard.view")
        return Response(data)
