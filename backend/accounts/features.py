"""Clinic-wide switches: which parts of the application a clinic uses.

A switch that is off hides the screens and makes the server refuse that part's requests, so turning
something off really turns it off. Only the owner changes them.
"""

from rest_framework.exceptions import PermissionDenied

# Name: (label, on by default)
FEATURES = {
    "appointments": ("Appointments", True),
    "billing": ("Billing", True),
    "product_sales": ("Product sales", True),
    "show_gst": ("Show GST on bills", True),
    "messages": ("WhatsApp messages", True),
    "auto_reminders": ("Send reminders without approval", False),
    "library": ("Homeopathy library", True),
    "stock_control": ("Stock control", False),
    "ai_drafting": ("AI drafting", False),
    "two_step": ("Two-step sign-in for owners and doctors", False),
}
# Drawn in the plan but not built yet. They stay off and the server refuses to turn them on.
NOT_BUILT = {"stock_control", "ai_drafting"}


def features_of(clinic):
    """Every switch with its current value: the clinic's choices over the defaults."""
    chosen = clinic.features if isinstance(clinic.features, dict) else {}
    return {name: bool(chosen.get(name, default)) and name not in NOT_BUILT for name, (_, default) in FEATURES.items()}


def feature_on(clinic, name):
    return features_of(clinic)[name]


def require_feature(member, name):
    if not feature_on(member.clinic, name):
        raise PermissionDenied(f"{FEATURES[name][0]} is switched off for this clinic.")
