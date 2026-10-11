# PyInstaller recipe for the installed Jivni application. Build from the repository root:
#
#     cd frontend && npm run build
#     pyinstaller packaging/jivni.spec --noconfirm
#
# The result is the folder dist/Jivni with a Jivni program inside. PyInstaller builds for the system it
# runs on, so the Mac, Linux and arm64 versions are built by running this same recipe on those systems.
#
# The application's own code is shipped as plain source and imported from the bundle folder at run time,
# which keeps Django's discovery of apps, migrations and commands working exactly as in development.
import ast
import os
from pathlib import Path

# PyInstaller's Django support imports the project settings while it analyses the program. These values
# exist only for that moment during the build; the installed application makes its own (see launcher.py).
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
os.environ.setdefault("DJANGO_SECRET_KEY", "build-time-placeholder-never-used-by-a-running-application")
os.environ.setdefault("DATA_PROTECTION_MODE", "development-only")
os.environ.setdefault("DATABASE_ENGINE", "sqlite")

from PyInstaller.utils.hooks import collect_all

root = Path(SPECPATH).parent
backend = root / "backend"
OWN = ["accounts", "audit", "config", "modules", "records", "vault"]
THIRD_PARTY = ["django", "rest_framework", "whitenoise", "waitress", "argon2", "cryptography", "PIL", "tzdata"]

if not (root / "frontend" / "dist" / "index.html").is_file():
    raise SystemExit("Build the frontend first: cd frontend && npm run build")

datas = [(str(root / "frontend" / "dist"), "frontend_dist")]
imported = set()
for package in OWN:
    for source in (backend / package).rglob("*.py"):
        relative = source.relative_to(backend)
        if "tests" in relative.parts:
            continue
        datas.append((str(source), str(relative.parent)))
        # Standard-library and third-party modules our source uses, which PyInstaller cannot see in data files.
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                imported.add(node.module)

binaries, hiddenimports = [], sorted(name for name in imported if name.split(".")[0] not in OWN)
for name in THIRD_PARTY:
    more_datas, more_binaries, more_hidden = collect_all(name)
    datas += more_datas
    binaries += more_binaries
    hiddenimports += more_hidden

analysis = Analysis(
    [str(backend / "launcher.py")],
    pathex=[],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    excludes=OWN + ["psycopg", "psycopg_binary", "tkinter", "pytest"],
)
pyz = PYZ(analysis.pure)
exe = EXE(pyz, analysis.scripts, [], exclude_binaries=True, name="Jivni", console=True)
COLLECT(exe, analysis.binaries, analysis.datas, name="Jivni")
