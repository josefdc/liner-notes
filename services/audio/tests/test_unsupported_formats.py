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
import os
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


def _id3(padding: int = 64, footer: bool = False, art: int = 0) -> bytes:
    """
    An ID3v2.4 tag with a title frame, ``art`` bytes of cover art and ``padding`` zero bytes, as
    MP3 and HLS AAC carry.
    """
    text = b"\x03tone"
    frame = b"TIT2" + _syncsafe(len(text)) + b"\x00\x00" + text
    if art:
        picture = b"\x00image/jpeg\x00\x03\x00" + _noise(art, seed=1)
        frame += b"APIC" + _syncsafe(len(picture)) + b"\x00\x00" + picture
    size = _syncsafe(len(frame) + padding)
    flags = b"\x10" if footer else b"\x00"
    tag = b"ID3\x04\x00" + flags + size + frame + bytes(padding)
    return tag + (b"3DI\x04\x00" + flags + size if footer else b"")


def _noise(n: int, seed: int = 0) -> bytes:
    return np.random.default_rng(seed).integers(0, 256, n, dtype=np.uint8).tobytes()


def _adts_frames() -> list[bytes]:
    """The ADTS frames of the tone.aac fixture (22.05 kHz: sampling frequency index 7)."""
    data, frames, i = AAC.read_bytes(), [], 0
    while i + 7 <= len(data):
        length = ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | (data[i + 5] >> 5)
        frames.append(data[i : i + length])
        i += length
    return frames


def _loas_frames() -> list[bytes]:
    """The LOAS frames of the tone.latm fixture."""
    data, frames, i = LATM.read_bytes(), [], 0
    while i + 3 <= len(data):
        length = 3 + (((data[i + 1] & 0x1F) << 8) | data[i + 2])
        frames.append(data[i : i + length])
        i += length
    return frames


def _rate_index(frame: bytes, index: int) -> bytes:
    """
    An ADTS frame with its sampling frequency index set to ``index``: 4 is 44.1 kHz, 5 is
    32 kHz, 7 (the fixture's) 22.05 kHz, 8 16 kHz; 13 and 14 are reserved, 15 is the escape.
    """
    return frame[:2] + bytes([(frame[2] & 0xC3) | (index << 2)]) + frame[3:]


def _channels(frame: bytes, config: int) -> bytes:
    """An ADTS frame with its channel configuration set to ``config`` (1-3)."""
    b2 = (frame[2] & 0xFE) | (config >> 2)
    b3 = (frame[3] & 0x3F) | ((config & 0x03) << 6)
    return frame[:2] + bytes([b2, b3]) + frame[4:]


def _mpeg2(frame: bytes) -> bytes:
    """An ADTS frame with its ID bit flipped (MPEG-4 to MPEG-2)."""
    return frame[:1] + bytes([frame[1] ^ 0x08]) + frame[2:]


def _alternating(change) -> bytes:
    """Eight ADTS frames, every other one changed by ``change``."""
    frames = _adts_frames()[:8]
    return b"".join(f if k % 2 == 0 else change(f) for k, f in enumerate(frames))


def _flac_holding_adts() -> bytes:
    """
    A FLAC file with a PADDING metadata block after STREAMINFO that holds six agreeing ADTS
    frames (decoders skip padding, whatever it holds).
    """
    flac = _encoded("FLAC")
    assert flac[:4] == b"fLaC" and flac[4] & 0x7F == 0  # STREAMINFO first
    last = flac[4] & 0x80
    streaminfo_end = 8 + int.from_bytes(flac[5:8], "big")
    padding = b"".join(_adts_frames()[:6])
    header = bytes([0x01 | last]) + len(padding).to_bytes(3, "big")
    streaminfo = bytes([flac[4] & 0x7F]) + flac[5:streaminfo_end]
    return b"fLaC" + streaminfo + header + padding + flac[streaminfo_end:]


def _webm_holding_mp3() -> bytes:
    """
    A WebM (EBML) header followed by bytes libsndfile's MP3 decoder reads as frames: what a
    30 s WebM/Opus body did 16-32 kB in, where libsndfile decoded 0.288 s of "MP3" from it.
    """
    ebml = (
        b"\x42\x86\x81\x01\x42\xf7\x81\x01\x42\xf2\x81\x04\x42\xf3\x81\x08"
        b"\x42\x82\x84webm\x42\x87\x81\x04\x42\x85\x81\x02"
    )
    segment = b"\x18\x53\x80\x67\x01\xff\xff\xff\xff\xff\xff\xff"
    return b"\x1a\x45\xdf\xa3" + bytes([0x80 | len(ebml)]) + ebml + segment + _encoded("MP3")


def _box(kind: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def _ftyp(major: bytes, *compatible: bytes) -> bytes:
    """An ISO BMFF file: a `ftyp` box with these brands, then an `mdat` box of noise."""
    brands = major + b"\x00\x00\x02\x00" + b"".join(compatible)
    return _box(b"ftyp", brands) + _box(b"mdat", _noise(2048))


def _encoded(fmt: str, subtype: str | None = None, sr: int = 22050) -> bytes:
    """1 s of a 440 Hz tone at ``sr``, written by libsndfile in ``fmt``."""
    tone = 0.3 * np.sin(2 * np.pi * 440 * np.arange(sr) / sr)
    out = io.BytesIO()
    sf.write(out, tone.astype(np.float32), sr, format=fmt, subtype=subtype)
    return out.getvalue()


def _quiet(fmt: str, endian: str = "FILE") -> bytes:
    """
    1 s of dither of +-16 LSB at 22.05 kHz, 16-bit, in ``fmt``. Big-endian, its samples from -16
    to -1 read as ADTS sync words (0xFFF0-0xFFFF); with this seed, two of them agree.
    """
    dither = np.random.default_rng(4).integers(-16, 16, 22050) / 32768
    out = io.BytesIO()
    sf.write(out, dither.astype(np.float32), 22050, format=fmt, subtype="PCM_16", endian=endian)
    return out.getvalue()


def _holding_adts(clip: bytes) -> bytes:
    """``clip`` with six agreeing ADTS frames written over its samples at byte 1500."""
    clip = bytearray(clip)
    frames = b"".join(_adts_frames()[:6])
    clip[1500 : 1500 + len(frames)] = frames
    return bytes(clip)


def _write(tmp_path: Path, body: bytes) -> str:
    # fetch_to_file names an audio/mpeg body .mp3, whatever it holds.
    path = tmp_path / "preview.mp3"
    path.write_bytes(body)
    return str(path)


def _serve(cdn, monkeypatch, name: str, body: bytes, content_type: str | None) -> str:
    """
    Serves ``body`` from the local CDN as ``content_type`` (None: without one); the allowlist
    is lifted.
    """
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
    "adts behind an ID3 tag with 5 kB of cover art": lambda: _id3(art=5000) + AAC.read_bytes(),
    "adts behind 16 zero bytes": lambda: bytes(16) + AAC.read_bytes(),
    "adts behind 1000 zero bytes": lambda: bytes(1000) + AAC.read_bytes(),
    "adts without its first header": lambda: AAC.read_bytes()[7:],
    "adts, two frames only": lambda: b"".join(_adts_frames()[:2]),
    "adts behind 4000 zero bytes": lambda: bytes(4000) + AAC.read_bytes(),
    # At 44.1 and 32 kHz the third ADTS byte also reads as a valid MPEG audio bitrate and rate:
    # only the layer (0) tells the stream from an MP3 frame.
    "adts at 44.1 kHz": lambda: b"".join(_rate_index(f, 4) for f in _adts_frames()),
    "adts at 32 kHz": lambda: b"".join(_rate_index(f, 5) for f in _adts_frames()),
    "loas": lambda: LATM.read_bytes(),
    "loas behind an ID3 tag": lambda: _id3() + LATM.read_bytes(),
    "loas without its first byte": lambda: LATM.read_bytes()[1:],
    # The ADIF magic and a zeroed header only: no encoder here writes ADIF.
    "adif": lambda: b"ADIF" + bytes(60),
    "m4a behind an ID3 tag": lambda: _id3() + M4A.read_bytes(),
    "m4a behind an ID3 tag with a footer": lambda: _id3(footer=True) + M4A.read_bytes(),
    "m4a behind two ID3 tags": lambda: _id3() + _id3(padding=0) + M4A.read_bytes(),
    "m4a behind a free box": lambda: _box(b"free") + M4A.read_bytes(),
    "m4a behind skip and wide boxes": lambda: (
        _box(b"skip", bytes(16)) + _box(b"wide") + M4A.read_bytes()
    ),
    "m4a behind free, skip and wide boxes": lambda: (
        _box(b"free") + _box(b"skip", bytes(16)) + _box(b"wide") + M4A.read_bytes()
    ),
    "mp4 (isom)": lambda: _ftyp(b"isom", b"isom", b"iso2", b"mp41"),
    "mp4 (mp42)": lambda: _ftyp(b"mp42", b"mp42", b"isom"),
    "m4b": lambda: _ftyp(b"M4B ", b"M4B ", b"mp42"),
    "quicktime": lambda: _ftyp(b"qt  ", b"qt  "),
    "3gpp": lambda: _ftyp(b"3gp5", b"3gp5", b"isom"),
    "3gpp2": lambda: _ftyp(b"3g2a", b"3g2a"),
    "dash": lambda: _ftyp(b"dash", b"iso6", b"dash"),
    "mp4 with an unknown major brand": lambda: _ftyp(b"abcd", b"abcd", b"mp42"),
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
    # Quiet 16-bit PCM in the containers libsndfile reads, big-endian where it can be.
    "au, quiet, big-endian": lambda: _quiet("AU", "BIG"),
    "wav, quiet, big-endian (RIFX)": lambda: _quiet("WAV", "BIG"),
    "ircam, quiet, big-endian": lambda: _quiet("IRCAM", "BIG"),
    "nist, quiet, big-endian": lambda: _quiet("NIST", "BIG"),
    "paf, quiet, big-endian": lambda: _quiet("PAF", "BIG"),
    "caf, quiet, big-endian": lambda: _quiet("CAF", "BIG"),
    "w64, quiet": lambda: _quiet("W64"),
    "flac holding agreeing ADTS frames in a padding block": _flac_holding_adts,
    # Six agreeing ADTS frames in the samples: only the container's magic keeps them apart.
    **{
        f"{fmt.lower()} ({endian.lower()}) holding agreeing ADTS frames": (
            lambda fmt=fmt, endian=endian: _holding_adts(_quiet(fmt, endian))
        )
        for fmt, endian in [
            ("WAV", "FILE"),
            ("WAV", "BIG"),
            ("W64", "FILE"),
            ("AIFF", "FILE"),
            ("CAF", "FILE"),
            ("AU", "BIG"),
            ("AU", "LITTLE"),
            ("IRCAM", "BIG"),
            ("IRCAM", "LITTLE"),
            ("NIST", "FILE"),
            ("PAF", "BIG"),
            ("PAF", "LITTLE"),
            ("AVR", "FILE"),
            ("PVF", "FILE"),
            ("VOC", "FILE"),
            ("MAT5", "FILE"),
            ("RF64", "FILE"),
        ]
    },
}

# Not MP4 or AAC, though close: never refused with REASON (most do not decode at all).
NOT_MP4_OR_AAC = {
    "junk, then ADTS frames whose sampling rate alternates": lambda: (
        bytes(16) + _alternating(lambda f: _rate_index(f, 8))
    ),
    "junk, then ADTS frames whose channel count alternates": lambda: (
        bytes(16) + _alternating(lambda f: _channels(f, 2))
    ),
    "junk, then ADTS frames whose MPEG version alternates": lambda: (
        bytes(16) + _alternating(_mpeg2)
    ),
    "junk, then three agreeing ADTS frames": lambda: (
        bytes(16) + b"".join(_adts_frames()[:3]) + bytes(64)
    ),
    "junk, then two chained LOAS frames": lambda: (
        bytes(16) + b"".join(_loas_frames()[:2]) + bytes(64)
    ),
    "ADTS frames with sampling index 13": lambda: b"".join(
        _rate_index(f, 13) for f in _adts_frames()[:8]
    ),
    "ADTS frames with sampling index 14": lambda: b"".join(
        _rate_index(f, 14) for f in _adts_frames()[:8]
    ),
    "ADTS frames with sampling index 15": lambda: b"".join(
        _rate_index(f, 15) for f in _adts_frames()[:8]
    ),
    "ftyp naming only jp2": lambda: _ftyp(b"jp2 ", b"jp2 "),
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


@pytest.mark.parametrize("form", NOT_MP4_OR_AAC)
def test_near_misses_are_not_called_mp4_or_aac(tmp_path, form):
    path = _write(tmp_path, NOT_MP4_OR_AAC[form]())
    assert not sniff.is_mp4_or_aac(path)
    try:
        main.decode(path)
    except main.InvalidAudioError as e:
        assert str(e) != REASON


def test_decode_reads_an_in_memory_clip():
    # The evals decode in-memory clips (evals/audio/evals_audio/service.py).
    signals = main.decode(io.BytesIO(_encoded("WAV")))
    assert 0.9 < signals.native.size / signals.native_sr < 1.1


def test_decode_refuses_an_in_memory_m4a_with_the_reason():
    with pytest.raises(main.InvalidAudioError) as refused:
        main.decode(io.BytesIO(M4A.read_bytes()))
    assert str(refused.value) == REASON


def test_the_sniff_reads_a_file_object_from_its_position_and_puts_it_back():
    clip = io.BytesIO(b"junk" + M4A.read_bytes())
    clip.seek(4)
    assert sniff.is_mp4_or_aac(clip)
    assert clip.tell() == 4
    clip.seek(0)
    assert not sniff.is_mp4_or_aac(clip)
    assert clip.tell() == 0


def test_the_sniff_reads_a_bytes_path(tmp_path):
    assert sniff.is_mp4_or_aac(os.fsencode(_write(tmp_path, M4A.read_bytes())))


def test_the_sniff_leaves_a_closed_file_object_to_the_decoder():
    clip = io.BytesIO(M4A.read_bytes())
    clip.close()
    assert not sniff.is_mp4_or_aac(clip)


def test_an_integer_file_descriptor_is_left_to_the_decoder(tmp_path):
    path = tmp_path / "clip.wav"
    path.write_bytes(_encoded("WAV"))
    fd = os.open(path, os.O_RDONLY)
    try:
        assert not sniff.is_mp4_or_aac(fd)
        signals = main.decode(fd)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass  # soundfile closed it
    assert 0.9 < signals.native.size / signals.native_sr < 1.1


# The starts sniff.py takes for a container the service decodes (sniff._DECODABLE_MAGIC).
CONTAINER_MAGICS = [
    b"RIFF",
    b"RIFX",
    b"RF64",
    b"riff",
    b"FORM",
    b"fLaC",
    b"OggS",
    b"caff",
    b".snd",
    b"dns.",
    b"\x64\xa3\x01\x00",
    b"\x64\xa3\x02\x00",
    b"\x64\xa3\x03\x00",
    b"\x64\xa3\x04\x00",
    b"NIST",
    b" paf",
    b"fap ",
    b"2BIT",
    b"PVF1",
    b"Crea",
    b"MATL",
]


def test_the_listed_container_starts_are_the_sniffs():
    assert set(CONTAINER_MAGICS) == sniff._DECODABLE_MAGIC


@pytest.mark.parametrize("magic", [*CONTAINER_MAGICS, b"XXXX"], ids=repr)
def test_a_listed_container_start_keeps_the_frame_scan_away(tmp_path, magic):
    # Six agreeing ADTS frames 1500 bytes in: the scan would find them behind any other start.
    body = magic + bytes(1496) + b"".join(_adts_frames()[:6]) + bytes(64)
    assert sniff.is_mp4_or_aac(_write(tmp_path, body)) is (magic == b"XXXX")


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
    assert response.json() == {"detail": DETAIL, "code": "unsupported_format"}
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
    assert response.json() == {"detail": DETAIL, "code": "unsupported_format"}
    assert list(temp_dir.iterdir()) == []


# The MP4 (M4A) and AAC types a host may declare, as hosts and servers name them.
MP4_AND_AAC_TYPES = [
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "audio/m4b",
    "audio/x-m4b",
    "audio/mpeg4",
    "application/mp4",
    "audio/aac",
    "audio/aacp",
    "audio/x-aac",
    "audio/aac-adts",
    "audio/x-hx-aac-adts",
    "audio/vnd.dlna.adts",
    "audio/mp4a-latm",
    "audio/mpeg4-generic",
    "audio/3gpp",
    "audio/3gpp2",
    "video/mp4",
    "audio/AAC; charset=binary",
]


@pytest.mark.parametrize("content_type", MP4_AND_AAC_TYPES)
def test_the_header_check_refuses_them_as_a_format_not_a_download(content_type):
    response = httpx.Response(200, headers={"content-type": content_type})
    with pytest.raises(preview.UnsupportedFormatError):
        preview._check_headers(response, preview.MAX_PREVIEW_BYTES)


@pytest.mark.parametrize("content_type", sorted(preview.UNSUPPORTED_TYPES))
def test_every_unsupported_type_is_refused_over_http_with_the_reason(
    client, cdn, monkeypatch, temp_dir, content_type
):
    url = _serve(cdn, monkeypatch, "tone.m4a", M4A.read_bytes(), content_type)
    response = client.post("/analyze", json={"preview_url": url})
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": DETAIL, "code": "unsupported_format"}
    assert list(temp_dir.iterdir()) == []


@pytest.mark.parametrize("content_type", [None, ""])
def test_a_preview_without_a_content_type_is_never_measured(
    client, cdn, monkeypatch, temp_dir, content_type
):
    # Refused by its headers, before the body: never decoded as MP3 under an .mp3 name.
    url = _serve(cdn, monkeypatch, "preview", _webm_holding_mp3(), content_type)
    response = client.post("/analyze", json={"preview_url": url})
    assert response.status_code == 502, response.text
    assert response.json() == {"detail": "Could not download the preview"}
    assert list(temp_dir.iterdir()) == []


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
    response = httpx.Response(200, headers={"content-type": content_type, "content-length": "4"})
    assert preview._check_headers(response, preview.MAX_PREVIEW_BYTES) == suffix


@pytest.mark.parametrize("headers", [{}, {"content-type": ""}, {"content-type": " ; x=1"}])
def test_the_header_check_refuses_a_missing_or_empty_content_type(headers):
    response = httpx.Response(200, headers=headers)
    with pytest.raises(preview.PreviewDownloadError, match="content type"):
        preview._check_headers(response, preview.MAX_PREVIEW_BYTES)
