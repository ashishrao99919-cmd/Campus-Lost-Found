"""Database helpers for Campus Lost & Found.

Supports two backends via the DATABASE_URL environment variable:
  - Not set / starts with "sqlite": local SQLite (default, for development)
  - Starts with "postgres": PostgreSQL via psycopg2

On Vercel the filesystem is ephemeral so local SQLite loses data on cold
starts.  Set DATABASE_URL to a hosted PostgreSQL database for production.
"""

import os
import sqlite3
from pathlib import Path

DATABASE_URL = os.environ.get("DATABASE_URL", "")

USE_POSTGRES = DATABASE_URL.startswith("postgres")

if USE_POSTGRES:
    try:
        import psycopg2
        import psycopg2.extras
        import psycopg2.extensions
    except ImportError:
        USE_POSTGRES = False

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "lost_found.db"
SCHEMA_PATH = BASE_DIR / "schema.sql"
UPLOAD_DIR = BASE_DIR / "uploads"

ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}


# ---------------------------------------------------------------------------
# PostgreSQL wrapper — makes psycopg2 behave like sqlite3 for our code
# ---------------------------------------------------------------------------

class _PgRow:
    """Thin wrapper so dict(row) works identically to sqlite3.Row."""
    __slots__ = ("_d",)

    def __init__(self, d):
        self._d = d

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self._d.values())[key]
        return self._d[key]

    def __contains__(self, key):
        return key in self._d

    def __iter__(self):
        return iter(self._d)

    def keys(self):
        return self._d.keys()

    def get(self, key, default=None):
        return self._d.get(key, default)


class _PgCursor:
    """Wraps psycopg2 cursor to match sqlite3 cursor interface."""

    def __init__(self, real_cur, lastrowid=None):
        self._cur = real_cur
        self._lastrowid = lastrowid

    @property
    def lastrowid(self):
        return self._lastrowid

    def fetchone(self):
        row = self._cur.fetchone()
        return _PgRow(dict(row)) if row else None

    def fetchall(self):
        return [_PgRow(dict(r)) for r in self._cur.fetchall()]


class _PgConnection:
    """Wraps psycopg2 connection to match sqlite3 connection interface."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, query, params=None):
        q = query.replace("?", "%s")
        q_upper = q.strip().upper()
        if not q_upper.startswith("PRAGMA"):
            q = q.replace("datetime('now')", "NOW()")
            q = q.replace("datetime('now', 'localtime')", "NOW()")
            q = q.replace("INSERT OR IGNORE INTO", "INSERT INTO")
        is_insert = q_upper.startswith("INSERT") or " INSERT " in (" " + q_upper)
        is_or_ignore = " INSERT OR IGNORE " in (" " + q.strip().upper())
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        if is_insert:
            if is_or_ignore and "ON CONFLICT" not in q.upper():
                q += " ON CONFLICT DO NOTHING"
            elif "RETURNING" not in q_upper:
                q += " RETURNING id"
        cur.execute(q, params or ())

        if is_insert:
            row = cur.fetchone()
            lastrowid = row["id"] if row else None
            cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        else:
            lastrowid = None

        return _PgCursor(cur, lastrowid)

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()

    def executescript(self, script):
        cur = self._conn.cursor()
        for stmt in script.split(";"):
            stmt = stmt.strip()
            if stmt:
                adapted = stmt.replace("?", "%s")
                adapted = adapted.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
                adapted = adapted.replace("datetime('now')", "NOW()")
                if adapted.upper().startswith("PRAGMA"):
                    continue
                cur.execute(adapted)
        self._conn.commit()


def _adapt_schema_for_pg(script):
    """Minimal SQLite→PostgreSQL schema translation."""
    script = script.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
    script = script.replace("datetime('now')", "NOW()")
    lines = [l for l in script.split("\n") if not l.strip().startswith("PRAGMA")]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Connection factory
# ---------------------------------------------------------------------------

def get_connection():
    """Return a database connection (SQLite or PostgreSQL)."""
    if USE_POSTGRES:
        conn = psycopg2.connect(DATABASE_URL)
        conn.autocommit = False
        return _PgConnection(conn)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _pg_table_columns(conn, table_name):
    """Return set of column names for a table (PostgreSQL)."""
    cur = conn._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = %s",
        (table_name,),
    )
    return {row["column_name"] for row in cur.fetchall()}


def _existing_items_columns(conn):
    if USE_POSTGRES:
        return _pg_table_columns(conn, "items")
    return {row[1] for row in conn.execute("PRAGMA table_info(items)")}


def init_db():
    """Create the database file and tables if they do not exist."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    conn = get_connection()
    try:
        schema_sql = open(SCHEMA_PATH, "r", encoding="utf-8").read()
        if USE_POSTGRES:
            schema_sql = _adapt_schema_for_pg(schema_sql)
        conn.executescript(schema_sql)

        # --- idempotent migration tweaks ---
        user_cols = (
            _pg_table_columns(conn, "users") if USE_POSTGRES
            else {row[1] for row in conn.execute("PRAGMA table_info(users)")}
        )
        if user_cols and "role" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
        if user_cols and "blocked" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0")

        columns = _existing_items_columns(conn)
        if columns and "reporter_id" not in columns:
            conn.execute(
                "ALTER TABLE items ADD COLUMN reporter_id INTEGER REFERENCES users(id)"
            )
        if columns and "university" not in columns:
            conn.execute(
                "ALTER TABLE items ADD COLUMN university TEXT NOT NULL DEFAULT 'other'"
            )
        conn.commit()
    finally:
        conn.close()


def rows_to_dicts(rows):
    return [dict(row) for row in rows]
