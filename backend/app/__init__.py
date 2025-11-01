"""Charge backend application."""

from pathlib import Path
import sys

SRC_PATH = Path(__file__).resolve().parent.parent / "src"
if SRC_PATH.exists() and str(SRC_PATH) not in sys.path:  # pragma: no branch - defensive guard
    sys.path.append(str(SRC_PATH))

from app.main import app

__all__ = ["app"]
