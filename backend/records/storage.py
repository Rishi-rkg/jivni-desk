"""Protected object storage; keys are internal and never public URLs."""

import hashlib
import io
import uuid
import warnings
from dataclasses import dataclass

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from PIL import Image, UnidentifiedImageError
from rest_framework.exceptions import ValidationError


@dataclass(frozen=True)
class StoredPhoto:
    key: str
    mime_type: str
    byte_size: int
    sha256: str


class PatientPhotoStore:
    def store(self, clinic_id, upload) -> StoredPhoto:
        if upload.size > 5 * 1024 * 1024:
            raise ValidationError({"photo": "Maximum photo size is 5 MiB."})
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                image = Image.open(upload)
                if image.format not in {"JPEG", "PNG"}:
                    raise ValidationError({"photo": "Use a JPEG or PNG image."})
                if image.width * image.height > 20_000_000:
                    raise ValidationError({"photo": "Image dimensions are too large."})
                image.load()
                image = image.convert("RGB")
                image.thumbnail((1200, 1200))
                # Re-encoding discards filenames and EXIF/location metadata.
                buffer = io.BytesIO()
                image.save(buffer, "JPEG", quality=85)
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise ValidationError({"photo": "Invalid image."}) from None
        data = buffer.getvalue()
        key = default_storage.save(f"clinics/{clinic_id}/photos/{uuid.uuid4()}.jpg", ContentFile(data))
        return StoredPhoto(key, "image/jpeg", len(data), hashlib.sha256(data).hexdigest())

    def open(self, key):
        return default_storage.open(key, "rb")

    def delete(self, key):
        default_storage.delete(key)


photo_store = PatientPhotoStore()


class PatientDocumentStore:
    """Lab reports and other papers. A PDF is kept as it is; a picture is re-encoded like a photo."""

    MAX_BYTES = 10 * 1024 * 1024

    def store(self, clinic_id, upload) -> StoredPhoto:
        if upload.size > self.MAX_BYTES:
            raise ValidationError({"file": "Maximum document size is 10 MiB."})
        head = upload.read(5)
        upload.seek(0)
        if head == b"%PDF-":
            data, extension, mime_type = upload.read(), "pdf", "application/pdf"
        else:
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    image = Image.open(upload)
                    if image.format not in {"JPEG", "PNG"}:
                        raise ValidationError({"file": "Use a PDF, or a JPEG or PNG picture."})
                    if image.width * image.height > 40_000_000:
                        raise ValidationError({"file": "The picture is too large."})
                    image.load()
                    image = image.convert("RGB")
                    image.thumbnail((2400, 2400))
                    buffer = io.BytesIO()
                    # Re-encoding discards file names and location data hidden in the picture.
                    image.save(buffer, "JPEG", quality=88)
            except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
                raise ValidationError({"file": "Use a PDF, or a JPEG or PNG picture."}) from None
            data, extension, mime_type = buffer.getvalue(), "jpg", "image/jpeg"
        key = default_storage.save(f"clinics/{clinic_id}/documents/{uuid.uuid4()}.{extension}", ContentFile(data))
        return StoredPhoto(key, mime_type, len(data), hashlib.sha256(data).hexdigest())

    def open(self, key):
        return default_storage.open(key, "rb")

    def delete(self, key):
        default_storage.delete(key)


document_store = PatientDocumentStore()
