"""Voice and SFU management endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from app.api.deps import get_current_user
from app.models import User
from app.config import get_settings
from app.services.sfu_manager import sfu_manager

settings = get_settings()
router = APIRouter(prefix="/voice", tags=["voice"])


@router.post("/rooms/{room_slug}/sfu/create")
async def create_sfu_room(
    room_slug: str,
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Create a room in SFU server.

    Requires authentication.
    """
    if not settings.sfu_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SFU is not enabled",
        )

    try:
        result = await sfu_manager.create_room(room_slug)
        return {"success": True, "room": result.get("room")}
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create SFU room: {str(e)}",
        ) from e


@router.delete("/rooms/{room_slug}/sfu")
async def delete_sfu_room(
    room_slug: str,
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Delete a room from SFU server.

    Requires authentication.
    """
    if not settings.sfu_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SFU is not enabled",
        )

    try:
        await sfu_manager.delete_room(room_slug)
        return {"success": True}
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete SFU room: {str(e)}",
        ) from e


@router.get("/rooms/{room_slug}/sfu/status")
async def get_sfu_room_status(
    room_slug: str,
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Get status of a room in SFU server.

    Requires authentication.
    """
    if not settings.sfu_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SFU is not enabled",
        )

    try:
        status_data = await sfu_manager.get_room_status(room_slug)
        if status_data is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="SFU room not found",
            )
        return {"success": True, "room": status_data.get("room")}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get SFU room status: {str(e)}",
        ) from e


@router.get("/sfu/health")
async def sfu_health_check() -> dict:
    """
    Check SFU server health.

    Public endpoint (no authentication required).
    """
    is_healthy = await sfu_manager.health_check()
    return {
        "healthy": is_healthy,
        "enabled": settings.sfu_enabled,
    }

