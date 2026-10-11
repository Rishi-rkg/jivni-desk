import getpass
import os


def secret(prompt, env_name):
    """Read a password or key from a prompt, or from an environment variable for scripted setup. Never echoed."""
    return os.environ.get(env_name) or getpass.getpass(prompt)


RECOVERY_NOTICE = """
CLINIC RECOVERY KEY

    {key}

Write this down and keep it somewhere safe and offline, such as a physical safe.
It is the only way back into the clinic's records if every password is lost.
It is shown once and is not stored anywhere. Anyone who has it can open the records.
"""
