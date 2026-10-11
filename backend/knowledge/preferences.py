"""What the library learns from use: which remedy a doctor chose after searching which words.

Kept in the clinic layer as preferences.toml so that a person or an AI assistant can read and correct it.
Only words the library already contains are remembered; what was typed is never stored.
"""

import threading
import tomllib

from . import tomlfmt
from .store import clinic_dir, read

HEADER = """What this clinic's library has learned. Safe to edit or delete; see README.md in the library folder.
[picks.<word>]  how many times each remedy was chosen after searching that word
[pins]          <word> = ["remedy-id", ...] always lists these first for that word, in this order"""

_lock = threading.Lock()


def record_pick(clinic_id, index, query, medicine_id):
    """Count one choice. Returns the words it was counted under."""
    learned = index.learnable_words(query)
    if not learned or medicine_id not in index.library.medicines:
        return []
    path = clinic_dir(clinic_id) / "preferences.toml"
    with _lock:
        # Read the file as it is now, not as the cached index saw it, so no count is lost.
        try:
            current = read(path) if path.is_file() else {}
        except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError):
            # Someone's edit left the file unreadable. Learning waits; their work is not overwritten.
            return []
        picks = {word: dict(counts) for word, counts in current.get("picks", {}).items() if isinstance(counts, dict)}
        for word in learned:
            counts = picks.setdefault(word, {})
            previous = counts.get(medicine_id, 0)
            counts[medicine_id] = (previous if isinstance(previous, int) else 0) + 1
        data = {"picks": dict(sorted(picks.items()))}
        pins = {word: value for word, value in current.get("pins", {}).items() if isinstance(value, list)}
        if pins:
            data["pins"] = pins
        tomlfmt.write(path, data, HEADER)
    return learned
