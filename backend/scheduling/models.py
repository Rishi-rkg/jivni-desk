"""The work week (when the clinic sees patients) and appointments.

Working days are kept one row per date, because the owner sets them by tapping dates in a month: a
holiday is simply a date that is switched off. A month nobody has set up yet follows the usual week.
"""

import datetime

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from records.models import StableRecord

SLOT_MINUTES = 15
# Until a month is set up in Work week: Monday to Saturday, morning and evening.
USUAL_SESSIONS = [["09:30", "13:00"], ["17:00", "20:00"]]
DURATIONS = {"first": 45, "follow_up": 15, "medicine_only": 15}


def parse_time(text):
    try:
        return datetime.time.fromisoformat(str(text))
    except ValueError:
        return None


def clean_sessions(value):
    """A day's sessions as [["09:30", "13:00"], ...]: at most three, in order, each ending after it starts."""
    if not isinstance(value, list) or len(value) > 3:
        raise ValidationError("A day has at most three sessions.")
    cleaned, previous = [], None
    for session in value:
        if not isinstance(session, list | tuple) or len(session) != 2:
            raise ValidationError("A session has a start and an end time.")
        start, end = parse_time(session[0]), parse_time(session[1])
        if not start or not end or end <= start or (previous and start < previous):
            raise ValidationError("Each session must end after it starts, and sessions must not overlap.")
        cleaned.append([start.strftime("%H:%M"), end.strftime("%H:%M")])
        previous = end
    return cleaned


class WorkDay(StableRecord):
    """One date of a month that was set up in Work week: its sessions, or none when the clinic is closed that day."""

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    day = models.DateField()
    sessions = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["day"]
        constraints = [models.UniqueConstraint(fields=["clinic", "day"], name="unique_work_day")]

    def clean(self):
        self.sessions = clean_sessions(self.sessions)


class WorkTemplate(StableRecord):
    """A saved work week, such as "Regular week" or "Short weekend". A clinic keeps at most four."""

    MAX = 4

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    slot = models.PositiveSmallIntegerField()
    name = models.CharField(max_length=60)
    # {"weekday": sessions, "saturday": sessions, "sunday": sessions}; an empty list means closed that day.
    hours = models.JSONField()

    class Meta:
        ordering = ["slot"]
        constraints = [models.UniqueConstraint(fields=["clinic", "slot"], name="unique_work_template_slot")]

    def clean(self):
        if not 1 <= self.slot <= self.MAX:
            raise ValidationError({"slot": f"A clinic keeps at most {self.MAX} saved work weeks."})
        if not isinstance(self.hours, dict) or set(self.hours) != {"weekday", "saturday", "sunday"}:
            raise ValidationError({"hours": "Give the times for weekdays, Saturday and Sunday."})
        self.hours = {part: clean_sessions(sessions) for part, sessions in self.hours.items()}


def sessions_on(clinic, day, known=None):
    """The sessions the clinic works on a date. `known` is {date: sessions} for the date's month, if already fetched."""
    if known is None:
        first = day.replace(day=1)
        last = (first + datetime.timedelta(days=32)).replace(day=1)
        known = dict(WorkDay.objects.filter(clinic=clinic, day__gte=first, day__lt=last).values_list("day", "sessions"))
    if known:
        return known.get(day, [])
    # Nobody has set this month up: the usual week, with Sunday closed.
    return [] if day.weekday() == 6 else USUAL_SESSIONS


def slot_times(sessions):
    """Every bookable start time in a day's sessions, a quarter of an hour apart."""
    times = []
    for start, end in sessions:
        moment = datetime.datetime.combine(datetime.date.min, parse_time(start))
        finish = datetime.datetime.combine(datetime.date.min, parse_time(end))
        while moment < finish:
            times.append(moment.time())
            moment += datetime.timedelta(minutes=SLOT_MINUTES)
    return times


class Appointment(StableRecord):
    class Status(models.TextChoices):
        BOOKED = "booked", "Booked"
        ARRIVED = "arrived", "Arrived"
        SEEN = "seen", "Seen"
        CANCELLED = "cancelled", "Cancelled"
        NO_SHOW = "no_show", "No-show"

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    patient = models.ForeignKey("records.Patient", on_delete=models.PROTECT, related_name="appointments")
    doctor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    day = models.DateField()
    # Empty for a walk-in: someone who came without a booked time.
    time = models.TimeField(null=True, blank=True)
    duration_minutes = models.PositiveSmallIntegerField(default=15)
    visit_type = models.CharField(
        max_length=14,
        default="follow_up",
        choices=[("first", "First visit"), ("follow_up", "Follow-up"), ("medicine_only", "Medicine only")],
    )
    # A few plain words for the front desk, such as "Collect medicine". Never anything clinical.
    reason = models.CharField(max_length=120, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.BOOKED)
    walk_in = models.BooleanField(default=False)
    arrived_at = models.DateTimeField(null=True, blank=True)
    seen_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancel_reason = models.CharField(max_length=200, blank=True)
    # Whether the patient should get a reminder the day before, and when one was prepared.
    remind = models.BooleanField(default=False)
    reminder_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["day", "time", "created_at"]
        indexes = [models.Index(fields=["clinic", "day"])]

    def clean(self):
        if self.patient_id and self.patient.clinic_id != self.clinic_id:
            raise ValidationError({"patient": "Invalid patient."})
        if not self.walk_in and self.time is None:
            raise ValidationError({"time": "Choose a time, or add the patient as a walk-in."})

    @property
    def active(self):
        return self.status not in {self.Status.CANCELLED, self.Status.NO_SHOW}

    def minutes(self):
        """(start, end) as minutes since midnight, for checking that two appointments do not overlap."""
        start = self.time.hour * 60 + self.time.minute
        return start, start + self.duration_minutes
