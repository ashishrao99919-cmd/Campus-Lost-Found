"""Vercel serverless entrypoint – wraps the Flask app from backend/."""

import sys
from pathlib import Path

_backend = str(Path(__file__).resolve().parent.parent / "backend")
if _backend not in sys.path:
    sys.path.insert(0, _backend)

from app import app as app  # noqa: F401, E402
