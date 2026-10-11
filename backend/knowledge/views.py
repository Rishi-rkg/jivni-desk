import io
import zipfile

from django.http import HttpResponse
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.response import Response

from accounts.access import CLINICAL_READ, CLINICAL_WRITE, require_role
from records.views import ClinicViewSet

from .preferences import record_pick
from .search import brief
from .store import clinic_dir, library, shipped_dir


class SearchSerializer(serializers.Serializer):
    q = serializers.CharField(max_length=300, allow_blank=True, trim_whitespace=True)
    limit = serializers.IntegerField(min_value=1, max_value=50, default=20)


class PickSerializer(serializers.Serializer):
    q = serializers.CharField(max_length=300, trim_whitespace=True)
    medicine = serializers.SlugField(max_length=120)


class KnowledgeViewSet(ClinicViewSet):
    """The reference library. It holds no patient data, so reads are not audited; exports are.

    What a doctor types into search may describe a patient, so it travels in the request body, never in
    the address, and is neither logged nor stored.
    """

    basename = "knowledge"
    lookup_value_regex = "[a-z0-9-]+"

    def index(self, allowed=CLINICAL_READ):
        require_role(self.request, allowed)
        return library(self.member.clinic_id)

    def list(self, request):
        index = self.index()
        held = index.library
        return Response(
            {
                "medicines": len(held.medicines),
                "rubrics": len(index.rubric_names),
                "lines": len(index.lines),
                "sources": [held.source(identifier) for identifier in held.sources],
                "problems": [
                    *held.problems,
                    *([{"file": "preferences.toml", "problem": index.preference_problem}] if index.preference_problem else []),
                ],
            }
        )

    @action(detail=False, methods=["post"])
    def search(self, request):
        index = self.index()
        data = SearchSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return Response(index.search(data.validated_data["q"], data.validated_data["limit"]))

    @action(detail=False, methods=["get"], url_path="medicines")
    def medicines(self, request):
        index = self.index()
        return Response(sorted((brief(medicine) for medicine in index.library.medicines.values()), key=lambda item: item["name"]))

    @action(detail=False, methods=["get"], url_path="medicines/(?P<medicine_id>[a-z0-9-]+)")
    def medicine(self, request, medicine_id=None):
        index = self.index()
        if medicine_id not in index.library.medicines:
            raise NotFound("That remedy is not in the library.")
        return Response(index.detail(medicine_id))

    @action(detail=False, methods=["post"])
    def picks(self, request):
        """Remember that this remedy was chosen after this search, so it ranks higher next time."""
        index = self.index(CLINICAL_WRITE)
        data = PickSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        if data.validated_data["medicine"] not in index.library.medicines:
            raise NotFound("That remedy is not in the library.")
        learned = record_pick(self.member.clinic_id, index, data.validated_data["q"], data.validated_data["medicine"])
        return Response({"learned": learned})

    @action(detail=False, methods=["get"])
    def export(self, request):
        """The whole library as a zip of text files: the shipped layer, and the clinic's own under clinic/."""
        self.index(CLINICAL_WRITE)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for prefix, root in (("", shipped_dir()), ("clinic/", clinic_dir(self.member.clinic_id))):
                if root.is_dir():
                    for path in sorted(root.rglob("*")):
                        if path.is_file() and path.suffix in (".toml", ".md") and not path.name.startswith("."):
                            archive.write(path, f"jivni-library/{prefix}{path.relative_to(root).as_posix()}")
        self.event("knowledge.export")
        response = HttpResponse(buffer.getvalue(), content_type="application/zip")
        response["Content-Disposition"] = 'attachment; filename="jivni-library.zip"'
        return response
