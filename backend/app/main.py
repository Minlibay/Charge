from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.metrics import router as metrics_router
from app.api.routes import router as api_router
from app.api.ws import router as ws_router
from app.config import get_settings

settings = get_settings()

app = FastAPI(title=settings.app_name, debug=settings.debug)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[str(origin) for origin in settings.cors_origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_origin_regex=settings.cors_allow_origin_regex,
)


@app.get("/health", tags=["system"])
def health_check() -> dict[str, str]:
    """Simple health check endpoint."""
    return {"status": "ok", "environment": settings.environment}


app.include_router(api_router, prefix="/api")
app.include_router(ws_router)
app.include_router(metrics_router)
