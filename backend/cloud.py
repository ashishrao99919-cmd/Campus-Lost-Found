"""Cloudinary integration for persistent image storage.

Reads credentials from environment variables only:
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET

When all three are present the module wires up the official SDK and stores
uploads in Cloudinary. Otherwise uploads fall back to local storage so local
development keeps working without any Cloudinary account.

Credentials are read at call time so that a process which starts before the
environment variables are populated (e.g. a warm serverless lambda) still picks
up the configured values.
"""

import os


def _env(name):
    return os.environ.get(name, "").strip()


def _credentials():
    return {
        "cloud_name": _env("CLOUDINARY_CLOUD_NAME"),
        "api_key": _env("CLOUDINARY_API_KEY"),
        "api_secret": _env("CLOUDINARY_API_SECRET"),
    }


def configured():
    creds = _credentials()
    return bool(creds["cloud_name"] and creds["api_key"] and creds["api_secret"])


def _sdk():
    try:
        import cloudinary
        import cloudinary.uploader
    except Exception:
        return None, "The Cloudinary SDK is not installed."
    creds = _credentials()
    cloudinary.config(
        cloud_name=creds["cloud_name"],
        api_key=creds["api_key"],
        api_secret=creds["api_secret"],
        secure=True,
    )
    return cloudinary.uploader, None


def upload(file_storage, public_id):
    """Upload an open file object to Cloudinary.

    Returns the secure_url string, or raises RuntimeError with a useful message.
    """
    if not configured():
        raise RuntimeError("Cloudinary is not configured.")
    uploader, sdk_error = _sdk()
    if uploader is None:
        raise RuntimeError(sdk_error or "Cloudinary is not configured.")
    parsed = parse_cloudinary_error
    try:
        result = uploader.upload(
            file_storage,
            public_id=public_id,
            resource_type="image",
            overwrite=True,
            folder="lost_and_found",
        )
    except Exception as exc:
        raise RuntimeError(parsed(exc)) from exc
    url = result.get("secure_url") or result.get("url")
    if not url:
        raise RuntimeError("Cloudinary did not return an image URL.")
    return url


def parse_cloudinary_error(exc):
    """Return a human-readable message for a Cloudinary SDK exception."""
    if not exc:
        return "unknown Cloudinary error."
    text = str(exc).strip()
    if not text:
        return "unknown Cloudinary error."
    lowered = text.lower()
    if "invalid api_key" in lowered:
        return (
            "Cloudinary rejected the API key (CLOUDINARY_API_KEY). Check that the "
            "API key and secret match the configured cloud and are both active. "
            f"[{text}]"
        )
    if "api secret" in lowered or "invalid_api_secret" in lowered or "api_secret" in lowered:
        return (
            "Cloudinary rejected the API secret (CLOUDINARY_API_SECRET). Verify the "
            "secret belongs to the same cloud as the API key. "
            f"[{text}]"
        )
    if "invalid cloud" in lowered or "cloud name" in lowered or "invalid_cloud_name" in lowered:
        return (
            "Cloudinary could not find the cloud (CLOUDINARY_CLOUD_NAME). Double-check "
            "the cloud name is exact. "
            f"[{text}]"
        )
    return f"{text}"


def public_id_from_url(url):
    """Derive the Cloudinary public id (including folder) from a secure_url.

    Cloudinary prepends the configured folder to the public id, so the full
    public id of an asset uploaded with folder='lost_and_found' is
    'lost_and_found/<name>'.
    """
    if not url:
        return None
    if "/image/upload/" not in url:
        return None
    tail = url.split("/image/upload/", 1)[1]
    # strip a leading version segment (/v123456/) if present
    first = tail.split("/", 1)
    if len(first) == 2 and first[0].startswith("v") and first[0][1:].isdigit():
        tail = first[1]
    public_id = tail.split(".", 1)[0]
    public_id = public_id.replace("%20", " ")
    return public_id or None


def delete(url):
    """Best-effort deletion of a Cloudinary asset by its URL."""
    if not configured():
        return
    pid = public_id_from_url(url)
    if not pid:
        return
    try:
        uploader, _ = _sdk()
        if uploader is not None:
            uploader.destroy(pid)
    except Exception:
        pass
