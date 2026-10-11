"""What a patient list row and a patient banner show beyond the patient's own details.

Kept apart from the serializers because it reads across visits and bills, and because who may see
each part differs: the balance is for roles that work with bills, the alert for clinical roles.
"""

import csv
import datetime
import io
from decimal import Decimal

from django.db.models import OuterRef, Subquery

from accounts.access import BILLING_READ, CLINICAL_READ, CLINICAL_WRITE
from accounts.features import feature_on

from .models import Encounter, FamilyLink, PatientConsent, PatientNote, current_consent


def with_visit_dates(queryset):
    """Adds each patient's last visit and the next visit advised at it, for sorting and filtering."""
    latest = Encounter.objects.filter(patient=OuterRef("pk")).order_by("-occurred_at", "-created_at")
    return queryset.annotate(
        last_visit_at=Subquery(latest.values("occurred_at")[:1]), next_advised=Subquery(latest.values("follow_up_date")[:1])
    )


def balances(clinic, patient_ids):
    """{patient id: what they owe} for the patients who owe anything."""
    from billing.models import Invoice

    owed = {}
    invoices = Invoice.objects.filter(clinic=clinic, status=Invoice.Status.ISSUED, patient_id__in=patient_ids).prefetch_related(
        "payments", "credit_notes"
    )
    for invoice in invoices:
        if invoice.balance > 0:
            owed[invoice.patient_id] = owed.get(invoice.patient_id, Decimal("0.00")) + invoice.balance
    return owed


def patients_with_a_balance(clinic):
    from billing.models import Invoice
    from billing.views import STATE_FILTERS, with_figures

    return (
        with_figures(Invoice.objects.filter(clinic=clinic, patient__isnull=False)).filter(STATE_FILTERS["outstanding"]).values("patient_id")
    )


def extras(member, patients):
    """Per patient: last visit, next advised date and, for roles that work with bills, the balance."""
    ids = [patient.pk for patient in patients]
    clinic = member.clinic
    visits = {}
    for encounter in Encounter.objects.filter(patient_id__in=ids).order_by("patient_id", "-occurred_at", "-created_at"):
        visits.setdefault(encounter.patient_id, encounter)
    show_balance = member.role_id in BILLING_READ and feature_on(clinic, "billing")
    owed = balances(clinic, ids) if show_balance else {}
    result = {}
    for patient in patients:
        last = visits.get(patient.pk)
        result[patient.pk] = {
            "last_visit": clinic.local_date(last.occurred_at).isoformat() if last else None,
            "next_advised": last.follow_up_date.isoformat() if last and last.follow_up_date else None,
            **({"balance": str(owed.get(patient.pk, Decimal("0.00")))} if show_balance else {}),
        }
    return result


def consent_data(patient):
    answers = current_consent(patient)
    return {
        kind: (
            {
                "granted": row.granted,
                "at": row.created_at.isoformat(),
                "by": row.recorded_by.get_full_name() or row.recorded_by.username,
                "wording_version": row.wording_version,
            }
            if row
            else None
        )
        for kind, row in answers.items()
    }


def record_consent(patient, user, choices):
    """Write a consent row for each kind whose answer differs from the current one."""
    answers = current_consent(patient)
    for kind in PatientConsent.Kind.values:
        if kind in choices and (answers[kind] is None or answers[kind].granted != choices[kind]):
            # Nothing is written the first time if the answer is simply "no": silence is not consent, and not a refusal either.
            if answers[kind] is None and not choices[kind]:
                continue
            PatientConsent.objects.create(patient=patient, kind=kind, granted=choices[kind], recorded_by=user)


def family_data(patient):
    def name(person):
        return " ".join(part for part in [person.first_name, person.middle_name, person.last_name] if part)

    rows = []
    for link in FamilyLink.objects.filter(patient=patient).select_related("relative"):
        rows.append({"id": str(link.pk), "patient": str(link.relative_id), "name": name(link.relative), "relation": link.relation})
    seen = {row["patient"] for row in rows}
    # A link made from the other person's record is shown here too, without repeating their word for it.
    for link in FamilyLink.objects.filter(relative=patient).select_related("patient"):
        if str(link.patient_id) not in seen:
            rows.append({"id": str(link.pk), "patient": str(link.patient_id), "name": name(link.patient), "relation": ""})
    return rows


def visible_note_kinds(role):
    """Which kinds of note a role reads: everyone the general ones, clinical roles the clinical ones, doctors all."""
    if role in CLINICAL_WRITE:
        return list(PatientNote.Kind.values)
    if role in CLINICAL_READ:
        return [PatientNote.Kind.GENERAL, PatientNote.Kind.CLINICAL]
    return [PatientNote.Kind.GENERAL]


# --- import from a spreadsheet

DATE_FORMATS = ["%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d %b %Y", "%d %B %Y"]
GENDERS = {"f": "female", "female": "female", "m": "male", "male": "male", "o": "other", "other": "other"}
IMPORT_FIELDS = [
    "first_name",
    "middle_name",
    "last_name",
    "date_of_birth",
    "gender",
    "phone",
    "whatsapp_number",
    "email",
    "old_file_number",
    "referred_by",
]


def parse_date(text):
    text = " ".join(str(text or "").split())
    for pattern in DATE_FORMATS:
        try:
            return datetime.datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def clean_import_row(row, today):
    """One spreadsheet row as patient details, and a list of what is wrong with it in plain words."""
    data = {field: " ".join(str(row.get(field) or "").split()) for field in IMPORT_FIELDS}
    problems = []
    if not data["first_name"]:
        problems.append("First name is missing")
    born = parse_date(data["date_of_birth"])
    if not data["date_of_birth"]:
        problems.append("Date of birth is missing")
    elif not born:
        problems.append("Date of birth is not a date we can read")
    elif born > today:
        problems.append("Date of birth is in the future")
    data["date_of_birth"] = born.isoformat() if born else ""
    data["gender"] = GENDERS.get(data["gender"].lower(), "undisclosed")
    for field in ["phone", "whatsapp_number"]:
        if data[field] and not all(char.isdigit() or char in "+ -()" for char in data[field]):
            problems.append("Phone number has letters in it")
            break
    return data, problems


def export_csv(patients):
    """Every patient's details as a spreadsheet, for the owner to keep or move elsewhere."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "Patient ID",
            "First name",
            "Middle name",
            "Last name",
            "Date of birth",
            "Sex",
            "Phone",
            "WhatsApp",
            "Email",
            "Old file number",
            "Referred by",
            "Registered",
            "Archived",
        ]
    )
    for patient in patients:
        codes = [identifier.code for identifier in patient.identifiers.all() if not identifier.revoked_at]
        writer.writerow(
            [
                codes[0] if codes else "",
                *[spreadsheet_safe(value) for value in [patient.first_name, patient.middle_name, patient.last_name]],
                patient.date_of_birth.isoformat() if patient.date_of_birth else "",
                patient.gender,
                spreadsheet_safe(patient.phone),
                spreadsheet_safe(patient.whatsapp_number),
                spreadsheet_safe(patient.email),
                spreadsheet_safe(patient.old_file_number),
                spreadsheet_safe(patient.referred_by),
                patient.created_at.date().isoformat(),
                "yes" if patient.archived_at else "",
            ]
        )
    return buffer.getvalue()


def spreadsheet_safe(text):
    """A spreadsheet treats a cell starting with = + - or @ as a formula; a leading apostrophe makes it plain text."""
    text = str(text or "")
    return f"'{text}" if text and text[0] in "=+-@\t\r" else text
