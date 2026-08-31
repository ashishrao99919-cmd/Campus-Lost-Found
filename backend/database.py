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

    def __init__(self, real_cur):
        self._cur = real_cur

    def fetchone(self):
        row = self._cur.fetchone()
        return _PgRow(dict(row)) if row else None

    def fetchall(self):
        return [_PgRow(dict(r)) for r in self._cur.fetchall()]


class _PgConnection:
    """Wraps psycopg2 connection to match sqlite3 connection interface."""

    def __init__(self, conn):
        self._conn = conn
        self._lastrowid = None

    def execute(self, query, params=None):
        q = query.replace("?", "%s")
        q_upper = q.strip().upper()
        is_insert = q_upper.startswith("INSERT") and "RETURNING" not in q_upper
        if is_insert:
            q += " RETURNING id"

        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(q, params or ())

        if is_insert:
            row = cur.fetchone()
            self._lastrowid = row["id"] if row else None
            cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        return _PgCursor(cur)

    @property
    def lastrowid(self):
        return self._lastrowid

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
    cur = conn._conn.cursor()
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
        if USE_POSTGRES:
            existing = _pg_existing_tables(conn)
        else:
            existing = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )}

        # --- items table (always created via schema.sql) ---
        # --- users table tweaks (idempotent) ---
        user_cols = (
            _pg_table_columns(conn, "users") if USE_POSTGRES
            else {row[1] for row in conn.execute("PRAGMA table_info(users)")}
        )

        if USE_POSTGRES:
            if user_cols and "role" not in user_cols:
                conn.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
            if user_cols and "blocked" not in user_cols:
                conn.execute("ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0")
        else:
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

        if "claims" not in existing:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS claims (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    listing_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                    claimant_id INTEGER NOT NULL REFERENCES users(id),
                    proof_details TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'rejected')),
                    resolved_at TEXT,
                    resolved_by INTEGER REFERENCES users(id),
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(listing_id, claimant_id)
                );
                CREATE INDEX IF NOT EXISTS idx_claims_listing ON claims(listing_id);
                CREATE INDEX IF NOT EXISTS idx_claims_claimant ON claims(claimant_id);
                CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);

                CREATE TABLE IF NOT EXISTS claim_notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    listing_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                    notification_type TEXT NOT NULL CHECK (notification_type IN ('accepted', 'rejected')),
                    title TEXT NOT NULL DEFAULT '',
                    item_name TEXT NOT NULL DEFAULT '',
                    is_read INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_claim_notif_user ON claim_notifications(user_id);
            """)

        with open(SCHEMA_PATH, "r", encoding="utf-8") as fh:
            schema_sql = fh.read()
        if USE_POSTGRES:
            schema_sql = _adapt_schema_for_pg(schema_sql)
        conn.executescript(schema_sql)
        conn.commit()
    finally:
        conn.close()


def _pg_existing_tables(conn):
    cur = conn._conn.cursor()
    cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    return {row["tablename"] for row in cur.fetchall()}


def rows_to_dicts(rows):
    return [dict(row) for row in rows]
