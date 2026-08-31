"""Deterministic matching engine for Campus Lost & Found.

Compares LOST and FOUND listings using category, university, title/description
similarity, location, and date proximity. No external AI services.
"""

import re
from datetime import datetime

STOP_WORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "its", "was", "are", "be",
    "has", "have", "had", "this", "that", "these", "those", "my", "your",
    "his", "her", "our", "their", "some", "any", "all", "no", "not",
    "very", "can", "will", "just", "also", "than", "then", "when",
    "what", "how", "who", "which", "there", "here", "if", "so",
    "about", "into", "over", "after", "before", "between", "under",
})


def _tokenize(text):
    text = str(text or "").lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return [w for w in text.split() if len(w) >= 2 and w not in STOP_WORDS]


def _text_similarity(a, b):
    tok_a = set(_tokenize(a))
    tok_b = set(_tokenize(b))
    if not tok_a or not tok_b:
        return 0.0
    return len(tok_a & tok_b) / len(tok_a | tok_b)


def _location_score(loc_a, loc_b):
    if not loc_a or not loc_b:
        return 0
    la, lb = loc_a.strip().lower(), loc_b.strip().lower()
    if la == lb:
        return 15
    if la in lb or lb in la:
        return 8
    return 0


def _date_score(date_a, date_b):
    if not date_a or not date_b:
        return 0
    try:
        da = datetime.strptime(date_a, "%Y-%m-%d")
        db = datetime.strptime(date_b, "%Y-%m-%d")
        diff = abs((da - db).days)
        if diff == 0:
            return 5
        if diff <= 3:
            return 3
        if diff <= 7:
            return 1
    except (ValueError, TypeError):
        pass
    return 0


def compute_match_score(lost_item, found_item):
    score = 0

    cat_a = (lost_item.get("category") or "").lower().strip()
    cat_b = (found_item.get("category") or "").lower().strip()
    if cat_a and cat_b and cat_a == cat_b:
        score += 30

    uni_a = (lost_item.get("university") or "").lower().strip()
    uni_b = (found_item.get("university") or "").lower().strip()
    if uni_a and uni_b and uni_a == uni_b and uni_a != "other":
        score += 25

    title_sim = _text_similarity(
        lost_item.get("item_name", ""), found_item.get("item_name", "")
    )
    score += int(title_sim * 25)

    desc_sim = _text_similarity(
        lost_item.get("description", ""), found_item.get("description", "")
    )
    score += int(desc_sim * 10)

    score += _location_score(
        lost_item.get("location", ""), found_item.get("location", "")
    )
    score += _date_score(lost_item.get("date", ""), found_item.get("date", ""))

    if score >= 65:
        confidence = "high"
    elif score >= 40:
        confidence = "medium"
    elif score >= 25:
        confidence = "low"
    else:
        confidence = "none"

    return {"score": score, "confidence": confidence}


def run_matchmaker(db, new_item_id):
    row = db.execute("SELECT * FROM items WHERE id = ?", (new_item_id,)).fetchone()
    if not row:
        return
    new_item = dict(row)
    if new_item["status"] == "returned":
        return

    opposite = "found" if new_item["type"] == "lost" else "lost"
    candidates = db.execute(
        "SELECT * FROM items WHERE type = ? AND status != 'returned' "
        "AND id != ? AND reporter_id IS NOT NULL",
        (opposite, new_item_id),
    ).fetchall()

    for cand in candidates:
        cand_d = dict(cand)
        if cand_d.get("reporter_id") == new_item.get("reporter_id"):
            continue

        if new_item["type"] == "lost":
            result = compute_match_score(new_item, cand_d)
        else:
            result = compute_match_score(cand_d, new_item)

        if result["confidence"] == "none":
            continue

        existing_dismissal = db.execute(
            "SELECT id FROM match_dismissals WHERE "
            "(listing_id = ? AND matched_listing_id = ? AND user_id = ?) OR "
            "(listing_id = ? AND matched_listing_id = ? AND user_id = ?)",
            (
                cand_d["id"], new_item_id, cand_d["reporter_id"],
                new_item_id, cand_d["id"], new_item["reporter_id"],
            ),
        ).fetchone()
        if existing_dismissal:
            continue

        if cand_d.get("reporter_id"):
            try:
                db.execute(
                    "INSERT OR IGNORE INTO match_notifications "
                    "(listing_id, matched_listing_id, user_id, confidence, title) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        cand_d["id"], new_item_id, cand_d["reporter_id"],
                        result["confidence"],
                        f"A {result['confidence']} possible match was found for your listing.",
                    ),
                )
            except Exception:
                pass

        if new_item.get("reporter_id"):
            try:
                db.execute(
                    "INSERT OR IGNORE INTO match_notifications "
                    "(listing_id, matched_listing_id, user_id, confidence, title) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        new_item_id, cand_d["id"], new_item["reporter_id"],
                        result["confidence"],
                        f"A {result['confidence']} possible match was found for your listing.",
                    ),
                )
            except Exception:
                pass

    db.commit()
