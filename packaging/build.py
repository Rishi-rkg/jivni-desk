"""Build Jivni for the system this runs on: the program, a portable archive and an installer.

    python packaging/build.py                 everything
    python packaging/build.py --skip-frontend reuse frontend/dist as it is

Results go to dist/release:

    Windows   Jivni-<version>-windows-<arch>-portable.zip      unzip anywhere, run Jivni.exe
              Jivni-<version>-windows-<arch>-setup.exe         installer (needs Inno Setup 6)
    macOS     Jivni-<version>-macos-<arch>-portable.zip        Jivni.app, drag anywhere
              Jivni-<version>-macos-<arch>.dmg                 disk image with the Applications shortcut
    Linux     Jivni-<version>-linux-<arch>-portable.tar.gz     unpack anywhere, run ./Jivni
              jivni_<version>_<arch>.deb                       installer for Debian and Ubuntu

A portable build keeps the clinic's data in a "Jivni-Data" folder beside the program (it carries a
portable.txt marker), so it can live on a USB drive. An installed build keeps data in the user's own
application-data folder. PyInstaller builds only for the system and processor it runs on, so each
row above has to be built on that kind of machine.
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
RELEASE = DIST / "release"
ICONS = ROOT / "packaging" / "icons"
PORTABLE_NOTE = (
    "This is the portable version of Jivni.\n\n"
    "Because this file is here, Jivni keeps the clinic's records in the Jivni-Data folder beside the program,\n"
    "not in the computer's own application folders. Move the whole folder together.\n"
    "Delete this file to make Jivni use the computer's application-data folder instead.\n"
)


def version():
    for line in (ROOT / "backend" / "launcher.py").read_text(encoding="utf-8").splitlines():
        if line.startswith("VERSION = "):
            return line.split('"')[1]
    raise SystemExit("VERSION not found in backend/launcher.py")


def arch():
    machine = platform.machine().lower()
    return {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine, machine)


def run(command, **options):
    print("+", " ".join(str(part) for part in command), flush=True)
    subprocess.run(command, check=True, **options)


def build_frontend():
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    run([npm, "ci", "--no-audit", "--no-fund"], cwd=ROOT / "frontend")
    run([npm, "run", "build"], cwd=ROOT / "frontend")


def build_program():
    run([sys.executable, "-m", "PyInstaller", str(ROOT / "packaging" / "jivni.spec"), "--noconfirm", "--log-level", "WARN"], cwd=ROOT)


def zip_folder(source, target, top, extra=None):
    """Zip `source` under the folder name `top`, keeping executable permissions; `extra` maps names to text."""
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                archive.write(path, Path(top) / path.relative_to(source))
        for name, text in (extra or {}).items():
            archive.writestr(f"{top}/{name}", text)


def windows(release_name):
    program = DIST / "Jivni"
    zip_folder(program, RELEASE / f"{release_name}-portable.zip", "Jivni", {"portable.txt": PORTABLE_NOTE})
    compilers = [
        shutil.which("ISCC"),
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Inno Setup 6" / "ISCC.exe",
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Inno Setup 6" / "ISCC.exe",
    ]
    compiler = next((str(path) for path in compilers if path and Path(path).is_file()), None)
    if not compiler:
        print("Inno Setup 6 was not found, so no installer was built. The portable zip is ready.")
        return
    run([compiler, "/Qp", f"/DAppVersion={version()}", f"/DArch={arch()}", str(ROOT / "packaging" / "windows" / "jivni.iss")])


def macos(release_name):
    app = DIST / "Jivni.app"
    # ditto keeps the application's signatures, links and permissions intact, which a plain zip does not.
    run(["ditto", "-c", "-k", "--keepParent", str(app), str(RELEASE / f"{release_name}-portable.zip")])
    stage = DIST / "dmg"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir()
    run(["ditto", str(app), str(stage / "Jivni.app")])
    os.symlink("/Applications", stage / "Applications")
    image = RELEASE / f"{release_name}.dmg"
    image.unlink(missing_ok=True)
    run(["hdiutil", "create", "-volname", "Jivni", "-srcfolder", str(stage), "-ov", "-format", "UDZO", str(image)])
    shutil.rmtree(stage, ignore_errors=True)


def linux(release_name):
    program = DIST / "Jivni"
    with tarfile.open(RELEASE / f"{release_name}-portable.tar.gz", "w:gz") as archive:
        archive.add(program, arcname="Jivni")
        note = DIST / "portable.txt"
        note.write_text(PORTABLE_NOTE, encoding="utf-8")
        archive.add(note, arcname="Jivni/portable.txt")
        note.unlink()
    if not shutil.which("dpkg-deb"):
        print("dpkg-deb was not found, so no .deb installer was built. The portable archive is ready.")
        return
    deb_arch = {"x64": "amd64", "arm64": "arm64"}[arch()]
    stage = DIST / "deb"
    shutil.rmtree(stage, ignore_errors=True)
    shutil.copytree(program, stage / "opt" / "jivni", symlinks=True)
    (stage / "usr" / "bin").mkdir(parents=True)
    os.symlink("/opt/jivni/Jivni", stage / "usr" / "bin" / "jivni")
    applications = stage / "usr" / "share" / "applications"
    applications.mkdir(parents=True)
    shutil.copy(ROOT / "packaging" / "linux" / "jivni.desktop", applications / "jivni.desktop")
    icons = stage / "usr" / "share" / "icons" / "hicolor" / "256x256" / "apps"
    icons.mkdir(parents=True)
    shutil.copy(ICONS / "jivni-256.png", icons / "jivni.png")
    control = stage / "DEBIAN"
    control.mkdir()
    (control / "control").write_text(
        f"Package: jivni\nVersion: {version()}\nSection: misc\nPriority: optional\nArchitecture: {deb_arch}\n"
        "Maintainer: Jivni <support@jivni.invalid>\n"
        "Recommends: gir1.2-ayatanaappindicator3-0.1\n"
        "Description: Jivni clinic workspace\n"
        " Patient records, visits, prescriptions and encrypted backups for a small clinic.\n"
        " Runs on this computer only and keeps its data in the user's own folder.\n",
        encoding="utf-8",
    )
    run(["dpkg-deb", "--build", "--root-owner-group", str(stage), str(RELEASE / f"jivni_{version()}_{deb_arch}.deb")])
    shutil.rmtree(stage, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--skip-frontend", action="store_true")
    parser.add_argument("--skip-program", action="store_true", help="Package the program already in dist/.")
    options = parser.parse_args()
    if not options.skip_frontend:
        build_frontend()
    if not options.skip_program:
        build_program()
    RELEASE.mkdir(parents=True, exist_ok=True)
    system = {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")
    {"windows": windows, "macos": macos, "linux": linux}[system](f"Jivni-{version()}-{system}-{arch()}")
    print("\nBuilt:")
    for path in sorted(RELEASE.iterdir()):
        print(f"  {path.name}  ({path.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
