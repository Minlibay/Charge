"""Prometheus-compatible metrics endpoint."""

from fastapi import APIRouter, Response

from app.monitoring.registry import registry


router = APIRouter(tags=["metrics"])


@router.get("/metrics", response_class=Response)
def export_metrics() -> Response:
    """Expose collected metrics for Prometheus scraping."""

    payload = registry.render()
    return Response(content=payload, media_type="text/plain; version=0.0.4")

