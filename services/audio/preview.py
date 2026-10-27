"""
Preview URL validation and bounded download.

The service only fetches 30-second previews from the Deezer and Spotify CDNs. A URL is
accepted when it is an https URL whose parsed host is one of the preview hosts below, with
no userinfo, no IP literal and no port other than 443. Downloads never follow redirects,
must declare an audio content type the service decodes, are capped at MAX_PREVIEW_BYTES and
must finish within DOWNLOAD_DEADLINE_S.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import tempfile
from urllib.parse import urlsplit

import httpx

MAX_URL_LENGTH = 2048
MAX_PREVIEW_BYTES = 2 * 1024 * 1024
CONNECT_TIMEOUT_S = 5.0
READ_TIMEOUT_S = 10.0
DOWNLOAD_DEADLINE_S = 20.0

# Spotify serves previews from p.scdn.co; Deezer from subdomains of dzcdn.net
# (for example cdnt-preview.dzcdn.net and cdns-preview-<x>.dzcdn.net).
ALLOWED_HOSTS = frozenset({"p.scdn.co"})
ALLOWED_HOST_SUFFIXES = (".dzcdn.net",)

# Only unreserved, reserved and percent characters from RFC 3986: no whitespace, control
# characters, backslashes or non-ASCII text that different URL parsers read differently.
_URL_CHARS = re.compile(r"[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")
# Lowercase DNS name with at least two labels and no trailing dot.
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOSTNAME = re.compile(rf"{_LABEL}(?:\.{_LABEL})+")


class PreviewURLError(ValueError):
    """The URL is not an allowed preview URL."""


class PreviewDownloadError(Exception):
    """The preview could not be downloaded within the limits."""


class UnsupportedFormatError(Exception):
    """The preview is declared as MP4 (M4A) or AAC audio, which the service does not decode."""


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def validate_preview_url(url: str) -> str:
    """Return ``url`` unchanged if it points at an allowed preview CDN; raise otherwise."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise PreviewURLError("empty or overlong URL")
    if not _URL_CHARS.fullmatch(url):
        raise PreviewURLError("URL contains characters outside RFC 3986")
    if not url.startswith("https://"):
        raise PreviewURLError("URL must use https")

    try:
        netloc = urlsplit(url).netloc
    except ValueError as e:
        raise PreviewURLError("URL is not well formed") from e
    if "@" in netloc:
        raise PreviewURLError("URL must not contain userinfo")
    host, has_port, port = netloc.partition(":")
    if has_port and port != "443":
        raise PreviewURLError("URL must use the default https port")
    if not _HOSTNAME.fullmatch(host) or _is_ip_literal(host):
        raise PreviewURLError("URL host must be a lowercase DNS name")
    # The preview CDNs use plain ASCII names; internationalised (punycode) labels are refused.
    if any(label.startswith("xn--") for label in host.split(".")):
        raise PreviewURLError("URL host must not use internationalised labels")
    if host not in ALLOWED_HOSTS and not host.endswith(ALLOWED_HOST_SUFFIXES):
        raise PreviewURLError("URL host is not a supported preview CDN")
    return url


def is_allowed_preview_url(url: str) -> bool:
    try:
        validate_preview_url(url)
    except PreviewURLError:
        return False
    return True


def _new_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        follow_redirects=False,
        # Ignore proxy variables and .netrc from the environment.
        trust_env=False,
        timeout=httpx.Timeout(
            connect=CONNECT_TIMEOUT_S,
            read=READ_TIMEOUT_S,
            write=READ_TIMEOUT_S,
            pool=CONNECT_TIMEOUT_S,
        ),
        # Compressed bodies could expand far beyond the size cap.
        headers={"Accept-Encoding": "identity", "Accept": "audio/*"},
    )


# Decoders pick the format partly from the file extension.
_SUFFIXES = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
}

# MP4 (M4A) and AAC types, which the decoder (libsndfile) cannot read. The preview hosts serve
# MP3; a preview declared as one of these is refused before its body is read, as a format, not
# a download, failure.
UNSUPPORTED_TYPES = frozenset(
    {
        "audio/mp4",
        "audio/m4a",
        "audio/x-m4a",
        "audio/aac",
        "audio/aacp",
        "audio/x-aac",
        "audio/x-hx-aac-adts",
        "audio/vnd.dlna.adts",
        "audio/mp4a-latm",
        "audio/mpeg4-generic",
        "audio/3gpp",
        "audio/3gpp2",
        "video/mp4",
    }
)


def _check_headers(response: httpx.Response, max_bytes: int) -> str:
    """
    Refuse anything but a 200 audio response within the cap; return a file suffix. A type the
    service does not decode raises UnsupportedFormatError, any other refusal
    PreviewDownloadError.
    """
    if response.status_code != 200:
        raise PreviewDownloadError(f"unexpected status {response.status_code}")
    media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type in UNSUPPORTED_TYPES:
        raise UnsupportedFormatError(f"content type {media_type!r} is not decoded")
    if media_type not in _SUFFIXES:
        raise PreviewDownloadError(f"unexpected content type {media_type!r}")
    encoding = response.headers.get("content-encoding", "identity").strip().lower()
    if encoding not in ("", "identity"):
        raise PreviewDownloadError(f"unexpected content encoding {encoding!r}")
    declared = response.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > max_bytes):
        raise PreviewDownloadError(f"declared length {declared} over the cap")
    return _SUFFIXES.get(media_type, ".mp3")


async def fetch_to_file(
    url: str,
    *,
    max_bytes: int = MAX_PREVIEW_BYTES,
    deadline_s: float = DOWNLOAD_DEADLINE_S,
) -> str:
    """
    Stream ``url`` into a temporary file and return its path. The caller removes the file.

    Does not validate the URL; use ``download_preview`` for untrusted input.
    """
    path = None
    complete = False
    try:
        async with asyncio.timeout(deadline_s), _new_client() as client:
            async with client.stream("GET", url) as response:
                suffix = _check_headers(response, max_bytes)
                fd, path = tempfile.mkstemp(prefix="preview-", suffix=suffix)
                received = 0
                with os.fdopen(fd, "wb") as out:
                    async for chunk in response.aiter_raw():
                        received += len(chunk)
                        if received > max_bytes:
                            raise PreviewDownloadError(f"body over the cap of {max_bytes} bytes")
                        out.write(chunk)
                if received == 0:
                    raise PreviewDownloadError("empty body")
        complete = True
        return path
    except TimeoutError as e:
        raise PreviewDownloadError(f"download exceeded {deadline_s} s") from e
    except (httpx.HTTPError, httpx.InvalidURL, UnicodeError) as e:
        # UnicodeError covers IDNA failures raised while httpx encodes the host.
        raise PreviewDownloadError(f"{type(e).__name__}: {e}") from e
    finally:
        if path is not None and not complete:
            try:
                os.remove(path)
            except OSError:
                pass


async def download_preview(url: str) -> str:
    """Validate ``url`` against the preview allowlist, then download it with ``fetch_to_file``."""
    validate_preview_url(url)
    return await fetch_to_file(url)
