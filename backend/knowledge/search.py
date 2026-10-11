"""Search over one clinic's library, held in memory.

A result always says why it is there: which parts of the query it matches, the lines that match and where
each line comes from. There is no percentage, because the data does not support one.
"""

import re
from bisect import bisect_left
from collections import defaultdict

from .store import RELATIONSHIP_KINDS
from .text import fold, stem, stems, words

SHORTCUTS = {
    "anti": "antidote",
    "antidote": "antidote",
    "antidotes": "antidote",
    "comp": "complementary",
    "complementary": "complementary",
    "sim": "similar",
    "similar": "similar",
    "inim": "inimical",
    "inimical": "inimical",
}
SHORTCUT = re.compile(r"^\s*([a-z]+)\s*\+\s*(.*)$", re.I)
MAX_PARTS = 8
LINES_SHOWN = 3


def brief(medicine):
    return {"id": medicine["id"], "name": medicine["name"], "abbreviation": medicine.get("abbreviation", "")}


class Index:
    def __init__(self, library):
        self.library = library
        self.lines = []
        self.postings = defaultdict(set)
        for medicine in library.medicines.values():
            for entry in medicine.get("symptoms", []):
                self._add(medicine["id"], "symptom", entry.get("section", ""), entry, entry.get("text", ""))
            for entry in medicine.get("modalities", []):
                if entry.get("kind") in ("worse", "better"):
                    self._add(medicine["id"], "modality", entry["kind"].capitalize(), entry, f"{entry['kind']} {entry.get('text', '')}")
        for rubric in library.rubrics.values():
            searched = " ".join([rubric["name"], *rubric.get("synonyms", [])])
            for entry in rubric.get("medicines", []):
                if entry.get("medicine") in library.medicines:
                    shown = {**entry, "text": rubric["name"], "rubric": rubric["id"]}
                    self._add(entry["medicine"], "rubric", rubric.get("chapter", "Rubric"), shown, searched)
        self.vocabulary = sorted(self.postings)

        self.same = defaultdict(set)
        for group in library.vocabulary:
            group_stems = {stem(fold(word)) for word in group if " " not in word.strip()}
            for item in group_stems:
                self.same[item] |= group_stems

        self.names = []
        for medicine in library.medicines.values():
            labels = [medicine["name"], medicine["id"].replace("-", " "), medicine.get("abbreviation", ""), *medicine.get("aliases", [])]
            self.names.append((medicine["id"], [fold(label).strip(" .") for label in labels if label]))

        self.picks = defaultdict(lambda: defaultdict(int))
        for word, counts in library.preferences.get("picks", {}).items():
            if isinstance(counts, dict):
                for medicine, count in counts.items():
                    if isinstance(count, int) and not isinstance(count, bool):
                        self.picks[stem(fold(word))][medicine] += count
        self.pins = {}
        for word, medicines in library.preferences.get("pins", {}).items():
            if isinstance(medicines, list):
                self.pins[stem(fold(word))] = [medicine for medicine in medicines if isinstance(medicine, str)]

    def _add(self, medicine, kind, section, entry, searched):
        number = len(self.lines)
        self.lines.append(
            {
                "medicine": medicine,
                "kind": kind,
                "section": section,
                "text": entry.get("text", ""),
                "grade": entry.get("grade", 1) if isinstance(entry.get("grade", 1), int) else 1,
                "source": entry.get("source", ""),
                "layer": entry.get("layer", "shipped"),
            }
        )
        for item in set(stems(f"{section} {searched}")):
            self.postings[item].add(number)

    def knows(self, word):
        """Whether a typed word is already a word of the library."""
        return stem(fold(word)) in self.postings

    def _lines_for(self, part_stems):
        found = None
        for item in part_stems:
            candidates = {item, *self.same.get(item, ())}
            if len(item) >= 3:
                # What is typed may be the start of a word: "naus" finds nausea.
                position = bisect_left(self.vocabulary, item)
                while position < len(self.vocabulary) and self.vocabulary[position].startswith(item):
                    candidates.add(self.vocabulary[position])
                    position += 1
            lines = set().union(*(self.postings.get(candidate, ()) for candidate in candidates))
            found = lines if found is None else found & lines
            if not found:
                return set()
        return found or set()

    def find_medicines(self, text, limit=8):
        """Remedies whose name, alias or abbreviation starts with what was typed."""
        typed = fold(text).strip(" .")
        if len(typed) < 2:
            return []
        scored = []
        for identifier, labels in self.names:
            ranks = [
                0 if label == typed else 1 if label.startswith(typed) else 2
                for label in labels
                if label.startswith(typed) or f" {typed}" in label
            ]
            if ranks:
                scored.append((min(ranks), self.library.medicines[identifier]["name"], identifier))
        return [brief(self.library.medicines[identifier]) for _, _, identifier in sorted(scored)[:limit]]

    def related(self, medicine_id, kind=None):
        """A remedy's relationships, each with whether the other remedy has an entry to open."""
        medicine = self.library.medicines[medicine_id]
        found = []
        for entry in medicine.get("relationships", []):
            if kind and entry.get("kind") != kind:
                continue
            other = self.library.medicines.get(entry.get("medicine", ""))
            found.append(
                {
                    "kind": entry.get("kind", ""),
                    "medicine": entry.get("medicine", ""),
                    "name": other["name"] if other else entry.get("name") or entry.get("as_written", ""),
                    "in_library": bool(other),
                    "note": entry.get("note", ""),
                    "source": entry.get("source", ""),
                    "layer": entry.get("layer", "shipped"),
                }
            )
        return found

    def detail(self, medicine_id):
        medicine = self.library.medicines[medicine_id]
        relationships = self.related(medicine_id)
        # The same statements read from the other side: remedies whose own entries name this one.
        named_by = [
            {"kind": entry.get("kind", ""), **brief(other), "source": entry.get("source", "")}
            for other in self.library.medicines.values()
            for entry in other.get("relationships", [])
            if entry.get("medicine") == medicine_id and other["id"] != medicine_id
        ]
        used = {entry.get("source", "") for field in ("symptoms", "modalities", "notes") for entry in medicine.get(field, [])}
        used |= {entry["source"] for entry in [*relationships, *named_by]}
        return {
            **brief(medicine),
            "aliases": medicine.get("aliases", []),
            "layer": medicine.get("layer", "shipped"),
            "symptoms": medicine.get("symptoms", []),
            "modalities": medicine.get("modalities", []),
            "notes": medicine.get("notes", []),
            "relationships": relationships,
            "named_by": named_by,
            "sources": {identifier: self.library.source(identifier) for identifier in sorted(used) if identifier},
        }

    def search(self, query, limit=20):
        query = str(query or "")[:300]
        response = {"shortcut": None, "medicines": [], "parts": [], "results": [], "total": 0, "sources": {}}
        used_sources = set()

        shortcut = SHORTCUT.match(query)
        if shortcut and shortcut.group(1).lower() in SHORTCUTS:
            kind = SHORTCUTS[shortcut.group(1).lower()]
            candidates = self.find_medicines(shortcut.group(2))
            response["shortcut"] = {"kind": kind, "of": candidates[0] if candidates else None, "items": [], "others": candidates[1:]}
            if candidates:
                response["shortcut"]["items"] = self.related(candidates[0]["id"], kind)
                used_sources |= {item["source"] for item in response["shortcut"]["items"]}
            response["sources"] = {identifier: self.library.source(identifier) for identifier in sorted(used_sources) if identifier}
            return response

        parts = [part.strip() for part in re.split(r"[+,\n]", query) if part.strip()][:MAX_PARTS]
        parts = [(part, stems(part)) for part in parts]
        parts = [(part, part_stems) for part, part_stems in parts if part_stems]
        response["parts"] = [part for part, _ in parts]
        if len(parts) == 1:
            response["medicines"] = self.find_medicines(parts[0][0])

        matched = defaultdict(dict)
        for position, (_, part_stems) in enumerate(parts):
            for number in self._lines_for(part_stems):
                matched[self.lines[number]["medicine"]].setdefault(position, []).append(self.lines[number])

        query_stems = {item for _, part_stems in parts for item in part_stems}
        ranked = []
        for identifier, by_part in matched.items():
            medicine = self.library.medicines[identifier]
            chosen = sum(self.picks[item].get(identifier, 0) for item in query_stems if item in self.picks)
            pinned = min((self.pins[item].index(identifier) for item in query_stems if identifier in self.pins.get(item, [])), default=None)
            grades = sum(max(line["grade"] for line in lines) for lines in by_part.values())
            count = sum(len(lines) for lines in by_part.values())
            key = (-len(by_part), pinned is None, pinned or 0, -chosen, -grades, -count, medicine["name"])
            ranked.append((key, identifier, by_part, chosen, pinned is not None))
        ranked.sort(key=lambda item: item[0])
        response["total"] = len(ranked)

        for _, identifier, by_part, chosen, pinned in ranked[:limit]:
            shown = []
            for position, lines in sorted(by_part.items()):
                lines.sort(key=lambda line: (-line["grade"], line["kind"] != "rubric", len(line["text"])))
                used_sources |= {line["source"] for line in lines[:LINES_SHOWN]}
                shown.append(
                    {
                        "part": parts[position][0],
                        "count": len(lines),
                        "lines": [{k: v for k, v in line.items() if k != "medicine"} for line in lines[:LINES_SHOWN]],
                    }
                )
            response["results"].append(
                {
                    **brief(self.library.medicines[identifier]),
                    "matched": shown,
                    "missing": [part for position, (part, _) in enumerate(parts) if position not in by_part],
                    "chosen": chosen,
                    "pinned": pinned,
                }
            )
        response["sources"] = {identifier: self.library.source(identifier) for identifier in sorted(used_sources) if identifier}
        return response

    def learnable_words(self, query):
        """The words of a query that may be remembered: only ones the library itself already contains."""
        query = str(query or "")[:300]
        if (shortcut := SHORTCUT.match(query)) and shortcut.group(1).lower() in SHORTCUTS:
            return []
        return sorted({word for word in words(query) if self.knows(word)})


__all__ = ["RELATIONSHIP_KINDS", "Index"]
