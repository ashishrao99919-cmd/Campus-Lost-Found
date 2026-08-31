"""Flask backend for Campus Lost & Found."""

import os
import re
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory, session
from flask_cors import CORS
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash

from category_rules import validate_category
from content_rules import validate_listing_content
from matching import run_matchmaker
from database import (
    ALLOWED_IMAGE_EXTENSIONS,
    BASE_DIR,
    UPLOAD_DIR,
    get_connection,
    init_db,
    rows_to_dicts,
)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "campus-lost-found-secret-key")

PRODUCTION = os.environ.get("VERCEL", "") or os.environ.get("FLASK_ENV") == "production"

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=PRODUCTION,
)

_cors_origins = os.environ.get("CORS_ORIGINS", "")
if _cors_origins:
    _allowed = [o.strip() for o in _cors_origins.split(",") if o.strip()]
else:
    _allowed = ["http://localhost:5173", "http://127.0.0.1:5173"]
CORS(
    app,
    supports_credentials=True,
    origins=_allowed,
)

app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # 8 MB upload cap

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

REQUIRED_FIELDS = ("item_name", "category", "type", "description", "date",
                   "location", "contact_number", "university")

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
                    "university", "status")

UNIVERSITIES = [
    ("mdu", "Maharshi Dayanand University (MDU)"),
    ("du", "Delhi University (DU)"),
    ("kuk", "Kurukshetra University (KUK)"),
    ("pu", "Panjab University"),
    ("amity", "Amity University"),
    ("lpu", "Lovely Professional University (LPU)"),
    ("cu", "Chandigarh University"),
    ("gju", "Guru Jambheshwar University"),
    ("mau", "Maharaja Agrasen University"),
    ("other", "Other"),
]
VALID_UNIVERSITY_IDS = {uid for uid, _ in UNIVERSITIES}

VALID_REPORT_REASONS = {
    "fake", "wrong_category", "prohibited", "duplicate",
    "inappropriate", "incorrect_info", "other",
}


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
    user_id = session.get("user_id")
    data["is_owner"] = bool(
        user_id is not None
        and data.get("reporter_id") is not None
        and data["reporter_id"] == user_id
    )
    data.pop("reporter_id", None)
    item_id = row["id"]
    db = open_db()
    counts = db.execute(
        "SELECT COUNT(*) as total, "
        "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending "
        "FROM reports WHERE listing_id = ?", (item_id,)
    ).fetchone()
    data["report_count"] = counts["total"] if counts else 0
    data["pending_report_count"] = counts["pending"] if counts else 0
    claim_counts = db.execute(
        "SELECT COUNT(*) as total, "
        "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending "
        "FROM claims WHERE listing_id = ?", (item_id,)
    ).fetchone()
    data["claim_count"] = claim_counts["total"] if claim_counts else 0
    data["pending_claim_count"] = claim_counts["pending"] if claim_counts else 0
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

    if "university" in clean and clean["university"] not in VALID_UNIVERSITY_IDS:
        return None, fail("Invalid university. Please choose from the provided options.")

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
def ensure_content_allowed(data):
    """Return a 400 response when title/description/category hit the
    prohibited list (motor vehicles except bicycles, living things, weapons)."""
    verdict = validate_listing_content(
        data.get("item_name"),
        data.get("description"),
        data.get("category"),
    )
    if not verdict.get("allowed"):
        return jsonify({
            "success": False,
            "message": f"This listing cannot be submitted. {verdict['reason']}",
            "error": "Prohibited content"
        }), 400
    return None


def ensure_owner(item):
    """Return an error response unless the session user owns this item."""
    user_id = session.get("user_id")
    if user_id is None:
        return jsonify({
            "success": False,
            "message": "Please log in to manage this listing.",
            "error": "Authentication required."
        }), 401
    raw = open_db().execute("SELECT reporter_id FROM items WHERE id = ?", (item["id"],)).fetchone()
    if not raw or raw["reporter_id"] is None or raw["reporter_id"] != user_id:
        message = "Only the user who reported this item can modify it."
        return jsonify({"success": False, "message": message, "error": message}), 403
    return None


def ensure_admin():
    """Return an error response unless the session user is an admin."""
    user_id = session.get("user_id")
    if user_id is None:
        return jsonify({
            "success": False,
            "message": "Please log in to access admin features.",
            "error": "Authentication required."
        }), 401
    row = open_db().execute(
        "SELECT role FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if not row or row["role"] != "admin":
        return jsonify({
            "success": False,
            "message": "You do not have permission to access admin features.",
            "error": "Forbidden."
        }), 403
    return None


def log_admin_action(action, target_type, target_id=None, details=""):
    user_id = session.get("user_id")
    if user_id is None:
        return
    db = open_db()
    db.execute(
        "INSERT INTO admin_logs (admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
        (user_id, action, target_type, target_id, details),
    )
    db.commit()


@app.post("/api/categories/validate")
def validate_item_category():
    data = request.get_json(silent=True) or {}
    result = validate_category(
        data.get("title"),
        data.get("description"),
        str(data.get("category", "")).strip(),
    )
    return jsonify({"success": True, **result})


@app.post("/api/listings/check")
def check_listing_content():
    data = request.get_json(silent=True) or {}
    verdict = validate_listing_content(
        data.get("title"),
        data.get("description"),
        data.get("category"),
    )
    return jsonify({"success": True, **verdict})


@app.post("/api/auth/register")
def register():
    data = request.get_json(silent=True)

    if not data:
        return fail("Request body must be valid JSON.")

    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if not name:
        return fail("Name is required.")

    if not email or not EMAIL_RE.match(email):
        return fail("Please enter a valid email.")

    if len(password) < 6:
        return fail("Password must be at least 6 characters.")

    db = open_db()

    existing = db.execute(
        "SELECT id FROM users WHERE email = ?",
        (email,)
    ).fetchone()

    if existing:
        return fail("An account with this email already exists.", 409)

    password_hash = generate_password_hash(password)

    cursor = db.execute(
        """
        INSERT INTO users (name, email, password)
        VALUES (?, ?, ?)
        """,
        (name, email, password_hash)
    )

    db.commit()

    session["user_id"] = cursor.lastrowid
    session["user_name"] = name
    session["user_email"] = email

    return jsonify({
        "success": True,
        "message": "Account created successfully.",
        "user": {
            "id": cursor.lastrowid,
            "name": name,
            "email": email,
            "role": "user"
        }
    }), 201


@app.post("/api/auth/login")
def login():
    data = request.get_json(silent=True)

    if not data:
        return fail("Request body must be valid JSON.", 400)

    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if not email or not password:
        return fail("Email and password are required.", 400)

    db = open_db()
    row = db.execute(
        "SELECT id, name, email, password, role, blocked FROM users WHERE email = ?",
        (email,)
    ).fetchone()

    if row is None or not check_password_hash(row["password"], password):
        return fail("Invalid email or password.", 401)

    if row["blocked"]:
        return fail("This account has been disabled. Please contact support.", 403)

    session["user_id"] = row["id"]
    session["user_name"] = row["name"]
    session["user_email"] = row["email"]

    return jsonify({
        "success": True,
        "message": "Login successful.",
        "user": {
            "id": row["id"],
            "name": row["name"],
            "email": row["email"],
            "role": row["role"]
        }
    })


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify({
        "success": True,
        "message": "Logged out successfully."
    })


@app.get("/api/auth/me")
def me():
    if "user_id" not in session:
        return fail("Not authenticated.", 401)

    db = open_db()
    row = db.execute(
        "SELECT id, name, email, role, blocked FROM users WHERE id = ?",
        (session["user_id"],)
    ).fetchone()

    if not row:
        session.clear()
        return fail("Not authenticated.", 401)

    return jsonify({
        "success": True,
        "user": {
            "id": row["id"],
            "name": row["name"],
            "email": row["email"],
            "role": row["role"]
        }
    })


@app.get("/api/universities")
def list_universities():
    items = [{"id": uid, "label": label} for uid, label in UNIVERSITIES]
    return jsonify({"success": True, "universities": items})


@app.get("/api/items")
def list_items():
    clauses, params = [], []

    mine = request.args.get("mine")
    if mine in ("1", "true"):
        user_id = session.get("user_id")
        if user_id is None:
            return fail("You must be logged in to view your listings.", 401)
        clauses.append("reporter_id = ?")
        params.append(user_id)

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

    university = request.args.get("university", "").strip().lower()
    if university:
        if university not in VALID_UNIVERSITY_IDS:
            return fail("Query parameter 'university' is not valid.")
        clauses.append("university = ?")
        params.append(university)

    search = request.args.get("search", "").strip()
    if search:
        needle = f"%{search}%"
        clauses.append(
            "(item_name LIKE ? OR category LIKE ? OR location LIKE ? OR description LIKE ? OR university LIKE ?)"
        )
        params.extend([needle, needle, needle, needle, needle])

    category = request.args.get("category", "").strip().lower()
    if category:
        clauses.append("category = ?")
        params.append(category)

    location = request.args.get("location", "").strip()
    if location:
        clauses.append("location = ?")
        params.append(location)

    days = request.args.get("days", "").strip()
    if days and days != "any":
        try:
            days_int = int(days)
            if days_int > 0:
                from datetime import timedelta
                cutoff = (datetime.now() - timedelta(days=days_int)).strftime("%Y-%m-%d")
                clauses.append("date >= ?")
                params.append(cutoff)
        except (ValueError, TypeError):
            pass

    sql = "SELECT * FROM items"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY created_at DESC, id DESC"

    rows = open_db().execute(sql, params).fetchall()
    items = [serialize(r) for r in rows]
    return ok("Items retrieved successfully", count=len(items), items=items)


@app.post("/api/items")
def create_item():
    user_id = session.get("user_id")
    if user_id is None:
        return fail("You must be logged in to report an item.", 401)

    data = request.get_json(silent=True)
    if data is None:
        return fail("Request body must be valid JSON.")

    content_guard = ensure_content_allowed(data)
    if content_guard:
        return content_guard

    fields, error = validate_payload(data, partial=False)
    if error:
        return error

    fields["status"] = data.get("status") or fields["type"]
    fields["email"] = fields.get("email", "")
    fields["additional_details"] = fields.get("additional_details", "")
    fields["university"] = data.get("university", "other")

    db = open_db()
    cursor = db.execute(
        """INSERT INTO items
               (item_name, category, type, description, date, location,
                contact_number, email, additional_details, status, reporter_id,
                university)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (fields["item_name"], fields["category"], fields["type"],
         fields["description"], fields["date"], fields["location"],
         fields["contact_number"], fields["email"],
         fields["additional_details"], fields["status"], user_id,
         fields["university"]),
    )
    db.commit()
    item = fetch_item(cursor.lastrowid)
    try:
        run_matchmaker(db, cursor.lastrowid)
    except Exception:
        pass
    return ok("Item created successfully", item=item, code=201)


@app.get("/api/items/<int:item_id>")
def get_item(item_id):
    item = fetch_item(item_id)
    if item is None:
        return fail("Item not found", code=404)
    return ok("Item retrieved successfully", item=item)


@app.put("/api/items/<int:item_id>")
def update_item(item_id):
    item = fetch_item(item_id)
    if item is None:
        return fail("Item not found", code=404)

    guard = ensure_owner(item)
    if guard:
        return guard

    data = request.get_json(silent=True)
    if data is None:
        return fail("Request body must be valid JSON.")

    content_guard = ensure_content_allowed(data)
    if content_guard:
        return content_guard

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
    try:
        run_matchmaker(db, item_id)
    except Exception:
        pass
    return ok("Item updated successfully", item=fetch_item(item_id))


@app.delete("/api/items/<int:item_id>")
def delete_item(item_id):
    item = fetch_item(item_id)
    if item is None:
        return fail("Item not found", code=404)

    guard = ensure_owner(item)
    if guard:
        return guard

    if item.get("status") == "returned":
        return fail(
            "This item has been marked as returned and can no longer be deleted.",
            code=400,
        )

    db = open_db()
    db.execute("DELETE FROM items WHERE id = ?", (item_id,))
    db.commit()
    delete_upload_file(item.get("image_path"))
    return ok("Item deleted successfully")


@app.put("/api/items/<int:item_id>/returned")
def mark_returned(item_id):
    user_id = session.get("user_id")
    if user_id is None:
        return jsonify({
            "success": False,
            "message": "Please log in to mark items as returned.",
            "error": "Authentication required."
        }), 401

    item = fetch_item(item_id)
    if item is None:
        return fail("Item not found", code=404)

    raw = open_db().execute("SELECT reporter_id FROM items WHERE id = ?", (item_id,)).fetchone()
    if not raw or raw["reporter_id"] is None or raw["reporter_id"] != user_id:
        message = "Only the user who reported this item can mark it as returned."
        return jsonify({
            "success": False,
            "message": message,
            "error": message
        }), 403

    db = open_db()
    db.execute(
        "UPDATE items SET status = 'returned', updated_at = datetime('now') WHERE id = ?",
        (item_id,),
    )
    db.execute(
        "DELETE FROM match_notifications WHERE listing_id = ? OR matched_listing_id = ?",
        (item_id, item_id),
    )
    db.execute(
        "UPDATE claims SET status = 'rejected', resolved_at = datetime('now') WHERE listing_id = ? AND status = 'pending'",
        (item_id,),
    )
    db.commit()
    return ok("Item marked as returned successfully", item=fetch_item(item_id))


@app.post("/api/items/<int:item_id>/image")
def upload_image(item_id):
    item = fetch_item(item_id)
    if item is None:
        return fail("Item not found", code=404)

    guard = ensure_owner(item)
    if guard:
        return guard

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


# ---------------------------------------------------------------- smart match routes

@app.get("/api/items/<int:item_id>/matches")
def get_item_matches(item_id):
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in to view matches.", 401)

    db = open_db()
    item = db.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    if not item:
        return fail("Item not found", 404)
    item = dict(item)
    if item["reporter_id"] != user_id:
        return fail("You do not have permission to view matches for this listing.", 403)

    rows = db.execute(
        "SELECT mn.*, i.item_name, i.type, i.category, i.location, i.university, i.date, i.status "
        "FROM match_notifications mn "
        "JOIN items i ON mn.matched_listing_id = i.id "
        "WHERE mn.listing_id = ? AND i.status != 'returned' "
        "AND NOT EXISTS ("
        "  SELECT 1 FROM match_dismissals md "
        "  WHERE md.listing_id = mn.listing_id "
        "  AND md.matched_listing_id = mn.matched_listing_id "
        "  AND md.user_id = ?"
        ") "
        "ORDER BY mn.confidence ASC, mn.created_at DESC",
        (item_id, user_id),
    ).fetchall()

    matches = []
    for r in rows:
        rd = dict(r)
        matches.append({
            "id": rd["id"],
            "listingId": str(rd["matched_listing_id"]),
            "confidence": rd["confidence"],
            "title": rd["item_name"],
            "category": rd["category"],
            "location": rd["location"],
            "university": rd["university"],
            "date": rd["date"],
            "type": rd["type"],
            "createdAt": rd["created_at"],
        })

    return jsonify({"success": True, "matches": matches, "count": len(matches)})


@app.get("/api/notifications")
def list_notifications():
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in to view notifications.", 401)

    db = open_db()
    rows = db.execute(
        "SELECT mn.*, i.item_name, i.type, i.category, i.university "
        "FROM match_notifications mn "
        "JOIN items i ON mn.listing_id = i.id "
        "WHERE mn.user_id = ? "
        "ORDER BY mn.is_read ASC, mn.created_at DESC LIMIT 50",
        (user_id,),
    ).fetchall()

    claim_rows = db.execute(
        "SELECT cn.*, i.type, i.category, i.university "
        "FROM claim_notifications cn "
        "JOIN items i ON cn.listing_id = i.id "
        "WHERE cn.user_id = ? "
        "ORDER BY cn.is_read ASC, cn.created_at DESC LIMIT 50",
        (user_id,),
    ).fetchall()

    unread_match = db.execute(
        "SELECT COUNT(*) FROM match_notifications WHERE user_id = ? AND is_read = 0",
        (user_id,),
    ).fetchone()[0]

    unread_claim = db.execute(
        "SELECT COUNT(*) FROM claim_notifications WHERE user_id = ? AND is_read = 0",
        (user_id,),
    ).fetchone()[0]

    notifications = []
    for r in rows:
        rd = dict(r)
        notifications.append({
            "id": f"m{rd['id']}",
            "listingId": str(rd["listing_id"]),
            "matchedListingId": str(rd["matched_listing_id"]),
            "confidence": rd["confidence"],
            "title": rd["title"],
            "itemName": rd["item_name"],
            "itemType": rd["type"],
            "category": rd["category"],
            "university": rd["university"],
            "isRead": rd["is_read"] == 1,
            "createdAt": rd["created_at"],
            "notifType": "match",
        })

    for r in claim_rows:
        rd = dict(r)
        notifications.append({
            "id": f"c{rd['id']}",
            "listingId": str(rd["listing_id"]),
            "title": rd["title"],
            "itemName": rd["item_name"],
            "itemType": rd["type"],
            "category": rd["category"],
            "university": rd["university"],
            "isRead": rd["is_read"] == 1,
            "createdAt": rd["created_at"],
            "notifType": "claim",
            "claimStatus": rd["notification_type"],
        })

    notifications.sort(key=lambda n: (n["isRead"], n.get("createdAt", "")), reverse=False)

    return jsonify({
        "success": True,
        "notifications": notifications[:50],
        "unreadCount": unread_match + unread_claim,
    })


@app.put("/api/notifications/<notif_id>/read")
def mark_notification_read(notif_id):
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in.", 401)

    db = open_db()
    notif_id_str = str(notif_id)
    if notif_id_str.startswith("m"):
        try:
            real_id = int(notif_id_str[1:])
        except ValueError:
            return fail("Invalid notification ID.", 400)
        row = db.execute(
            "SELECT id, user_id FROM match_notifications WHERE id = ?", (real_id,)
        ).fetchone()
        if not row:
            return fail("Notification not found.", 404)
        if row["user_id"] != user_id:
            return fail("Access denied.", 403)
        db.execute("UPDATE match_notifications SET is_read = 1 WHERE id = ?", (real_id,))
    elif notif_id_str.startswith("c"):
        try:
            real_id = int(notif_id_str[1:])
        except ValueError:
            return fail("Invalid notification ID.", 400)
        row = db.execute(
            "SELECT id, user_id FROM claim_notifications WHERE id = ?", (real_id,)
        ).fetchone()
        if not row:
            return fail("Notification not found.", 404)
        if row["user_id"] != user_id:
            return fail("Access denied.", 403)
        db.execute("UPDATE claim_notifications SET is_read = 1 WHERE id = ?", (real_id,))
    else:
        return fail("Invalid notification ID.", 400)

    db.commit()
    return jsonify({"success": True, "message": "Notification marked as read."})


@app.put("/api/notifications/read-all")
def mark_all_notifications_read():
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in.", 401)

    db = open_db()
    db.execute(
        "UPDATE match_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
        (user_id,),
    )
    db.execute(
        "UPDATE claim_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
        (user_id,),
    )
    db.commit()
    return jsonify({"success": True, "message": "All notifications marked as read."})


@app.put("/api/matches/<int:match_id>/dismiss")
def dismiss_match(match_id):
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in.", 401)

    db = open_db()
    row = db.execute(
        "SELECT id, listing_id, matched_listing_id, user_id FROM match_notifications WHERE id = ?",
        (match_id,),
    ).fetchone()
    if not row:
        return fail("Match not found.", 404)
    if row["user_id"] != user_id:
        return fail("Access denied.", 403)

    db.execute(
        "INSERT OR IGNORE INTO match_dismissals (listing_id, matched_listing_id, user_id) VALUES (?, ?, ?)",
        (row["listing_id"], row["matched_listing_id"], user_id),
    )
    db.execute("DELETE FROM match_notifications WHERE id = ?", (match_id,))
    db.commit()
    return jsonify({"success": True, "message": "Match dismissed."})


# ---------------------------------------------------------------- claim routes

@app.post("/api/items/<int:item_id>/claim")
def create_claim(item_id):
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in to claim an item.", 401)

    db = open_db()
    item = db.execute("SELECT id, type, reporter_id, item_name FROM items WHERE id = ?", (item_id,)).fetchone()
    if not item:
        return fail("Item not found.", 404)

    if item["type"] != "found":
        return fail("Only found items can be claimed.", 400)

    if item["reporter_id"] is not None and item["reporter_id"] == user_id:
        return fail("You cannot claim your own listing.", 400)

    existing = db.execute(
        "SELECT id, status FROM claims WHERE listing_id = ? AND claimant_id = ?",
        (item_id, user_id),
    ).fetchone()
    if existing:
        if existing["status"] == "pending":
            return fail("You already have a pending claim for this item.")
        return fail("You have already submitted a claim for this item.")

    data = request.get_json(silent=True) or {}
    proof = (data.get("proof_details") or "").strip()
    if not proof or len(proof) < 10:
        return fail("Please provide proof or details that only the real owner would know (at least 10 characters).")
    proof = proof[:1000]

    cur = db.execute(
        "INSERT INTO claims (listing_id, claimant_id, proof_details) VALUES (?, ?, ?)",
        (item_id, user_id, proof),
    )
    db.commit()

    return jsonify({
        "success": True,
        "message": "Claim submitted successfully. The item owner will review your request.",
        "claim": {
            "id": cur.lastrowid,
            "listing_id": item_id,
            "status": "pending",
        },
    }), 201


@app.get("/api/items/<int:item_id>/claims")
def list_item_claims(item_id):
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in.", 401)

    db = open_db()
    item = db.execute("SELECT id, reporter_id FROM items WHERE id = ?", (item_id,)).fetchone()
    if not item:
        return fail("Item not found.", 404)

    if item["reporter_id"] is None or item["reporter_id"] != user_id:
        return fail("Only the item owner can view claims.", 403)

    rows = db.execute(
        "SELECT c.*, u.name as claimant_name "
        "FROM claims c JOIN users u ON c.claimant_id = u.id "
        "WHERE c.listing_id = ? ORDER BY c.created_at DESC",
        (item_id,),
    ).fetchall()

    claims = []
    for r in rows:
        rd = dict(r)
        claims.append({
            "id": rd["id"],
            "listing_id": rd["listing_id"],
            "claimant_id": rd["claimant_id"],
            "claimant_name": rd["claimant_name"],
            "proof_details": rd["proof_details"],
            "status": rd["status"],
            "resolved_at": rd["resolved_at"],
            "created_at": rd["created_at"],
        })

    return jsonify({"success": True, "claims": claims, "count": len(claims)})


@app.get("/api/my-claims")
def list_my_claims():
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in.", 401)

    db = open_db()
    rows = db.execute(
        "SELECT c.*, i.item_name, i.type, i.category, i.location, i.university "
        "FROM claims c JOIN items i ON c.listing_id = i.id "
        "WHERE c.claimant_id = ? ORDER BY c.created_at DESC",
        (user_id,),
    ).fetchall()

    claims = []
    for r in rows:
        rd = dict(r)
        claims.append({
            "id": rd["id"],
            "listing_id": rd["listing_id"],
            "item_name": rd["item_name"],
            "item_type": rd["type"],
            "category": rd["category"],
            "location": rd["location"],
            "university": rd["university"],
            "status": rd["status"],
            "created_at": rd["created_at"],
            "resolved_at": rd["resolved_at"],
        })

    return jsonify({"success": True, "claims": claims, "count": len(claims)})


@app.put("/api/claims/<int:claim_id>/accept")
def accept_claim(claim_id):
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in.", 401)

    db = open_db()
    claim = db.execute("SELECT * FROM claims WHERE id = ?", (claim_id,)).fetchone()
    if not claim:
        return fail("Claim not found.", 404)

    claim = dict(claim)
    if claim["status"] != "pending":
        return fail("This claim has already been actioned.")

    item = db.execute("SELECT id, reporter_id, item_name FROM items WHERE id = ?", (claim["listing_id"],)).fetchone()
    if not item or item["reporter_id"] is None or item["reporter_id"] != user_id:
        return fail("Only the item owner can accept claims.", 403)

    db.execute(
        "UPDATE claims SET status = 'accepted', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?",
        (user_id, claim_id),
    )
    db.execute(
        "UPDATE items SET status = 'returned', updated_at = datetime('now') WHERE id = ?",
        (claim["listing_id"],),
    )
    db.execute(
        "DELETE FROM match_notifications WHERE listing_id = ? OR matched_listing_id = ?",
        (claim["listing_id"], claim["listing_id"]),
    )
    db.execute(
        "DELETE FROM claims WHERE listing_id = ? AND status = 'pending' AND id != ?",
        (claim["listing_id"], claim_id),
    )
    db.execute(
        "INSERT INTO claim_notifications (claim_id, user_id, listing_id, notification_type, title, item_name) "
        "VALUES (?, ?, ?, 'accepted', ?, ?)",
        (claim_id, claim["claimant_id"], claim["listing_id"],
         f"Your claim on \"{item['item_name']}\" has been accepted!",
         item["item_name"]),
    )
    db.commit()

    return jsonify({"success": True, "message": "Claim accepted. Item marked as returned."})


@app.put("/api/claims/<int:claim_id>/reject")
def reject_claim(claim_id):
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in.", 401)

    db = open_db()
    claim = db.execute("SELECT * FROM claims WHERE id = ?", (claim_id,)).fetchone()
    if not claim:
        return fail("Claim not found.", 404)

    claim = dict(claim)
    if claim["status"] != "pending":
        return fail("This claim has already been actioned.")

    item = db.execute("SELECT id, reporter_id, item_name FROM items WHERE id = ?", (claim["listing_id"],)).fetchone()
    if not item or item["reporter_id"] is None or item["reporter_id"] != user_id:
        return fail("Only the item owner can reject claims.", 403)

    db.execute(
        "UPDATE claims SET status = 'rejected', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?",
        (user_id, claim_id),
    )
    db.execute(
        "INSERT INTO claim_notifications (claim_id, user_id, listing_id, notification_type, title, item_name) "
        "VALUES (?, ?, ?, 'rejected', ?, ?)",
        (claim_id, claim["claimant_id"], claim["listing_id"],
         f"Your claim on \"{item['item_name']}\" was not accepted.",
         item["item_name"]),
    )
    db.commit()

    return jsonify({"success": True, "message": "Claim rejected."})


@app.get("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


# ---------------------------------------------------------------- admin routes

@app.get("/api/admin/stats")
def admin_stats():
    guard = ensure_admin()
    if guard:
        return guard
    db = open_db()
    total_users = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    total_items = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    active_items = db.execute("SELECT COUNT(*) FROM items WHERE status != 'returned'").fetchone()[0]
    returned_items = db.execute("SELECT COUNT(*) FROM items WHERE status = 'returned'").fetchone()[0]
    lost_items = db.execute("SELECT COUNT(*) FROM items WHERE type = 'lost'").fetchone()[0]
    found_items = db.execute("SELECT COUNT(*) FROM items WHERE type = 'found'").fetchone()[0]
    recent_items = [dict(r) for r in db.execute(
        "SELECT i.id, i.item_name, i.type, i.status, i.category, i.location, i.university, i.created_at, u.name as reporter_name "
        "FROM items i LEFT JOIN users u ON i.reporter_id = u.id "
        "ORDER BY i.created_at DESC, i.id DESC LIMIT 5"
    ).fetchall()]
    recent_users = [dict(r) for r in db.execute(
        "SELECT id, name, email, role, blocked, created_at FROM users ORDER BY created_at DESC LIMIT 5"
    ).fetchall()]
    pending_reports = db.execute("SELECT COUNT(*) FROM reports WHERE status = 'pending'").fetchone()[0]
    total_reports = db.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
    total_matches = db.execute("SELECT COUNT(*) FROM match_notifications").fetchone()[0]
    high_matches = db.execute("SELECT COUNT(*) FROM match_notifications WHERE confidence = 'high'").fetchone()[0]
    medium_matches = db.execute("SELECT COUNT(*) FROM match_notifications WHERE confidence = 'medium'").fetchone()[0]
    total_notifications = total_matches
    total_claims = db.execute("SELECT COUNT(*) FROM claims").fetchone()[0]
    pending_claims = db.execute("SELECT COUNT(*) FROM claims WHERE status = 'pending'").fetchone()[0]
    return jsonify({
        "success": True,
        "stats": {
            "total_users": total_users,
            "total_listings": total_items,
            "active_listings": active_items,
            "returned_listings": returned_items,
            "lost_listings": lost_items,
            "found_listings": found_items,
            "pending_reports": pending_reports,
            "total_reports": total_reports,
            "total_matches": total_matches,
            "high_matches": high_matches,
            "medium_matches": medium_matches,
            "total_notifications": total_notifications,
            "total_claims": total_claims,
            "pending_claims": pending_claims,
        },
        "recent_items": recent_items,
        "recent_users": recent_users,
    })


@app.get("/api/admin/users")
def admin_list_users():
    guard = ensure_admin()
    if guard:
        return guard
    db = open_db()
    rows = db.execute(
        "SELECT id, name, email, role, blocked, created_at FROM users ORDER BY created_at DESC"
    ).fetchall()
    return jsonify({"success": True, "users": [dict(r) for r in rows]})


@app.put("/api/admin/users/<int:user_id>")
def admin_update_user(user_id):
    guard = ensure_admin()
    if guard:
        return guard
    db = open_db()
    row = db.execute("SELECT id, name, email, role, blocked FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return fail("User not found.", 404)
    data = request.get_json(silent=True) or {}
    updates = []
    params = []
    if "blocked" in data:
        blocked_val = 1 if data["blocked"] else 0
        updates.append("blocked = ?")
        params.append(blocked_val)
    if "role" in data:
        new_role = data["role"]
        if new_role not in ("user", "admin"):
            return fail("Invalid role. Must be 'user' or 'admin'.")
        updates.append("role = ?")
        params.append(new_role)
    if not updates:
        return fail("No valid fields to update.")
    params.append(user_id)
    db.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
    db.commit()
    action_parts = []
    if "blocked" in data:
        action_parts.append(f"blocked={'yes' if data['blocked'] else 'no'}")
    if "role" in data:
        action_parts.append(f"role={data['role']}")
    log_admin_action("update_user", "user", user_id, "; ".join(action_parts))
    updated = db.execute(
        "SELECT id, name, email, role, blocked, created_at FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    return jsonify({"success": True, "user": dict(updated)})


@app.get("/api/admin/items")
def admin_list_items():
    guard = ensure_admin()
    if guard:
        return guard
    clauses, params = [], []
    item_type = request.args.get("type")
    if item_type and item_type in ("lost", "found"):
        clauses.append("i.type = ?")
        params.append(item_type)
    status = request.args.get("status")
    if status and status in ("lost", "found", "returned"):
        clauses.append("i.status = ?")
        params.append(status)
    university = request.args.get("university", "").strip().lower()
    if university and university in VALID_UNIVERSITY_IDS:
        clauses.append("i.university = ?")
        params.append(university)
    category = request.args.get("category", "").strip().lower()
    if category:
        clauses.append("i.category = ?")
        params.append(category)
    search = request.args.get("search", "").strip()
    if search:
        needle = f"%{search}%"
        clauses.append("(i.item_name LIKE ? OR i.category LIKE ? OR i.location LIKE ? OR i.description LIKE ?)")
        params.extend([needle, needle, needle, needle])
    sql = (
        "SELECT i.id, i.item_name, i.type, i.status, i.category, i.location, i.university, "
        "i.date, i.description, i.contact_number, i.email, i.additional_details, i.image_path, "
        "i.reporter_id, i.created_at, i.updated_at, u.name as reporter_name, u.email as reporter_email "
        "FROM items i LEFT JOIN users u ON i.reporter_id = u.id"
    )
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY i.created_at DESC, i.id DESC"
    rows = open_db().execute(sql, params).fetchall()
    items = [dict(r) for r in rows]
    db = open_db()
    for item in items:
        counts = db.execute(
            "SELECT COUNT(*) as total, "
            "SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending "
            "FROM reports WHERE listing_id = ?", (item["id"],)
        ).fetchone()
        item["report_count"] = counts["total"] if counts else 0
        item["pending_report_count"] = counts["pending"] if counts else 0
    return jsonify({"success": True, "items": items, "count": len(items)})


@app.delete("/api/admin/items/<int:item_id>")
def admin_delete_item(item_id):
    guard = ensure_admin()
    if guard:
        return guard
    db = open_db()
    row = db.execute("SELECT id, item_name FROM items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        return fail("Item not found.", 404)
    image_row = db.execute("SELECT image_path FROM items WHERE id = ?", (item_id,)).fetchone()
    db.execute("DELETE FROM items WHERE id = ?", (item_id,))
    db.commit()
    if image_row and image_row["image_path"]:
        delete_upload_file(image_row["image_path"])
    log_admin_action("delete_item", "item", item_id, row["item_name"])
    return jsonify({"success": True, "message": "Item deleted successfully."})


@app.get("/api/admin/logs")
def admin_logs():
    guard = ensure_admin()
    if guard:
        return guard
    db = open_db()
    rows = db.execute(
        "SELECT l.id, l.action, l.target_type, l.target_id, l.details, l.created_at, "
        "u.name as admin_name, u.email as admin_email "
        "FROM admin_logs l LEFT JOIN users u ON l.admin_id = u.id "
        "ORDER BY l.created_at DESC, l.id DESC LIMIT 100"
    ).fetchall()
    return jsonify({"success": True, "logs": [dict(r) for r in rows]})


# ---------------------------------------------------------------- report routes

@app.post("/api/items/<int:item_id>/report")
def create_report(item_id):
    user_id = session.get("user_id")
    if user_id is None:
        return fail("Please log in to report a listing.", 401)

    db = open_db()
    item = db.execute("SELECT id FROM items WHERE id = ?", (item_id,)).fetchone()
    if not item:
        return fail("Item not found.", 404)

    data = request.get_json(silent=True) or {}
    reason = (data.get("reason") or "").strip().lower()
    if reason not in VALID_REPORT_REASONS:
        return fail("Invalid reason. Please select a valid report reason.")
    details = (data.get("details") or "").strip()[:500]

    existing = db.execute(
        "SELECT id FROM reports WHERE listing_id = ? AND reporter_id = ? AND status = 'pending'",
        (item_id, user_id),
    ).fetchone()
    if existing:
        return fail("You already have a pending report for this listing.")

    cur = db.execute(
        "INSERT INTO reports (listing_id, reporter_id, reason, details) VALUES (?, ?, ?, ?)",
        (item_id, user_id, reason, details),
    )
    db.commit()
    report_id = cur.lastrowid

    log_admin_action("report_created", "report", report_id,
                     f"listing#{item_id} reason={reason}")

    return jsonify({
        "success": True,
        "message": "Report submitted successfully.",
        "report": {
            "id": report_id,
            "listing_id": item_id,
            "reason": reason,
            "status": "pending",
        },
    }), 201


@app.get("/api/admin/reports")
def admin_list_reports():
    guard = ensure_admin()
    if guard:
        return guard
    db = open_db()
    clauses, params = [], []
    status = request.args.get("status", "").strip().lower()
    if status in ("pending", "resolved", "dismissed"):
        clauses.append("r.status = ?")
        params.append(status)
    reason = request.args.get("reason", "").strip().lower()
    if reason and reason in VALID_REPORT_REASONS:
        clauses.append("r.reason = ?")
        params.append(reason)
    university = request.args.get("university", "").strip().lower()
    if university and university in VALID_UNIVERSITY_IDS:
        clauses.append("i.university = ?")
        params.append(university)
    sql = (
        "SELECT r.id, r.listing_id, r.reporter_id, r.reason, r.details, r.status, "
        "r.resolved_at, r.resolved_by, r.created_at, "
        "i.item_name, i.type, i.category, i.university, i.reporter_id as owner_id, "
        "u_reporter.name as reporter_name, "
        "u_owner.name as owner_name, "
        "u_resolver.name as resolver_name "
        "FROM reports r "
        "JOIN items i ON r.listing_id = i.id "
        "LEFT JOIN users u_reporter ON r.reporter_id = u_reporter.id "
        "LEFT JOIN users u_owner ON i.reporter_id = u_owner.id "
        "LEFT JOIN users u_resolver ON r.resolved_by = u_resolver.id"
    )
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY r.created_at DESC, r.id DESC"
    rows = db.execute(sql, params).fetchall()
    reports = [dict(r) for r in rows]
    return jsonify({"success": True, "reports": reports, "count": len(reports)})


@app.put("/api/admin/reports/<int:report_id>/resolve")
def admin_resolve_report(report_id):
    guard = ensure_admin()
    if guard:
        return guard
    db = open_db()
    row = db.execute("SELECT id, status FROM reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        return fail("Report not found.", 404)
    if row["status"] != "pending":
        return fail("This report has already been actioned.")
    user_id = session.get("user_id")
    db.execute(
        "UPDATE reports SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?",
        (user_id, report_id),
    )
    db.commit()
    log_admin_action("report_resolved", "report", report_id, "status=resolved")
    return jsonify({"success": True, "message": "Report resolved."})


@app.put("/api/admin/reports/<int:report_id>/dismiss")
def admin_dismiss_report(report_id):
    guard = ensure_admin()
    if guard:
        return guard
    db = open_db()
    row = db.execute("SELECT id, status FROM reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        return fail("Report not found.", 404)
    if row["status"] != "pending":
        return fail("This report has already been actioned.")
    user_id = session.get("user_id")
    db.execute(
        "UPDATE reports SET status = 'dismissed', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?",
        (user_id, report_id),
    )
    db.commit()
    log_admin_action("report_dismissed", "report", report_id, "status=dismissed")
    return jsonify({"success": True, "message": "Report dismissed."})


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
    app.run(host="127.0.0.1", port=5000, debug=not PRODUCTION)
