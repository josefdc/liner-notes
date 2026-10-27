"""
MP4 (M4A) and AAC previews: libsndfile does not read them, so the service refuses them with
that reason, never as a generic decode or download failure, and never decodes them. The formats
it does decode are never refused.

The fixtures are 1 s of a 440 Hz sine, mono at 22.05 kHz, AAC-LC at 24 kb/s, made with FFmpeg
(N-127579, native aac encoder) without metadata:

    ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=22050:duration=1" -ac 1 -c:a aac \\
        -b:a 24k -map_metadata -1 -fflags +bitexact -flags:a +bitexact -movflags +faststart \\
        tone.m4a

and the same command with `-f adts` for tone.aac (a raw ADTS stream, as served as audio/aac)
and with `-f latm` for tone.latm (a LOAS stream). The other forms are built from them here.
"""

import io
import struct
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import main
import preview
import sniff

FIXTURES = Path(__file__).parent / "fixtures"
M4A = FIXTURES / "tone.m4a"
AAC = FIXTURES / "tone.aac"
LATM = FIXTURES / "tone.latm"
REASON = "it is an MP4 (M4A) or AAC file, a format the service does not decode"
DETAIL = f"The preview is not analysable audio: {REASON}"
UNDECODABLE = "the file could not be decoded as audio"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    with TestClient(main.app) as c:
        yield c


def _syncsafe(n: int) -> bytes:
    return bytes((n >> shift) & 0x7F for shift in (21, 14, 7, 0))


def _id3(padding: int = 64, footer: bool = False) -> bytes:
    """An ID3v2.4 tag with a title frame and ``padding`` zero bytes, as MP3 and HLS AAC carry."""
    text = b"\x03tone"
    frame = b"TIT2" + _syncsafe(len(text)) + b"\x00\x00" + text
    size = _syncsafe(len(frame) + padding)
    flags = b"\x10" if footer else b"\x00"
    tag = b"ID3\x04\x00" + flags + size + frame + bytes(padding)
    return tag + (b"3DI\x04\x00" + flags + size if footer else b"")


def _box(kind: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def _ftyp(major: bytes, *compatible: bytes) -> bytes:
    """An ISO BMFF file: a `ftyp` box with these brands, then an `mdat` box of noise."""
    noise = np.random.default_rng(0).integers(0, 256, 2048, dtype=np.uint8).tobytes()
    return _box(b"ftyp", major + b"\x00\x00\x02\x00" + b"".join(compatible)) + _box(b"mdat", noise)


def _encoded(fmt: str, subtype: str | None = None, sr: int = 22050) -> bytes:
    """1 s of a 440 Hz tone at ``sr``, written by libsndfile in ``fmt``."""
    tone = 0.3 * np.sin(2 * np.pi * 440 * np.arange(sr) / sr)
    out = io.BytesIO()
    sf.write(out, tone.astype(np.float32), sr, format=fmt, subtype=subtype)
    return out.getvalue()


def _write(tmp_path: Path, body: bytes) -> str:
    # fetch_to_file names an audio/mpeg body .mp3, whatever it holds.
    path = tmp_path / "preview.mp3"
    path.write_bytes(body)
    return str(path)


def _serve(cdn, monkeypatch, name: str, body: bytes, content_type: str) -> str:
    """Serves ``body`` from the local CDN as ``content_type``; the allowlist is lifted."""
    base, server = cdn
    path = f"/api/1/1/a/b/0/{name}"
    server.files[path] = body
    server.types[path] = content_type
    monkeypatch.setattr(preview, "validate_preview_url", lambda url: None)
    return f"{base}{path}"


# Forms the service must refuse with REASON (built when the case runs).
REFUSED = {
    "m4a": lambda: M4A.read_bytes(),
    "adts": lambda: AAC.read_bytes(),
    "adts behind an ID3 tag": lambda: _id3() + AAC.read_bytes(),
    "adts behind an ID3 tag with a footer": lambda: _id3(footer=True) + AAC.read_bytes(),
    "adts behind two ID3 tags": lambda: _id3() + _id3(padding=0) + AAC.read_bytes(),
    "adts behind 16 zero bytes": lambda: bytes(16) + AAC.read_bytes(),
    "adts behind 1000 zero bytes": lambda: bytes(1000) + AAC.read_bytes(),
    "adts without its first header": lambda: AAC.read_bytes()[7:],
    "loas": lambda: LATM.read_bytes(),
    "loas behind an ID3 tag": lambda: _id3() + LATM.read_bytes(),
    "loas without its first byte": lambda: LATM.read_bytes()[1:],
    # The ADIF magic and a zeroed header only: no encoder here writes ADIF.
    "adif": lambda: b"ADIF" + bytes(60),
    "m4a behind a free box": lambda: _box(b"free") + M4A.read_bytes(),
    "m4a behind skip and wide boxes": lambda: (
        _box(b"skip", bytes(16)) + _box(b"wide") + M4A.read_bytes()
    ),
    "mp4 (isom)": lambda: _ftyp(b"isom", b"isom", b"iso2", b"mp41"),
    "mp4 (mp42)": lambda: _ftyp(b"mp42", b"mp42", b"isom"),
    "m4b": lambda: _ftyp(b"M4B ", b"M4B ", b"mp42"),
    "quicktime": lambda: _ftyp(b"qt  ", b"qt  "),
    "3gpp": lambda: _ftyp(b"3gp5", b"3gp5", b"isom"),
    "3gpp2": lambda: _ftyp(b"3g2a", b"3g2a"),
    "dash": lambda: _ftyp(b"dash", b"iso6", b"dash"),
}

# Formats the service decodes: never refused.
DECODABLE = {
    "mp3 (bare frame)": lambda: _encoded("MP3"),
    "mp3 behind an ID3 tag": lambda: _id3() + _encoded("MP3"),
    "mp3 behind 16 zero bytes": lambda: bytes(16) + _encoded("MP3"),
    # A plausible ADTS header, then MP3: no second ADTS header where its length points.
    "mp3 behind an ADTS-like header": lambda: b"\xff\xf1\x50\x80\x02\x1f\xfc" + _encoded("MP3"),
    "wav": lambda: _encoded("WAV"),
    "flac": lambda: _encoded("FLAC"),
    "ogg vorbis": lambda: _encoded("OGG", "VORBIS"),
    "ogg opus": lambda: _encoded("OGG", "OPUS", sr=48000),
}

# ISO BMFF images: not MP4 audio or video, so they get the generic reason.
IMAGES = {
    "heic": lambda: _ftyp(b"heic", b"mif1", b"heic"),
    "avif": lambda: _ftyp(b"avif", b"avif", b"mif1", b"miaf"),
    "avif naming iso8": lambda: _ftyp(b"avif", b"avif", b"mif1", b"miaf", b"iso8"),
}


@pytest.mark.parametrize("form", REFUSED)
def test_decode_refuses_mp4_and_aac_as_a_format_it_does_not_decode(tmp_path, form):
    path = _write(tmp_path, REFUSED[form]())
    with pytest.raises(main.InvalidAudioError) as refused:
        main.decode(path)
    assert str(refused.value) == REASON


@pytest.mark.parametrize("form", DECODABLE)
def test_formats_the_service_decodes_are_never_refused(tmp_path, form):
    path = _write(tmp_path, DECODABLE[form]())
    assert not sniff.is_mp4_or_aac(path)
    signals = main.decode(path)
    assert 0.9 < signals.native.size / signals.native_sr < 1.2


@pytest.mark.parametrize("form", IMAGES)
def test_heif_images_are_not_called_mp4(tmp_path, form):
    path = _write(tmp_path, IMAGES[form]())
    with pytest.raises(main.InvalidAudioError) as refused:
        main.decode(path)
    assert str(refused.value) == UNDECODABLE


@pytest.mark.parametrize(
    ("name", "content_type"),
    [
        ("tone.m4a", "audio/mp4"),
        ("tone.m4a", "audio/x-m4a"),
        ("tone.m4a", "video/mp4"),
        ("tone.aac", "audio/aac"),
        ("tone.aac", "audio/x-hx-aac-adts"),
        ("tone.latm", "audio/mp4a-latm"),
    ],
)
def test_a_preview_declared_as_mp4_or_aac_is_refused_with_that_reason(
    client, cdn, monkeypatch, temp_dir, name, content_type
):
    url = _serve(cdn, monkeypatch, name, (FIXTURES / name).read_bytes(), content_type)
    response = client.post("/analyze", json={"preview_url": url})
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": DETAIL}
    assert list(temp_dir.iterdir()) == []


@pytest.mark.parametrize(
    "form", ["m4a", "adts", "adts behind an ID3 tag", "adts behind 16 zero bytes", "loas"]
)
def test_an_mp4_or_aac_preview_served_as_mp3_is_refused_with_that_reason(
    client, cdn, monkeypatch, temp_dir, form
):
    url = _serve(cdn, monkeypatch, "preview.mp3", REFUSED[form](), "audio/mpeg")
    response = client.post("/analyze", json={"preview_url": url})
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": DETAIL}
    assert list(temp_dir.iterdir()) == []


@pytest.mark.parametrize(
    "content_type",
    [
        "audio/mp4",
        "audio/x-m4a",
        "audio/aac",
        "audio/AAC; charset=binary",
        "audio/x-hx-aac-adts",
        "audio/vnd.dlna.adts",
        "audio/3gpp",
        "audio/3gpp2",
        "video/mp4",
    ],
)
def test_the_header_check_refuses_them_as_a_format_not_a_download(content_type):
    response = httpx.Response(200, headers={"content-type": content_type})
    with pytest.raises(preview.UnsupportedFormatError):
        preview._check_headers(response, preview.MAX_PREVIEW_BYTES)


@pytest.mark.parametrize(
    ("content_type", "suffix"),
    [
        ("audio/mpeg", ".mp3"),
        ("audio/mp3", ".mp3"),
        ("audio/wav", ".wav"),
        ("audio/x-wav", ".wav"),
        ("audio/flac", ".flac"),
        ("audio/ogg", ".ogg"),
    ],
)
def test_the_header_check_accepts_the_formats_the_service_decodes(content_type, suffix):
    response = httpx.Response(200, headers={"content-type": content_type})
    assert preview._check_headers(response, preview.MAX_PREVIEW_BYTES) == suffix
