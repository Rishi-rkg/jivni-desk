"""Reads the library from its files: the shipped layer, with one clinic's own layer laid over it.

Nothing here writes to the shipped layer. See knowledge/README.md for the file format.
"""

import os
import threading
import time
import tomllib
from pathlib import Path

from django.conf import settings

from .text import fold

LIST_FIELDS = ("symptoms", "modalities", "relationships", "notes", "medicines")
RELATIONSHIP_KINDS = ("antidote", "complementary", "similar", "inimical", "follows")
CLINIC_SOURCE = "clinic"
PREFERENCES = "preferences.toml"


def shipped_dir():
    return Path(os.environ.get("KNOWLEDGE_BASE_DIR") or getattr(settings, "KNOWLEDGE_BASE_DIR", settings.BASE_DIR.parent / "knowledge"))


def clinic_dir(clinic_id):
    root = os.environ.get("KNOWLEDGE_CLINIC_DIR") or getattr(settings, "KNOWLEDGE_CLINIC_DIR", Path(settings.MEDIA_ROOT).parent / "library")
    return Path(root) / str(clinic_id)


def read(path):
    with open(path, "rb") as file:
        return tomllib.load(file)


def entry_key(field, entry):
    """What makes two entries the same entry, so a clinic entry can hide a shipped one."""
    if field == "relationships":
        return (fold(entry.get("kind", "")), fold(entry.get("medicine") or entry.get("as_written", "")))
    if field == "medicines":
        return (fold(entry.get("medicine", "")),)
    return (fold(entry.get("text", "")),)


def overlay(shipped, clinic):
    """One remedy or rubric as the clinic sees it: the shipped file with the clinic's differences applied."""
    merged = {key: value for key, value in (shipped or {}).items() if key not in LIST_FIELDS}
    merged["layer"] = "shipped" if shipped else "clinic"
    for key, value in (clinic or {}).items():
        if key == "aliases":
            merged["aliases"] = [*merged.get("aliases", []), *[alias for alias in value if alias not in merged.get("aliases", [])]]
        elif key not in LIST_FIELDS and key != "id":
            merged[key] = value
    for field in LIST_FIELDS:
        entries = [{**entry, "layer": "shipped"} for entry in (shipped or {}).get(field, [])]
        for change in (clinic or {}).get(field, []):
            if change.get("hide"):
                hidden = entry_key(field, change)
                entries = [entry for entry in entries if entry_key(field, entry) != hidden]
            else:
                entries.append({"source": CLINIC_SOURCE, **change, "layer": "clinic"})
        if entries:
            merged[field] = entries
    return merged


class Library:
    """Everything one clinic's library holds, merged and ready to index. Preferences are read separately."""

    def __init__(self, shipped, clinic):
        self.problems = []
        self.sources = self._file(shipped / "sources.toml") or {}
        self.vocabulary = (self._file(shipped / "vocabulary.toml") or {}).get("same", [])
        self.abbreviations = self._file(shipped / "abbreviations.toml") or {}
        self.medicines = self._merge(self._folder(shipped / "medicines"), self._folder(clinic / "medicines"))
        # A rubric file holds either one rubric, or a whole chapter of a repertory as a list.
        single, self.rubric_sets = ({}, {}), []
        for number, (layer, root) in enumerate((("shipped", shipped / "rubrics"), ("clinic", clinic / "rubrics"))):
            for path, data in self._folder(root, deep=True).items():
                if isinstance(data.get("rubrics"), list):
                    self.rubric_sets.append({**data, "layer": layer})
                else:
                    single[number][Path(path).stem] = data
        self.rubrics = self._merge(*single)

    def _file(self, path):
        """A file that cannot be read is reported and skipped; one bad edit must not take the library down."""
        if not path.is_file():
            return None
        try:
            return read(path)
        except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError) as error:
            self.problems.append({"file": f"{path.parent.name}/{path.name}", "problem": str(error)})
            return None

    def _folder(self, root, deep=False):
        found = {}
        if root.is_dir():
            for path in sorted(root.rglob("*.toml") if deep else root.glob("*.toml")):
                data = self._file(path)
                if data is not None:
                    found[path.relative_to(root).as_posix() if deep else path.stem] = data
        return found

    @staticmethod
    def _merge(shipped, clinic):
        merged = {}
        for identifier in sorted({*shipped, *clinic}):
            entry = overlay(shipped.get(identifier), clinic.get(identifier))
            entry["id"] = identifier
            entry.setdefault("name", identifier.replace("-", " ").capitalize())
            merged[identifier] = entry
        return merged

    def source(self, identifier):
        return {"id": identifier, **self.sources.get(identifier, {"title": identifier})}


def signature(*roots):
    """Changes whenever a library file is added, removed or edited. What the library has learned is not part of it."""
    found = []
    for root in roots:
        if root.is_dir():
            for path in root.rglob("*.toml"):
                if path.name != PREFERENCES:
                    status = path.stat()
                    found.append((str(path), status.st_mtime_ns, status.st_size))
    return hash(tuple(sorted(found)))


def _stamp(path):
    try:
        status = path.stat()
        return (status.st_mtime_ns, status.st_size)
    except OSError:
        return None


_cache = {}
_lock = threading.Lock()


def library(clinic_id):
    """The clinic's library, ready to search.

    The files are looked at again at most once every KNOWLEDGE_RECHECK_SECONDS and re-read only if one changed.
    What the library has learned is one small file, checked every time, so a choice counts at once.
    """
    from .search import Index

    shipped, clinic = shipped_dir(), clinic_dir(clinic_id)
    key, now = str(clinic_id), time.monotonic()
    with _lock:
        cached = _cache.get(key)
    if not cached or cached["folders"] != (shipped, clinic) or now - cached["checked"] >= getattr(settings, "KNOWLEDGE_RECHECK_SECONDS", 2):
        current = signature(shipped, clinic)
        if not cached or cached["folders"] != (shipped, clinic) or cached["signature"] != current:
            cached = {"folders": (shipped, clinic), "signature": current, "index": Index(Library(shipped, clinic)), "learned": "unread"}
        cached["checked"] = now
        with _lock:
            _cache[key] = cached
    index = cached["index"]
    learned = _stamp(clinic / PREFERENCES)
    if cached["learned"] != learned:
        preferences = {}
        if learned:
            try:
                preferences = read(clinic / PREFERENCES)
            except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError) as error:
                preferences = {"problem": str(error)}
        index.learn(preferences)
        cached["learned"] = learned
    return index
