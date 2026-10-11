"""Users and roles, and the clinic's security settings. For the owner alone.

Giving someone access means sealing the clinic key for their password, which only a person who already
holds the key can do. So an invitation, a password reset and a new recovery key all use the keys the
owner's own session has unlocked.
"""

import datetime
import secrets
import time
import uuid

from django.conf import settings
from django.contrib.auth.validators import UnicodeUsernameValidator
from django.contrib.sessions.models import Session
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from audit.models import record_event
from vault import services as vault
from vault.models import ClinicKey, KeyGrant
from vault.session import ClinicLocked

from . import two_step
from .access import membership
from .features import feature_on
from .models import Membership, Role, TwoStep, User

# Symbols for one-time passwords: none that can be mistaken for another when read aloud or written down.
SYMBOLS = "23456789ABCDEFGHJKMNPQRSTVWXYZ"


def one_time_password():
    """A password to read out or write down once: four groups of four, with no letters that look like digits."""
    return "-".join("".join(secrets.choice(SYMBOLS) for _ in range(4)) for _ in range(4))


def live_sessions():
    """{user id: (how many sessions are signed in, when the latest was last used)}, read from the session table."""
    found = {}
    oldest = time.time() - settings.SESSION_IDLE_SECONDS
    for session in Session.objects.filter(expire_date__gt=timezone.now()).iterator():
        data = session.get_decoded()
        user_id, last = data.get("_auth_user_id"), data.get("last_activity") or data.get("signed_in_at")
        if not user_id or not isinstance(last, int) or last < oldest:
            continue
        count, latest = found.get(user_id, (0, 0))
        found[user_id] = (count + 1, max(latest, last))
    return found


def end_sessions(user_ids, keep=None):
    """Sign these people out wherever they are signed in. `keep` is the session key of the one asking, if it stays."""
    wanted, ended = {str(user_id) for user_id in user_ids}, 0
    for session in Session.objects.all().iterator():
        if session.session_key != keep and session.get_decoded().get("_auth_user_id") in wanted:
            session.delete()
            ended += 1
    return ended


def owner_of(request):
    member = membership(request)
    if member.role_id != "owner":
        record_event(request, "access.denied", clinic=member.clinic, outcome="denied", resource_type="Clinic", resource_id=member.clinic_id)
        raise PermissionDenied("Only the clinic owner can do this.")
    return member


def clinic_keys(request, clinic):
    """The clinic keys this session holds, or None for a clinic that has no key yet."""
    if not ClinicKey.objects.filter(clinic=clinic).exists():
        return None
    try:
        return request.vault.keys(clinic.pk)
    except ClinicLocked:
        raise serializers.ValidationError(
            {"detail": "This session cannot open the clinic's records. Sign out, sign in again, and try once more."}
        ) from None


def owners(clinic):
    return Membership.objects.filter(clinic=clinic, role_id="owner", is_active=True)


def rows(clinic, asking):
    members = list(Membership.objects.filter(clinic=clinic).select_related("user", "role"))
    members.sort(key=lambda member: (not member.is_active, (member.user.get_full_name() or member.user.username).lower()))
    users = [member.user_id for member in members]
    enrolled = set(TwoStep.objects.filter(user_id__in=users, confirmed_at__isnull=False).values_list("user_id", flat=True))
    granted = set(
        KeyGrant.objects.filter(kind=KeyGrant.Kind.USER, revoked_at__isnull=True, clinic_key__clinic=clinic).values_list(
            "user_id", flat=True
        )
    )
    live, asked = live_sessions(), feature_on(clinic, "two_step")
    has_key = ClinicKey.objects.filter(clinic=clinic).exists()
    result = []
    for member in members:
        user = member.user
        count, latest = live.get(str(user.pk), (0, 0))
        last = datetime.datetime.fromtimestamp(latest, tz=datetime.UTC) if latest else user.last_login
        result.append(
            {
                "id": str(user.pk),
                "username": user.username,
                "name": user.get_full_name(),
                "role": member.role_id,
                "is_active": member.is_active,
                "two_step": user.pk in enrolled,
                "two_step_asked": asked and member.role_id in two_step.REQUIRED_ROLES,
                "signed_in": count,
                "last_active": last.isoformat() if last else None,
                # Still using the one-time password they were given.
                "must_change_password": user.must_change_password,
                "can_open_records": not has_key or user.pk in granted,
                "you": user.pk == asking.pk,
            }
        )
    return result


class TeamView(APIView):
    """P55: who works here and as what."""

    def get(self, request):
        member = owner_of(request)
        record_event(request, "team.list", clinic=member.clinic)
        return Response(
            {
                "roles": [{"code": role.code, "label": role.label} for role in Role.objects.all()],
                "results": rows(member.clinic, request.user),
            }
        )

    @sensitive_variables()
    def post(self, request):
        """Invite someone: an account with a one-time password, shown once, that they replace at first sign-in."""
        member = owner_of(request)
        clinic, data = member.clinic, request.data
        username = str(data.get("username", "")).strip()
        name = " ".join(str(data.get("name", "")).split())[:150]
        errors = {}
        try:
            UnicodeUsernameValidator()(username)
            if not 1 <= len(username) <= 150:
                raise ValidationError("Enter a username.")
        except ValidationError:
            errors["username"] = ["Use letters, digits and @ . + - _ only."]
        if not errors and User.objects.filter(username__iexact=username).exists():
            errors["username"] = ["That username is taken."]
        if not name:
            errors["name"] = ["Enter the person's name as it should appear on records."]
        if not Role.objects.filter(pk=data.get("role")).exists():
            errors["role"] = ["Choose a role."]
        if errors:
            raise serializers.ValidationError(errors)
        keys = clinic_keys(request, clinic)
        password = one_time_password()
        with transaction.atomic():
            user = User(username=username, first_name=name, must_change_password=True)
            user.set_password(password)
            user.save()
            Membership.objects.create(clinic=clinic, user=user, role_id=data["role"])
            if keys:
                vault.grant_access(clinic, keys, user, password, granted_by=request.user)
            record_event(request, "team.invite", user, clinic)
        row = next(item for item in rows(clinic, request.user) if item["id"] == str(user.pk))
        # The only time this password is ever shown.
        return Response({**row, "one_time_password": password}, status=201)


class TeamMemberView(APIView):
    def member(self, request, user_id):
        asking = owner_of(request)
        try:
            return asking, Membership.objects.select_related("user", "clinic").get(clinic=asking.clinic, user_id=uuid.UUID(str(user_id)))
        except (Membership.DoesNotExist, ValueError):
            raise serializers.ValidationError("That person is not a member of this clinic.") from None

    def answer(self, request, member, **more):
        row = next(item for item in rows(member.clinic, request.user) if item["id"] == str(member.user_id))
        return Response({**row, **more})

    @sensitive_variables()
    def new_password(self, request, member):
        """Replace someone's password with a one-time one, and seal the clinic key for it. Their two-step is set up again."""
        keys = clinic_keys(request, member.clinic)
        password = one_time_password()
        user = member.user
        user.set_password(password)
        user.must_change_password = True
        user.save()
        two_step.remove(user)
        end_sessions([user.pk])
        if keys:
            vault.grant_access(member.clinic, keys, user, password, granted_by=request.user)
        return password

    @sensitive_variables()
    def patch(self, request, user_id):
        """Change someone's name or role, or switch them off or back on."""
        asking, member = self.member(request, user_id)
        data, clinic, more = request.data, asking.clinic, {}
        own = member.user_id == request.user.pk
        with transaction.atomic():
            if "name" in data:
                name = " ".join(str(data["name"]).split())[:150]
                if not name:
                    raise serializers.ValidationError({"name": ["Enter the person's name."]})
                member.user.first_name, member.user.last_name = name, ""
                member.user.save(update_fields=["first_name", "last_name"])
            if "role" in data and data["role"] != member.role_id:
                if not Role.objects.filter(pk=data["role"]).exists():
                    raise serializers.ValidationError({"role": ["Choose a role."]})
                if own:
                    raise serializers.ValidationError({"role": ["You cannot change your own role. Another owner can."]})
                if member.role_id == "owner" and member.is_active and owners(clinic).count() == 1:
                    raise serializers.ValidationError({"role": ["A clinic needs at least one owner."]})
                member.role_id = data["role"]
                member.save(update_fields=["role"])
                record_event(request, "team.role", member.user, clinic)
            if "is_active" in data and bool(data["is_active"]) != member.is_active:
                if own:
                    raise serializers.ValidationError({"is_active": ["You cannot switch yourself off."]})
                if data["is_active"]:
                    member.is_active = True
                    member.save(update_fields=["is_active"])
                    # Their old password no longer opens anything, so coming back starts with a new one.
                    more["one_time_password"] = self.new_password(request, member)
                    record_event(request, "team.reactivate", member.user, clinic)
                else:
                    if member.role_id == "owner" and owners(clinic).count() == 1:
                        raise serializers.ValidationError({"is_active": ["A clinic needs at least one owner."]})
                    member.is_active = False
                    member.save(update_fields=["is_active"])
                    vault.revoke_access(clinic, member.user)
                    end_sessions([member.user_id])
                    record_event(request, "team.deactivate", member.user, clinic)
            if "name" in data:
                record_event(request, "team.update", member.user, clinic)
        return self.answer(request, member, **more)


class TeamActionView(TeamMemberView):
    """Manage: reset a password, sign someone out everywhere, or take their two-step sign-in off."""

    @sensitive_variables()
    def post(self, request, user_id, action):
        asking, member = self.member(request, user_id)
        clinic, more = asking.clinic, {}
        with transaction.atomic():
            if action == "reset-password":
                if not member.is_active:
                    raise serializers.ValidationError("Switch this person back on first.")
                if member.user_id == request.user.pk:
                    raise serializers.ValidationError("Change your own password in My account.")
                more["one_time_password"] = self.new_password(request, member)
                record_event(request, "team.reset_password", member.user, clinic)
            elif action == "sign-out":
                keep = request.session.session_key if member.user_id == request.user.pk else None
                more["ended"] = end_sessions([member.user_id], keep=keep)
                record_event(request, "team.sign_out", member.user, clinic)
            elif action == "two-step-off":
                two_step.remove(member.user)
                end_sessions([member.user_id], keep=request.session.session_key)
                record_event(request, "team.two_step_off", member.user, clinic)
            else:
                raise serializers.ValidationError("Unknown action.")
        return self.answer(request, member, **more)


class SecurityView(APIView):
    """P59: what the Security page shows. The switch and the lock time are saved through the clinic settings."""

    def get(self, request):
        member = owner_of(request)
        clinic = member.clinic
        recovery = (
            KeyGrant.objects.filter(kind=KeyGrant.Kind.RECOVERY, revoked_at__isnull=True, clinic_key__clinic=clinic)
            .order_by("-created_at")
            .first()
        )
        users = {str(user_id) for user_id in Membership.objects.filter(clinic=clinic).values_list("user_id", flat=True)}
        live = live_sessions()
        return Response(
            {
                "two_step_asked": feature_on(clinic, "two_step"),
                "lock_after_minutes": clinic.lock_after_minutes,
                "recovery_key_created_at": recovery.created_at.isoformat() if recovery else None,
                "sessions": sum(count for user_id, (count, _) in live.items() if user_id in users),
            }
        )


class RecoveryKeyView(APIView):
    @sensitive_variables()
    def post(self, request):
        """W11: make a new recovery key. The old one stops working at once; the new one is shown this one time."""
        member = owner_of(request)
        if not isinstance(request.data.get("password"), str) or not request.user.check_password(request.data["password"]):
            raise serializers.ValidationError({"password": ["That password is not correct."]})
        keys = clinic_keys(request, member.clinic)
        if not keys:
            raise serializers.ValidationError("This clinic has no encryption key yet.")
        try:
            recovery = vault.replace_recovery_key(member.clinic, keys, replaced_by=request.user)
        except vault.VaultError as error:
            raise serializers.ValidationError(str(error)) from None
        record_event(request, "clinic.recovery_key", clinic=member.clinic)
        return Response({"recovery_key": recovery}, status=201)


class SessionsView(APIView):
    def post(self, request):
        """Sign out all: everyone in the clinic, on every device, except the screen this was pressed on."""
        member = owner_of(request)
        users = Membership.objects.filter(clinic=member.clinic).values_list("user_id", flat=True)
        ended = end_sessions(users, keep=request.session.session_key)
        record_event(request, "clinic.sessions_ended", clinic=member.clinic)
        return Response({"ended": ended})
