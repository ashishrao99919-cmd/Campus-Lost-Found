PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name          TEXT    NOT NULL,
    category           TEXT    NOT NULL,
    type               TEXT    NOT NULL CHECK (type IN ('lost', 'found')),
    description        TEXT    NOT NULL,
    date               TEXT    NOT NULL,
    location           TEXT    NOT NULL,
    contact_number     TEXT    NOT NULL,
    email              TEXT    NOT NULL DEFAULT '',
    additional_details TEXT    NOT NULL DEFAULT '',
    image_path         TEXT,
    status             TEXT    NOT NULL DEFAULT 'lost'
                       CHECK (status IN ('lost', 'found', 'returned')),
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_type ON items (type);
CREATE INDEX IF NOT EXISTS idx_items_status ON items (status);
CREATE INDEX IF NOT EXISTS idx_items_category ON items (category);
