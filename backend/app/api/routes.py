from fastapi import APIRouter

router = APIRouter()


@router.get("/", tags=["root"])
def read_root() -> dict[str, str]:
    return {"message": "Welcome to the Charge API"}
