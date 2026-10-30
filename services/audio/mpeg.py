"""
The length of an MPEG audio stream (MP3, MP2, MP1) by counting its frames.

libsndfile hands MP3 to mpg123, and its read stops at the length mpg123 gives when the file is
opened. mpg123 takes that length from a Xing or Info header in the first frame. Without one it
estimates it from the file's size and the first frame's bitrate, which is close for CBR and can
be far off for VBR: a 3.03 s VBR file whose first frame has a high bitrate is estimated, and
read, as 0.54 s. Each frame header gives its own length in bytes and its number of samples, so
counting the frames gives the stream's real length without decoding it.

The scan starts right after the leading ID3v2 tags, where libsndfile looks for the first frame,
and counts frames whose header has the first frame's version, layer and sample rate, each where
the previous frame's length puts it. It stops at the first byte that does not start such a frame
(an ID3v1 or APE tag, junk, the end of the file) and leaves out a last frame the file cuts short.
mpg123 resyncs after junk inside a stream, so the count may fall short of what it decodes. A
free-format stream (bitrate index 0) gives frames no length and is not counted.
"""

from __future__ import annotations

import io
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
    # A Xing or Info header in the first frame: mpg123 takes the length from it, and trims the
    # encoder delay and padding its LAME tag gives, so the decoded length is that header frame
    # and up to two more frames shorter than the count.
    length_header: bool

    @property
    def seconds(self) -> float:
        return self.samples / self.sample_rate


def parse_header(data: bytes, i: int) -> Header | None:
    """The MPEG audio frame header at ``i``, or None (no sync, a reserved or free-format field)."""
    if i + 4 > len(data) or data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
        return None
    version = _VERSIONS.get((data[i + 1] >> 3) & 0x03)
    layer = 4 - ((data[i + 1] >> 1) & 0x03)
    bitrate_index, rate_index = data[i + 2] >> 4, (data[i + 2] >> 2) & 0x03
    if version is None or layer == 4 or bitrate_index in (0, 15) or rate_index == 3:
        return None
    padding = (data[i + 2] >> 1) & 0x01
    bitrate = _BITRATES[(min(version, 2), layer)][bitrate_index - 1] * 1000
    sample_rate = _SAMPLE_RATES[version][rate_index]
    if layer == 1:
        length, samples = (12 * bitrate // sample_rate + padding) * 4, 384
    elif layer == 2 or version == 1:
        length, samples = 144 * bitrate // sample_rate + padding, 1152
    else:
        length, samples = 72 * bitrate // sample_rate + padding, 576
    mono = (data[i + 3] >> 6) == 0x03
    return Header(version, layer, sample_rate, mono, length, samples)


def _has_length_header(data: bytes, first: Header) -> bool:
    """Whether the first frame is a Xing or Info header."""
    at = _XING_OFFSETS[(min(first.version, 2), first.mono)]
    return data[at : at + 4] in (b"Xing", b"Info")


def stream_length(data: bytes) -> StreamLength | None:
    """
    The frames counted in the bytes of an MPEG audio file (see the module docstring), or None
    when they do not start with an MPEG audio frame after the ID3v2 tags (any other format), or
    when that frame is free-format.
    """
    data = data[sniff.id3v2_end(io.BytesIO(data), 0) :]
    first = parse_header(data, 0)
    if first is None:
        return None
    frames = samples = at = 0
    while (frame := parse_header(data, at)) is not None and at + frame.length <= len(data):
        if (frame.version, frame.layer, frame.sample_rate) != (
            first.version,
            first.layer,
            first.sample_rate,
        ):
            break
        frames += 1
        samples += frame.samples
        at += frame.length
    return StreamLength(frames, samples, first.sample_rate, _has_length_header(data, first))
