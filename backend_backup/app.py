"""Flask backend for Campus Lost & Found (SQLite, no external services)."""

import re
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename

from database import (
    ALLOWED_IMAGE_EXTENSIONS,
    BASE_DIR,
    UPLOAD_DIR,
    get_connection,
    init_db,
    rows_to_dicts,
)

app = Flask(__name__)
CORS(app)

app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # 8 MB upload cap

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

REQUIRED_FIELDS = ("item_name", "category", "type", "description", "date",
                   "location", "contact_number")

FIELD_LIMITS = {
    "item_name": 150,
    "category": 60,
    "description": 2000,
    "location": 100,
    "contact_number": 30,
    "email": 120,
    "additional_details": 2000,
}

UPDATABLE_FIELDS = ("item_name", "category", "type", "description", "date",
                    "location", "contact_number", "email", "additional_details",
                    "status")


# ---------------------------------------------------------------- helpers

def open_db():
    if "db" not in g:
        g.db = get_connection()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def fail(message, code=400):
    return jsonify({"success": False, "message": message}), code


def ok(message, item=None, code=200, **extra):
    payload = {"success": True, "message": message}
    if item is not None:
        payload["item"] = item
    payload.update(extra)
    return jsonify(payload), code


def serialize(row):
    """Row dict -> API dict with an absolute image_url when available."""
    data = dict(row)
    image_path = data.get("image_path")
    data["image_url"] = f"{request.host_url}{image_path}" if image_path else None
    return data


def fetch_item(item_id):
    row = open_db().execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    return serialize(row) if row else None


def validate_payload(data, partial=False):
    """Return (clean_fields, error_response). error_response is None when valid."""
    clean = {}

    for field in (REQUIRED_FIELDS if not partial else ()):
        value = data.get(field)
        if not isinstance(value, str) or not value.strip():
            return None, fail(f"Missing required field: {field}")

    for field in UPDATABLE_FIELDS:
        if field not in data:
            continue
        value = data[field]
        if not isinstance(value, str):
            return None, fail(f"Field must be a string: {field}")
        value = value.strip()
        limit = FIELD_LIMITS.get(field)
        if limit and len(value) > limit:
            return None, fail(f"Field too long (max {limit} characters): {field}")
        clean[field] = value

    if "type" in clean and clean["type"] not in ("lost", "found"):
        return None, fail("Field 'type' must be 'lost' or 'found'.")

    if "status" in clean and clean["status"] not in ("lost", "found", "returned"):
        return None, fail("Field 'status' must be 'lost', 'found' or 'returned'.")

    if "email" in clean and clean["email"]:
        if not EMAIL_RE.match(clean["email"]):
            return None, fail("Field 'email' does not look like a valid email address.")
    elif partial and data.get("email") == "":
        clean["email"] = ""

    if "date" in clean:
        try:
            datetime.strptime(clean["date"], "%Y-%m-%d")
        except ValueError:
            return None, fail("Field 'date' must use the YYYY-MM-DD format.")

    if not clean and partial:
        return None, fail("No valid fields to update.")

    return clean, None


def delete_upload_file(image_path):
    """Best-effort removal of an orphaned file inside uploads/."""
    if not image_path:
        return
    candidate = (BASE_DIR / image_path).resolve()
    try:
        candidate.relative_to(UPLOAD_DIR.resolve())
    except ValueError:
        return
    if candidate.is_file():
        try:
            candidate.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------- routes

@app.get("/api/items")
def list_items():
    clauses, params = [], []

    item_type = request.args.get("type")
    if item_type:
        if item_type not in ("lost", "found"):
            return fail("Query parameter 'type' must be 'lost' or 'found'.")
        clauses.append("type = ?")
        params.append(item_type)

    status = request.args.get("status")
    if status:
        if status not in ("lost", "found", "returned"):
            return fail("Query parameter 'status' must be 'lost', 'found' or 'returned'.")
        clauses.append("status = ?")
        params.append(status)

    search = request.args.get("search", "").strip()
    if search:
        needle = f"%{search}%"
        clauses.append(
            "(item_name LIKE ? OR category LIKE ? OR location LIKE ? OR description LIKE ?)"
        )
        params.extend([needle, needle, needle, needle])

    sql = "SELECT * FROM items"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY created_at DESC, id DESC"

    rows = open_db().execute(sql, params).fetchall()
    items = [serialize(r) for r in rows]
    return ok("Items retrieved successfully", count=len(items), items=items)


@app.post("/api/items")
def create_item():
    data = request.get_json(silent=True)
    if data is None:
        return fail("Request body must be valid JSON.")

    fields, error = validate_payload(data, partial=False)
    if error:
        return error

    fields["status"] = data.get("status") or fields["type"]
    fields["email"] = fields.get("email", "")
    fields["additional_details"] = fields.get("additional_details", "")

    db = open_db()
    cursor = db.execute(
        """INSERT INTO items
               (item_name, category, type, description, date, location,
                contact_number, email, additional_details, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (fields["item_name"], fields["category"], fields["type"],
         fields["description"], fields["date"], fields["location"],
         fields["contact_number"], fields["email"],
         fields["additional_details"], fields["status"]),
    )
    db.commit()
    item = fetch_item(cursor.lastrowid)
    return ok("Item created successfully", item=item, code=201)


@app.get("/api/items/<int:item_id>")
def get_item(item_id):
    item = fetch_item(item_id)
    if item is None:
        return fail("Item not found", code=404)
    return ok("Item retrieved successfully", item=item)


@app.put("/api/items/<int:item_id>")
def update_item(item_id):
    if fetch_item(item_id) is None:
        return fail("Item not found", code=404)

    data = request.get_json(silent=True)
    if data is None:
        return fail("Request body must be valid JSON.")

    fields, error = validate_payload(data, partial=True)
    if error:
        return error
    fields.pop("id", None)

    assignments = ", ".join(f"{name} = ?" for name in fields)
    params = list(fields.values())
    db = open_db()
    db.execute(
        f"UPDATE items SET {assignments}, updated_at = datetime('now') WHERE id = ?",
        [*params, item_id],
    )
    db.commit()
    return ok("Item updated successfully", item=fetch_item(item_id))


@app.delete("/api/items/<int:item_id>")
def delete_item(item_id):
    item = fetch_item(item_id)
    if item is None:
        return fail("Item not found", code=404)

    db = open_db()
    db.execute("DELETE FROM items WHERE id = ?", (item_id,))
    db.commit()
    delete_upload_file(item.get("image_path"))
    return ok("Item deleted successfully")


@app.put("/api/items/<int:item_id>/returned")
def mark_returned(item_id):
    if fetch_item(item_id) is None:
        return fail("Item not found", code=404)

    db = open_db()
    db.execute(
        "UPDATE items SET status = 'returned', updated_at = datetime('now') WHERE id = ?",
        (item_id,),
    )
    db.commit()
    return ok("Item marked as returned successfully", item=fetch_item(item_id))


@app.post("/api/items/<int:item_id>/image")
def upload_image(item_id):
    if fetch_item(item_id) is None:
        return fail("Item not found", code=404)

    file = request.files.get("image") or next(iter(request.files.values()), None)
    if file is None or not file.filename:
        return fail("No image file provided. Send multipart/form-data with an 'image' field.")

    original = secure_filename(file.filename)
    extension = original.rsplit(".", 1)[-1].lower() if "." in original else ""
    if extension not in ALLOWED_IMAGE_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_IMAGE_EXTENSIONS))
        return fail(f"Unsupported image type. Allowed: {allowed}.")

    unique_name = f"item_{item_id}_{uuid.uuid4().hex[:8]}_{original}"
    destination = UPLOAD_DIR / unique_name
    resolved = destination.resolve()
    if UPLOAD_DIR.resolve() not in resolved.parents:
        return fail("Invalid file path.", code=400)

    previous_path = (fetch_item(item_id) or {}).get("image_path")
    file.save(destination)

    db = open_db()
    db.execute(
        "UPDATE items SET image_path = ?, updated_at = datetime('now') WHERE id = ?",
        (f"uploads/{unique_name}", item_id),
    )
    db.commit()
    if previous_path and previous_path != f"uploads/{unique_name}":
        delete_upload_file(previous_path)

    return ok("Image uploaded successfully", item=fetch_item(item_id))


@app.get("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


@app.errorhandler(404)
def not_found(_e):
    return fail("Endpoint not found", code=404)


@app.errorhandler(405)
def method_not_allowed(_e):
    return fail("Method not allowed", code=405)


@app.errorhandler(413)
def too_large(_e):
    return fail("Upload too large. Maximum size is 8 MB.", code=413)


@app.errorhandler(500)
def server_error(_e):
    return fail("Internal server error", code=500)


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
