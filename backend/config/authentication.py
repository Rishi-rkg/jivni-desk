from rest_framework.authentication import SessionAuthentication


class ClinicSessionAuthentication(SessionAuthentication):
    """Session authentication that answers 401, not 403, when nobody is signed in.

    The browser uses the difference to show the lock screen (sign in again and keep
    unsaved work) instead of a permission error.
    """

    def authenticate_header(self, request):
        return "Session"
