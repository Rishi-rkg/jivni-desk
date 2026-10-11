"""Search over one clinic's library, held in memory.

A result always says why it is there: which parts of the query it matches, the lines that match and where
each line comes from. There is no percentage, because the data does not support one.
"""

import re
from array import array
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
RUBRIC, LINE = 0, 1


def brief(medicine):
    return {"id": medicine["id"], "name": medicine["name"], "abbreviation": medicine.get("abbreviation", "")}


def short(abbreviation):
    return fold(abbreviation).strip().strip(".").replace(" ", "")


class Index:
    def __init__(self, library):
        self.library = library
        self.preference_problem = ""
        self.picks, self.pins = {}, {}

        # Lines of the remedies' own entries: symptoms and what makes them worse or better.
        self.lines = []
        self.line_postings = defaultdict(list)
        for medicine in library.medicines.values():
            for entry in medicine.get("symptoms", []):
                self._add_line(medicine["id"], "symptom", entry.get("section", ""), entry, entry.get("text", ""))
            for entry in medicine.get("modalities", []):
                if entry.get("kind") in ("worse", "better"):
                    self._add_line(
                        medicine["id"], "modality", entry["kind"].capitalize(), entry, f"{entry['kind']} {entry.get('text', '')}"
                    )

        # Rubrics. A repertory has tens of thousands, so each is kept as a name and a packed list of
        # (remedy, grade) rather than as one record per remedy.
        self.medicine_ids = list(library.medicines)
        number_of = {identifier: number for number, identifier in enumerate(self.medicine_ids)}
        by_abbreviation = {short(medicine.get("abbreviation", "")): medicine["id"] for medicine in library.medicines.values()}
        self.rubric_names, self.rubric_remedies, self.rubric_origin = [], [], []
        self.origins = []
        self.rubric_postings = defaultdict(list)
        self.unknown_remedies = 0

        def add_rubric(name, searched, chapter, graded, origin):
            packed = array("H")
            for identifier, grade in graded:
                if identifier in number_of:
                    packed.append(number_of[identifier] * 4 + min(max(grade, 1), 3))
                else:
                    self.unknown_remedies += 1
            if not packed:
                return
            number = len(self.rubric_names)
            self.rubric_names.append(name)
            self.rubric_remedies.append(packed)
            self.rubric_origin.append(origin)
            for item in set(stems(f"{chapter} {searched}")):
                self.rubric_postings[item].append(number)

        for rubric in library.rubrics.values():
            graded = [
                (entry.get("medicine", ""), entry.get("grade", 1) if isinstance(entry.get("grade", 1), int) else 1)
                for entry in rubric.get("medicines", [])
            ]
            # A single rubric may cite a different source for each remedy; the first is shown.
            source = next((entry.get("source", "") for entry in rubric.get("medicines", [])), "")
            self.origins.append((rubric.get("chapter", "Rubric"), source, rubric.get("layer", "shipped")))
            add_rubric(
                rubric["name"],
                " ".join([rubric["name"], *rubric.get("synonyms", [])]),
                rubric.get("chapter", ""),
                graded,
                len(self.origins) - 1,
            )
        for group in library.rubric_sets:
            source, chapter = str(group.get("source", "")), str(group.get("chapter", "Rubric"))
            meaning = library.abbreviations.get(source, {})
            self.origins.append((chapter, source, group["layer"]))
            origin = len(self.origins) - 1
            for rubric in group["rubrics"]:
                if not isinstance(rubric, dict) or not rubric.get("name"):
                    continue
                graded = []
                for grade in (3, 2, 1):
                    for written in rubric.get(f"g{grade}", []):
                        key = short(written)
                        graded.append((meaning.get(key) or (written if written in number_of else by_abbreviation.get(key, "")), grade))
                add_rubric(rubric["name"], " ".join([rubric["name"], *rubric.get("synonyms", [])]), chapter, graded, origin)

        self.vocabulary = sorted({*self.line_postings, *self.rubric_postings})
        self.same = defaultdict(set)
        for group in library.vocabulary:
            group_stems = {stem(fold(word)) for word in group if " " not in word.strip()}
            for item in group_stems:
                self.same[item] |= group_stems

        self.names = []
        for medicine in library.medicines.values():
            labels = [medicine["name"], medicine["id"].replace("-", " "), medicine.get("abbreviation", ""), *medicine.get("aliases", [])]
            self.names.append((medicine["id"], [fold(label).strip(" .") for label in labels if label]))

    def _add_line(self, medicine, kind, section, entry, searched):
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
            self.line_postings[item].append(number)

    def learn(self, preferences):
        """Take in what the clinic's preferences file says. Called whenever that file changes."""
        self.preference_problem = str(preferences.get("problem", "")) if isinstance(preferences.get("problem"), str) else ""
        picks = defaultdict(lambda: defaultdict(int))
        for word, counts in preferences.get("picks", {}).items() if isinstance(preferences.get("picks"), dict) else ():
            if isinstance(counts, dict):
                for medicine, count in counts.items():
                    if isinstance(count, int) and not isinstance(count, bool):
                        picks[stem(fold(word))][medicine] += count
        pins = {}
        for word, medicines in preferences.get("pins", {}).items() if isinstance(preferences.get("pins"), dict) else ():
            if isinstance(medicines, list):
                pins[stem(fold(word))] = [medicine for medicine in medicines if isinstance(medicine, str)]
        self.picks, self.pins = {word: dict(counts) for word, counts in picks.items()}, pins

    def knows(self, word):
        """Whether a typed word is already a word of the library."""
        item = stem(fold(word))
        return item in self.line_postings or item in self.rubric_postings

    def _expand(self, item):
        candidates = {item, *self.same.get(item, ())}
        if len(item) >= 3:
            # What is typed may be the start of a word: "naus" finds nausea.
            position = bisect_left(self.vocabulary, item)
            while position < len(self.vocabulary) and self.vocabulary[position].startswith(item):
                candidates.add(self.vocabulary[position])
                position += 1
        return candidates

    def _matching(self, part_stems, postings):
        found = None
        for item in part_stems:
            numbers = set().union(*(postings.get(candidate, ()) for candidate in self._expand(item)))
            found = numbers if found is None else found & numbers
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

    def _shown(self, reference):
        grade, kind, number = reference
        if kind == LINE:
            return {key: value for key, value in self.lines[number].items() if key != "medicine"}
        chapter, source, layer = self.origins[self.rubric_origin[number]]
        return {"kind": "rubric", "section": chapter, "text": self.rubric_names[number], "grade": grade, "source": source, "layer": layer}

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

        # For each remedy and each part of the query: the lines and rubrics that are the reason, as
        # (grade, kind, number), turned into readable lines only for what is finally shown.
        matched = defaultdict(dict)
        for position, (_, part_stems) in enumerate(parts):
            for number in self._matching(part_stems, self.line_postings):
                line = self.lines[number]
                matched[line["medicine"]].setdefault(position, []).append((line["grade"], LINE, number))
            for number in self._matching(part_stems, self.rubric_postings):
                for packed in self.rubric_remedies[number]:
                    matched[self.medicine_ids[packed >> 2]].setdefault(position, []).append((packed & 3, RUBRIC, number))

        query_stems = {item for _, part_stems in parts for item in part_stems}
        ranked = []
        for identifier, by_part in matched.items():
            chosen = sum(self.picks[item].get(identifier, 0) for item in query_stems if item in self.picks)
            pinned = min((self.pins[item].index(identifier) for item in query_stems if identifier in self.pins.get(item, [])), default=None)
            grades = sum(max(reference[0] for reference in references) for references in by_part.values())
            count = sum(len(references) for references in by_part.values())
            key = (-len(by_part), pinned is None, pinned or 0, -chosen, -grades, -count, self.library.medicines[identifier]["name"])
            ranked.append((key, identifier, by_part, chosen, pinned is not None))
        ranked.sort(key=lambda item: item[0])
        response["total"] = len(ranked)

        for _, identifier, by_part, chosen, pinned in ranked[:limit]:
            shown = []
            for position, references in sorted(by_part.items()):
                # Strongest first; at the same grade a rubric before a sentence, and the shorter rubric first.
                references.sort(
                    key=lambda reference: (
                        -reference[0],
                        reference[1],
                        len(self.rubric_names[reference[2]]) if reference[1] == RUBRIC else 0,
                    )
                )
                lines = [self._shown(reference) for reference in references[:LINES_SHOWN]]
                used_sources |= {line["source"] for line in lines}
                shown.append({"part": parts[position][0], "count": len(references), "lines": lines})
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
