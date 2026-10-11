"""The work week, booking by phone, the day's diary, follow-ups due and the dashboard."""

import datetime
from decimal import Decimal
from unittest import mock

from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from billing.models import Invoice, InvoiceLine
from records.models import Encounter, EncounterDraft, Patient
from scheduling.models import USUAL_SESSIONS, Appointment, WorkDay, sessions_on, slot_times

# A Tuesday far enough ahead that it is never "today" or the past while these tests are in use.
DAY = datetime.date(2031, 10, 7)
SUNDAY = datetime.date(2031, 10, 5)


class SchedulingTestCase(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic", time_zone="Asia/Kolkata")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="owner", password="synthetic-password", first_name="Dr Synthetic")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="owner")
        self.anita = Patient.objects.create(
            clinic=self.clinic, first_name="Anita", last_name="Synthetic", gender="female", phone="+91 90000 00142"
        )
        self.sunita = Patient.objects.create(clinic=self.clinic, first_name="Sunita", gender="female", whatsapp_number="9000000142")
        self.vikram = Patient.objects.create(clinic=self.clinic, first_name="Vikram", gender="male", phone="9000000143")
        self.foreign = Patient.objects.create(clinic=self.other_clinic, first_name="Other", gender="other", phone="9000000142")
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()

    def role(self, value):
        self.member.role_id = value
        self.member.save()

    def book(self, patient=None, time="10:15", day=DAY, **more):
        body = {"patient": str((patient or self.anita).pk), "day": day.isoformat(), "time": time, **more}
        return self.client.post("/api/v1/appointments/", body, format="json")


class WorkWeekTests(SchedulingTestCase):
    def test_a_month_nobody_set_up_follows_the_usual_week(self):
        data = self.client.get("/api/v1/work-days/?month=2031-10").data
        self.assertEqual((data["saved"], data["days"][DAY.isoformat()]), (False, USUAL_SESSIONS))
        self.assertNotIn(SUNDAY.isoformat(), data["days"])
        self.assertEqual(len(data["days"]), 27)  # October 2031 has four Sundays
        self.assertEqual(sessions_on(self.clinic, SUNDAY), [])

    def test_saving_a_month_sets_each_date_and_closes_the_rest(self):
        days = {DAY.isoformat(): [["09:30", "13:00"], ["17:00", "20:00"]], SUNDAY.isoformat(): [["10:00", "12:00"]]}
        saved = self.client.post("/api/v1/work-days/", {"month": "2031-10", "days": days}, format="json")
        self.assertEqual((saved.status_code, saved.data["saved"], saved.data["days"]), (200, True, days))
        self.assertEqual(sessions_on(self.clinic, datetime.date(2031, 10, 8)), [])  # not listed: closed
        self.assertEqual(sessions_on(self.clinic, SUNDAY), [["10:00", "12:00"]])
        # Another month is untouched, and so is another clinic.
        self.assertEqual(sessions_on(self.clinic, datetime.date(2031, 11, 4)), USUAL_SESSIONS)
        self.assertEqual(sessions_on(self.other_clinic, datetime.date(2031, 10, 8)), USUAL_SESSIONS)
        # A month with every date closed stays closed rather than falling back to the usual week.
        closed = self.client.post("/api/v1/work-days/", {"month": "2031-10", "days": {}}, format="json").data
        self.assertEqual((closed["saved"], closed["days"]), (True, {}))
        self.assertEqual(WorkDay.objects.filter(clinic=self.clinic).count(), 31)
        self.assertTrue(AuditEvent.objects.filter(action="work_week.save").exists())

    def test_bad_months_and_other_roles_are_refused(self):
        for body in [
            {"month": "2031-13", "days": {}},
            {"month": "2031-10", "days": {"2031-11-01": [["09:00", "10:00"]]}},
            {"month": "2031-10", "days": {DAY.isoformat(): [["13:00", "09:00"]]}},
            {"month": "2031-10", "days": {DAY.isoformat(): [["09:00", "12:00"], ["11:00", "13:00"]]}},
            {"month": "2031-10", "days": {DAY.isoformat(): "all day"}},
            {"month": "2031-10", "days": []},
        ]:
            self.assertEqual(self.client.post("/api/v1/work-days/", body, format="json").status_code, 400, body)
        self.assertFalse(WorkDay.objects.exists())
        self.role("admin")
        self.assertEqual(self.client.post("/api/v1/work-days/", {"month": "2031-10", "days": {}}, format="json").status_code, 200)
        for role in ["clinician", "reception"]:
            self.role(role)
            self.assertEqual(self.client.get("/api/v1/work-days/?month=2031-10").status_code, 200, role)
            self.assertEqual(self.client.post("/api/v1/work-days/", {"month": "2031-10", "days": {}}, format="json").status_code, 403, role)
        self.role("billing")
        self.assertEqual(self.client.get("/api/v1/work-days/").status_code, 403)

    def test_at_most_four_work_weeks_are_saved(self):
        hours = {"weekday": [["09:30", "13:00"]], "saturday": [["09:30", "13:00"]], "sunday": []}
        saved = self.client.put("/api/v1/work-days/templates/2/", {"name": "Short weekend", "hours": hours}, format="json")
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual([(row["slot"], row["name"]) for row in saved.data], [(1, ""), (2, "Short weekend"), (3, ""), (4, "")])
        self.assertEqual(saved.data[1]["hours"], hours)
        for slot, body in [
            (5, {"name": "Fifth", "hours": hours}),
            (1, {"name": "", "hours": hours}),
            (1, {"name": "x", "hours": {"weekday": []}}),
        ]:
            self.assertEqual(self.client.put(f"/api/v1/work-days/templates/{slot}/", body, format="json").status_code, 400, (slot, body))
        self.assertEqual(self.client.delete("/api/v1/work-days/templates/2/").data[1]["name"], "")
        self.role("reception")
        self.assertEqual(self.client.put("/api/v1/work-days/templates/1/", {"name": "x", "hours": hours}, format="json").status_code, 403)

    def test_slots_are_a_quarter_of_an_hour_apart_inside_the_sessions(self):
        times = [time.strftime("%H:%M") for time in slot_times([["09:30", "10:15"], ["17:00", "17:30"]])]
        self.assertEqual(times, ["09:30", "09:45", "10:00", "17:00", "17:15"])


class BookingTests(SchedulingTestCase):
    def test_a_phone_number_finds_everyone_registered_on_it(self):
        found = self.client.post("/api/v1/appointments/by-phone/", {"phone": "90000 00142"}, format="json").data["patients"]
        self.assertEqual(sorted(row["name"] for row in found), ["Anita Synthetic", "Sunita"])
        self.assertEqual(
            self.client.post("/api/v1/appointments/by-phone/", {"phone": "+91-9000000143"}, format="json").data["patients"][0]["name"],
            "Vikram",
        )
        self.assertEqual(self.client.post("/api/v1/appointments/by-phone/", {"phone": "12"}, format="json").data["patients"], [])
        self.assertEqual(self.client.get("/api/v1/appointments/by-phone/").status_code, 405)
        # The number is never written to the audit log.
        self.assertFalse(AuditEvent.objects.filter(action="appointment.phone_lookup").exclude(resource_id=None).exists())

    def test_a_new_patient_is_added_with_only_a_name_and_number(self):
        created = self.client.post("/api/v1/appointments/quick-patient/", {"name": " Grace  Lee ", "phone": "9000000199"}, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        patient = Patient.objects.get(first_name="Grace")
        self.assertEqual(
            (patient.last_name, patient.phone, patient.date_of_birth, patient.clinic), ("Lee", "9000000199", None, self.clinic)
        )
        self.assertRegex(created.data["code"], r"^PAT-")
        self.assertEqual(self.client.post("/api/v1/appointments/quick-patient/", {"name": ""}, format="json").status_code, 400)
        # The patient API still asks for a date of birth at ordinary registration.
        self.assertEqual(self.client.post("/api/v1/patients/", {"first_name": "No", "gender": "other"}, format="json").status_code, 400)
        self.assertEqual(self.client.get(f"/api/v1/patients/{patient.pk}/").data["date_of_birth"], None)

    def test_booking_takes_a_free_time_inside_the_work_week(self):
        booked = self.book(remind=True)
        self.assertEqual(booked.status_code, 201, booked.data)
        row = booked.data
        self.assertEqual((row["time"], row["status"], row["duration_minutes"], row["remind"]), ("10:15", "booked", 15, True))
        self.assertEqual((row["patient"]["name"], row["patient"]["phone"]), ("Anita Synthetic", "+91 90000 00142"))
        first = self.book(self.vikram, "10:30", visit_type="first")
        self.assertEqual((first.status_code, first.data["duration_minutes"]), (201, 45))
        for patient, time, why in [
            (self.sunita, "10:15", "already booked"),
            (self.sunita, "11:00", "inside the 45 minute first visit"),
            (self.sunita, "13:00", "closed at lunch"),
            (self.sunita, "12:45", "fine"),
            (self.sunita, "07:00", "before opening"),
            (self.sunita, "half past ten", "not a time"),
        ]:
            expected = 201 if why == "fine" else 400
            self.assertEqual(self.book(patient, time).status_code, expected, why)
        self.assertEqual(self.book(self.sunita, "10:00", day=SUNDAY).status_code, 400)
        self.assertEqual(self.book(self.sunita, "10:00", day=datetime.date(2020, 1, 6)).status_code, 400)
        self.assertEqual(self.book(self.foreign, "09:30").status_code, 400)
        self.assertEqual(self.book(self.sunita, "09:30", visit_type="chat").status_code, 400)
        slots = {slot["time"]: slot["free"] for slot in self.client.get(f"/api/v1/appointments/slots/?day={DAY}").data["slots"]}
        self.assertEqual(
            (slots["10:00"], slots["10:15"], slots["10:30"], slots["11:00"], slots["11:15"], slots["12:45"]),
            (True, False, False, False, True, False),
        )
        self.assertEqual(self.client.get(f"/api/v1/appointments/slots/?day={SUNDAY}").data["slots"], [])

    def test_a_first_visit_must_fit_before_the_session_ends(self):
        self.assertEqual(self.book(time="12:30", visit_type="first").status_code, 400)
        self.assertEqual(self.book(time="12:15", visit_type="first").status_code, 201)

    def test_two_doctors_can_be_booked_at_the_same_time(self):
        colleague = User.objects.create_user(username="colleague", password="synthetic-password")
        Membership.objects.create(clinic=self.clinic, user=colleague, role_id="clinician")
        self.assertEqual(self.book(doctor=str(self.user.pk)).status_code, 201)
        self.assertEqual(self.book(self.vikram, doctor=str(self.user.pk)).status_code, 400)
        self.assertEqual(self.book(self.vikram, doctor=str(colleague.pk)).status_code, 201)
        names = [row["name"] for row in self.client.get("/api/v1/appointments/doctors/").data]
        self.assertEqual(sorted(names), ["Dr Synthetic", "colleague"])
        receptionist = User.objects.create_user(username="desk", password="synthetic-password")
        Membership.objects.create(clinic=self.clinic, user=receptionist, role_id="reception")
        self.assertEqual(self.book(self.sunita, "11:00", doctor=str(receptionist.pk)).status_code, 400)

    def test_an_appointment_moves_through_the_day(self):
        booked = self.book().data
        url = f"/api/v1/appointments/{booked['id']}"
        self.assertEqual(self.client.post(f"{url}/seen/").data["status"], "seen")
        other = self.book(self.vikram, "10:30").data
        arrived = self.client.post(f"/api/v1/appointments/{other['id']}/arrive/").data
        self.assertEqual((arrived["status"], arrived["waiting_minutes"]), ("arrived", 0))
        self.assertEqual(self.client.post(f"/api/v1/appointments/{other['id']}/arrive/").status_code, 400)
        self.assertEqual(self.client.post(f"/api/v1/appointments/{other['id']}/no-show/").status_code, 400)
        self.assertEqual(self.client.post(f"/api/v1/appointments/{other['id']}/cancel/", {}, format="json").status_code, 400)
        cancelled = self.client.post(f"/api/v1/appointments/{other['id']}/cancel/", {"reason": "Cancelled by patient"}, format="json").data
        self.assertEqual((cancelled["status"], cancelled["cancel_reason"]), ("cancelled", "Cancelled by patient"))
        # The cancelled time is free again.
        third = self.book(self.sunita, "10:30").data
        moved = self.client.post(
            f"/api/v1/appointments/{third['id']}/reschedule/", {"day": DAY.isoformat(), "time": "11:15"}, format="json"
        ).data
        self.assertEqual((moved["time"], moved["status"]), ("11:15", "booked"))
        self.assertEqual(
            self.client.post(
                f"/api/v1/appointments/{third['id']}/reschedule/", {"day": DAY.isoformat(), "time": "10:15"}, format="json"
            ).status_code,
            400,
        )
        self.assertEqual(self.client.post(f"/api/v1/appointments/{third['id']}/no-show/").data["status"], "no_show")
        listed = self.client.get(f"/api/v1/appointments/?day={DAY}").data["results"]
        self.assertEqual(
            [(row["time"], row["status"]) for row in listed], [("10:15", "seen"), ("10:30", "cancelled"), ("11:15", "no_show")]
        )

    def test_a_walk_in_arrives_at_once_and_a_finalised_visit_closes_the_appointment(self):
        walk_in = self.client.post(
            "/api/v1/appointments/", {"patient": str(self.anita.pk), "walk_in": True, "reason": "Collect medicine"}, format="json"
        )
        self.assertEqual(walk_in.status_code, 201, walk_in.data)
        self.assertEqual(
            (walk_in.data["time"], walk_in.data["status"], walk_in.data["walk_in"], walk_in.data["day"]),
            (None, "arrived", True, self.clinic.today().isoformat()),
        )
        visit = self.client.post("/api/v1/encounters/", {"patient": str(self.anita.pk), "chief_complaint": "Synthetic"}, format="json")
        self.assertEqual(visit.status_code, 201, visit.data)
        self.assertEqual(Appointment.objects.get(pk=walk_in.data["id"]).status, "seen")
        # With a bill issued today the diary says so.
        invoice = Invoice.objects.create(clinic=self.clinic, patient=self.anita, created_by=self.user)
        InvoiceLine.objects.create(invoice=invoice, kind="service", description="Consultation", rate=Decimal("500"))
        invoice.status, invoice.number, invoice.issued_at = "issued", "INV/1", timezone.now()
        invoice.save()
        self.assertTrue(self.client.get("/api/v1/appointments/").data["results"][0]["billed"])

    def test_roles_switches_and_other_clinics(self):
        booked = self.book().data
        for role in ["clinician", "assistant", "reception"]:
            self.role(role)
            self.assertEqual(self.client.get(f"/api/v1/appointments/?day={DAY}").status_code, 200, role)
        for role in ["billing", "admin"]:
            self.role(role)
            self.assertEqual(self.client.get("/api/v1/appointments/").status_code, 403, role)
            self.assertEqual(self.book(self.vikram, "11:00").status_code, 403, role)
        self.role("assistant")
        self.assertEqual(self.client.post("/api/v1/appointments/quick-patient/", {"name": "Desk Only"}, format="json").status_code, 201)
        self.role("owner")
        self.clinic.features = {"appointments": False}
        self.clinic.save()
        self.assertEqual(self.client.get("/api/v1/appointments/").status_code, 403)
        self.clinic.features = {}
        self.clinic.save()
        foreign = Appointment.objects.create(
            clinic=self.other_clinic, patient=self.foreign, day=DAY, time=datetime.time(9, 30), created_by=self.user
        )
        self.assertEqual(self.client.post(f"/api/v1/appointments/{foreign.pk}/arrive/").status_code, 400)
        self.assertEqual(len(self.client.get(f"/api/v1/appointments/?day={DAY}").data["results"]), 1)
        self.assertEqual(self.client.get(f"/api/v1/appointments/?from={DAY}&to=2032-10-07").status_code, 400)
        self.assertTrue(AuditEvent.objects.filter(action="appointment.create", resource_id=booked["id"]).exists())


class FollowUpAndDashboardTests(SchedulingTestCase):
    def visit(self, patient, follow_up, days_ago=1):
        return Encounter.objects.create(
            patient=patient,
            clinician=self.user,
            chief_complaint="Synthetic",
            occurred_at=timezone.now() - datetime.timedelta(days=days_ago),
            follow_up_date=follow_up,
        )

    def test_follow_ups_due_say_who_is_booked(self):
        today = self.clinic.today()
        self.visit(self.anita, today - datetime.timedelta(days=4), days_ago=20)
        self.visit(self.vikram, today + datetime.timedelta(days=2))
        self.visit(self.sunita, today + datetime.timedelta(days=30))
        tomorrow = today + datetime.timedelta(days=1)
        WorkDay.objects.create(clinic=self.clinic, day=tomorrow, sessions=[["09:00", "20:00"]])
        self.assertEqual(self.book(self.vikram, "11:00", day=tomorrow).status_code, 201)
        data = self.client.get("/api/v1/appointments/follow-ups/").data
        self.assertEqual(data["count"], 2)
        rows = {row["patient"]["name"]: row for row in data["results"]}
        self.assertIsNone(rows["Anita Synthetic"]["booked"])
        self.assertEqual(rows["Vikram"]["booked"], {"day": tomorrow.isoformat(), "time": "11:00"})
        self.assertNotIn("Sunita", rows)

    def test_the_dashboard_gathers_the_day_for_each_role(self):
        today = self.clinic.today()
        Appointment.objects.create(
            clinic=self.clinic,
            patient=self.anita,
            day=today,
            time=datetime.time(9, 30),
            status="arrived",
            arrived_at=timezone.now(),
            created_by=self.user,
        )
        Appointment.objects.create(
            clinic=self.clinic, patient=self.vikram, day=today, time=datetime.time(9, 0), status="seen", created_by=self.user
        )
        Appointment.objects.create(
            clinic=self.clinic, patient=self.sunita, day=today, time=datetime.time(10, 15), status="cancelled", created_by=self.user
        )
        self.visit(self.vikram, today - datetime.timedelta(days=1), days_ago=10)
        EncounterDraft.objects.create(patient=self.anita, author=self.user, data={})
        invoice = Invoice.objects.create(clinic=self.clinic, patient=self.anita, created_by=self.user, total=Decimal("320"))
        Invoice.objects.filter(pk=invoice.pk).update(status="issued", number="INV/1", issued_at=timezone.now())
        with mock.patch("vault.api.status", return_value={"last_ok_at": None, "overdue": True, "due": True, "problem": ""}):
            data = self.client.get("/api/v1/dashboard/").data
        self.assertEqual(
            (data["appointments"], data["follow_ups_due"], data["unpaid"]), ({"total": 2, "seen": 1}, 1, {"count": 1, "total": "320.00"})
        )
        self.assertEqual(
            [(row["patient"]["name"], row["status"]) for row in data["queue"]], [("Anita Synthetic", "arrived"), ("Vikram", "seen")]
        )
        self.assertEqual({item["kind"] for item in data["attention"]}, {"drafts", "backup"})
        self.assertEqual(data["recent"][0]["name"], "Vikram")
        self.role("reception")
        desk = self.client.get("/api/v1/dashboard/").data
        self.assertEqual((desk["attention"], desk["unpaid"]["count"], len(desk["queue"])), ([], 1, 2))
        self.role("billing")
        billing = self.client.get("/api/v1/dashboard/").data
        self.assertEqual((billing["appointments"], billing["queue"], billing["unpaid"]["total"]), (None, [], "320.00"))
        self.role("admin")
        admin = self.client.get("/api/v1/dashboard/").data
        self.assertEqual((admin["appointments"], admin["unpaid"], admin["attention"]), (None, None, []))

    def test_appointments_join_the_patient_timeline(self):
        self.book()
        kinds = [item["kind"] for item in self.client.get(f"/api/v1/patients/{self.anita.pk}/feed/").data["items"]]
        self.assertEqual(kinds, ["appointment"])
        self.role("billing")
        self.assertEqual(self.client.get(f"/api/v1/patients/{self.anita.pk}/feed/").data["items"], [])
