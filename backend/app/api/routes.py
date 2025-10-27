from fastapi import APIRouter

from app.api.auth import router as auth_router
from app.api.channels import router as channels_router
from app.api.config import router as config_router
from app.api.invites import router as invites_router
from app.api.rooms import router as rooms_router
from app.api.messages import router as messages_router

router = APIRouter()

router.include_router(auth_router, prefix="/auth", tags=["auth"])
router.include_router(config_router)
router.include_router(rooms_router)
router.include_router(channels_router)
router.include_router(invites_router)
router.include_router(messages_router)


@router.get("/", tags=["root"])
def read_root() -> dict[str, str]:
    return {"message": "Welcome to the Charge API"}
