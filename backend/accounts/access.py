from rest_framework.exceptions import PermissionDenied

from .models import Membership

CLINICAL_READ = {"owner", "clinician", "assistant"}
CLINICAL_WRITE = {"owner", "clinician"}
DEMOGRAPHIC_WRITE = {"owner", "clinician", "assistant", "reception"}
CLINIC_ADMIN = {"owner", "admin"}
# Bills hold no clinical text (prescribed medicines are one unnamed line), so the front desk works with them.
BILLING_READ = {"owner", "clinician", "reception", "billing"}
BILLING_WRITE = {"owner", "clinician", "reception", "billing"}
# Voids, credit notes and refunds undo money that was recorded: owner or billing only.
BILLING_CORRECT = {"owner", "billing"}
PRICE_LIST_READ = BILLING_READ | {"admin"}
PRICE_LIST_WRITE = {"owner", "admin"}
DAY_END = {"owner", "billing"}


def membership(request):
    clinic_id = request.session.get("clinic_id")
    result = (
        Membership.objects.select_related("clinic", "role").filter(user=request.user, clinic_id=clinic_id, is_active=True).first()
        if clinic_id
        else None
    )
    if not result:
        raise PermissionDenied("Select an active clinic before accessing records.")
    return result


def require_role(request, allowed):
    member = membership(request)
    if member.role_id not in allowed:
        raise PermissionDenied("Your clinic role does not allow this action.")
    return member
