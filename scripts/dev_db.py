"""Project-local PostgreSQL for development and tests. No Windows service, no admin rights.

    python scripts/dev_db.py start    create the cluster on first use, then start it
    python scripts/dev_db.py stop
    python scripts/dev_db.py status
    python scripts/dev_db.py test     run the backend suite against it (extra arguments are passed on)

The cluster lives in .tools/pgdata (ignored by git), listens on 127.0.0.1 only, and uses the
POSTGRES_* values from .env. It holds synthetic data only and is not a production database.
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / ".tools" / "pgdata"
LOG = ROOT / ".tools" / "postgres.log"


def read_env():
    path = ROOT / ".env"
    if not path.exists():
        raise SystemExit("No .env found. Run: python scripts/init_env.py")
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def binary(name):
    found = shutil.which(name)
    if found:
        return found
    for base in sorted(Path("C:/Program Files/PostgreSQL").glob("*/bin"), reverse=True):
        candidate = base / f"{name}.exe"
        if candidate.exists():
            return str(candidate)
    raise SystemExit(f"{name} was not found. Install PostgreSQL 16 or add its bin folder to PATH.")


def port(env):
    return env.get("DEV_POSTGRES_PORT", "5432")


def running():
    return subprocess.run([binary("pg_ctl"), "status", "-D", str(DATA)], capture_output=True).returncode == 0


def init(env):
    if (DATA / "PG_VERSION").exists():
        return
    if not env.get("POSTGRES_PASSWORD"):
        raise SystemExit("POSTGRES_PASSWORD is empty in .env. Run: python scripts/init_env.py")
    DATA.parent.mkdir(parents=True, exist_ok=True)
    # The password reaches initdb through a private temporary file, never the command line.
    handle, pwfile = tempfile.mkstemp(text=True)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(env["POSTGRES_PASSWORD"])
        subprocess.run([binary("initdb"), "-D", str(DATA), "-U", env.get("POSTGRES_USER", "clinic"), "--auth=scram-sha-256",
                        f"--pwfile={pwfile}", "-E", "UTF8", "--locale=C"], check=True, stdout=subprocess.DEVNULL)
    finally:
        os.remove(pwfile)
    print("Created a development database cluster in .tools/pgdata.")


def start(env):
    init(env)
    if running():
        print("PostgreSQL is already running.")
        return
    options = f"-c listen_addresses=127.0.0.1 -c port={port(env)}"
    # The server outlives this script, so it must not inherit our output pipes; its messages go to the log file.
    started = subprocess.run([binary("pg_ctl"), "start", "-D", str(DATA), "-l", str(LOG), "-w", "-o", options],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if started.returncode:
        raise SystemExit("PostgreSQL did not start. See .tools/postgres.log.")
    child = connection_env(env)
    name = env.get("POSTGRES_DB", "clinic")
    if not name.replace("_", "").isalnum():
        raise SystemExit("POSTGRES_DB must contain only letters, digits and underscores.")
    exists = subprocess.run([binary("psql"), "-d", "postgres", "-tAc", f"SELECT 1 FROM pg_database WHERE datname = '{name}'"],
                            env=child, capture_output=True, text=True).stdout.strip()
    if exists != "1":
        subprocess.run([binary("createdb"), name], env=child, check=True)
    print(f"PostgreSQL is running on 127.0.0.1:{port(env)}.")


def stop():
    if running():
        subprocess.run([binary("pg_ctl"), "stop", "-D", str(DATA), "-m", "fast", "-w"], check=True, stdout=subprocess.DEVNULL)
    print("PostgreSQL is stopped.")


def connection_env(env):
    child = dict(os.environ)
    child.update({"PGHOST": "127.0.0.1", "PGPORT": port(env), "PGUSER": env.get("POSTGRES_USER", "clinic"), "PGPASSWORD": env.get("POSTGRES_PASSWORD", "")})
    return child


def django_env(env):
    child = dict(os.environ)
    child.update(env)
    child.update({"POSTGRES_HOST": "127.0.0.1", "POSTGRES_PORT": port(env), "TEST_DATABASE": "postgres"})
    return child


def test(env, extra):
    start(env)
    # --noinput: a test database left behind by an interrupted run is replaced without asking.
    command = [sys.executable, "manage.py", "test", "--settings=config.test_settings", "--noinput", *extra]
    raise SystemExit(subprocess.run(command, cwd=ROOT / "backend", env=django_env(env)).returncode)


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    env = read_env()
    if action == "start":
        start(env)
    elif action == "stop":
        stop()
    elif action == "status":
        print("PostgreSQL is running." if (DATA / "PG_VERSION").exists() and running() else "PostgreSQL is not running.")
    elif action == "test":
        test(env, sys.argv[2:])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
