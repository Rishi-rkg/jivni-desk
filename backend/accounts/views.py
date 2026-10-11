import hashlib
import json

from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_POST

from audit.models import record_event

from .models import Membership


def session_data(request):
    memberships = Membership.objects.filter(user=request.user, is_active=True).select_related("clinic", "role")
    return {
        "user": {"id": str(request.user.id), "username": request.user.username, "name": request.user.get_full_name()},
        "clinic_id": request.session.get("clinic_id"),
        "memberships": [
            {"clinic_id": str(m.clinic_id), "clinic_name": m.clinic.name, "role": m.role_id, "time_zone": m.clinic.time_zone}
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
    return JsonResponse(session_data(request))


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
    return JsonResponse({"detail": "Logged out.", "csrf_token": get_token(request)})


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
