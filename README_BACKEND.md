# Campus Lost & Found — Flask Backend

Optional backend for the existing frontend-only app. Python + Flask + SQLite.
The frontend keeps working with `localStorage` until you choose to wire it up — no frontend changes are required by this backend.

## 1. Install dependencies

From the `backend/` folder:

```powershell
cd backend

# (optional but recommended) create a virtual environment
python -m venv .venv
.\.venv\Scripts\activate          # Windows PowerShell
# source .venv/bin/activate       # macOS / Linux

pip install -r requirements.txt
```

`requirements.txt` contains:

- **Flask** — web framework
- **Flask-CORS** — allows the Vite frontend (`localhost:5173`) to call this API from the browser
- **Werkzeug** — used for secure uploaded-image filenames

## 2. Start the server

```powershell
python app.py
```

- Runs at **http://127.0.0.1:5000**
- On startup it automatically creates `backend/lost_found.db` and the `items`
  table (from `schema.sql`) if they do not exist yet, and ensures the
  `backend/uploads/` folder exists.

## 3. API endpoints

Base URL: `http://127.0.0.1:5000/api`

| Method | Endpoint                    | Description                                        |
| ------ | --------------------------- | -------------------------------------------------- |
| GET    | `/api/items`                | All items (newest first). Supports filters below.   |
| POST   | `/api/items`                | Create a lost/found item (JSON body).               |
| GET    | `/api/items/<id>`           | One item.                                           |
| PUT    | `/api/items/<id>`           | Update any subset of item fields (JSON body).       |
| DELETE | `/api/items/<id>`           | Delete an item (and its uploaded image).            |
| PUT    | `/api/items/<id>/returned`  | Mark an item as `returned`.                         |
| POST   | `/api/items/<id>/image`     | Upload an image (multipart field `image`).          |

Query parameters on `GET /api/items`:

| Parameter | Values                        | Example                  |
| --------- | ----------------------------- | ------------------------ |
| `type`    | `lost`, `found`               | `?type=lost`             |
| `status`  | `lost`, `found`, `returned`   | `?status=returned`       |
| `search`  | free text                     | `?search=wallet`         |

`search` matches against **item name, category, location and description**.
Filters can be combined: `/api/items?type=found&status=returned&search=wallet`.

Uploaded files are served at `http://127.0.0.1:5000/uploads/<filename>`, and every
serialized item includes a ready-to-use absolute `image_url`.

### Create an item

```bash
curl -X POST http://127.0.0.1:5000/api/items ^
  -H "Content-Type: application/json" ^
  -d "{\"item_name\":\"Black Wallet\",\"category\":\"wallets\",\"type\":\"lost\",\"description\":\"Bifold leather wallet\",\"date\":\"2026-08-23\",\"location\":\"Central Library\",\"contact_number\":\"+1 555 010 1234\",\"email\":\"you@campus.edu\",\"additional_details\":\"Metro card inside\"}"
```

Response `201`:

```json
{
  "success": true,
  "message": "Item created successfully",
  "item": { "id": 1, "item_name": "Black Wallet", "...": "..." }
}
```

### Upload an image

```bash
curl -X POST http://127.0.0.1:5000/api/items/1/image -F "image=@photo.png"
```

Allowed types: `png`, `jpg`, `jpeg`, `webp` (max 8 MB). Files are stored in
`backend/uploads/` under secure, unique names generated with Werkzeug's
`secure_filename`.

### Mark as returned

```bash
curl -X PUT http://127.0.0.1:5000/api/items/1/returned
```

### Errors

Every error is JSON with a proper HTTP status code:

```json
{ "success": false, "message": "Item not found" }
```

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| 400  | Missing/invalid fields or bad file            |
| 404  | Item or endpoint not found                    |
| 405  | Wrong HTTP method                             |
| 413  | Upload larger than 8 MB                       |
| 500  | Unexpected server error                       |

## 4. Database structure

File: `backend/lost_found.db` (created automatically).

Table `items`:

| Column              | Type    | Notes                                          |
| ------------------- | ------- | ---------------------------------------------- |
| `id`                | INTEGER | Primary key, auto-increment                     |
| `item_name`         | TEXT    | Required                                        |
| `category`          | TEXT    | Required (e.g. `wallets`, `electronics`)        |
| `type`              | TEXT    | `lost` or `found`                               |
| `description`       | TEXT    | Required                                        |
| `date`              | TEXT    | `YYYY-MM-DD`                                    |
| `location`          | TEXT    | Required                                        |
| `contact_number`    | TEXT    | Required                                        |
| `email`             | TEXT    | Optional                                        |
| `additional_details`| TEXT    | Optional identifying details                    |
| `image_path`        | TEXT    | Relative path like `uploads/item_1_ab12_x.png`  |
| `status`            | TEXT    | `lost`, `found` or `returned`                   |
| `created_at`        | TEXT    | UTC timestamp set automatically                 |
| `updated_at`        | TEXT    | Refreshed on every update                       |

Indexes exist on `type`, `status` and `category`.

To reset the database: stop the server and delete `backend/lost_found.db`; it is recreated on the next start.

## 5. How the frontend should communicate with the backend

CORS is enabled for all origins via Flask-CORS, so the Vite dev server
(`http://localhost:5173`) can call the API directly from browser JavaScript.

When you decide to wire the frontend up (the current UI stays untouched):

```js
const API = 'http://127.0.0.1:5000/api';

// list lost items
const { items } = await fetch(`${API}/items?type=lost`).then((r) => r.json());

// create a report
await fetch(`${API}/items`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ item_name: 'Black Wallet', type: 'lost', /* ... */ }),
});

// upload the photo chosen in the report form
const form = new FormData();
form.append('image', fileInput.files[0]);
await fetch(`${API}/items/${id}/image`, { method: 'POST', body: form });

// mark returned (replaces the localStorage-based flag)
await fetch(`${API}/items/${id}/returned`, { method: 'PUT' });
```

Display uploaded photos using the `image_url` each item carries; fall back to
the existing SVG generator when it is `null`.
