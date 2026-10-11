"""Imports remedies from William Boericke's Pocket Manual of Homoeopathic Materia Medica (9th edition, 1927).

The text is in the public domain. It is read from the transcription at homeoint.org, one page per
remedy, and written as one library file per remedy. Nothing is paraphrased: every symptom line is a
sentence of the source, and whatever the parser cannot classify is kept verbatim as a note.

    cd backend
    ../.venv/Scripts/python -m knowledge.importers.boericke --cache SOME_FOLDER            # the seed list
    ../.venv/Scripts/python -m knowledge.importers.boericke --cache SOME_FOLDER ARN BELL   # chosen remedies

Pages are fetched once into the cache folder, one a second, so a re-run does not ask the site again.
"""

import argparse
import datetime
import html
import re
import time
import urllib.request
from pathlib import Path

from knowledge import tomlfmt
from knowledge.text import fold, slug

SOURCE_ID = "boericke-mm-9"
BASE_URL = "http://www.homeoint.org/books/boericmm/"
SEED = (
    "ACON APIS ARN ARS BELL BRY CALC CAMPH CARB-V CAUST CHAM CHIN COLOC FERR-P GELS GRAPH HEP HYPER IGN IP "
    "KALI-BI LACH LED LYC MERC NAT-M NUX-V PHOS PULS RHUS-T SEP SIL STAPH SULPH THUJ"
).split()

# How the book shortens names inside its Relationship paragraphs, where that differs from its own index.
SHORT_FORMS = {
    "rhus": "RHUS-T",
    "nux": "NUX-V",
    "ipec": "IP",
    "ipecac": "IP",
    "merc": "MERC",
    "calc": "CALC",
    "ars": "ARS",
    "hepar": "HEP",
    "china": "CHIN",
    "cinch": "CHIN",
    "carbo": "CARB-V",
    "carbo veg": "CARB-V",
    "nat mur": "NAT-M",
    "kali bich": "KALI-BI",
    "kali bichr": "KALI-BI",
    "ferr phos": "FERR-P",
    "colocy": "COLOC",
    "cimicif": "CIMIC",
    "arsenic": "ARS",
    "bellad": "BELL",
    "calcar": "CALC",
    "phos": "PHOS",
    "phosph": "PHOS",
    "ham": "HAM",
    "verat": "VERAT",
    "verat alb": "VERAT",
    "kali phos": "KALI-P",
    "lycop": "LYC",
    "puls": "PULS",
    "sulph": "SULPH",
}
RELATIONSHIP_LABELS = {
    "antidotes": "antidote",
    "antidote": "antidote",
    "complementary": "complementary",
    "compare": "similar",
    "inimical": "inimical",
    "incompatible": "inimical",
}
SECTION = re.compile(r'<font color="#ff0000">\s*<b>\s*(?:<p[^>]*>)?\s*([^<]{2,60}?)\.\s*--\s*</b>', re.I)
EMPHASIS_OPEN, EMPHASIS_CLOSE, SECTION_MARK, ASIDE = chr(0x27E6), chr(0x27E7), chr(1), chr(2)
LABELS = "|".join(sorted(RELATIONSHIP_LABELS, key=len, reverse=True))


def fetch(path, cache):
    target = Path(cache) / path.replace("/", "_")
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(BASE_URL + path, timeout=30) as response:  # noqa: S310 (fixed http address)
            target.write_bytes(response.read())
        time.sleep(1)
    return target.read_bytes().decode("cp1252", errors="replace")


def plain(markup):
    markup = re.sub(r"<[^>]+>", " ", markup)
    return re.sub(r"\s+", " ", html.unescape(markup).replace("\xa0", " ")).strip()


def sentence_case(name):
    name = re.sub(r"\s+", " ", name).strip().lower()
    return name[:1].upper() + name[1:]


def remedy_index(cache):
    """Every remedy in the book: its code, its page and its name as the book's own list gives them."""
    page = fetch("remedies.htm", cache)
    found = {}
    for href, code, rest in re.findall(r'<a[^>]*href="([a-z]/[^"]+)"[^>]*>([^<]+)</a>\s*-+&gt;\s*(.*?)<br>', page, re.S | re.I):
        full = plain(rest)
        name = re.split(r"\s+-\s+|\(", full)[0].strip(" -,")
        found[code.strip().upper()] = {"page": href, "name": sentence_case(name), "id": slug(name), "listed_as": full}
    return found


class Resolver:
    """Turns a name as the book writes it ("Camph", "Rhus") into a remedy of the book, or gives up."""

    def __init__(self, index):
        self.index = index
        self.by_code = {fold(code).replace("-", " "): code for code in index}
        self.names = {fold(entry["name"]): code for code, entry in index.items()}

    def code(self, written):
        key = re.sub(r"[^a-z0-9 ]+", " ", fold(written))
        key = re.sub(r"\s+", " ", key).strip()
        if not key:
            return None
        if key in SHORT_FORMS:
            return SHORT_FORMS[key]
        if key in self.by_code:
            return self.by_code[key]
        if key in self.names:
            return self.names[key]
        if len(key) < 4:
            return None
        matches = {code for name, code in self.names.items() if name.startswith(key)}
        return matches.pop() if len(matches) == 1 else None


def split_sentences(text):
    parts = re.split(rf"(?<=[.!?])\s+(?=[A-Z{EMPHASIS_OPEN}(])", text)
    merged = []
    for part in parts:
        # A cross-reference such as "( Ranunc; Cimicif )." belongs to the sentence before it.
        if merged and part.lstrip(EMPHASIS_OPEN).startswith("("):
            merged[-1] += " " + part
        else:
            merged.append(part)
    return merged


def clean(text):
    text = text.replace(EMPHASIS_OPEN, "").replace(EMPHASIS_CLOSE, "")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\(\s+", "(", text)
    text = re.sub(r"\s+([).,;:])", r"\1", text)
    return text.strip(" ;")


def lines_of(text):
    for sentence in split_sentences(text):
        cleaned = clean(sentence)
        if len(cleaned) > 2:
            yield {"text": cleaned, "grade": 2 if EMPHASIS_OPEN in sentence else 1}


def modalities(text):
    """ "Worse, least touch; motion. Better, lying down." becomes one entry per circumstance."""
    found, kind = [], "note"
    for sentence in split_sentences(text):
        cleaned = clean(sentence)
        match = re.match(r"(Worse|Better)\b[,:;]?\s*(.*)", cleaned, re.I)
        if match:
            kind, cleaned = match.group(1).lower(), match.group(2)
        elif len(cleaned.split()) > 4:
            # A short unlabelled sentence carries on the list before it ("Worse, wet weather. Seashore.");
            # a long one is a remark.
            kind = "note"
        if kind == "note":
            if cleaned:
                found.append({"kind": kind, "text": cleaned})
            continue
        for item in cleaned.rstrip(".").split(";"):
            item = item.strip(" ,")
            switch = re.match(r"(worse|better)\b[,:]?\s*(.*)", item, re.I)
            if switch:
                kind, item = switch.group(1).lower(), switch.group(2)
            item = re.sub(r"^(from|by|in|at|on)\s+", "", item)
            if item:
                found.append({"kind": kind, "text": item})
    return found


def without_brackets(text):
    """The text with its bracketed asides removed, and those asides."""
    asides = []
    while True:
        text, count = re.subn(r"\(([^()]*)\)", lambda match: asides.append(match.group(1).strip()) or f" {ASIDE} ", text)
        if not count:
            return text, asides


def relationships(text, resolver):
    pieces = re.split(rf"\b({LABELS})\s*[:;]", clean(text), flags=re.I)
    found, seen = [], set()
    for label, body in zip(pieces[1::2], pieces[2::2], strict=False):
        kind = RELATIONSHIP_LABELS[label.lower()]
        body, asides = without_brackets(body)
        asides = iter(asides)
        if kind != "similar":
            # The list of names ends at the first full stop that is followed by more prose.
            body = re.split(r"\.\s+(?=[A-Z])", body, maxsplit=1)[0]
        for item in re.split(r";|\.\s", body):
            note = " ".join(next(asides, "") for _ in range(item.count(ASIDE)))
            written = item.replace(ASIDE, " ").strip(" .,")
            written = re.sub(r"\s+", " ", written)
            if not written or len(written.split()) > 3:
                continue
            code = resolver.code(written)
            if not code or (kind, code) in seen:
                continue
            seen.add((kind, code))
            entry = {"kind": kind, "medicine": resolver.index[code]["id"], "name": resolver.index[code]["name"], "as_written": written}
            if note.strip():
                entry["note"] = note.strip()
            found.append(entry)
    return found


def parse(page, code, resolver, imported):
    entry = resolver.index[code]
    heading = re.search(r'<a name="[^"]*">.*?</p>', page, re.S | re.I)
    body = page[heading.end() :] if heading else page
    body = re.split(r"Copyright\s", body)[0]
    titles = [plain(part) for part in re.split(r"<br\s*/?>", heading.group(0), flags=re.I)] if heading else []
    titles = [title.strip("() ") for title in titles if title.strip("() ")]
    # A few headings carry a gloss after the name ("GLONOINUM : gl = glycerin; ...").
    name = sentence_case(titles[0].split(" : ")[0]) if titles else entry["name"]
    aliases = []
    for alias in titles[1:]:
        alias = sentence_case(alias) if alias.isupper() else alias
        if fold(alias) != fold(name) and alias not in aliases:
            aliases.append(alias)

    body = SECTION.sub(lambda match: f"{SECTION_MARK}{plain(match.group(1))}{SECTION_MARK}", body)
    body = re.sub(r"<i>", EMPHASIS_OPEN, body, flags=re.I)
    body = re.sub(r"</i>", EMPHASIS_CLOSE, body, flags=re.I)
    text = plain(body)
    # Some pages run these headings into the paragraph before them instead of setting them in red.
    text = re.sub(rf"(?<!{SECTION_MARK})\b(Modalities|Relationships?|Dose)\.\s*--\s*", rf"{SECTION_MARK}\1{SECTION_MARK}", text)
    parts = text.split(SECTION_MARK)
    sections = []
    for title, text in [("General", parts[0]), *zip(parts[1::2], parts[2::2], strict=False)]:
        if title.strip() == "Modalities":
            # A few pages carry on from the modalities into the relationships and the dose with no heading at all.
            dose = re.search(r"(?<=\.)\s+Dose\.\s", text)
            if dose:
                text, after = text[: dose.start()], text[dose.end() :]
                sections.append(("Dose", after))
            related = re.search(rf"\b(?:{LABELS})\s*[:;]", text, re.I)
            if related:
                sections.append(("Relationship", text[related.start() :]))
                text = text[: related.start()]
        sections.append((title, text))

    source = {"source": SOURCE_ID}
    medicine = {
        "id": entry["id"],
        "name": name,
        "abbreviation": code.capitalize() + ".",
        "aliases": aliases,
        "import": {
            "source": SOURCE_ID,
            "locator": BASE_URL + entry["page"],
            "imported_on": imported,
            "imported_by": "knowledge.importers.boericke",
        },
        "symptoms": [],
        "modalities": [],
        "relationships": [],
        "notes": [],
    }
    for title, text in sections:
        title, text = title.strip(), text.strip()
        if not text:
            continue
        if title == "Modalities":
            medicine["modalities"] += [{**item, **source} for item in modalities(text)]
        elif title in ("Relationship", "Relationships"):
            medicine["relationships"] += [{**item, **source} for item in relationships(text, resolver)]
            # The paragraph also holds prose and comparisons the list above cannot carry.
            medicine["notes"].append({"section": "Relationship", "text": clean(text), **source})
        elif title in ("Dose", "Non-Homeopathic Uses"):
            medicine["notes"].append({"section": title, "text": clean(text), **source})
        else:
            medicine["symptoms"] += [{"section": title, **item, **source} for item in lines_of(text)]
    return {key: value for key, value in medicine.items() if value not in ([], "")}


HEADER = """{name}: one remedy of the Jivni reference library. The format is described in knowledge/README.md.
Imported from a public-domain book; do not edit this file by hand. A clinic's own changes go in its
own layer, which is merged over this file and never rewrites it."""


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("codes", nargs="*", help="remedy codes from the book's index, for example ARN BELL; default: the seed list")
    parser.add_argument("--cache", required=True, help="folder that keeps the fetched pages")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[3] / "knowledge"))
    parser.add_argument("--date", default=datetime.date.today().isoformat(), help="the import date to record")
    parser.add_argument("--all", action="store_true", help="every remedy in the book's index")
    options = parser.parse_args()

    index = remedy_index(options.cache)
    resolver = Resolver(index)
    for code in sorted(index) if options.all else [code.upper() for code in options.codes] or SEED:
        if code not in index:
            raise SystemExit(f"{code} is not in the book's index")
        medicine = parse(fetch(index[code]["page"], options.cache), code, resolver, options.date)
        tomlfmt.write(Path(options.out) / "medicines" / f"{medicine['id']}.toml", medicine, HEADER.format(name=medicine["name"]))
        counts = {key: len(medicine.get(key, [])) for key in ("symptoms", "modalities", "relationships")}
        print(f"{code:8} {medicine['id']:28} {counts}")


if __name__ == "__main__":
    main()
