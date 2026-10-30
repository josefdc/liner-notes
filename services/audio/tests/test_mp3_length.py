"""
An MP3 is decoded to its real length. libsndfile reads an MP3 up to the length mpg123 gives when
the file is opened; without a Xing or Info header that is an estimate from the file's size and
the first frame's bitrate, and for VBR it can be a fraction of the stream. The service counts the
frames (mpeg.py) and decodes such a file again from a pipe, where the read goes on to the end;
when even that falls short by more than max(0.1 s, 2 %), the preview is refused with its own
reason instead of being measured, or gated as too short, on that part. CBR files and files with
a Xing or Info header that gives the frame count decode as before.

The fixtures are 1 s of a 440 Hz sine, mono at 44.1 kHz, VBR (LAME quality 6), made with FFmpeg
(N-127579, libmp3lame) without metadata:

    ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -c:a libmp3lame -q:a 6 -write_xing 0 \\
        -map_metadata -1 -fflags +bitexact -flags:a +bitexact tone-vbr.mp3

tone-vbr.mp3 has no Xing header: libsndfile 1.2.2 reads 8700 of its 46080 samples (0.20 s of
1.04 s). tone-vbr-xing.mp3 is the same command without `-write_xing 0`. Both start with an empty
ID3v2 tag.
"""

import io
import os
import struct
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import main
import mpeg
import preview
import sniff

FIXTURES = Path(__file__).parent / "fixtures"
VBR = FIXTURES / "tone-vbr.mp3"
VBR_XING = FIXTURES / "tone-vbr-xing.mp3"
# Samples in the 40 frames of tone-vbr.mp3, and what libsndfile reads of them on its own.
VBR_SAMPLES = 40 * 1152
VBR_ESTIMATED = 8700
TRUNCATED = "the MP3 decodes to less audio than its MPEG audio frames hold"
READ_FAILED = "the MP3 could not be decoded to the end of its MPEG audio frames"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    with TestClient(main.app) as c:
        yield c


def _plain_read(source) -> np.ndarray:
    """What libsndfile reads on its own, downmixed as decode() does."""
    with sf.SoundFile(source) as f:
        data = f.read(-1, dtype="float32", always_2d=True)
    return np.mean(data, axis=1, dtype=np.float32)


def _repeated(times: int) -> bytes:
    """tone-vbr.mp3's frames ``times`` over behind its ID3v2 tag: a longer VBR stream."""
    raw = VBR.read_bytes()
    tag = sniff.id3v2_end(io.BytesIO(raw), 0)
    return raw[:tag] + raw[tag:] * times


def _sine_mp3(sr: int, seconds: float = 2.0, channels: int = 1, cbr: bool = False) -> bytes:
    """
    A 440 Hz sine written as MP3 by libsndfile (LAME, with a Xing or Info header): VBR, as the
    other tests write their MP3s, or CBR.
    """
    t = np.arange(int(sr * seconds)) / sr
    y = np.repeat((0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)[:, None], channels, 1)
    out = io.BytesIO()
    # libsndfile keeps a constant bitrate only when a compression level is set with it.
    cbr_options = {"bitrate_mode": "CONSTANT", "compression_level": 0.5}
    sf.write(out, y, sr, format="MP3", **(cbr_options if cbr else {}))
    return out.getvalue()


def _bitrates(raw: bytes) -> set[int]:
    """The bitrate indexes of the frames after the first (the Xing or Info header)."""
    at = sniff.id3v2_end(io.BytesIO(raw), 0)
    found = []
    while (frame := mpeg.parse_header(raw, at)) is not None:
        found.append(raw[at + 2] >> 4)
        at += frame.length
    return set(found[1:])


def _without_length_header(raw: bytes) -> bytes:
    """The MP3 without its first frame, the Xing or Info header."""
    start = sniff.id3v2_end(io.BytesIO(raw), 0)
    first = mpeg.parse_header(raw, start)
    assert first is not None
    return raw[:start] + raw[start + first.length :]


def _syncsafe(n: int) -> bytes:
    return bytes((n >> shift) & 0x7F for shift in (21, 14, 7, 0))


def _parts(raw: bytes) -> tuple[bytes, list[bytes], bytes]:
    """The ID3v2 tags, the frames one by one, and what follows them."""
    at = tag = sniff.id3v2_end(io.BytesIO(raw), 0)
    frames = []
    while (frame := mpeg.parse_header(raw, at)) is not None and at + frame.length <= len(raw):
        frames.append(raw[at : at + frame.length])
        at += frame.length
    return raw[:tag], frames, raw[at:]


def _whole(source) -> tuple[np.ndarray, mpeg.StreamLength]:
    """decode()'s samples and the frame count of a file (a path)."""
    return main.decode(str(source)).native, mpeg.stream_length(Path(source).read_bytes())


def _never_decoded_again(monkeypatch):
    def fail(data):
        raise AssertionError("decoded again from a pipe")

    monkeypatch.setattr(main, "_decode_through_pipe", fail)


# The issue's verification: the decoded length is within 0.1 s of the encoded length.


@pytest.mark.parametrize("form", ["path", "file object"])
def test_a_vbr_mp3_without_a_xing_header_decodes_to_its_real_length(form):
    assert len(_plain_read(VBR)) == VBR_ESTIMATED  # libsndfile alone: 0.20 s
    source = str(VBR) if form == "path" else io.BytesIO(VBR.read_bytes())
    signals = main.decode(source)
    assert signals.native_sr == 44100
    assert abs(signals.duration - 1.0) < 0.1
    # Every sample of the 40 frames, and the first decode's samples unchanged.
    assert signals.native.size == VBR_SAMPLES
    assert np.array_equal(signals.native[:VBR_ESTIMATED], _plain_read(VBR))


def test_a_longer_vbr_stream_is_measured_and_gated_on_its_whole_length(tmp_path):
    path = tmp_path / "preview.mp3"
    path.write_bytes(_repeated(6))  # 6.27 s; libsndfile alone reads 1.18 s
    assert len(_plain_read(path)) / 44100 < 1.2
    v2 = main.analyze_audio_file(str(path))["v2"]
    assert v2["window"]["durationSeconds"] == round(6 * VBR_SAMPLES / 44100, 3)
    assert v2["gate"]["reason"] != "too_short"
    assert "gate_too_short" not in {r["code"] for r in v2["withheld"].values()}


def test_a_vbr_mp3_without_a_xing_header_is_analysed_over_http(client, cdn, monkeypatch):
    base, server = cdn
    server.files["/api/1/1/a/b/0/preview.mp3"] = _repeated(6)
    monkeypatch.setattr(preview, "validate_preview_url", lambda url: None)
    response = client.post("/analyze", json={"preview_url": f"{base}/api/1/1/a/b/0/preview.mp3"})
    assert response.status_code == 200, response.text
    assert response.json()["v2"]["window"]["durationSeconds"] == round(6 * VBR_SAMPLES / 44100, 3)


# Through the real pipe: a cut last frame, large or footed ID3v2 tags, junk the frame count
# skips, and first frames whose Xing or Info header mpg123 does not use.


@pytest.mark.parametrize("cut", [1, 10, 100, 300])
def test_a_30_s_stream_with_a_cut_last_frame_is_measured_whole(tmp_path, cut):
    path = tmp_path / "cut.mp3"
    path.write_bytes(_repeated(29)[:-cut])  # 30.3 s of frames
    assert len(_plain_read(path)) < 0.5 * 29 * VBR_SAMPLES
    native, stream = _whole(path)
    assert native.size == stream.samples  # every whole frame
    assert native.size / 44100 >= 30.0
    # The pipe read fails at the cut frame; what decoded before it was kept.
    assert main._decode_through_pipe(path.read_bytes()[stream.start :])[1] is True


@pytest.mark.parametrize("form", ["300 KB cover art", "ID3v2.4 with a footer"])
def test_a_stream_behind_a_large_or_footed_id3v2_tag_is_measured_whole(tmp_path, form):
    _, frames, _ = _parts(_repeated(29))
    if form == "300 KB cover art":
        body = b"APIC" + struct.pack(">I", 300_000) + b"\x00\x00" + bytes(300_000)
        tag = b"ID3\x03\x00\x00" + _syncsafe(len(body)) + body
    else:
        body = b"APIC" + _syncsafe(1000) + b"\x00\x00" + bytes(1000)
        tag = b"ID3\x04\x00\x10" + _syncsafe(len(body)) + body + b"3DI\x04\x00\x10"
        tag += _syncsafe(len(body))
    path = tmp_path / "tagged.mp3"
    path.write_bytes(tag + b"".join(frames))
    assert len(_plain_read(path)) < 0.7 * 29 * VBR_SAMPLES
    native, stream = _whole(path)
    assert stream.start == len(tag)
    assert native.size == stream.samples == 29 * VBR_SAMPLES


@pytest.mark.parametrize(
    "form", ["zeros after the ID3v2 tag", "one zero byte and no tag", "junk after frame 3"]
)
def test_a_stream_the_count_resyncs_in_is_measured_whole(tmp_path, form):
    tag, frames, _ = _parts(_repeated(6))
    if form == "zeros after the ID3v2 tag":
        raw = tag + bytes(1000) + b"".join(frames)
    elif form == "one zero byte and no tag":
        raw = b"\x00" + b"".join(frames)
    else:
        raw = tag + b"".join(frames[:3]) + b"JUNKJUNK" + b"".join(frames[3:])
    path = tmp_path / "junk.mp3"
    path.write_bytes(raw)
    assert len(_plain_read(path)) < 0.5 * 6 * VBR_SAMPLES
    native, stream = _whole(path)
    assert native.size == stream.samples == 6 * VBR_SAMPLES


def test_a_xing_header_without_a_frame_count_is_read_whole(tmp_path):
    # mpg123 skips such a header frame but takes no length from it: the size estimate again.
    tag, frames, tail = _parts(_sine_mp3(44100, seconds=6.0, channels=2))
    header = bytearray(frames[0])
    at = header.find(b"Xing")
    header[at + 4 : at + 8] = bytes(4)
    path = tmp_path / "no-count.mp3"
    path.write_bytes(tag + bytes(header) + b"".join(frames[1:]) + tail)
    assert len(_plain_read(path)) < 0.5 * 6 * 44100
    native, stream = _whole(path)
    assert stream.length_header is False
    # Every frame but the header frame, which mpg123 skips.
    assert native.size == stream.samples - 1152
    assert native.size >= 6 * 44100


@pytest.mark.parametrize("sr", [8000, 22050, 44100])
def test_a_crc_protected_xing_frame_is_no_length_header(tmp_path, sr):
    # The header sits 2 bytes later, behind the CRC; libsndfile 1.2.2 does not use it either and
    # reads such a file to its size estimate. Made by hand (protection bit cleared, 2 CRC bytes
    # inserted): the encoders at hand do not write CRCs.
    tag, frames, tail = _parts(_sine_mp3(sr, seconds=1.5))
    first = bytearray(frames[0])
    first[1] &= 0xFE
    crc_first = bytes(first[:4]) + b"\x00\x00" + bytes(first[4:-2])
    path = tmp_path / "crc.mp3"
    path.write_bytes(tag + crc_first + b"".join(frames[1:]) + tail)
    assert len(_plain_read(path)) < 0.7 * 1.5 * sr
    native, stream = _whole(path)
    assert stream.length_header is False
    assert native.size == stream.samples  # every frame, the header frame decoded as audio


def test_a_stale_xing_frame_count_is_trusted_a_known_limit(tmp_path):
    # mpg123 reads to the header's count, on the pipe too: such a file is measured on the part
    # that decodes, as before the count existed.
    tag, frames, tail = _parts(_sine_mp3(44100, seconds=6.0, channels=2))
    header = bytearray(frames[0])
    at = header.find(b"Xing")
    header[at + 8 : at + 12] = struct.pack(">I", 50)
    path = tmp_path / "stale.mp3"
    path.write_bytes(tag + bytes(header) + b"".join(frames[1:]) + tail)
    assert mpeg.stream_length(path.read_bytes()).length_header is True
    assert np.array_equal(main.decode(str(path)).native, _plain_read(path))
    assert len(_plain_read(path)) < 50 * 1152


def _write_and_close(fd: int, data: bytes) -> None:
    try:
        os.write(fd, data)
    except OSError:
        pass
    finally:
        os.close(fd)


# soundfile's length callback raises inside libsndfile on such a source (as before the count).
@pytest.mark.filterwarnings("ignore::pytest.PytestUnraisableExceptionWarning")
def test_a_source_that_cannot_seek_is_refused_as_undecodable():
    read_end, write_end = os.pipe()
    feeder = threading.Thread(target=_write_and_close, args=(write_end, _repeated(6)))
    feeder.start()
    with os.fdopen(read_end, "rb") as source:
        with pytest.raises(
            main.InvalidAudioError, match="^the file could not be decoded as audio$"
        ):
            main.decode(source)
    feeder.join()


# A read that stays short is refused with its own reason, never measured or gated.


def test_a_read_that_stays_short_is_refused_with_its_reason(monkeypatch):
    first = sf.read(str(VBR), dtype="float32", always_2d=True)[0]
    monkeypatch.setattr(main, "_decode_through_pipe", lambda data: (first, False))
    with pytest.raises(main.InvalidAudioError, match=f"^{TRUNCATED}$"):
        main.decode(str(VBR))


def test_a_second_read_that_fails_short_is_refused_with_that_reason(monkeypatch):
    first = sf.read(str(VBR), dtype="float32", always_2d=True)[0]
    monkeypatch.setattr(main, "_decode_through_pipe", lambda data: (first, True))
    with pytest.raises(main.InvalidAudioError, match=f"^{READ_FAILED}$"):
        main.decode(str(VBR))


def test_a_second_decode_that_cannot_start_is_refused_with_that_reason(monkeypatch):
    def fail(data):
        raise sf.LibsndfileError(1)

    monkeypatch.setattr(main, "_decode_through_pipe", fail)
    with pytest.raises(main.InvalidAudioError, match=f"^{READ_FAILED}$"):
        main.decode(str(VBR))


def test_a_stream_that_turns_mono_is_refused_through_the_real_pipe(tmp_path):
    # A known limit: stereo frames, then mono frames at the same rate. The frames count both,
    # libsndfile stops at the change, so the preview is refused.
    tag, stereo, _ = _parts(_without_length_header(_sine_mp3(44100, seconds=6.0, channels=2)))
    _, mono, _ = _parts(VBR.read_bytes())
    path = tmp_path / "turns-mono.mp3"
    path.write_bytes(tag + b"".join(stereo + mono * 6))
    with pytest.raises(main.InvalidAudioError, match=f"^{TRUNCATED}$"):
        main.decode(str(path))


def test_a_truncated_preview_is_refused_over_http(client, cdn, monkeypatch, temp_dir):
    base, server = cdn
    server.files["/api/1/1/a/b/0/preview.mp3"] = VBR.read_bytes()
    monkeypatch.setattr(preview, "validate_preview_url", lambda url: None)
    monkeypatch.setattr(
        main, "_decode_through_pipe", lambda data: (np.zeros((0, 1), np.float32), False)
    )
    response = client.post("/analyze", json={"preview_url": f"{base}/api/1/1/a/b/0/preview.mp3"})
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": f"The preview is not analysable audio: {TRUNCATED}"}
    assert list(temp_dir.iterdir()) == []


# CBR files and files with a Xing or Info header decode exactly as before, without a second
# decode; so does a file whose frames and first decode agree.


def test_a_vbr_mp3_with_a_xing_header_decodes_as_before(monkeypatch):
    _never_decoded_again(monkeypatch)
    signals = main.decode(str(VBR_XING))
    assert np.array_equal(signals.native, _plain_read(VBR_XING))
    assert signals.native.size == 44100  # the Xing header's length: the encoder delay trimmed


@pytest.mark.parametrize("sr", [8000, 16000, 22050, 44100, 48000])
@pytest.mark.parametrize("info", [True, False], ids=["with info header", "without"])
def test_a_cbr_mp3_decodes_as_before(monkeypatch, tmp_path, sr, info):
    raw = _sine_mp3(sr, channels=2, cbr=True)
    assert len(_bitrates(raw)) == 1
    if not info:
        raw = _without_length_header(raw)
    stream = mpeg.stream_length(raw)
    assert stream is not None and stream.length_header is info
    path = tmp_path / "clip.mp3"
    path.write_bytes(raw)
    _never_decoded_again(monkeypatch)
    assert np.array_equal(main.decode(str(path)).native, _plain_read(path))
    if not info:
        # The frames and the decode agree: nothing to read again, nothing refused.
        assert len(_plain_read(path)) == stream.samples


@pytest.mark.parametrize("sr", [8000, 16000, 22050, 44100, 48000])
@pytest.mark.parametrize("channels", [1, 2])
def test_libsndfiles_vbr_without_its_xing_header_decodes_to_its_frames(tmp_path, sr, channels):
    raw = _sine_mp3(sr, channels=channels)
    assert len(_bitrates(raw)) > 1
    with_header = len(_plain_read(io.BytesIO(raw)))
    raw = _without_length_header(raw)
    stream = mpeg.stream_length(raw)
    path = tmp_path / "clip.mp3"
    path.write_bytes(raw)
    assert len(_plain_read(path)) < 0.5 * with_header  # libsndfile alone: the estimate
    signals = main.decode(str(path))
    # Every frame, the encoder delay and padding included (no LAME tag says what to trim).
    assert signals.native.size == stream.samples
    assert signals.duration >= 2.0


def test_the_mp3s_the_other_tests_write_decode_as_before(monkeypatch, tmp_path):
    # As test_v2 and test_fixtures write them: soundfile's MP3 (VBR with a Xing header) at
    # 22.05 kHz mono and 44.1 kHz stereo.
    _never_decoded_again(monkeypatch)
    for sr, channels in ((22050, 1), (44100, 2)):
        path = tmp_path / f"clip-{sr}.mp3"
        path.write_bytes(_sine_mp3(sr, seconds=5.0, channels=channels))
        assert np.array_equal(main.decode(str(path)).native, _plain_read(path))


def test_a_shortfall_within_the_tolerance_keeps_the_first_decode():
    stream = mpeg.StreamLength(
        frames=1000, samples=1000 * 1152, sample_rate=44100, length_header=False, start=0
    )
    seconds = stream.samples / 44100  # 26.1 s: 2 % is 0.52 s
    assert not main._short_of(stream.samples, stream)
    assert not main._short_of(int((seconds - 0.5) * 44100), stream)
    assert main._short_of(int((seconds - 0.6) * 44100), stream)
    short = mpeg.StreamLength(
        frames=40, samples=VBR_SAMPLES, sample_rate=44100, length_header=False, start=0
    )
    assert not main._short_of(VBR_SAMPLES - 4000, short)  # 0.09 s
    assert main._short_of(VBR_SAMPLES - 4800, short)  # 0.11 s


def test_a_wav_is_never_scanned_or_decoded_again(monkeypatch, tmp_path):
    path = tmp_path / "clip.wav"
    sf.write(path, np.zeros(22050, np.float32), 22050)
    _never_decoded_again(monkeypatch)
    assert main.decode(str(path)).native.size == 22050
    assert mpeg.stream_length(path.read_bytes()) is None


# The frame count (mpeg.py).


def test_the_frame_count_is_what_a_whole_decode_gives():
    for raw in (VBR.read_bytes(), _repeated(6)):
        stream = mpeg.stream_length(raw)
        assert stream is not None and not stream.length_header
        assert stream.sample_rate == 44100
        assert main._decode_through_pipe(raw[stream.start :])[0].shape[0] == stream.samples
    assert mpeg.stream_length(VBR.read_bytes()) == mpeg.StreamLength(
        frames=40, samples=VBR_SAMPLES, sample_rate=44100, length_header=False, start=20
    )


def test_the_frame_count_sees_the_xing_header():
    stream = mpeg.stream_length(VBR_XING.read_bytes())
    assert stream == mpeg.StreamLength(
        frames=41, samples=41 * 1152, sample_rate=44100, length_header=True, start=20
    )


@pytest.mark.parametrize(
    ("sr", "samples"), [(8000, 576), (16000, 576), (22050, 576), (32000, 1152), (48000, 1152)]
)
def test_the_frame_count_reads_each_mpeg_version(sr, samples):
    stream = mpeg.stream_length(_sine_mp3(sr))
    assert stream is not None and stream.sample_rate == sr
    assert stream.samples == stream.frames * samples


def test_the_frame_count_stops_at_a_trailing_tag_and_a_cut_frame():
    raw = VBR.read_bytes()
    full = mpeg.stream_length(raw)
    assert mpeg.stream_length(raw + b"TAG" + bytes(125)) == full
    assert mpeg.stream_length(raw[:-1]).frames == full.frames - 1


def test_the_frame_count_skips_frames_of_another_stream():
    _, other, _ = _parts(_sine_mp3(22050))
    raw = VBR.read_bytes()
    tag, frames, _ = _parts(raw)
    assert mpeg.stream_length(raw + b"".join(other)).frames == 40
    mixed = tag + b"".join(frames[:20] + other + frames[20:])
    assert mpeg.stream_length(mixed).frames == 40


@pytest.mark.parametrize(
    "where", ["zeros before the first frame", "junk after frame 3", "junk after frame 30"]
)
def test_the_frame_count_resyncs_after_junk(where):
    tag, frames, _ = _parts(VBR.read_bytes())
    if where == "zeros before the first frame":
        raw = tag + bytes(1000) + b"".join(frames)
    else:
        n = 3 if where == "junk after frame 3" else 30
        raw = tag + b"".join(frames[:n]) + b"JUNK\xff\xfbJUNK" + b"".join(frames[n:])
    stream = mpeg.stream_length(raw)
    assert (stream.frames, stream.samples) == (40, VBR_SAMPLES)
    assert stream.start == len(tag) + (1000 if where.startswith("zeros") else 0)


def test_the_frame_count_takes_no_false_sync():
    # A sync word whose next frames do not follow is not a frame, before or inside the stream.
    tag, frames, _ = _parts(VBR.read_bytes())
    false = frames[0][:4] + bytes(10)
    stream = mpeg.stream_length(tag + false + b"".join(frames[:5]) + false + b"".join(frames[5:]))
    assert (stream.frames, stream.start) == (40, len(tag) + len(false))


def test_the_frame_count_of_large_inputs_without_frames_or_of_tiny_frames():
    # 2 MB, the download limit: sync words with an invalid third byte, then 32-byte frames.
    assert mpeg.stream_length(b"\xff\xfb" * (1 << 20)) is None
    tiny = bytes([0xFF, 0xFF, 0x14, 0xC0]) + bytes(28)  # MPEG-1 layer I, 32 kbit/s, 48 kHz
    stream = mpeg.stream_length(tiny * (1 << 16))
    assert (stream.frames, stream.samples, stream.sample_rate) == (1 << 16, 384 << 16, 48000)


def test_a_xing_header_without_a_frame_count_is_no_length_header():
    tag, frames, tail = _parts(VBR_XING.read_bytes())
    header = bytearray(frames[0])
    at = header.find(b"Xing")
    assert header[at + 7] & 1
    header[at + 4 : at + 8] = bytes(4)
    raw = tag + bytes(header) + b"".join(frames[1:]) + tail
    assert mpeg.stream_length(raw).length_header is False


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"RIFF" + bytes(64),
        b"\xff\xfb\x00\x00" + bytes(64),  # free format: frames without a length
        b"\xff\xfb\xf0\x00" + bytes(64),  # bitrate index 15
        b"\xff\xfb\x9c\x00" + bytes(64),  # rate index 3
        b"\xff\xeb\x90\x00" + bytes(64),  # version bits 01 (reserved)
        b"\xff\xf9\x90\x00" + bytes(64),  # layer bits 00 (reserved)
    ],
    ids=["empty", "wav", "free format", "bad bitrate", "bad rate", "bad version", "bad layer"],
)
def test_the_frame_count_is_none_for_anything_else(data):
    assert mpeg.stream_length(data) is None


def test_the_frame_count_skips_id3v2_tags():
    raw = VBR.read_bytes()
    tag = sniff.id3v2_end(io.BytesIO(raw), 0)
    frame = b"TIT2" + struct.pack(">I", 5) + b"\x00\x00" + b"\x03tone"
    second = b"ID3\x03\x00\x00" + bytes([0, 0, 0, len(frame)]) + frame
    both = mpeg.stream_length(raw[:tag] + second + raw[tag:])
    one = mpeg.stream_length(raw)
    assert (both.frames, both.samples, both.start) == (one.frames, one.samples, tag + len(second))
