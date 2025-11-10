import logging.config

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.metrics import router as metrics_router
from app.api.routes import router as api_router
from app.api.ws import router as ws_router
from app.config import get_settings
from charge.realtime.managers import shutdown_realtime, startup_realtime


LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "format": "%(asctime)s %(levelname)s [%(name)s] %(message)s",
        }
    },
    "handlers": {
        "default": {
            "class": "logging.StreamHandler",
            "formatter": "standard",
        }
    },
    "root": {
        "handlers": ["default"],
        "level": "INFO",
    },
    "loggers": {
        "charge.realtime.transport": {
            "handlers": ["default"],
            "level": "INFO",
            "propagate": False,
        }
    },
}


logging.config.dictConfig(LOGGING_CONFIG)

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


@app.on_event("startup")
async def _startup() -> None:
    await startup_realtime()


@app.on_event("shutdown")
async def _shutdown() -> None:
    await shutdown_realtime()


app.include_router(api_router, prefix="/api")
app.include_router(ws_router)
app.include_router(metrics_router)
