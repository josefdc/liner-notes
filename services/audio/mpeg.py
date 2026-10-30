"""
The length of an MPEG audio stream (MP3, MP2, MP1) by counting its frames.

libsndfile hands MP3 to mpg123, and its read stops at the length mpg123 gives when the file is
opened. mpg123 takes that length from a Xing or Info header in the first frame. Without one it
estimates it from the file's size and the first frame's bitrate, which is close for CBR and can
be far off for VBR: a 3.03 s VBR file whose first frame has a high bitrate is estimated, and
read, as 0.54 s. Each frame header gives its own length in bytes and its number of samples, so
counting the frames gives the stream's real length without decoding it.

The scan starts after the leading ID3v2 tags and takes the first sync word followed by
CONFIRMING_FRAMES frames in a row (each where the previous frame's length puts it) for the first
frame, so leading zeros or junk are skipped and a false sync is not counted. It then counts the
frames whose header has the first frame's version, layer and sample rate. At a byte that does
not start such a frame (junk inside the stream, an ID3v1 or APE tag, a cut last frame) it looks
for the next confirmed frame, as mpg123 resyncs, and the count goes on from there. The scan is
linear in the file's size. A free-format stream (bitrate index 0) gives frames no length and is
not counted.

Known limits; such a file is measured on the part that decodes, as before the count existed:
- A Xing or Info header with a frame count is trusted (mpg123 reads to it), so a header whose
  count is stale (lower than the frames that follow) is not caught.
- main.decode cannot read an integer file descriptor again (soundfile closes it), so a file
  given that way is not counted.
"""

from __future__ import annotations

import functools
import io
import re
from dataclasses import dataclass

import sniff

# Bitrates in kbit/s by bitrate index (1-14), for MPEG-1 layers I, II and III and for MPEG-2
# and 2.5 layer I and layers II and III.
_BITRATES = {
    (1, 1): (32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448),
    (1, 2): (32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384),
    (1, 3): (32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
    (2, 1): (32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256),
    (2, 2): (8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
    (2, 3): (8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
}
# Sample rates in Hz by version (MPEG-1, 2, 2.5) and rate index (0-2).
_SAMPLE_RATES = {1: (44100, 48000, 32000), 2: (22050, 24000, 16000), 25: (11025, 12000, 8000)}
# Version bits: 00 MPEG-2.5, 10 MPEG-2, 11 MPEG-1 (01 is reserved).
_VERSIONS = {0: 25, 2: 2, 3: 1}
# Where a Xing or Info header starts in the first frame (after the 4-byte header and the side
# information), by version and whether the frame is mono.
_XING_OFFSETS = {(1, False): 36, (1, True): 21, (2, False): 21, (2, True): 13}
# The Xing flag that says the header holds the number of frames.
_XING_FRAMES_FLAG = 0x01
# Frames with the same version, layer and sample rate that must follow each other (each where the
# previous one's length puts it) before the scan takes a sync word for a frame, at the start and
# after junk; fewer do when they end exactly at the end of the file.
CONFIRMING_FRAMES = 3
# The first three bytes of a header parse_header accepts: the sync, a version other than the
# reserved 01 and a layer other than the reserved 00, then a bitrate index of 1-14 and a rate
# index of 0-2. The sync search runs in C; only these candidates are parsed.
_SYNC = re.compile(
    b"\\xff["
    + b"".join(
        re.escape(bytes([b])) for b in range(0xE0, 0x100) if (b >> 3) & 3 != 1 and (b >> 1) & 3
    )
    + b"]["
    + b"".join(re.escape(bytes([b])) for b in range(0x10, 0xF0) if (b >> 2) & 3 != 3)
    + b"]"
)


@dataclass(frozen=True)
class Header:
    """An MPEG audio frame header: what the scan compares and counts."""

    version: int  # 1, 2 or 25 (MPEG-2.5)
    layer: int  # 1, 2 or 3
    sample_rate: int
    mono: bool
    length: int  # bytes, header included
    samples: int  # samples per channel the frame decodes to


@dataclass(frozen=True)
class StreamLength:
    """What counting the frames of an MPEG audio stream found."""

    frames: int
    samples: int  # per channel, over every frame counted
    sample_rate: int
    # A Xing or Info header with a frame count in the first frame: mpg123 takes the length from
    # it, and trims the encoder delay and padding its LAME tag gives, so the decoded length is
    # that header frame and up to two more frames shorter than the count.
    length_header: bool
    start: int  # the offset of the first frame in the file

    @property
    def seconds(self) -> float:
        return self.samples / self.sample_rate


def parse_header(data: bytes, i: int) -> Header | None:
    """The MPEG audio frame header at ``i``, or None (no sync, a reserved or free-format field)."""
    if i + 4 > len(data) or data[i] != 0xFF:
        return None
    return _header(data[i + 1], data[i + 2], data[i + 3] >> 6)


@functools.cache
def _header(b1: int, b2: int, mode: int) -> Header | None:
    """The header for its second and third bytes and channel mode (cached: a scan of junk full
    of sync words parses the same few headers over and over)."""
    if (b1 & 0xE0) != 0xE0:
        return None
    version = _VERSIONS.get((b1 >> 3) & 0x03)
    layer = 4 - ((b1 >> 1) & 0x03)
    bitrate_index, rate_index = b2 >> 4, (b2 >> 2) & 0x03
    if version is None or layer == 4 or bitrate_index in (0, 15) or rate_index == 3:
        return None
    padding = (b2 >> 1) & 0x01
    bitrate = _BITRATES[(min(version, 2), layer)][bitrate_index - 1] * 1000
    sample_rate = _SAMPLE_RATES[version][rate_index]
    if layer == 1:
        length, samples = (12 * bitrate // sample_rate + padding) * 4, 384
    elif layer == 2 or version == 1:
        length, samples = 144 * bitrate // sample_rate + padding, 1152
    else:
        length, samples = 72 * bitrate // sample_rate + padding, 576
    return Header(version, layer, sample_rate, mode == 0x03, length, samples)


def _has_length_header(data: bytes, i: int, first: Header) -> bool:
    """
    Whether the first frame (at ``i``) is a Xing or Info header that gives the number of frames.
    The offset is the one for a frame without CRC: libsndfile 1.2.2 reads a file whose header
    sits 2 bytes further in, behind a CRC, to its size estimate, as if it had none.
    """
    at = i + _XING_OFFSETS[(min(first.version, 2), first.mono)]
    if data[at : at + 4] not in (b"Xing", b"Info"):
        return False
    return len(data) >= at + 8 and bool(data[at + 7] & _XING_FRAMES_FLAG)


def _key(frame: Header) -> tuple[int, int, int]:
    return frame.version, frame.layer, frame.sample_rate


def _confirmed(data: bytes, i: int, key: tuple[int, int, int] | None) -> Header | None:
    """
    The frame at ``i`` when CONFIRMING_FRAMES frames with its version, layer and sample rate
    (``key``, when given) follow each other from it, or fewer that end exactly at the end.
    """
    first = parse_header(data, i)
    if first is None or (key is not None and _key(first) != key):
        return None
    at = i
    for _ in range(CONFIRMING_FRAMES):
        frame = parse_header(data, at)
        if frame is None or _key(frame) != _key(first) or at + frame.length > len(data):
            return None
        at += frame.length
        if at == len(data):
            break
    return first


def _sync(data: bytes, i: int, key: tuple[int, int, int] | None) -> int | None:
    """The offset of the first confirmed frame at or after ``i`` (see _confirmed), or None."""
    while (found := _SYNC.search(data, i)) is not None:
        if _confirmed(data, found.start(), key) is not None:
            return found.start()
        i = found.start() + 1
    return None


def stream_length(data: bytes) -> StreamLength | None:
    """
    The frames counted in the bytes of an MPEG audio file (see the module docstring), or None
    when no confirmed frame follows the ID3v2 tags (any other format, a free-format stream).
    """
    start = _sync(data, sniff.id3v2_end(io.BytesIO(data), 0), None)
    if start is None:
        return None
    first = parse_header(data, start)
    key = _key(first)
    frames = samples = 0
    at: int | None = start
    while at is not None:
        frame = parse_header(data, at)
        if frame is None or _key(frame) != key or at + frame.length > len(data):
            # Junk, a frame of another stream or a cut last frame: on to the next confirmed frame.
            at = _sync(data, at + 1, key)
            continue
        end = at + frame.length
        following = parse_header(data, end)
        if end == len(data) or (following is not None and _key(following) == key):
            frames, samples, at = frames + 1, samples + frame.samples, end
            continue
        # No frame follows: the last frame before junk or a tag, or a false sync word inside the
        # stream, which a confirmed frame starts before the end of.
        resync = _sync(data, at + 1, key)
        if resync is None or resync >= end:
            frames, samples = frames + 1, samples + frame.samples
        at = resync
    header = _has_length_header(data, start, first)
    return StreamLength(frames, samples, first.sample_rate, header, start)
