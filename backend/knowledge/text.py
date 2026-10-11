"""How search reads words: the same folding is applied to the library and to what is typed."""

import re
import unicodedata

LIGATURES = str.maketrans({"æ": "ae", "œ": "oe", "Æ": "Ae", "Œ": "Oe", "’": "'"})
WORD = re.compile(r"[a-z0-9]+")
STOPWORDS = frozenset(
    "a an and are as at be by for from had has have he her his in is it its of on or she that the "
    "their there these this to was were when which who with".split()
)


def fold(value):
    """Lower case, no accents, ligatures written out."""
    value = unicodedata.normalize("NFKD", str(value).translate(LIGATURES))
    return "".join(character for character in value if not unicodedata.combining(character)).lower()


def slug(value):
    return "-".join(WORD.findall(fold(value)))


def stem(word):
    """A deliberately crude stem: enough to match bruise, bruised and bruising, or diarrhoea and diarrhea."""
    if len(word) > 5:
        word = word.replace("ae", "e").replace("oe", "e")
    if len(word) > 6 and word.endswith("ness"):
        word = word[:-4]
    if len(word) > 4 and word.endswith("ies"):
        word = word[:-3] + "y"
    elif len(word) > 5 and word.endswith("sses"):
        word = word[:-2]
    elif len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
        word = word[:-1]
    for suffix in ("ing", "ed"):
        if len(word) > len(suffix) + 2 and word.endswith(suffix):
            word = word[: -len(suffix)]
            if len(word) > 3 and word[-1] == word[-2] and word[-1] not in "aeiouslz":
                word = word[:-1]
            break
    if len(word) > 4 and word.endswith("e"):
        word = word[:-1]
    return word


def words(value):
    """The meaningful words of a text, folded but not stemmed."""
    return [word for word in WORD.findall(fold(value)) if word not in STOPWORDS]


def stems(value):
    return [stem(word) for word in words(value)]
