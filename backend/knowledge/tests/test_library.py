import io
import shutil
import tempfile
import tomllib
import zipfile
from pathlib import Path

from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from knowledge import tomlfmt
from knowledge.preferences import record_pick
from knowledge.store import clinic_dir, library, shipped_dir
from knowledge.text import stem

ARNICA = {
    "id": "arnica-montana",
    "name": "Arnica montana",
    "abbreviation": "Arn.",
    "aliases": ["Leopard's Bane"],
    "symptoms": [
        {"section": "General", "text": "Sore, lame, bruised feeling.", "grade": 2, "source": "book"},
        {"section": "Head", "text": "Hot, with cold body.", "grade": 1, "source": "book"},
        {"section": "Stomach", "text": "Vomiting of blood.", "grade": 1, "source": "book"},
        {"section": "General", "text": "Aversion to tobacco.", "grade": 1, "source": "book"},
    ],
    "modalities": [{"kind": "worse", "text": "least touch", "source": "book"}],
    "relationships": [
        {"kind": "antidote", "medicine": "camphora", "name": "Camphora", "as_written": "Camph", "source": "book"},
        {"kind": "complementary", "medicine": "aconitum-napellus", "name": "Aconitum napellus", "source": "book"},
        {"kind": "similar", "medicine": "bellis-perennis", "name": "Bellis perennis", "source": "book"},
    ],
}
BELLIS = {
    "id": "bellis-perennis",
    "name": "Bellis perennis",
    "abbreviation": "Bell-p.",
    "symptoms": [
        {"section": "General", "text": "Bruised soreness after a fall.", "grade": 1, "source": "book"},
        {"section": "Head", "text": "Headache from occiput to top of head.", "grade": 1, "source": "book"},
    ],
}
CAMPHORA = {
    "id": "camphora",
    "name": "Camphora",
    "abbreviation": "Camph.",
    "symptoms": [{"section": "Stomach", "text": "Nausea with hæmorrhage.", "grade": 1, "source": "book"}],
}
RUBRIC = {
    "id": "head-pain-sun",
    "name": "Head, pain, sun, from exposure to",
    "chapter": "Head",
    "synonyms": ["sunstroke"],
    "medicines": [{"medicine": "bellis-perennis", "grade": 3, "source": "book"}],
}


class LibraryFiles:
    """A small shipped library and an empty clinic folder, both thrown away after each test."""

    def setUp(self):
        super().setUp()
        self.folder = Path(tempfile.mkdtemp(prefix="library-tests-"))
        self.addCleanup(shutil.rmtree, self.folder, True)
        self.shipped = self.folder / "shipped"
        for medicine in (ARNICA, BELLIS, CAMPHORA):
            tomlfmt.write(self.shipped / "medicines" / f"{medicine['id']}.toml", medicine)
        tomlfmt.write(self.shipped / "rubrics" / f"{RUBRIC['id']}.toml", RUBRIC)
        (self.shipped / "sources.toml").write_text('[book]\ntitle = "A book"\nauthor = "An author"\nyear = 1900\n', encoding="utf-8")
        (self.shipped / "vocabulary.toml").write_text('same = [["bruised", "contusion"], ["haemorrhage", "bleeding"]]\n', encoding="utf-8")
        overridden = override_settings(
            KNOWLEDGE_BASE_DIR=self.shipped, KNOWLEDGE_CLINIC_DIR=self.folder / "clinics", KNOWLEDGE_RECHECK_SECONDS=0
        )
        overridden.enable()
        self.addCleanup(overridden.disable)

    def clinic_file(self, clinic, name, data):
        tomlfmt.write(clinic_dir(clinic) / name, data)

    def names(self, clinic, query):
        return [result["name"] for result in library(clinic).search(query)["results"]]


class FormatTests(SimpleTestCase):
    def test_what_is_written_reads_back_the_same(self):
        data = {
            "id": "x",
            "aliases": ['He said "hello"', "back\\slash", "æther"],
            "flag": True,
            "symptoms": [{"text": "line one\nline two", "grade": 2}, {"text": "tab\there"}],
            "picks": {"two words": {"arnica-montana": 3}},
            "import": {"source": "book"},
        }
        self.assertEqual(tomllib.loads(tomlfmt.dumps(data, "A header\nof two lines")), data)

    def test_entries_are_written_one_to_a_line(self):
        written = tomlfmt.dumps(ARNICA)
        self.assertIn('  { section = "Head", text = "Hot, with cold body.", grade = 1, source = "book" },\n', written)

    def test_words_that_should_match_do(self):
        for group in (
            ["bruise", "bruised", "bruising", "bruises"],
            ["diarrhoea", "diarrhea"],
            ["haemorrhage", "hemorrhage"],
            ["vomit", "vomiting"],
        ):
            self.assertEqual(len({stem(word) for word in group}), 1, group)
        self.assertNotEqual(stem("head"), stem("heat"))


class LayerTests(LibraryFiles, SimpleTestCase):
    def test_the_clinic_layer_adds_hides_and_creates_without_touching_shipped_files(self):
        before = {path.name: path.read_bytes() for path in self.shipped.rglob("*.toml")}
        self.clinic_file(
            "one",
            "medicines/arnica-montana.toml",
            {
                "id": "arnica-montana",
                "aliases": ["Mountain tobacco"],
                "symptoms": [
                    {"section": "Extremities", "text": "Sore after long cycling.", "grade": 2},
                    {"text": "Aversion to tobacco.", "hide": True, "note": "Not seen in practice."},
                ],
                "relationships": [
                    {"kind": "complementary", "medicine": "camphora"},
                    {"kind": "similar", "medicine": "bellis-perennis", "hide": True},
                ],
            },
        )
        self.clinic_file(
            "one", "medicines/calendula.toml", {"id": "calendula", "name": "Calendula", "symptoms": [{"text": "Torn wounds."}]}
        )
        index = library("one")
        arnica = index.detail("arnica-montana")
        texts = [entry["text"] for entry in arnica["symptoms"]]
        self.assertIn("Sore after long cycling.", texts)
        self.assertNotIn("Aversion to tobacco.", texts)
        self.assertEqual(arnica["aliases"], ["Leopard's Bane", "Mountain tobacco"])
        added = next(entry for entry in arnica["symptoms"] if entry["text"] == "Sore after long cycling.")
        self.assertEqual((added["layer"], added["source"]), ("clinic", "clinic"))
        kinds = {(entry["kind"], entry["medicine"], entry["layer"]) for entry in arnica["relationships"]}
        self.assertIn(("complementary", "camphora", "clinic"), kinds)
        self.assertNotIn(("similar", "bellis-perennis", "shipped"), kinds)
        self.assertEqual(index.detail("calendula")["layer"], "clinic")
        self.assertEqual(self.names("one", "torn wounds"), ["Calendula"])
        # Another clinic sees none of it, and the shipped files are byte for byte what they were.
        self.assertIn("Aversion to tobacco.", [entry["text"] for entry in library("two").detail("arnica-montana")["symptoms"]])
        self.assertNotIn("calendula", library("two").library.medicines)
        self.assertEqual({path.name: path.read_bytes() for path in self.shipped.rglob("*.toml")}, before)

    def test_an_unreadable_file_is_reported_and_the_rest_still_works(self):
        (clinic_dir("one") / "medicines").mkdir(parents=True)
        (clinic_dir("one") / "medicines" / "camphora.toml").write_text("symptoms = [ {", encoding="utf-8")
        index = library("one")
        self.assertEqual([problem["file"] for problem in index.library.problems], ["medicines/camphora.toml"])
        self.assertIn("camphora", index.library.medicines)
        self.assertEqual(self.names("one", "bruised")[0], "Arnica montana")

    def test_an_edit_is_seen_without_restarting(self):
        self.assertEqual(self.names("one", "cycling"), [])
        self.clinic_file("one", "medicines/camphora.toml", {"symptoms": [{"text": "Cramp after cycling."}]})
        self.assertEqual(self.names("one", "cycling"), ["Camphora"])


class SearchTests(LibraryFiles, SimpleTestCase):
    def test_each_part_of_a_query_is_explained(self):
        found = library("one").search("bruised + vomiting + thirst")
        first = found["results"][0]
        self.assertEqual(first["name"], "Arnica montana")
        self.assertEqual([match["part"] for match in first["matched"]], ["bruised", "vomiting"])
        self.assertEqual(first["missing"], ["thirst"])
        line = first["matched"][0]["lines"][0]
        self.assertEqual(
            (line["text"], line["section"], line["grade"], line["source"]), ("Sore, lame, bruised feeling.", "General", 2, "book")
        )
        self.assertEqual(found["sources"]["book"]["author"], "An author")
        # Bellis matches one part only, so it comes after the remedy that matches two.
        self.assertEqual([result["name"] for result in found["results"]], ["Arnica montana", "Bellis perennis"])
        self.assertNotIn("score", first)

    def test_spelling_synonyms_and_unfinished_words(self):
        self.assertEqual(self.names("one", "hemorrhage"), ["Camphora"])
        self.assertEqual(self.names("one", "bleeding"), ["Camphora"])
        self.assertEqual(self.names("one", "contusion"), ["Arnica montana", "Bellis perennis"])
        self.assertEqual(self.names("one", "naus"), ["Camphora"])
        self.assertEqual(self.names("one", "worse touch"), ["Arnica montana"])
        self.assertEqual(self.names("one", "sunstroke"), ["Bellis perennis"])
        self.assertEqual(self.names("one", ""), [])
        self.assertEqual(self.names("one", "the of and"), [])

    def test_a_rubric_is_a_reason_like_any_other(self):
        line = library("one").search("head pain sun")["results"][0]["matched"][0]["lines"][0]
        self.assertEqual((line["kind"], line["text"], line["grade"]), ("rubric", "Head, pain, sun, from exposure to", 3))

    def test_a_chapter_of_a_repertory_is_read_with_its_grades_and_abbreviations(self):
        chapter = {
            "source": "book",
            "chapter": "Head",
            "rubrics": [
                {"name": "Motions of head, rolling head", "page": 131, "g3": ["camph"], "g2": ["arn", "bellis-perennis"], "g1": ["zzz"]},
                {"name": "Motions of head, rolling head, sleep, during", "page": 131, "g1": ["bell-p"]},
                {"name": "Nobody listed", "g1": ["zzz"]},
            ],
        }
        tomlfmt.write(self.shipped / "rubrics" / "book" / "head.toml", chapter)
        tomlfmt.write(self.shipped / "abbreviations.toml", {"book": {"camph": "camphora", "arn": "arnica-montana"}})
        index = library("one")
        found = index.search("rolling head")
        self.assertEqual([result["name"] for result in found["results"]], ["Camphora", "Bellis perennis", "Arnica montana"])
        line = found["results"][0]["matched"][0]["lines"][0]
        self.assertEqual(
            line,
            {
                "kind": "rubric",
                "section": "Head",
                "text": "Motions of head, rolling head",
                "grade": 3,
                "source": "book",
                "layer": "shipped",
            },
        )
        # Bellis is under both rubrics; an abbreviation the library cannot place is left out, not guessed.
        self.assertEqual(found["results"][1]["matched"][0]["count"], 2)
        self.assertEqual(index.unknown_remedies, 2)
        self.assertEqual(self.names("one", "nobody listed"), [])
        # The clinic can add a chapter of its own in the same shape.
        own = {"source": "clinic", "chapter": "Clinic", "rubrics": [{"name": "Cyclist's knee", "g2": ["arnica-montana"]}]}
        self.clinic_file("one", "rubrics/ours.toml", own)
        mine = library("one").search("cyclist knee")["results"][0]
        self.assertEqual((mine["name"], mine["matched"][0]["lines"][0]["layer"]), ("Arnica montana", "clinic"))
        self.assertEqual(self.names("two", "cyclist knee"), [])

    def test_a_name_finds_the_remedy(self):
        index = library("one")
        self.assertEqual([item["id"] for item in index.search("arn")["medicines"]], ["arnica-montana"])
        self.assertEqual([item["id"] for item in index.search("Bell-p.")["medicines"]], ["bellis-perennis"])
        self.assertEqual([item["id"] for item in index.search("leopard")["medicines"]], ["arnica-montana"])

    def test_the_relationship_shortcuts(self):
        index = library("one")
        antidotes = index.search("anti+arnica")["shortcut"]
        self.assertEqual((antidotes["kind"], antidotes["of"]["id"]), ("antidote", "arnica-montana"))
        self.assertEqual([(item["name"], item["in_library"]) for item in antidotes["items"]], [("Camphora", True)])
        complementary = index.search("comp + arn")["shortcut"]
        self.assertEqual([(item["name"], item["in_library"]) for item in complementary["items"]], [("Aconitum napellus", False)])
        self.assertEqual(index.search("anti+nothing")["shortcut"]["of"], None)
        # A word before a plus sign that is not a shortcut is an ordinary part of a symptom search.
        self.assertIsNone(index.search("bruised + vomiting")["shortcut"])

    def test_a_remedy_shows_who_names_it(self):
        named = library("one").detail("camphora")["named_by"]
        self.assertEqual([(item["kind"], item["id"]) for item in named], [("antidote", "arnica-montana")])


class LearningTests(LibraryFiles, SimpleTestCase):
    def test_what_the_doctor_chooses_moves_up_and_only_library_words_are_kept(self):
        self.assertEqual(self.names("one", "bruised"), ["Arnica montana", "Bellis perennis"])
        learned = record_pick("one", library("one"), "Mrs Sharma bruised knee zzyzx", "bellis-perennis")
        self.assertEqual(learned, ["bruised"])
        stored = (clinic_dir("one") / "preferences.toml").read_text(encoding="utf-8")
        self.assertEqual(tomllib.loads(stored)["picks"], {"bruised": {"bellis-perennis": 1}})
        for typed in ("Sharma", "knee", "zzyzx"):
            self.assertNotIn(typed, stored)
        self.assertEqual(self.names("one", "bruised"), ["Bellis perennis", "Arnica montana"])
        self.assertEqual(library("one").search("bruising")["results"][0]["chosen"], 1)
        # It never outranks a remedy that matches more of what was asked, and stays inside its clinic.
        self.assertEqual(self.names("one", "bruised + vomiting")[0], "Arnica montana")
        self.assertEqual(self.names("two", "bruised"), ["Arnica montana", "Bellis perennis"])

    def test_counts_add_up_and_pins_come_first(self):
        for _ in range(3):
            record_pick("one", library("one"), "bruised", "bellis-perennis")
        self.assertEqual(
            tomllib.loads((clinic_dir("one") / "preferences.toml").read_text(encoding="utf-8"))["picks"]["bruised"], {"bellis-perennis": 3}
        )
        self.clinic_file("one", "preferences.toml", {"picks": {"bruised": {"bellis-perennis": 3}}, "pins": {"bruise": ["arnica-montana"]}})
        first = library("one").search("bruised")["results"][0]
        self.assertEqual((first["name"], first["pinned"]), ("Arnica montana", True))
        record_pick("one", library("one"), "bruised", "bellis-perennis")
        kept = tomllib.loads((clinic_dir("one") / "preferences.toml").read_text(encoding="utf-8"))
        self.assertEqual(kept, {"picks": {"bruised": {"bellis-perennis": 4}}, "pins": {"bruise": ["arnica-montana"]}})

    def test_nothing_is_learned_from_a_shortcut_an_unknown_remedy_or_over_a_broken_file(self):
        self.assertEqual(record_pick("one", library("one"), "anti+arnica", "camphora"), [])
        self.assertEqual(record_pick("one", library("one"), "bruised", "not-a-remedy"), [])
        self.assertFalse((clinic_dir("one") / "preferences.toml").exists())
        clinic_dir("one").mkdir(parents=True)
        (clinic_dir("one") / "preferences.toml").write_text("[picks\nmy half-finished edit", encoding="utf-8")
        self.assertEqual(record_pick("one", library("one"), "bruised", "camphora"), [])
        self.assertEqual((clinic_dir("one") / "preferences.toml").read_text(encoding="utf-8"), "[picks\nmy half-finished edit")


class ApiTests(LibraryFiles, TestCase):
    def setUp(self):
        super().setUp()
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.users = {}
        for role in ("clinician", "assistant", "reception", "billing"):
            self.users[role] = User.objects.create_user(username=role, password="synthetic-password")
            Membership.objects.create(clinic=self.clinic, user=self.users[role], role_id=role)
        self.users["other"] = User.objects.create_user(username="other", password="synthetic-password")
        Membership.objects.create(clinic=self.other_clinic, user=self.users["other"], role_id="clinician")

    def signed_in(self, name):
        client = APIClient()
        client.force_login(self.users[name])
        session = client.session
        session["clinic_id"] = str(self.other_clinic.pk if name == "other" else self.clinic.pk)
        session.save()
        return client

    def test_search_medicine_and_overview(self):
        client = self.signed_in("clinician")
        found = client.post("/api/v1/knowledge/search/", {"q": "bruised + vomiting"}, format="json")
        self.assertEqual(found.status_code, 200)
        self.assertEqual(found.data["results"][0]["id"], "arnica-montana")
        self.assertEqual(
            client.post("/api/v1/knowledge/search/", {"q": "anti+arnica"}, format="json").data["shortcut"]["items"][0]["name"], "Camphora"
        )
        detail = client.get("/api/v1/knowledge/medicines/arnica-montana/")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual([item["name"] for item in detail.data["relationships"] if item["kind"] == "complementary"], ["Aconitum napellus"])
        self.assertEqual(client.get("/api/v1/knowledge/medicines/no-such-remedy/").status_code, 404)
        self.assertEqual(
            [item["id"] for item in client.get("/api/v1/knowledge/medicines/").data], ["arnica-montana", "bellis-perennis", "camphora"]
        )
        overview = client.get("/api/v1/knowledge/")
        self.assertEqual((overview.data["medicines"], overview.data["rubrics"], overview.data["problems"]), (3, 1, []))
        # Search text may describe a patient: it is never accepted in the address.
        self.assertEqual(client.get("/api/v1/knowledge/search/?q=bruised").status_code, 405)

    def test_who_may_do_what(self):
        anonymous = APIClient()
        self.assertEqual(anonymous.post("/api/v1/knowledge/search/", {"q": "bruised"}, format="json").status_code, 401)
        self.assertEqual(anonymous.get("/api/v1/knowledge/export/").status_code, 401)
        for role in ("reception", "billing"):
            client = self.signed_in(role)
            self.assertEqual(client.post("/api/v1/knowledge/search/", {"q": "bruised"}, format="json").status_code, 403, role)
            self.assertEqual(client.get("/api/v1/knowledge/medicines/arnica-montana/").status_code, 403, role)
            self.assertEqual(client.get("/api/v1/knowledge/export/").status_code, 403, role)
        self.assertEqual(AuditEvent.objects.filter(action="access.denied", outcome="denied", resource_type="knowledge").count(), 6)
        assistant = self.signed_in("assistant")
        self.assertEqual(assistant.post("/api/v1/knowledge/search/", {"q": "bruised"}, format="json").status_code, 200)
        self.assertEqual(
            assistant.post("/api/v1/knowledge/picks/", {"q": "bruised", "medicine": "camphora"}, format="json").status_code, 403
        )
        self.assertEqual(assistant.get("/api/v1/knowledge/export/").status_code, 403)
        self.assertFalse((clinic_dir(self.clinic.pk) / "preferences.toml").exists())

    def test_one_clinic_never_sees_anothers_layer_or_learning(self):
        self.clinic_file(self.clinic.pk, "medicines/calendula.toml", {"name": "Calendula", "symptoms": [{"text": "Torn wounds."}]})
        mine, theirs = self.signed_in("clinician"), self.signed_in("other")
        picked = mine.post("/api/v1/knowledge/picks/", {"q": "bruised", "medicine": "bellis-perennis"}, format="json")
        self.assertEqual((picked.status_code, picked.data), (200, {"learned": ["bruised"]}))
        self.assertEqual(mine.post("/api/v1/knowledge/picks/", {"q": "bruised", "medicine": "nothing"}, format="json").status_code, 404)
        self.assertEqual(
            mine.post("/api/v1/knowledge/search/", {"q": "bruised"}, format="json").data["results"][0]["id"], "bellis-perennis"
        )
        self.assertEqual(
            theirs.post("/api/v1/knowledge/search/", {"q": "bruised"}, format="json").data["results"][0]["id"], "arnica-montana"
        )
        self.assertEqual(mine.get("/api/v1/knowledge/medicines/calendula/").status_code, 200)
        self.assertEqual(theirs.get("/api/v1/knowledge/medicines/calendula/").status_code, 404)
        with zipfile.ZipFile(io.BytesIO(theirs.get("/api/v1/knowledge/export/").content)) as archive:
            self.assertFalse([name for name in archive.namelist() if "/clinic/" in name])

    def test_export_is_the_whole_library_as_text_and_is_audited_without_content(self):
        client = self.signed_in("clinician")
        self.clinic_file(self.clinic.pk, "medicines/calendula.toml", {"name": "Calendula", "symptoms": [{"text": "Torn wounds."}]})
        client.post("/api/v1/knowledge/picks/", {"q": "bruised", "medicine": "bellis-perennis"}, format="json")
        response = client.get("/api/v1/knowledge/export/")
        self.assertEqual((response.status_code, response["Content-Type"]), (200, "application/zip"))
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertEqual(
                sorted(archive.namelist()),
                [
                    "jivni-library/clinic/medicines/calendula.toml",
                    "jivni-library/clinic/preferences.toml",
                    "jivni-library/medicines/arnica-montana.toml",
                    "jivni-library/medicines/bellis-perennis.toml",
                    "jivni-library/medicines/camphora.toml",
                    "jivni-library/rubrics/head-pain-sun.toml",
                    "jivni-library/sources.toml",
                    "jivni-library/vocabulary.toml",
                ],
            )
            self.assertEqual(tomllib.loads(archive.read("jivni-library/medicines/arnica-montana.toml").decode())["name"], "Arnica montana")
        self.assertEqual(AuditEvent.objects.filter(action="knowledge.export", clinic=self.clinic).count(), 1)
        # Searching and choosing leave nothing in the audit log: no patient record is involved.
        client.post("/api/v1/knowledge/search/", {"q": "bruised"}, format="json")
        self.assertEqual(AuditEvent.objects.filter(clinic=self.clinic).count(), 1)


class ShippedLibraryTests(SimpleTestCase):
    """The library that ships with Jivni, as it is in the repository. Read once for the whole class: it is large."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        empty = Path(tempfile.mkdtemp(prefix="library-tests-"))
        cls.addClassCleanup(shutil.rmtree, empty, True)
        overridden = override_settings(KNOWLEDGE_CLINIC_DIR=empty)
        overridden.enable()
        cls.addClassCleanup(overridden.disable)

    def test_every_file_is_readable_named_for_its_id_and_cites_a_listed_source(self):
        index = library("shipped-check")
        held = index.library
        self.assertEqual(held.problems, [])
        self.assertGreaterEqual(len(held.medicines), 30)
        for path in (shipped_dir() / "medicines").glob("*.toml"):
            medicine = tomllib.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(medicine["id"], path.stem)
            self.assertTrue(medicine["name"])
            for field in ("symptoms", "modalities", "relationships", "notes"):
                for entry in medicine.get(field, []):
                    self.assertIn(entry.get("source"), held.sources, f"{path.name}: {entry}")
        for group in held.vocabulary:
            self.assertGreaterEqual(len(group), 2)

    def test_the_book_answers_as_the_book_reads(self):
        index = library("shipped-check")
        antidotes = index.search("anti+arnica")["shortcut"]
        self.assertEqual([item["name"] for item in antidotes["items"]], ["Camphora"])
        complementary = {item["name"] for item in index.detail("arnica-montana")["relationships"] if item["kind"] == "complementary"}
        self.assertEqual(complementary, {"Aconitum napellus", "Ipecacuanha"})
        found = index.search("bruised + bed feels too hard")
        arnica = next(result for result in found["results"][:3] if result["id"] == "arnica-montana")
        self.assertEqual(arnica["missing"], [])
        self.assertEqual(found["sources"]["boericke-mm-9"]["author"], "William Boericke")

    def test_the_repertory_is_whole_and_every_abbreviation_is_placed(self):
        index = library("shipped-check")
        self.assertGreater(len(index.rubric_names), 60000)
        self.assertEqual(index.unknown_remedies, 0)
        found = index.search("head pain sun exposure")
        first = found["results"][0]["matched"][0]["lines"][0]
        self.assertEqual((first["kind"], first["section"], first["grade"], first["source"]), ("rubric", "Head", 3, "kent-repertory"))
        self.assertIn("glonoinum", [result["id"] for result in found["results"][:8]])
        self.assertEqual(found["sources"]["kent-repertory"]["author"], "James Tyler Kent")
