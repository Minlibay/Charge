from fastapi import APIRouter

from app.api.auth import router as auth_router
from app.api.rooms import router as rooms_router

router = APIRouter()

router.include_router(auth_router, prefix="/auth", tags=["auth"])
router.include_router(rooms_router)


@router.get("/", tags=["root"])
def read_root() -> dict[str, str]:
    return {"message": "Welcome to the Charge API"}
