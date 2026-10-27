"""
Recognises MP4 (M4A) and AAC files by their first bytes, so that the service refuses them with
that reason. libsndfile reads neither, and under an .mp3 name its MP3 decoder can find spurious
frames in an ADTS stream and decode a fraction of a second of it, which the gate then calls too
short.

After up to four ID3v2 tags, a file is MP4 or AAC when it is:
- an ISO BMFF file whose `ftyp` box (first, or behind up to three `free`, `skip` or `wide`
  boxes) names an MP4, QuickTime or 3GPP brand; HEIF images (HEIC, AVIF) are not;
- an ADIF stream (the `ADIF` magic);
- an ADTS stream: an ADTS frame header (the 12-bit sync and layer 0) within the first
  SCAN_BYTES, followed by frames with the same stream parameters where each frame's length puts
  them: two frames in all for a stream at the start, _ADTS_FRAMES_PAST_START further in;
- a LOAS (LATM) stream: the 11-bit LOAS sync within the first SCAN_BYTES, and two more where
  the frame lengths put them.

A file that starts (after its ID3v2 tags) with an MPEG audio frame of layer 1-3 or with the
magic of a container libsndfile reads (_DECODABLE_MAGIC) is in a format the service decodes,
and is never refused.
"""

from __future__ import annotations

import os
import struct
from typing import BinaryIO

# How far into the file (after its ID3v2 tags) a first ADTS or LOAS frame is looked for.
SCAN_BYTES = 4096
# The longest ADTS frame (a 13-bit length) and the longest LOAS frame (3 + a 13-bit length).
_MAX_FRAME = 3 + 0x1FFF
_MAX_ID3_TAGS = 4
# The `ftyp` box may be the first box or follow up to three free space boxes.
_MAX_LEADING_BOXES = 4
# ADTS frames that must follow each other with the same stream parameters: two for a stream at
# the start (after the ID3v2 tags), four for one the scan finds further in. Behind an unknown
# 16-byte header, big-endian PCM dithered by +-8 LSB holds two agreeing headers in 73 % of
# files, three in 1.3 % and four in 1 of 3000.
_ADTS_FRAMES_PAST_START = 4
# LOAS frames that must follow each other (its sync word has only 11 bits).
_LOAS_FRAMES = 3
# The scan window: SCAN_BYTES, the frames that confirm a first header found at its end, and the
# last header.
_WINDOW = SCAN_BYTES + (max(_ADTS_FRAMES_PAST_START, _LOAS_FRAMES) - 1) * _MAX_FRAME + 16

# ISO BMFF brands of MP4 audio and video, QuickTime and Flash video. 3GPP and 3GPP2 brands
# all start with "3g".
_MP4_BRANDS = frozenset(
    {
        b"M4A ",
        b"M4B ",
        b"M4P ",
        b"M4V ",
        b"M4VH",
        b"M4VP",
        b"mp41",
        b"mp42",
        b"mp71",
        b"isom",
        *(b"iso%d" % n for n in range(2, 10)),
        b"avc1",
        b"dash",
        b"msdh",
        b"msix",
        b"cmfc",
        b"MSNV",
        b"NDAS",
        b"mmp4",
        b"qt  ",
        b"f4v ",
        b"f4a ",
        b"f4b ",
    }
)
# HEIF image brands: a file whose major brand is one of these is an image, whatever compatible
# brands it also names.
_IMAGE_BRANDS = frozenset(
    {
        b"heic",
        b"heix",
        b"heim",
        b"heis",
        b"hevc",
        b"hevx",
        b"hevm",
        b"hevs",
        b"mif1",
        b"mif2",
        b"msf1",
        b"miaf",
        b"avif",
        b"avis",
        b"avio",
        b"avci",
    }
)
# The first four bytes of these containers libsndfile reads (not all it reads): WAV (RIFF,
# RIFX, RF64, W64), AIFF and 8SVX (FORM), FLAC, Ogg, CAF, AU (both byte orders), IRCAM
# (64 A3 01-04 00), NIST SPHERE, PARIS (both byte orders), AVR, PVF, VOC and MATLAB 5.
# Big-endian PCM of a quiet start reads as ADTS sync words (0xFFFx is -16..-1), so these must
# never reach the frame scan.
_DECODABLE_MAGIC = frozenset(
    {
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
        *(b"\x64\xa3" + bytes([marker, 0]) for marker in (1, 2, 3, 4)),
        b"NIST",
        b" paf",
        b"fap ",
        b"2BIT",
        b"PVF1",
        b"Crea",
        b"MATL",
    }
)


def _id3_end(f, offset: int) -> int:
    """The offset after the leading ID3v2 tags (up to _MAX_ID3_TAGS) of a file from ``offset``."""
    for _ in range(_MAX_ID3_TAGS):
        f.seek(offset)
        header = f.read(10)
        if len(header) < 10 or header[:3] != b"ID3" or header[3] == 0xFF:
            break
        size_bytes = header[6:10]
        if any(byte & 0x80 for byte in size_bytes):
            break
        size = 0
        for byte in size_bytes:
            size = (size << 7) | byte
        footer = 10 if header[5] & 0x10 else 0
        offset += 10 + size + footer
    return offset


def _ftyp_brands(data: bytes) -> list[bytes] | None:
    """The major and compatible brands of the `ftyp` box, first or behind free space boxes."""
    offset = 0
    for _ in range(_MAX_LEADING_BOXES):
        if offset + 8 > len(data):
            return None
        size, kind = struct.unpack_from(">I4s", data, offset)
        header = 8
        if size == 1:
            if offset + 16 > len(data):
                return None
            size = struct.unpack_from(">Q", data, offset + 8)[0]
            header = 16
        if kind == b"ftyp":
            end = len(data) if size == 0 else min(offset + size, len(data))
            body = data[offset + header : end]
            if len(body) < 8:
                return None
            return [body[:4]] + [body[i : i + 4] for i in range(8, len(body) - 3, 4)]
        if kind not in (b"free", b"skip", b"wide") or size < header:
            return None
        offset += size
    return None


def _is_mp4_brand(brands: list[bytes]) -> bool:
    if brands[0] in _IMAGE_BRANDS:
        return False
    return any(brand in _MP4_BRANDS or brand.startswith(b"3g") for brand in brands)


def _starts_decodable(data: bytes) -> bool:
    """
    Whether the data starts like a format the service decodes: one of the containers in
    _DECODABLE_MAGIC, or an MPEG audio frame of layer 1-3 with a valid version, bitrate and
    sample rate (MP3, MP2, MP1).
    """
    if data[:4] in _DECODABLE_MAGIC:
        return True
    if len(data) < 4 or data[0] != 0xFF or (data[1] & 0xE0) != 0xE0:
        return False
    version, layer = (data[1] >> 3) & 0x03, (data[1] >> 1) & 0x03
    bitrate, rate = data[2] >> 4, (data[2] >> 2) & 0x03
    return version != 1 and layer != 0 and bitrate != 0x0F and rate != 0x03


def _adts_frame(data: bytes, i: int) -> tuple[int, tuple[int, ...]] | None:
    """The length and stream parameters of an ADTS frame header at ``i``, or None."""
    if i + 7 > len(data) or data[i] != 0xFF or (data[i + 1] & 0xF6) != 0xF0:
        return None
    b1, b2, b3, b4, b5 = data[i + 1 : i + 6]
    if (b2 >> 2) & 0x0F > 12:  # sampling frequency index 13-15: reserved or escape
        return None
    length = ((b3 & 0x03) << 11) | (b4 << 3) | (b5 >> 5)
    header = 7 if b1 & 0x01 else 9
    if length <= header:
        return None
    # ID and protection, profile, sampling frequency and channel configuration.
    return length, (b1, b2 & 0xFD, b3 >> 6)


def _loas_frame(data: bytes, i: int) -> int | None:
    """The length of a LOAS frame (AudioSyncStream) at ``i``, or None."""
    if i + 3 > len(data) or data[i] != 0x56 or (data[i + 1] & 0xE0) != 0xE0:
        return None
    length = 3 + (((data[i + 1] & 0x1F) << 8) | data[i + 2])
    return length if length > 3 else None


def _adts_at(data: bytes, i: int, frames: int) -> bool:
    """Whether ``frames`` ADTS frames with the same stream parameters follow each other at i."""
    first = _adts_frame(data, i)
    if first is None:
        return False
    at = i + first[0]
    for _ in range(frames - 1):
        frame = _adts_frame(data, at)
        if frame is None or frame[1] != first[1]:
            return False
        at += frame[0]
    return True


def _loas_at(data: bytes, i: int) -> bool:
    for _ in range(_LOAS_FRAMES):
        length = _loas_frame(data, i)
        if length is None:
            return False
        i += length
    return True


def _head(f) -> bytes:
    """The first _WINDOW bytes after the ID3v2 tags, from the file's current position."""
    f.seek(_id3_end(f, f.tell()))
    return f.read(_WINDOW)


def is_mp4_or_aac(source: str | os.PathLike | BinaryIO) -> bool:
    """
    Whether the file is MP4 (M4A) or AAC by its first bytes (see the module docstring).
    ``source`` is a path or a binary file object, read from its current position and put back
    there. A file that cannot be read, or anything else (an integer file descriptor), is not
    called MP4 or AAC: the decoder decides.
    """
    try:
        if isinstance(source, (str, bytes, os.PathLike)):
            with open(source, "rb") as f:
                data = _head(f)
        elif not all(hasattr(source, name) for name in ("read", "seek", "tell")):
            return False
        else:
            position = source.tell()
            try:
                data = _head(source)
            finally:
                source.seek(position)
    except (OSError, ValueError):
        # ValueError: a closed file object; io.UnsupportedOperation is both.
        return False
    if data[:4] == b"ADIF":
        return True
    brands = _ftyp_brands(data)
    if brands is not None:
        return _is_mp4_brand(brands)
    if _starts_decodable(data):
        return False
    for i in range(min(SCAN_BYTES, len(data))):
        frames = 2 if i == 0 else _ADTS_FRAMES_PAST_START
        if data[i] == 0xFF and _adts_at(data, i, frames):
            return True
        if data[i] == 0x56 and _loas_at(data, i):
            return True
    return False
