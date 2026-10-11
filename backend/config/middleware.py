import time
import uuid

from django.conf import settings
from django.contrib.auth import logout


class PrivateResponseMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.path.startswith("/api/"):
            response["Cache-Control"] = "no-store, private"
            response["Referrer-Policy"] = "no-referrer"
        return response


class RequestIdMiddleware:
    """Give every request an ID that audit events and the response both carry."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.request_id = uuid.uuid4()
        response = self.get_response(request)
        response["X-Request-ID"] = str(request.request_id)
        return response


class IdleTimeoutMiddleware:
    """End a session that has made no request for SESSION_IDLE_SECONDS."""

    def __init__(self, get_response):
        self.get_response = get_response

    @staticmethod
    def allowed(request):
        """The clinic's own lock time when it is shorter, with a minute's grace so the screen locks first."""
        chosen = request.session.get("idle_seconds")
        if isinstance(chosen, int) and chosen > 0:
            return min(settings.SESSION_IDLE_SECONDS, chosen + 60)
        return settings.SESSION_IDLE_SECONDS

    def __call__(self, request):
        if request.user.is_authenticated:
            now = int(time.time())
            last = request.session.get("last_activity")
            if isinstance(last, int) and now - last > self.allowed(request):
                from accounts.models import Membership
                from audit.models import record_event

                member = (
                    Membership.objects.filter(user=request.user, clinic_id=request.session.get("clinic_id"))
                    .select_related("clinic")
                    .first()
                )
                record_event(request, "auth.idle_timeout", clinic=member.clinic if member else None)
                logout(request)
            elif not isinstance(last, int) or now - last >= 60:
                # Written at most once a minute so ordinary reads do not rewrite the session.
                request.session["last_activity"] = now
        return self.get_response(request)


class SignInStepsMiddleware:
    """Until someone has chosen their own password and set up two-step sign-in where it is asked, nothing else answers.

    The steps themselves live under /api/v1/auth/. Without this the screens that ask for them would be decoration.
    """

    OPEN = "/api/v1/auth/"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.user.is_authenticated and request.path.startswith("/api/") and not request.path.startswith(self.OPEN):
            pending = request.session.get("pending")
            if pending:
                from django.http import JsonResponse

                return JsonResponse({"detail": "Finish signing in first.", "pending": pending}, status=403)
        return self.get_response(request)
