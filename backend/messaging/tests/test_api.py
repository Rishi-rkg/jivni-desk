"""Messages: wording, consent, approval, sending by hand, rules that prepare, templates, campaigns and replies."""

import datetime
from unittest import mock

from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from messaging.models import Message, MessageRule, MessageTemplate, ensure_standard, render, whatsapp_digits
from messaging.rules import medicine_named, prepare
from records.models import Encounter, Patient, PatientConsent, Prescription, PrescriptionItem
from scheduling.models import Appointment

MONDAY = datetime.date(2031, 10, 6)
SATURDAY = datetime.date(2031, 10, 4)


class MessagingTestCase(TestCase):
    def setUp(self):
        cache.clear()
        self.clinic = Clinic.objects.create(name="Synthetic clinic", time_zone="Asia/Kolkata", phone="+91 90000 00100", currency="INR")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="owner", password="synthetic-password", first_name="Dr Synthetic")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="owner")
        self.anita = Patient.objects.create(
            clinic=self.clinic, first_name="Anita", last_name="Synthetic", gender="female", phone="+91 90000 00142"
        )
        self.vikram = Patient.objects.create(clinic=self.clinic, first_name="Vikram", gender="male", phone="9000000143")
        self.sunita = Patient.objects.create(clinic=self.clinic, first_name="Sunita", gender="female")
        self.foreign = Patient.objects.create(clinic=self.other_clinic, first_name="Other", gender="other", phone="9000000199")
        self.agree(self.anita)
        self.agree(self.sunita)
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()

    def agree(self, patient, kind="care", granted=True):
        return PatientConsent.objects.create(patient=patient, kind=kind, granted=granted, recorded_by=self.user)

    def role(self, value):
        self.member.role_id = value
        self.member.save()

    def write(self, patient=None, body="Hello, the clinic is closed on Friday.", **more):
        return self.client.post("/api/v1/messages/", {"patient": str((patient or self.anita).pk), "body": body, **more}, format="json")

    def step(self, message_id, name, body=None):
        return self.client.post(f"/api/v1/messages/{message_id}/{name}/", body or {}, format="json")

    def box(self, name):
        return self.client.get(f"/api/v1/messages/?box={name}").data["results"]

    def template(self, key):
        ensure_standard(self.clinic)
        return MessageTemplate.objects.get(clinic=self.clinic, key=key)

    def visit(self, patient, days_ago):
        return Encounter.objects.create(
            patient=patient,
            clinician=self.user,
            chief_complaint="Synthetic",
            occurred_at=timezone.now() - datetime.timedelta(days=days_ago),
        )


class WordingTests(MessagingTestCase):
    def test_numbers_are_made_ready_for_whatsapp(self):
        self.assertEqual(whatsapp_digits("+91 90000 00142"), "919000000142")
        self.assertEqual(whatsapp_digits("9000000143"), "919000000143")
        self.assertEqual(whatsapp_digits("090000 00143"), "919000000143")
        self.assertEqual(whatsapp_digits("0044 20 7946 0958"), "442079460958")
        self.assertEqual(whatsapp_digits("5550100"), "")
        self.assertEqual(whatsapp_digits(""), "")

    def test_fields_are_filled_and_missing_ones_are_named(self):
        text, missing = render("Hello {first_name}, see you on {appointment_date}. {not_a_field}", {"first_name": "Anita"})
        self.assertEqual((text, missing), ("Hello Anita, see you on {appointment_date}. {not_a_field}", ["appointment_date"]))

    def test_a_medicine_from_the_patients_record_is_noticed(self):
        visit = self.visit(self.anita, 3)
        envelope = Prescription.objects.create(encounter=visit, prescriber=self.user)
        PrescriptionItem.objects.create(prescription=envelope, medicine_name_snapshot="Arnica montana 200C")
        PrescriptionItem.objects.create(prescription=envelope, medicine_name_snapshot="Nux vomica 30")
        self.assertEqual(medicine_named(self.anita, "Please continue the ARNICA as before"), "Arnica montana 200C")
        self.assertEqual(medicine_named(self.anita, "Take nux vomica tonight"), "Nux vomica 30")
        self.assertEqual(medicine_named(self.anita, "Your appointment is at 10:15"), "")
        # Another patient's medicines are not this patient's business.
        self.assertEqual(medicine_named(self.vikram, "Please continue the arnica"), "")
        refused = self.write(body="Please continue the Arnica as before")
        self.assertEqual(refused.status_code, 400)
        self.assertIn("never contain", str(refused.data["body"]))

    def test_a_message_is_written_by_hand_or_from_a_template(self):
        by_hand = self.write()
        self.assertEqual((by_hand.status_code, by_hand.data["status"], by_hand.data["source"]), (201, "waiting", "manual"))
        self.assertEqual((by_hand.data["context"], by_hand.data["to"], by_hand.data["blocked"]), ("Written by hand", "+91 90000 00142", ""))
        self.assertTrue(by_hand.data["consent"]["granted"])

        reminder = self.template("appointment_reminder")
        body = {"patient": str(self.anita.pk), "template": str(reminder.pk)}
        preview = self.client.post("/api/v1/messages/preview/", body, format="json").data
        self.assertEqual(preview["missing"], ["appointment date", "appointment time"])
        self.assertIn("Hello Anita, this is a reminder of your appointment at Synthetic clinic on {appointment_date}", preview["body"])
        # A field nothing was filled in for cannot be sent as it is.
        self.assertEqual(self.write(body=preview["body"], template=str(reminder.pk)).status_code, 400)

        with mock.patch.object(Clinic, "today", return_value=MONDAY):
            booked = Appointment.objects.create(
                clinic=self.clinic, patient=self.anita, doctor=self.user, day=MONDAY, time=datetime.time(10, 15), created_by=self.user
            )
            preview = self.client.post("/api/v1/messages/preview/", body, format="json").data
        self.assertEqual(preview["missing"], [])
        self.assertTrue(preview["body"].endswith("on Mon 06 Oct 2031 at 10:15."))
        made = self.write(body=preview["body"], template=str(reminder.pk), appointment=str(booked.pk))
        self.assertEqual(
            (made.data["source"], made.data["title"], made.data["template"]),
            ("template", "Appointment reminder", {"name": "Appointment reminder", "version": 1}),
        )
        self.assertEqual(made.data["context"], "Appointment Mon 06 Oct 10:15")

    def test_who_and_what_cannot_be_written_to(self):
        self.assertEqual(self.write(self.foreign).status_code, 400)
        self.assertEqual(self.write(body="  ").status_code, 400)
        self.assertEqual(self.write(body="x" * 1001).status_code, 400)
        self.anita.archived_at = timezone.now()
        self.anita.save()
        self.assertEqual(self.write().status_code, 400)
        draft = MessageTemplate.objects.create(
            clinic=self.clinic, name="Festival greeting", kind="greetings", body="Happy Diwali, {first_name}!"
        )
        self.assertEqual(self.write(self.vikram, template=str(draft.pk)).status_code, 400)


class SendingTests(MessagingTestCase):
    def test_a_message_is_approved_then_sent_by_hand_once(self):
        message = self.write(body="Hello Anita & family, the clinic is closed on Friday.").data
        self.role("reception")
        self.assertEqual(self.step(message["id"], "approve").status_code, 403)
        self.assertEqual(self.step(message["id"], "send").status_code, 403)
        self.role("clinician")
        approved = self.step(message["id"], "approve")
        self.assertEqual(
            (approved.status_code, approved.data["status"], approved.data["approved_by_name"]), (200, "approved", "Dr Synthetic")
        )
        self.assertEqual(self.step(message["id"], "approve").status_code, 400)
        # The front desk sends what a doctor approved.
        self.role("reception")
        sent = self.step(message["id"], "send")
        self.assertEqual((sent.status_code, sent.data["status"], sent.data["to"]), (200, "sent", "+91 90000 00142"))
        self.assertEqual(
            sent.data["link"], "https://wa.me/919000000142?text=Hello%20Anita%20%26%20family%2C%20the%20clinic%20is%20closed%20on%20Friday."
        )
        self.assertEqual(self.step(message["id"], "send").status_code, 400)
        self.assertEqual([row["id"] for row in self.box("sent")], [message["id"]])
        self.assertEqual(self.box("waiting"), [])
        # The record says who did what, and never what was said.
        events = AuditEvent.objects.filter(action__startswith="message.", resource_id=message["id"])
        self.assertEqual(set(events.values_list("action", flat=True)), {"message.create", "message.approve", "message.send"})
        self.assertFalse(any("closed on Friday" in str(vars(event)) for event in AuditEvent.objects.all()))

    def test_the_owner_approves_and_sends_in_one_step(self):
        message = self.write().data
        sent = self.step(message["id"], "send")
        self.assertEqual(
            (sent.data["status"], sent.data["approved_by_name"], sent.data["sent_by_name"]), ("sent", "Dr Synthetic", "Dr Synthetic")
        )

    def test_nothing_goes_without_consent_or_a_number(self):
        no_consent, no_number = self.write(self.vikram).data, self.write(self.sunita).data
        self.assertEqual(no_consent["blocked"], "No care-message consent.")
        self.assertEqual(no_number["blocked"], "No WhatsApp number on the patient's record.")
        for message in (no_consent, no_number):
            refused = self.step(message["id"], "approve")
            self.assertEqual(refused.status_code, 400)
            self.assertIn("Not sendable", str(refused.data))
            self.assertEqual(self.step(message["id"], "send").status_code, 400)
        self.agree(self.vikram)
        self.assertEqual(self.step(no_consent["id"], "approve").status_code, 200)
        # Consent taken back after approval still stops the message.
        self.agree(self.vikram, granted=False)
        self.assertEqual(self.step(no_consent["id"], "send").status_code, 400)
        self.assertEqual(Message.objects.get(pk=no_consent["id"]).status, "approved")
        # A greeting needs its own consent.
        greeting = self.write(kind="greetings", body="Happy new year from the clinic!").data
        self.assertEqual(greeting["blocked"], "No consent to greetings and clinic news.")
        self.sunita.phone = "12345"
        self.sunita.save()
        self.assertEqual(self.box("waiting")[1]["blocked"], "The WhatsApp number looks incomplete.")

    def test_editing_sending_later_discarding_failing_and_trying_again(self):
        message = self.write().data
        self.step(message["id"], "approve")
        tomorrow = (self.clinic.today() + datetime.timedelta(days=1)).isoformat()
        later = self.client.patch(f"/api/v1/messages/{message['id']}/", {"send_after": tomorrow}, format="json")
        self.assertEqual((later.status_code, later.data["send_after"], later.data["status"]), (200, tomorrow, "approved"))
        today = self.clinic.today().isoformat()
        self.assertEqual(self.client.patch(f"/api/v1/messages/{message['id']}/", {"send_after": today}, format="json").status_code, 400)
        # New wording from the front desk needs approving again.
        self.role("reception")
        edited = self.client.patch(f"/api/v1/messages/{message['id']}/", {"body": "Hello, we are closed on Saturday."}, format="json")
        self.assertEqual((edited.data["status"], edited.data["approved_by_name"]), ("waiting", ""))
        self.role("owner")
        sent = self.step(message["id"], "send")
        self.assertEqual((sent.data["status"], sent.data["send_after"]), ("sent", None))
        self.assertEqual(self.client.patch(f"/api/v1/messages/{message['id']}/", {"body": "Changed"}, format="json").status_code, 400)
        self.assertEqual(self.step(message["id"], "discard").status_code, 400)
        self.assertEqual(self.step(message["id"], "failed").status_code, 400)
        failed = self.step(message["id"], "failed", {"reason": "Number is not on WhatsApp"})
        self.assertEqual((failed.data["status"], failed.data["failed_reason"]), ("failed", "Number is not on WhatsApp"))
        again = self.step(message["id"], "retry")
        self.assertEqual(
            (again.status_code, again.data["status"], again.data["body"]), (201, "approved", "Hello, we are closed on Saturday.")
        )
        self.assertEqual(len(self.box("failed")), 1)
        thrown = self.step(again.data["id"], "discard")
        self.assertEqual(thrown.data["status"], "discarded")
        self.assertEqual(self.box("waiting"), [])
        counts = self.client.get("/api/v1/messages/counts/").data
        self.assertEqual(counts, {"waiting": 0, "replies": 0, "failed": 1})

    def test_several_are_approved_or_discarded_together(self):
        first, second, blocked = self.write().data, self.write(body="Second synthetic message").data, self.write(self.vikram).data
        ids = [first["id"], second["id"], blocked["id"], "not-an-id"]
        self.role("reception")
        self.assertEqual(self.client.post("/api/v1/messages/bulk/", {"action": "approve", "ids": ids}, format="json").status_code, 403)
        self.role("owner")
        done = self.client.post("/api/v1/messages/bulk/", {"action": "approve", "ids": ids}, format="json").data
        self.assertEqual(done, {"done": 2, "skipped": 2})
        self.assertEqual([row["status"] for row in self.box("waiting")], ["approved", "approved", "waiting"])
        thrown = self.client.post("/api/v1/messages/bulk/", {"action": "discard", "ids": [blocked["id"]]}, format="json").data
        self.assertEqual(thrown, {"done": 1, "skipped": 0})
        self.assertEqual(self.client.post("/api/v1/messages/bulk/", {"action": "send", "ids": ids}, format="json").status_code, 400)

    def test_a_reply_is_noted_and_dealt_with(self):
        self.role("reception")
        reply = self.client.post(
            "/api/v1/messages/replies/", {"patient": str(self.anita.pk), "body": "Can I come at 5 instead?"}, format="json"
        )
        self.assertEqual(
            (reply.status_code, reply.data["status"], reply.data["source"], reply.data["consent"]), (201, "received", "reply", None)
        )
        self.assertEqual(self.client.get("/api/v1/messages/counts/").data["replies"], 1)
        self.assertEqual(self.step(reply.data["id"], "send").status_code, 400)
        handled = self.step(reply.data["id"], "handled")
        self.assertEqual(handled.data["status"], "handled")
        self.assertEqual(self.step(reply.data["id"], "handled").status_code, 400)
        self.assertEqual(self.client.get("/api/v1/messages/counts/").data["replies"], 0)
        self.assertEqual(len(self.box("replies")), 1)

    def test_roles_switches_and_other_clinics(self):
        message = self.write().data
        foreign = Message.objects.create(clinic=self.other_clinic, patient=self.foreign, title="Other", body="Other clinic's message")
        self.assertEqual(self.step(foreign.pk, "send").status_code, 400)
        self.assertEqual(self.client.patch(f"/api/v1/messages/{foreign.pk}/", {"body": "Mine now"}, format="json").status_code, 400)
        self.assertEqual([row["id"] for row in self.box("waiting")], [message["id"]])
        self.assertEqual(self.client.get(f"/api/v1/messages/?patient={self.foreign.pk}").status_code, 400)
        self.assertEqual(self.client.get("/api/v1/messages/?box=everything").status_code, 400)
        for role in ["assistant", "billing", "admin"]:
            self.role(role)
            self.assertEqual(self.client.get("/api/v1/messages/").status_code, 403, role)
            self.assertEqual(self.write().status_code, 403, role)
        self.role("owner")
        self.clinic.features = {"messages": False}
        self.clinic.save()
        self.assertEqual(self.client.get("/api/v1/messages/").status_code, 403)
        self.assertEqual(self.client.get("/api/v1/message-templates/").status_code, 403)
        self.assertEqual(prepare(self.clinic, force=True), 0)

    def test_messages_join_the_patient_timeline_and_the_dashboard(self):
        message = self.write().data
        self.step(message["id"], "send")
        thrown = self.write(body="Synthetic message that was discarded").data
        self.step(thrown["id"], "discard")
        items = self.client.get(f"/api/v1/patients/{self.anita.pk}/feed/").data["items"]
        self.assertEqual([(item["kind"], item["status"], item["title"]) for item in items], [("message", "sent", "Message")])
        history = self.client.get(f"/api/v1/messages/?patient={self.anita.pk}").data["results"]
        self.assertEqual([row["status"] for row in history], ["sent"])
        self.write(self.vikram)
        with mock.patch("vault.api.status", return_value={"last_ok_at": None, "overdue": False, "due": False, "problem": ""}):
            self.assertEqual(self.client.get("/api/v1/dashboard/").data["messages_waiting"], 1)
            self.role("assistant")
            self.assertNotIn("messages_waiting", self.client.get("/api/v1/dashboard/").data)
        self.assertEqual(self.client.get(f"/api/v1/patients/{self.anita.pk}/feed/").data["items"], [])


class RuleTests(MessagingTestCase):
    def book(self, patient, day, time=datetime.time(10, 15), **more):
        return Appointment.objects.create(
            clinic=self.clinic, patient=patient, doctor=self.user, day=day, time=time, created_by=self.user, **more
        )

    def test_tomorrows_appointments_get_a_reminder_once(self):
        with mock.patch.object(Clinic, "today", return_value=MONDAY):
            booked = self.book(self.anita, MONDAY + datetime.timedelta(days=1), remind=True)
            self.book(self.vikram, MONDAY + datetime.timedelta(days=1), datetime.time(11, 0), remind=False)
            self.book(self.sunita, MONDAY + datetime.timedelta(days=2), remind=True)
            self.assertEqual(prepare(self.clinic, force=True), 1)
            self.assertEqual(prepare(self.clinic, force=True), 0)
        message = Message.objects.get()
        self.assertEqual(
            (message.patient, message.title, message.status, message.source), (self.anita, "Appointment reminder", "waiting", "rule")
        )
        self.assertEqual(
            message.body, "Hello Anita, this is a reminder of your appointment at Synthetic clinic on Tue 07 Oct 2031 at 10:15."
        )
        booked.refresh_from_db()
        self.assertIsNotNone(booked.reminder_at)
        row = self.box("waiting")[0]
        self.assertEqual(row["context"], "Appointment Tue 07 Oct 10:15 · Rule: Appointment reminder")

    def test_saturday_prepares_mondays_reminders_because_sunday_is_closed(self):
        with mock.patch.object(Clinic, "today", return_value=SATURDAY):
            self.book(self.anita, MONDAY, remind=True)
            self.assertEqual(prepare(self.clinic, force=True), 1)

    def test_reminders_skip_approval_only_when_the_clinic_says_so(self):
        ensure_standard(self.clinic)
        rule = MessageRule.objects.get(clinic=self.clinic, trigger="before_appointment")
        rule.needs_approval = False
        rule.save()
        with mock.patch.object(Clinic, "today", return_value=MONDAY):
            self.book(self.anita, MONDAY + datetime.timedelta(days=1), remind=True)
            prepare(self.clinic, force=True)
            self.assertEqual(Message.objects.get().status, "waiting")
            self.clinic.features = {"auto_reminders": True}
            self.clinic.save()
            self.book(self.vikram, MONDAY + datetime.timedelta(days=1), datetime.time(11, 0), remind=True)
            prepare(self.clinic, force=True)
        ready = Message.objects.get(patient=self.vikram)
        self.assertEqual((ready.status, ready.approved_by, ready.approved_at is not None), ("approved", None, True))
        # Ready is not sent: with no consent it still goes nowhere.
        self.assertEqual(self.step(ready.pk, "send").status_code, 400)

    def test_a_check_in_goes_a_month_after_the_last_visit_unless_a_visit_is_booked(self):
        self.visit(self.anita, 31)
        self.visit(self.vikram, 33)
        self.visit(self.sunita, 10)
        self.book(self.vikram, self.clinic.today() + datetime.timedelta(days=40))
        self.assertEqual(prepare(self.clinic, force=True), 1)
        message = Message.objects.get()
        self.assertEqual((message.patient, message.title), (self.anita, "30 day check-in"))
        self.assertIn("It has been about one month since your visit to Synthetic clinic", message.body)
        self.assertEqual(prepare(self.clinic, force=True), 0)
        # The 90 day rule is off until someone switches it on.
        older = Patient.objects.create(clinic=self.clinic, first_name="Farid", gender="male", phone="9000000144")
        self.visit(older, 92)
        self.assertEqual(prepare(self.clinic, force=True), 0)
        MessageRule.objects.filter(clinic=self.clinic, name="90 day follow-up").update(enabled=True)
        self.assertEqual(prepare(self.clinic, force=True), 1)
        self.assertEqual(Message.objects.get(patient=older).title, "90 day follow-up")

    def test_a_birthday_greeting_is_prepared_only_with_greetings_consent(self):
        today = self.clinic.today()
        born = today.replace(year=1990) if (today.month, today.day) != (2, 29) else datetime.date(1992, 2, 29)
        for patient in (self.anita, self.vikram):
            patient.date_of_birth = born
            patient.save()
        self.agree(self.anita, "greetings")
        self.assertEqual(prepare(self.clinic, force=True), 1)
        message = Message.objects.get()
        self.assertEqual((message.patient, message.kind, message.title), (self.anita, "greetings", "Birthday greeting"))
        self.assertEqual(message.body, "Happy birthday, Anita! Warm wishes from everyone at Synthetic clinic.")

    def test_opening_the_queue_prepares_and_asking_again_soon_does_not_look_again(self):
        self.visit(self.anita, 31)
        self.assertEqual(len(self.box("waiting")), 1)
        self.visit(self.vikram, 31)
        self.assertEqual(prepare(self.clinic), 0)
        self.assertEqual(len(self.box("waiting")), 1)
        self.assertEqual(prepare(self.clinic, force=True), 1)


class TemplateAndRuleTests(MessagingTestCase):
    def test_every_clinic_starts_with_the_same_templates_and_rules(self):
        first = self.client.get("/api/v1/message-templates/").data
        self.assertEqual(
            [row["name"] for row in first["results"]],
            ["Appointment reminder", "Birthday greeting", "Follow-up 30 days", "Follow-up 90 days", "Invoice and receipt"],
        )
        self.assertEqual(first["results"][0]["uses"], ["first name", "clinic name", "appointment date", "appointment time"])
        self.assertIn({"name": "first_name", "label": "first name"}, first["fields"])
        rules = self.client.get("/api/v1/message-rules/").data
        self.assertEqual(
            [(row["name"], row["enabled"], row["words"]) for row in rules["results"]],
            [
                ("Appointment reminder", True, "1 day before · needs approval"),
                ("30 day check-in", True, "30 days after last visit, if no follow-up is booked · needs approval"),
                ("Birthday greeting", True, "On the day · greetings consent only · needs approval"),
                ("90 day follow-up", False, "Switched off"),
            ],
        )
        self.client.get("/api/v1/message-templates/")
        self.assertEqual((MessageTemplate.objects.count(), MessageRule.objects.count()), (5, 4))

    def test_changing_the_wording_makes_a_new_version_and_old_messages_keep_theirs(self):
        template = self.template("check_in_30")
        self.visit(self.anita, 31)
        prepare(self.clinic, force=True)
        before = Message.objects.get()
        changed = self.client.patch(
            f"/api/v1/message-templates/{template.pk}/", {"body": "Hello {first_name}, how are you? {clinic_name}"}, format="json"
        )
        self.assertEqual((changed.status_code, changed.data["version"], changed.data["uses"]), (200, 2, ["first name", "clinic name"]))
        same = self.client.patch(f"/api/v1/message-templates/{template.pk}/", {"name": "Follow-up 30 days"}, format="json")
        self.assertEqual(same.data["version"], 2)
        before.refresh_from_db()
        self.assertEqual((before.template_version, "about one month" in before.body), (1, True))
        self.assertEqual(
            self.client.patch(f"/api/v1/message-templates/{template.pk}/", {"body": "About your {diagnosis}"}, format="json").status_code,
            400,
        )
        made = self.client.post(
            "/api/v1/message-templates/",
            {"name": "Festival greeting", "kind": "greetings", "body": "Happy Diwali, {first_name}!"},
            format="json",
        )
        self.assertEqual((made.status_code, made.data["approved"], made.data["version"]), (201, False, 1))
        again = self.client.post("/api/v1/message-templates/", {"name": "festival greeting", "body": "Twice"}, format="json")
        self.assertEqual(again.status_code, 400)
        self.assertEqual(self.client.post("/api/v1/message-templates/", {"name": "No wording"}, format="json").status_code, 400)

    def test_rules_are_set_by_owner_and_administrator(self):
        ensure_standard(self.clinic)
        check_in = MessageRule.objects.get(clinic=self.clinic, name="30 day check-in")
        off = self.client.patch(f"/api/v1/message-rules/{check_in.pk}/", {"enabled": False, "days": 45}, format="json")
        self.assertEqual((off.status_code, off.data["enabled"], off.data["days"], off.data["words"]), (200, False, 45, "Switched off"))
        refused = self.client.patch(f"/api/v1/message-rules/{check_in.pk}/", {"needs_approval": False}, format="json")
        self.assertEqual(refused.status_code, 400)
        half_year = {
            "name": "6 month check-in",
            "trigger": "after_last_visit",
            "days": 180,
            "template": str(self.template("follow_up_90").pk),
        }
        made = self.client.post("/api/v1/message-rules/", half_year, format="json")
        self.assertEqual((made.status_code, made.data["enabled"], made.data["days"]), (201, False, 180))
        self.assertEqual(self.client.post("/api/v1/message-rules/", half_year, format="json").status_code, 400)
        foreign = MessageTemplate.objects.create(clinic=self.other_clinic, name="Other", body="Other clinic's wording")
        self.assertEqual(
            self.client.patch(f"/api/v1/message-rules/{check_in.pk}/", {"template": str(foreign.pk)}, format="json").status_code, 400
        )
        self.assertEqual(
            self.client.post("/api/v1/message-rules/", {**half_year, "name": "Too far", "days": 900}, format="json").status_code, 400
        )
        self.role("admin")
        self.assertEqual(self.client.patch(f"/api/v1/message-rules/{check_in.pk}/", {"enabled": True}, format="json").status_code, 200)
        self.assertEqual(self.client.get("/api/v1/message-templates/").status_code, 200)
        self.assertEqual(self.client.get("/api/v1/messages/").status_code, 403)
        for role in ["reception", "clinician"]:
            self.role(role)
            self.assertEqual(self.client.get("/api/v1/message-rules/").status_code, 200, role)
            self.assertEqual(self.client.patch(f"/api/v1/message-rules/{check_in.pk}/", {"enabled": False}, format="json").status_code, 403)
            self.assertEqual(
                self.client.post("/api/v1/message-templates/", {"name": "Mine", "body": "Hello"}, format="json").status_code, 403
            )
        self.assertTrue(AuditEvent.objects.filter(action="message_rule.update").exists())


class CampaignTests(MessagingTestCase):
    def test_a_campaign_prepares_one_message_for_each_patient_who_agreed(self):
        greeting = self.template("birthday")
        self.agree(self.anita, "greetings")
        self.agree(self.sunita, "greetings")
        body = {"name": "New year greeting", "template": str(greeting.pk), "audience": "everyone"}
        count = self.client.post("/api/v1/message-campaigns/count/", body, format="json").data
        self.assertEqual(count, {"ready": 1, "left_out": 2})
        made = self.client.post("/api/v1/message-campaigns/", body, format="json")
        self.assertEqual((made.status_code, made.data["prepared"], made.data["left_out"]), (201, 1, 2))
        message = Message.objects.get()
        self.assertEqual(
            (message.patient, message.source, message.status, message.title), (self.anita, "campaign", "waiting", "New year greeting")
        )
        self.assertEqual(self.box("waiting")[0]["context"], "Campaign: New year greeting")
        listed = self.client.get("/api/v1/message-campaigns/").data
        self.assertEqual((listed["results"][0]["waiting"], listed["results"][0]["sent"]), (1, 0))
        # Only patients seen lately, when asked.
        self.assertEqual(
            self.client.post("/api/v1/message-campaigns/", {**body, "audience": "seen_6_months"}, format="json").status_code, 400
        )
        self.visit(self.anita, 20)
        self.assertEqual(
            self.client.post("/api/v1/message-campaigns/count/", {**body, "audience": "seen_6_months"}, format="json").data["ready"], 1
        )
        self.assertEqual(self.client.post("/api/v1/message-campaigns/", {**body, "audience": "nobody"}, format="json").status_code, 400)
        self.assertEqual(self.client.post("/api/v1/message-campaigns/", {**body, "name": " "}, format="json").status_code, 400)
        self.role("clinician")
        self.assertEqual(self.client.post("/api/v1/message-campaigns/", body, format="json").status_code, 403)
        self.assertEqual(self.client.get("/api/v1/message-campaigns/").status_code, 200)
