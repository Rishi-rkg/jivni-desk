import uuid

from django.test import SimpleTestCase

from vault import crypto

KDF = {"alg": "argon2id", "time_cost": 1, "memory_cost": 64, "parallelism": 1}


class EnvelopeTests(SimpleTestCase):
    def setUp(self):
        self.key = crypto.random_key()
        self.clinic, self.record = uuid.uuid4(), uuid.uuid4()

    def seal(self, plaintext=b"Synthetic clinical note", **changes):
        context = {"clinic_id": self.clinic, "record_id": self.record, "purpose": "note.body", **changes}
        return crypto.encrypt(self.key, 1, context["clinic_id"], context["record_id"], context["purpose"], plaintext)

    def open(self, blob, keys=None, **changes):
        context = {"clinic_id": self.clinic, "record_id": self.record, "purpose": "note.body", **changes}
        return crypto.decrypt(keys or {1: self.key}, context["clinic_id"], context["record_id"], context["purpose"], blob)

    def test_round_trip_for_empty_unicode_and_large_values(self):
        for plaintext in [b"", "सिंथेटिक नोट 🩺".encode(), b"x" * 1_000_000]:
            blob = self.seal(plaintext)
            self.assertEqual(self.open(blob), plaintext)
            if plaintext:
                self.assertNotIn(plaintext[:32], blob)

    def test_same_plaintext_never_produces_the_same_ciphertext(self):
        self.assertNotEqual(self.seal(), self.seal())

    def test_any_changed_byte_is_rejected(self):
        blob = bytearray(self.seal())
        for position in [0, 5, 10, 30, 60, 70, len(blob) - 20, len(blob) - 1]:
            damaged = bytearray(blob)
            damaged[position] ^= 1
            with self.assertRaises(crypto.DecryptionError, msg=position):
                self.open(bytes(damaged))
        for truncated in [b"", bytes(blob[:10]), bytes(blob[:-1])]:
            with self.assertRaises(crypto.DecryptionError):
                self.open(truncated)

    def test_ciphertext_is_bound_to_its_clinic_record_and_field(self):
        blob = self.seal()
        for wrong in [{"clinic_id": uuid.uuid4()}, {"record_id": uuid.uuid4()}, {"purpose": "encounter.assessment"}]:
            with self.assertRaises(crypto.DecryptionError, msg=wrong):
                self.open(blob, **wrong)

    def test_wrong_or_missing_key_fails_closed(self):
        blob = self.seal()
        for keys in [{1: crypto.random_key()}, {2: self.key}, {}]:
            with self.assertRaises(crypto.DecryptionError):
                crypto.decrypt(keys, self.clinic, self.record, "note.body", blob)

    def test_rewrap_moves_to_a_new_key_without_changing_the_data_ciphertext(self):
        blob = self.seal()
        new_key = crypto.random_key()
        moved = crypto.rewrap({1: self.key}, new_key, 2, self.clinic, self.record, "note.body", blob)
        self.assertEqual(crypto.Envelope.from_bytes(moved).sealed_data, crypto.Envelope.from_bytes(blob).sealed_data)
        self.assertEqual(self.open(moved, keys={2: new_key}), b"Synthetic clinical note")
        with self.assertRaises(crypto.DecryptionError):
            self.open(moved, keys={2: self.key})
        # Old and new values stay readable side by side while a rotation is in progress.
        self.assertEqual(self.open(blob, keys={1: self.key, 2: new_key}), b"Synthetic clinical note")

    def test_errors_carry_no_detail(self):
        try:
            self.open(self.seal(), purpose="other")
        except crypto.DecryptionError as error:
            self.assertEqual(str(error), "")


class PrimitiveTests(SimpleTestCase):
    def test_associated_data_is_unambiguous(self):
        self.assertNotEqual(crypto.associated_data("a", "bc"), crypto.associated_data("ab", "c"))
        self.assertNotEqual(crypto.associated_data("a", None), crypto.associated_data("a"))
        self.assertNotEqual(crypto.associated_data("a", 1), crypto.associated_data("a", 2))
        with self.assertRaises(TypeError):
            crypto.associated_data("a", True)
        with self.assertRaises(TypeError):
            crypto.associated_data("a", 1.5)

    def test_key_derivation_depends_on_secret_salt_and_cost(self):
        salt = crypto.random_salt()
        base = crypto.derive_key("synthetic-password", salt, KDF)
        self.assertEqual(len(base), 32)
        self.assertEqual(base, crypto.derive_key("synthetic-password", salt, KDF))
        self.assertNotEqual(base, crypto.derive_key("synthetic-passwore", salt, KDF))
        self.assertNotEqual(base, crypto.derive_key("synthetic-password", crypto.random_salt(), KDF))
        self.assertNotEqual(base, crypto.derive_key("synthetic-password", salt, {**KDF, "time_cost": 2}))
        with self.assertRaises(ValueError):
            crypto.derive_key("synthetic-password", salt, {**KDF, "alg": "md5"})

    def test_stored_cost_settings_are_bounded(self):
        salt = crypto.random_salt()
        for bad in [{"memory_cost": 64 * 1024 * 1024}, {"time_cost": 1000}, {"parallelism": 0}, {"memory_cost": 1}]:
            with self.assertRaises(ValueError, msg=bad):
                crypto.derive_key("synthetic-password", salt, {**KDF, **bad})

    def test_seal_rejects_short_keys(self):
        with self.assertRaises(ValueError):
            crypto.seal(b"short", b"data", b"")
        with self.assertRaises(crypto.DecryptionError):
            crypto.unseal(b"short", crypto.seal(crypto.random_key(), b"data", b""), b"")
