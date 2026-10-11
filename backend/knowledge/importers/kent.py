"""Imports James Tyler Kent's Repertory of the Homoeopathic Materia Medica from the transcription at homeoint.org.

The text is in the public domain (Kent died in 1916). Each rubric becomes one line of a chapter file in
knowledge/rubrics/kent/, with its remedies in the three grades the book prints: plain (1), italics (2), bold (3).
Remedies are written by Kent's own abbreviations; knowledge/abbreviations.toml says which remedy each one is.
A remedy that has no entry in the library yet gets a file holding only its name.

    cd backend
    ../.venv/Scripts/python -m knowledge.importers.kent --cache SOME_FOLDER

Pages are fetched once into the cache folder, one a second.
"""

import argparse
import datetime
import html
import re
import time
import tomllib
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from knowledge import tomlfmt
from knowledge.text import fold, slug

SOURCE_ID = "kent-repertory"
BASE_URL = "http://www.homeoint.org/books/kentrep/"
TOKEN = re.compile(r"<[^>]*>|[^<]+")
PAGE_HEADER = re.compile(r"^(.*?)\s*p\.\s*(\d+)$")
DASHES = re.compile(r"^-{5,}")
REMEDY = re.compile(r"^[a-z][a-z0-9-]*$")
SEE = re.compile(r"\(\s*see\b[^)]*\)", re.I)

# Kent's names for remedies the library already holds under another spelling.
SAME_REMEDY = {
    "natrum": "natrium",
    "kali": "kalium",
}


def fetch(page, cache):
    target = Path(cache) / page.rsplit("/", 1)[-1]
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(urllib.parse.urljoin(BASE_URL, page), timeout=60) as response:  # noqa: S310 (fixed http address)
            target.write_bytes(response.read())
        time.sleep(1)
    return target.read_bytes().decode("cp1252", errors="replace")


def text_of(markup):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", markup)).replace("\xa0", " ")).strip()


def pages(cache):
    """The book's pages in order, found from its chapter lists."""
    chapters = sorted(set(re.findall(r'href="(kent[a-z]+\.htm)', fetch("index.htm", cache), re.I)))
    found = {}
    for chapter in chapters:
        # Later chapters keep their pages in sibling folders (../kentrep1/kent0475.htm).
        for address in re.findall(r'href="((?:\.\./kentrep\d/)?kent\d{4}\.htm)', fetch(chapter, cache), re.I):
            found[address.rsplit("/", 1)[-1].lower()] = address
    return [found[name] for name in sorted(found)]


def remedy_names(cache):
    """Kent's list of abbreviations: "Acon." is Aconitum Napellus."""
    names = {}
    for line in re.split(r"<br\s*/?>|</p>", fetch("kentreme.htm", cache), flags=re.I):
        match = re.match(r"^(.*?)\.?\s*-{4,}\s*(.+)$", text_of(line))
        if match:
            names[fold(match.group(1)).replace(" ", "").strip(".")] = match.group(2).strip(" .")
    return names


def paragraphs(page):
    """A page in order: (0, [(text, grade), ...]) for a paragraph, (+1 or -1, None) where nesting opens or closes."""
    bold, italic, inside, pieces = False, False, False, []
    for token in TOKEN.findall(page):
        if not token.startswith("<"):
            if inside:
                pieces.append((html.unescape(token).replace("\xa0", " "), 3 if bold else 2 if italic else 1))
            continue
        tag = re.match(r"</?\s*([a-z0-9]+)", token, re.I)
        name = tag.group(1).lower() if tag else ""
        closing = token.startswith("</")
        if name == "p":
            if inside and pieces:
                yield 0, pieces
            inside, pieces = not closing, []
        elif name == "dir":
            yield (-1 if closing else 1), None
        elif name == "b":
            bold = not closing
        elif name == "i":
            italic = not closing


def sentence_case(name):
    """ "MOTIONS of head" as "Motions of head"; a name already in lower case is left alone."""
    first, _, rest = name.partition(" ")
    if first.isupper() and len(first) > 1:
        first = first.capitalize()
    return f"{first} {rest}".strip()


def parse(page_markup, state, rubrics, unknown):
    """Adds the page's rubrics. `state` carries the open headings from one page to the next."""
    skip_context = False
    depth = 0
    for step, pieces in paragraphs(page_markup):
        if pieces is None:
            depth = max(0, depth + step)
            continue
        whole = re.sub(r"\s+", " ", "".join(text for text, _ in pieces)).strip()
        if not whole or DASHES.match(whole) or whole.startswith(("KENT", "Copyright")):
            continue
        header = PAGE_HEADER.match(whole)
        if header and header.group(1).isupper():
            state["chapter"], state["page"] = header.group(1).strip().title(), int(header.group(2))
            # The next line only repeats where the book was; the real nesting follows as <dir> tags.
            skip_context, depth = True, 0
            continue
        if skip_context:
            skip_context = False
            continue

        name, grades = "", {1: [], 2: [], 3: []}
        divided = False
        for text, grade in pieces:
            if not divided:
                before, colon, text = re.sub(r"\s+", " ", f" {text} ").partition(" : ")
                name += before
                if not colon:
                    continue
                divided = True
            for written in text.split(","):
                remedy = fold(written).strip().strip(".").replace(" ", "")
                if not remedy:
                    continue
                if REMEDY.match(remedy):
                    grades[grade].append(remedy)
                else:
                    unknown[written.strip()] += 1
        name = re.sub(r"\s+", " ", SEE.sub("", name))
        name = sentence_case(re.sub(r"\s+([,;])", r"", name).strip(" ,;:"))
        if not name:
            continue
        del state["path"][depth:]
        state["path"] += [""] * (depth - len(state["path"]))
        state["path"].append(name)
        if any(grades.values()):
            full = ", ".join(part for part in state["path"] if part)
            key = (state["chapter"], full)
            if key in rubrics:
                # A page that ends mid-rubric is repeated at the top of the next file.
                for grade, remedies in grades.items():
                    rubrics[key]["grades"][grade] += [r for r in remedies if r not in rubrics[key]["grades"][grade]]
            else:
                rubrics[key] = {"name": full, "page": state["page"], "grades": grades}


HEADER = """Kent's Repertory, chapter: {chapter}. One rubric to a line; see knowledge/README.md.
g3 = bold in the book, g2 = italics, g1 = plain. Remedies are Kent's abbreviations (knowledge/abbreviations.toml).
Imported from a public-domain book; do not edit by hand. A clinic's own rubrics go in its own layer."""


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--cache", required=True, help="folder that keeps the fetched pages")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[3] / "knowledge"))
    parser.add_argument("--date", default=datetime.date.today().isoformat(), help="the import date to record")
    options = parser.parse_args()
    out = Path(options.out)

    names = remedy_names(options.cache)
    rubrics, unknown, state = {}, Counter(), {"chapter": "", "page": 0, "path": []}
    for page in pages(options.cache):
        parse(fetch(page, options.cache), state, rubrics, unknown)

    # Which library remedy each abbreviation means.
    library = {}
    for path in sorted((out / "medicines").glob("*.toml")):
        medicine = tomllib.loads(path.read_text(encoding="utf-8"))
        library[fold(medicine.get("abbreviation", "")).strip(".")] = medicine["id"]
        library.setdefault("name:" + medicine["id"], medicine["id"])
    used = Counter(remedy for rubric in rubrics.values() for remedies in rubric["grades"].values() for remedy in remedies)
    abbreviations, created, unnamed = {}, 0, []
    for remedy in sorted(used):
        name = names.get(remedy)
        candidates = [library.get(remedy)]
        if name:
            identifier = slug(name)
            respelt = "-".join(SAME_REMEDY.get(part, part) for part in identifier.split("-"))
            candidates += [library.get("name:" + identifier), library.get("name:" + respelt)]
        match = next((candidate for candidate in candidates if candidate), None)
        if not match and name:
            match = slug(name)
            tomlfmt.write(
                out / "medicines" / f"{match}.toml",
                {
                    "id": match,
                    "name": name[:1].upper() + name[1:].lower(),
                    "abbreviation": remedy.capitalize() + ".",
                    "import": {
                        "source": SOURCE_ID,
                        "locator": BASE_URL + "kentreme.htm",
                        "imported_on": options.date,
                        "imported_by": "knowledge.importers.kent",
                    },
                },
                "A remedy named in Kent's Repertory. The library has no materia medica entry for it yet.",
            )
            library["name:" + match] = match
            created += 1
        if match:
            abbreviations[remedy] = match
        else:
            unnamed.append(remedy)

    existing = out / "abbreviations.toml"
    table = tomllib.loads(existing.read_text(encoding="utf-8")) if existing.is_file() else {}
    table[SOURCE_ID] = abbreviations
    tomlfmt.write(existing, table, "What each source's remedy abbreviations mean: abbreviation = remedy id (a file in medicines/).")

    by_chapter = {}
    for (chapter, _), rubric in rubrics.items():
        entry = {"name": rubric["name"], "page": rubric["page"]}
        for grade in (3, 2, 1):
            known = [remedy for remedy in rubric["grades"][grade] if remedy in abbreviations]
            if known:
                entry[f"g{grade}"] = known
        if len(entry) > 2:
            by_chapter.setdefault(chapter, []).append(entry)
    for old in (out / "rubrics" / "kent").glob("*.toml"):
        old.unlink()
    for chapter, entries in by_chapter.items():
        data = {"source": SOURCE_ID, "chapter": chapter, "imported_on": options.date, "rubrics": entries}
        tomlfmt.write(out / "rubrics" / "kent" / f"{slug(chapter)}.toml", data, HEADER.format(chapter=chapter))
        print(f"{chapter:28} {len(entries):6} rubrics")
    print(
        f"{sum(len(entries) for entries in by_chapter.values())} rubrics, {sum(used.values())} remedy entries, {len(abbreviations)} remedies ({created} new files)"
    )
    print(f"abbreviations Kent's list does not explain ({len(unnamed)}): {' '.join(f'{r}x{used[r]}' for r in unnamed[:60])}")
    print(f"text that is not a remedy ({len(unknown)} kinds): {unknown.most_common(25)}")


if __name__ == "__main__":
    main()
