import hashlib
import json

from django.conf import settings
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.debug import sensitive_variables
from django.views.decorators.http import require_GET, require_POST

from audit.models import record_event
from vault import backup as vault_backup
from vault import services as vault
from vault import session as vault_session

from .models import Membership


def session_data(request, unlocked=None):
    """`unlocked` is passed at sign-in, before the browser holds the unlock cookie; later requests ask the vault."""

    def records_unlocked(clinic_id):
        return clinic_id in unlocked if unlocked is not None else request.vault.is_unlocked(clinic_id)

    memberships = Membership.objects.filter(user=request.user, is_active=True).select_related("clinic", "role")
    return {
        "user": {"id": str(request.user.id), "username": request.user.username, "name": request.user.get_full_name()},
        "clinic_id": request.session.get("clinic_id"),
        "memberships": [
            {
                "clinic_id": str(m.clinic_id),
                "clinic_name": m.clinic.name,
                "role": m.role_id,
                "time_zone": m.clinic.time_zone,
                "records_unlocked": records_unlocked(m.clinic_id),
            }
            for m in memberships
        ],
        "idle_timeout_seconds": settings.SESSION_IDLE_SECONDS,
        "csrf_token": get_token(request),
    }


@require_GET
def csrf(request):
    return JsonResponse({"csrf_token": get_token(request)})


@require_GET
def me(request):
    if not request.user.is_authenticated:
        return JsonResponse({"detail": "Authentication required."}, status=401)
    return JsonResponse(session_data(request))


def payload(request):
    try:
        result = json.loads(request.body)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, UnicodeDecodeError):
        return None


@require_POST
@csrf_protect
@transaction.atomic
@sensitive_variables()
def sign_in(request):
    data = payload(request)
    if data is None or not isinstance(data.get("username"), str) or not isinstance(data.get("password"), str):
        return JsonResponse({"detail": "Provide username and password."}, status=400)
    username = data["username"][:150]
    # A deployment must use a shared cache and edge rate limits. Never trust X-Forwarded-For here.
    key = "login:" + hashlib.sha256((request.META.get("REMOTE_ADDR", "") + ":" + username).encode()).hexdigest()
    failures = cache.get(key, 0)
    if failures >= 5:
        return JsonResponse({"detail": "Too many login attempts. Try again in 5 minutes."}, status=429)
    user = authenticate(request, username=username, password=data["password"])
    if not user:
        cache.set(key, failures + 1, 300)
        # Record the attempt against every clinic the named account belongs to, so an owner can
        # see it. One query whether or not the username exists.
        known = list(Membership.objects.filter(user__username=username).select_related("clinic"))
        for member in known or [None]:
            record_event(
                request,
                "auth.login_failed",
                clinic=member.clinic if member else None,
                outcome="failed",
                resource_type="User" if member else "",
                resource_id=member.user_id if member else None,
            )
        return JsonResponse({"detail": "Invalid username or password."}, status=401)
    memberships = list(Membership.objects.filter(user=user, is_active=True).select_related("clinic"))
    if not memberships:
        former = list(Membership.objects.filter(user=user).select_related("clinic"))
        for member in former or [None]:
            record_event(request, "auth.login_denied", clinic=member.clinic if member else None, outcome="denied", actor=user)
        return JsonResponse({"detail": "No active clinic membership."}, status=403)
    cache.delete(key)
    login(request, user)
    request.session["clinic_id"] = str(memberships[0].clinic_id)
    record_event(request, "auth.login", clinic=memberships[0].clinic)
    # The password is used once more here to open the clinic keys sealed for this person, then discarded.
    unlocked = vault.unlock(user, data["password"])
    vault_backup.ensure_backup_keys(unlocked)
    response = JsonResponse(session_data(request, unlocked))
    vault_session.start(request, response, unlocked)
    return response


@require_POST
@csrf_protect
@transaction.atomic
def sign_out(request):
    if request.user.is_authenticated:
        member = (
            Membership.objects.filter(user=request.user, clinic_id=request.session.get("clinic_id"), is_active=True)
            .select_related("clinic")
            .first()
        )
        record_event(request, "auth.logout", clinic=member.clinic if member else None)
    logout(request)
    response = JsonResponse({"detail": "Logged out.", "csrf_token": get_token(request)})
    vault_session.end(request, response)
    return response


@require_POST
@csrf_protect
@transaction.atomic
def select_clinic(request):
    if not request.user.is_authenticated:
        return JsonResponse({"detail": "Authentication required."}, status=401)
    data = payload(request)
    if not data or not isinstance(data.get("clinic_id"), str):
        return JsonResponse({"detail": "Provide clinic_id."}, status=400)
    try:
        member = Membership.objects.filter(user=request.user, clinic_id=data["clinic_id"], is_active=True).select_related("clinic").first()
    except (ValueError, ValidationError):
        member = None
    if not member:
        return JsonResponse({"detail": "Invalid clinic membership."}, status=403)
    request.session["clinic_id"] = str(member.clinic_id)
    record_event(request, "auth.select_clinic", clinic=member.clinic)
    return JsonResponse(session_data(request))


@require_POST
@csrf_protect
@sensitive_variables()
def change_password(request):
    """Change the signed-in person's password and re-seal their clinic keys for it."""
    if not request.user.is_authenticated:
        return JsonResponse({"detail": "Authentication required."}, status=401)
    data = payload(request)
    if not data or not isinstance(data.get("current_password"), str) or not isinstance(data.get("new_password"), str):
        return JsonResponse({"detail": "Provide current_password and new_password."}, status=400)
    user = request.user
    member = (
        Membership.objects.filter(user=user, clinic_id=request.session.get("clinic_id"), is_active=True).select_related("clinic").first()
    )
    clinic = member.clinic if member else None
    if not user.check_password(data["current_password"]):
        record_event(request, "auth.password_change_failed", clinic=clinic, outcome="failed")
        return JsonResponse({"detail": "The current password is not correct."}, status=400)
    try:
        validate_password(data["new_password"], user)
    except ValidationError as error:
        return JsonResponse({"new_password": error.messages}, status=400)
    with transaction.atomic():
        vault.change_password(user, data["current_password"], data["new_password"])
        user.set_password(data["new_password"])
        user.save()
        record_event(request, "auth.password_changed", clinic=clinic)
    # Keeps this session signed in; other sessions of this user are signed out by Django.
    update_session_auth_hash(request, user)
    return JsonResponse({"detail": "Password changed.", "csrf_token": get_token(request)})
