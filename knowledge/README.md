# The Jivni reference library

A homeopathy reference kept as plain text files: one file per remedy, one file per rubric. People can read
it, a doctor can change it from inside Jivni, and the whole folder can be handed to any AI assistant to
extend or tidy. Nothing in it is patient data, so nothing in it is encrypted.

It is reference material. It never writes a prescription; the doctor decides.

## Two layers

| Layer | Where | Who changes it |
| --- | --- | --- |
| **Shipped** | this folder: `medicines/`, `rubrics/`, `sources.toml`, `abbreviations.toml`, `vocabulary.toml` | importers only (`backend/knowledge/importers/`) |
| **Clinic** | the clinic's data folder: `library/<clinic id>/` with the same `medicines/` and `rubrics/`, plus `preferences.toml` | the clinic's doctors, in Jivni or by editing the files |

Jivni reads the shipped layer and lays the clinic layer over it. **The clinic layer never rewrites a shipped
file**, so an update to the shipped library never loses a doctor's work, and what the book said can always be
told apart from what the clinic added. In an exported zip the clinic layer is the `clinic/` folder.

## Files are TOML

Lines starting with `#` are comments. Text goes in double quotes. Every entry sits on one line.

### A remedy: `medicines/<id>.toml`

```toml
id = "arnica-montana"            # lower case, hyphens; the file has the same name
name = "Arnica montana"
abbreviation = "Arn."
aliases = ["Leopard's Bane", "Arnica"]

symptoms = [
  { section = "Mind", text = "Fears touch, or the approach of anyone.", grade = 1, source = "boericke-mm-9" },
]
modalities = [
  { kind = "worse", text = "least touch", source = "boericke-mm-9" },      # kind: worse | better | note
]
relationships = [
  { kind = "antidote", medicine = "camphora", name = "Camphora", as_written = "Camph", source = "boericke-mm-9" },
]
notes = [
  { section = "Dose", text = "Third to thirtieth potency.", source = "boericke-mm-9" },
]
```

- `grade` is how strongly the source marks a symptom: 1 plain, 2 emphasised, 3 the strongest a source has.
- `relationships.kind` is one of `antidote`, `complementary`, `similar`, `inimical`, `follows`, or any word the
  clinic chooses. **It is read from this remedy's side**: an `antidote` entry in Arnica's file names a remedy
  that antidotes Arnica. `medicine` is the other remedy's `id`; it may name a remedy that has no file yet.
- `source` is required on every entry and must be a key of `sources.toml` (or `clinic`).
- Any entry may carry `note = "..."`.

### A rubric: `rubrics/<id>.toml`

A rubric is a symptom as a repertory lists it, with the remedies listed under it.

```toml
id = "head-pain-sun-from-exposure-to"
name = "Head, pain, sun, from exposure to"
chapter = "Head"
synonyms = ["sunstroke headache"]

medicines = [
  { medicine = "glonoinum", name = "Glonoinum", grade = 3, source = "clinic" },
]
```

### A chapter of a repertory: `rubrics/<book>/<chapter>.toml`

A whole repertory has tens of thousands of rubrics, so an imported one is kept a chapter to a file, one rubric
to a line, with the remedies in the book's own abbreviations under the grade the book gives them (`g3` strongest):

```toml
source = "kent-repertory"
chapter = "Head"

rubrics = [
  { name = "Pain, headache in general, sun, from exposure to, amel.", page = 149, g1 = ["graph", "stront"] },
]
```

`abbreviations.toml` says which remedy each abbreviation means for each source (`acon = "aconitum-napellus"`).
A remedy may also be written by its full `id`. A clinic can add files of the same shape in its own layer.

### Sources: `sources.toml`

One table per source with title, author, edition, year, rights and where it was read. When two sources
disagree, both entries stay, each under its own source; nothing is merged into one unattributed fact.

### Search words: `vocabulary.toml`

Lists of words that search treats as the same ("bleeding" finds "hæmorrhage").

## The clinic layer

A file in the clinic layer has the same name and shape as the shipped file it adds to. It holds only the
differences:

```toml
# library/<clinic id>/medicines/arnica-montana.toml
id = "arnica-montana"

symptoms = [
  # add a line
  { section = "Extremities", text = "Sore after long cycling.", grade = 2, source = "clinic", by = "Dr Rao", on = "2027-02-03" },
  # hide a shipped line: repeat its text exactly and say why
  { text = "Aversion to tobacco.", hide = true, source = "clinic", note = "Not seen in practice." },
]
relationships = [
  { kind = "complementary", medicine = "rhus-toxicodendron", name = "Rhus toxicodendron", source = "clinic" },
  { kind = "similar", medicine = "bellis-perennis", hide = true, source = "clinic" },
]
```

- Plain fields (`name`, `abbreviation`) replace the shipped value; `aliases` are added to it.
- An entry is added, unless it has `hide = true`, which hides the shipped entry it matches (same `text`, or
  same `kind` and `medicine`). Hidden entries are still in the shipped file and come back if the line is removed.
- A remedy or rubric that exists only in the clinic layer is a new one; give it `id` and `name`.

### What the library learns: `preferences.toml`

```toml
# How often a remedy was chosen after searching a word. A higher count moves it up for that word.
[picks.bruised]
arnica-montana = 4

# Always first for a word, in this order, whatever the counts say.
[pins]
bruised = ["arnica-montana", "bellis-perennis"]
```

Jivni adds to `picks` when a doctor chooses a remedy from search results. It records only words that already
exist in the library, never what was typed, and nothing about the patient. Edit or delete anything here.

## Searching

- `headache + worse sunlight + nausea`: each part between `+` is one symptom. Results list which parts each
  remedy matches, the matching lines and their sources.
- `anti+arnica` lists what antidotes Arnica. `comp+`, `sim+` and `inim+` do the same for complementary, similar
  and inimical remedies.
- A remedy's name or abbreviation finds the remedy.

## Asking an AI to edit the library

Export the zip from Jivni, give it to the assistant with this file, and ask for changes **inside `clinic/`
only**. Import the zip back. Useful rules to pass on: keep every `source`; never delete a shipped line, hide it;
one entry per line; do not invent sources.

## Rights

Shipped text comes only from public-domain or properly licensed sources, each listed in `sources.toml`.
