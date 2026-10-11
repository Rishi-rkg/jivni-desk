from rest_framework.routers import SimpleRouter

from .views import KnowledgeViewSet

router = SimpleRouter()
router.register("knowledge", KnowledgeViewSet, basename="knowledge")
urlpatterns = router.urls
