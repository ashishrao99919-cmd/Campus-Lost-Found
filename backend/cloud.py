"""Cloudinary integration for persistent image storage.

Reads credentials from environment variables only:
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET

When all three are present the module wires up the official SDK and stores
uploads in Cloudinary. Otherwise uploads fall back to local storage so local
development keeps working without any Cloudinary account.
"""

import os

CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME", "").strip()
API_KEY = os.environ.get("CLOUDINARY_API_KEY", "").strip()
API_SECRET = os.environ.get("CLOUDINARY_API_SECRET", "").strip()

CONFIGURED = bool(CLOUD_NAME and API_KEY and API_SECRET)


def _sdk():
    try:
        import cloudinary
        import cloudinary.uploader
    except Exception:  # pragma: no cover - import guard
        return None
    cloudinary.config(
        cloud_name=CLOUD_NAME,
        api_key=API_KEY,
        api_secret=API_SECRET,
        secure=True,
    )
    return cloudinary.uploader


def configured():
    return CONFIGURED


def upload(file_storage, public_id):
    """Upload an open file object to Cloudinary.

    Returns the secure_url string, or raises CloudinaryError on failure.
    """
    if not CONFIGURED:
        raise RuntimeError("Cloudinary is not configured.")
    uploader = _sdk()
    if uploader is None:
        raise RuntimeError("The Cloudinary SDK is not installed.")
    result = uploader.upload(
        file_storage,
        public_id=public_id,
        resource_type="image",
        overwrite=True,
        folder="lost_and_found",
    )
    url = result.get("secure_url") or result.get("url")
    if not url:
        raise RuntimeError("Cloudinary did not return an image URL.")
    return url


def public_id_from_url(url):
    """Derive the Cloudinary public id from a secure_url (best effort)."""
    if not url:
        return None
    if "/image/upload/" not in url:
        return None
    tail = url.split("/image/upload/", 1)[1]
    if "/" in tail:
        tail = tail.split("/", 1)[1]
    public_id = tail.split(".", 1)[0]
    public_id = public_id.replace("%20", " ")
    return public_id or None


def delete(url):
    """Best-effort deletion of a Cloudinary asset by its URL."""
    if not CONFIGURED:
        return
    pid = public_id_from_url(url)
    if not pid:
        return
    try:
        uploader = _sdk()
        if uploader is not None:
            uploader.destroy(pid)
    except Exception:
        pass
