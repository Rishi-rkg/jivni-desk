import hashlib
import json
import time

from django.conf import settings
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.validators import UnicodeUsernameValidator
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.debug import sensitive_variables
from django.views.decorators.http import require_GET, require_POST

from audit.models import record_event
from knowledge import store as library_store
from vault import backup as vault_backup
from vault import services as vault
from vault import session as vault_session

from . import totp, two_step
from .features import features_of
from .models import Clinic, Installation, Membership, Role, User, valid_time_zone


def session_data(request, unlocked=None):
    """`unlocked` is passed at sign-in, before the browser holds the unlock cookie; later requests ask the vault."""

    def records_unlocked(clinic_id):
        return clinic_id in unlocked if unlocked is not None else request.vault.is_unlocked(clinic_id)

    memberships = list(Membership.objects.filter(user=request.user, is_active=True).select_related("clinic", "role"))
    clinic_id = request.session.get("clinic_id")
    active = next((m.clinic for m in memberships if str(m.clinic_id) == str(clinic_id)), None)
    return {
        "user": {
            "id": str(request.user.id),
            "username": request.user.username,
            "name": request.user.get_full_name(),
            "two_step": two_step.enrolled(request.user),
        },
        # What this person must finish before the workspace opens: their own password, two-step sign-in.
        "pending": request.session.get("pending") or [],
        "clinic_id": clinic_id,
        "memberships": [
            {
                "clinic_id": str(m.clinic_id),
                "clinic_name": m.clinic.name,
                "role": m.role_id,
                "time_zone": m.clinic.time_zone,
                "currency": m.clinic.currency,
                "features": features_of(m.clinic),
                "records_unlocked": records_unlocked(m.clinic_id),
            }
            for m in memberships
        ],
        "idle_timeout_seconds": idle_seconds(request, active),
        "csrf_token": get_token(request),
    }


def pending_steps(user):
    """What a person has to finish straight after signing in. The server refuses everything else until they have."""
    steps = []
    if user.must_change_password:
        steps.append("password")
    if two_step.required_for(user) and not two_step.enrolled(user):
        steps.append("two_step")
    return steps


def idle_seconds(request, clinic):
    """How long the screen may sit untouched before it locks: the clinic's choice, sooner on a shared computer."""
    seconds = settings.SESSION_IDLE_SECONDS
    if clinic:
        seconds = min(seconds, clinic.lock_after_minutes * 60)
    if request.session.get("shared_computer"):
        seconds = min(seconds, 120)
    # The server ends an untouched session by the same clock (config/middleware.py).
    if request.session.get("idle_seconds") != seconds:
        request.session["idle_seconds"] = seconds
    return seconds


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
    # Unlocking the screen of a session that is still alive is not a new sign-in, so no code is asked for again.
    resumed = request.user.is_authenticated and request.user.pk == user.pk
    if two_step.enrolled(user) and not resumed:
        code = data.get("code")
        if not isinstance(code, str) or not code.strip():
            return JsonResponse({"detail": "Enter the 6-digit code from your authenticator app.", "two_step": True}, status=401)
        if not two_step.check(user, data["password"], code):
            cache.set(key, failures + 1, 300)
            record_event(request, "auth.two_step_failed", clinic=memberships[0].clinic, outcome="failed", actor=user)
            return JsonResponse({"detail": "That code is not right. Check the app and try again.", "two_step": True}, status=401)
    cache.delete(key)
    login(request, user)
    request.session["clinic_id"] = str(memberships[0].clinic_id)
    request.session["signed_in_at"] = int(time.time())
    request.session["pending"] = pending_steps(user)
    if data.get("shared_computer") is True:
        request.session["shared_computer"] = True
    record_event(request, "auth.login", clinic=memberships[0].clinic)
    # The password is used once more here to open the clinic keys sealed for this person, then discarded.
    unlocked = vault.unlock(user, data["password"])
    vault_backup.ensure_backup_keys(unlocked)
    response = JsonResponse(session_data(request, unlocked))
    vault_session.start(request, response, unlocked)
    library_store.warm(memberships[0].clinic_id)
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
        two_step.reseal(user, data["current_password"], data["new_password"])
        user.set_password(data["new_password"])
        # A password the person chose themselves ends the one-time password they were given.
        user.must_change_password = False
        user.save()
        record_event(request, "auth.password_changed", clinic=clinic)
    # Keeps this session signed in; other sessions of this user are signed out by Django.
    update_session_auth_hash(request, user)
    request.session["pending"] = pending_steps(user)
    return JsonResponse({"detail": "Password changed.", "csrf_token": get_token(request), "pending": request.session["pending"]})


@require_POST
@csrf_protect
@transaction.atomic
def account(request):
    """Change the signed-in person's own display name."""
    if not request.user.is_authenticated:
        return JsonResponse({"detail": "Authentication required."}, status=401)
    data = payload(request)
    name = data.get("full_name") if data else None
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 150:
        return JsonResponse({"full_name": ["Enter your name as it should appear on records."]}, status=400)
    request.user.first_name, request.user.last_name = name.strip(), ""
    request.user.save(update_fields=["first_name", "last_name"])
    member = (
        Membership.objects.filter(user=request.user, clinic_id=request.session.get("clinic_id"), is_active=True)
        .select_related("clinic")
        .first()
    )
    record_event(request, "auth.account_update", clinic=member.clinic if member else None)
    return JsonResponse(session_data(request))


@csrf_protect
@sensitive_variables()
def setup(request):
    """First-time setup: create the clinic and its owner, turn on encryption, and show the recovery key once.

    Open to whoever reaches a brand-new installation first, and closed for good once a clinic exists.
    """
    needed = not Clinic.objects.exists()
    if request.method == "GET":
        return JsonResponse({"needed": needed})
    if request.method != "POST":
        return JsonResponse({"detail": "Method not allowed."}, status=405)
    if not needed:
        return JsonResponse({"detail": "This installation is already set up. Sign in instead."}, status=409)
    data = payload(request) or {}
    text = {
        key: data.get(key).strip() if isinstance(data.get(key), str) else ""
        for key in ["clinic_name", "username", "full_name", "time_zone"]
    }
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    errors = {}
    if not 1 <= len(text["clinic_name"]) <= 200:
        errors["clinic_name"] = ["Enter the clinic's name."]
    user = User(username=text["username"][:150], first_name=text["full_name"][:150])
    try:
        UnicodeUsernameValidator()(text["username"])
        if not 1 <= len(text["username"]) <= 150:
            raise ValidationError("Enter a username.")
    except ValidationError:
        errors["username"] = ["Enter a username using letters, digits and @ . + - _ only."]
    try:
        validate_password(password, user)
    except ValidationError as error:
        errors["password"] = error.messages
    time_zone = text["time_zone"] or "Asia/Kolkata"
    try:
        valid_time_zone(time_zone)
    except ValidationError as error:
        errors["time_zone"] = error.messages
    if errors:
        return JsonResponse(errors, status=400)
    try:
        with transaction.atomic():
            Installation.objects.create()
            user.set_password(password)
            user.save()
            clinic = Clinic.objects.create(name=text["clinic_name"], time_zone=time_zone, currency="INR")
            Membership.objects.create(clinic=clinic, user=user, role=Role.objects.get(pk="owner"))
            # Encryption is not optional: the clinic's key is created with the clinic.
            recovery = vault.create_clinic_key(clinic, user, password)
    except IntegrityError:
        return JsonResponse({"detail": "This installation is already set up. Sign in instead."}, status=409)
    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    request.session["clinic_id"] = str(clinic.pk)
    request.session["signed_in_at"] = int(time.time())
    record_event(request, "clinic.setup", clinic, clinic)
    unlocked = vault.unlock(user, password)
    # The recovery key is returned exactly once, here. It is not stored and cannot be shown again.
    response = JsonResponse({**session_data(request, unlocked), "recovery_key": recovery}, status=201)
    vault_session.start(request, response, unlocked)
    library_store.warm(clinic.pk)
    return response


def _password_request(request):
    """The signed-in person and the fields they sent, once their password has been typed again and is right."""
    if not request.user.is_authenticated:
        return None, JsonResponse({"detail": "Authentication required."}, status=401)
    data = payload(request)
    if not data or not isinstance(data.get("password"), str):
        return None, JsonResponse({"password": ["Enter your password."]}, status=400)
    if not request.user.check_password(data["password"]):
        return None, JsonResponse({"password": ["That password is not correct."]}, status=400)
    return data, None


def _active_clinic(request):
    member = (
        Membership.objects.filter(user=request.user, clinic_id=request.session.get("clinic_id"), is_active=True)
        .select_related("clinic")
        .first()
    )
    return member.clinic if member else None


@require_POST
@csrf_protect
@sensitive_variables()
def two_step_start(request):
    """Begin setting up two-step sign-in. Answers once with the secret for the authenticator app."""
    data, refused = _password_request(request)
    if refused:
        return refused
    if two_step.enrolled(request.user):
        return JsonResponse({"detail": "Two-step sign-in is already on. Turn it off first to set it up again."}, status=400)
    secret = two_step.start(request.user, data["password"])
    return JsonResponse({"secret": secret, "uri": totp.uri(secret, request.user.username)})


@require_POST
@csrf_protect
@sensitive_variables()
def two_step_confirm(request):
    """Finish setting up: a code typed back proves the app holds the secret. From now on sign-in asks for one."""
    data, refused = _password_request(request)
    if refused:
        return refused
    if not two_step.check(request.user, data["password"], data.get("code", ""), confirming=True):
        return JsonResponse({"code": ["That code is not right. Check the app and try again."]}, status=400)
    request.session["pending"] = pending_steps(request.user)
    record_event(request, "auth.two_step_on", clinic=_active_clinic(request))
    return JsonResponse(session_data(request))


@require_POST
@csrf_protect
@sensitive_variables()
def two_step_off(request):
    data, refused = _password_request(request)
    if refused:
        return refused
    if two_step.required_for(request.user):
        return JsonResponse({"detail": "Your clinic asks owners and doctors to use two-step sign-in."}, status=400)
    two_step.remove(request.user)
    record_event(request, "auth.two_step_off", clinic=_active_clinic(request))
    return JsonResponse(session_data(request))


RECOVERY_REFUSED = "That username and recovery key do not open a clinic here."


@require_POST
@csrf_protect
@sensitive_variables()
def recover(request):
    """Every password is lost: the recovery key gives an owner a new password. The key is then replaced.

    Open without signing in, so it answers the same way whichever part was wrong, and allows few attempts.
    """
    data = payload(request) or {}
    username, typed, password = (data.get(name) for name in ("username", "recovery_key", "new_password"))
    if not all(isinstance(value, str) and value for value in (username, typed, password)):
        return JsonResponse({"detail": "Enter the owner's username, the recovery key and a new password."}, status=400)
    key = "recover:" + hashlib.sha256(request.META.get("REMOTE_ADDR", "").encode()).hexdigest()
    failures = cache.get(key, 0)
    if failures >= 5:
        return JsonResponse({"detail": "Too many attempts. Try again in 15 minutes."}, status=429)
    owners = list(
        Membership.objects.filter(user__username=username[:150], role_id="owner", is_active=True).select_related("user", "clinic")
    )
    opened = []
    for member in owners:
        try:
            opened.append((member.clinic, vault.recover(member.clinic, typed)))
        except vault.VaultError:
            continue
    if not opened:
        cache.set(key, failures + 1, 900)
        for member in owners or [None]:
            record_event(
                request,
                "auth.recovery_failed",
                clinic=member.clinic if member else None,
                outcome="failed",
                actor=member.user if member else None,
            )
        return JsonResponse({"detail": RECOVERY_REFUSED}, status=400)
    user = owners[0].user
    try:
        validate_password(password, user)
    except ValidationError as error:
        return JsonResponse({"new_password": error.messages}, status=400)
    from .team import end_sessions

    fresh = []
    with transaction.atomic():
        user.set_password(password)
        user.must_change_password = False
        user.save()
        # Whoever set up the authenticator app may be the person who lost everything: it is set up again.
        two_step.remove(user)
        end_sessions([user.pk])
        for clinic, keys in opened:
            vault.grant_access(clinic, keys, user, password, granted_by=user)
            # A recovery key that has been typed in is spent.
            fresh.append({"clinic": clinic.name, "recovery_key": vault.replace_recovery_key(clinic, keys, replaced_by=user)})
            record_event(request, "auth.recovery_used", clinic=clinic, actor=user)
    cache.delete(key)
    return JsonResponse({"detail": "Password reset. Sign in with the new password.", "recovery_keys": fresh})
