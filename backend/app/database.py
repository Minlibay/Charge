from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

settings = get_settings()

# Configure connection pool to handle more concurrent connections
# pool_size: number of connections to maintain persistently
# max_overflow: additional connections that can be created on demand
# pool_pre_ping: verify connections before using them
engine = create_engine(
    settings.database_url,
    echo=settings.debug,
    future=True,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, future=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_db_session() -> Iterator[Session]:
    """Context manager for short-lived database sessions.
    
    Use this in WebSocket handlers instead of Depends(get_db) to avoid
    holding database connections for the entire WebSocket connection lifetime.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
