"""Reads the library from its files: the shipped layer, with one clinic's own layer laid over it.

Nothing here writes to the shipped layer. See knowledge/README.md for the file format.
"""

import os
import threading
import tomllib
from pathlib import Path

from django.conf import settings

from .text import fold

LIST_FIELDS = ("symptoms", "modalities", "relationships", "notes", "medicines")
RELATIONSHIP_KINDS = ("antidote", "complementary", "similar", "inimical", "follows")
CLINIC_SOURCE = "clinic"


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
    """Everything one clinic's library holds, merged and ready to search."""

    def __init__(self, shipped, clinic):
        self.problems = []
        self.sources = self._file(shipped / "sources.toml") or {}
        self.vocabulary = (self._file(shipped / "vocabulary.toml") or {}).get("same", [])
        self.medicines = self._folder(shipped, clinic, "medicines")
        self.rubrics = self._folder(shipped, clinic, "rubrics")
        self.preferences = self._file(clinic / "preferences.toml") or {}

    def _file(self, path):
        """A file that cannot be read is reported and skipped; one bad edit must not take the library down."""
        if not path.is_file():
            return None
        try:
            return read(path)
        except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError) as error:
            self.problems.append({"file": f"{path.parent.name}/{path.name}", "problem": str(error)})
            return None

    def _folder(self, shipped, clinic, name):
        files = {}
        for layer, root in (("shipped", shipped / name), ("clinic", clinic / name)):
            if root.is_dir():
                for path in sorted(root.glob("*.toml")):
                    files.setdefault(path.stem, {})[layer] = self._file(path)
        merged = {}
        for identifier, layers in files.items():
            if not layers.get("shipped") and not layers.get("clinic"):
                continue
            entry = overlay(layers.get("shipped"), layers.get("clinic"))
            entry["id"] = identifier
            entry.setdefault("name", identifier.replace("-", " ").capitalize())
            merged[identifier] = entry
        return merged

    def source(self, identifier):
        return {"id": identifier, **self.sources.get(identifier, {"title": identifier})}


def signature(*roots):
    """Changes whenever a library file is added, removed or edited."""
    found = []
    for root in roots:
        if root.is_dir():
            for path in root.rglob("*.toml"):
                status = path.stat()
                found.append((str(path), status.st_mtime_ns, status.st_size))
    return hash(tuple(sorted(found)))


_cache = {}
_lock = threading.Lock()


def library(clinic_id):
    """The clinic's library, re-read only when a file has changed."""
    from .search import Index

    shipped, clinic = shipped_dir(), clinic_dir(clinic_id)
    current = signature(shipped, clinic)
    with _lock:
        cached = _cache.get(str(clinic_id))
        if cached and cached[0] == current:
            return cached[1]
    index = Index(Library(shipped, clinic))
    with _lock:
        _cache[str(clinic_id)] = (current, index)
    return index
