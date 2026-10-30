"""
An MP3 is decoded to its real length. libsndfile reads an MP3 up to the length mpg123 gives when
the file is opened; without a Xing or Info header that is an estimate from the file's size and
the first frame's bitrate, and for VBR it can be a fraction of the stream. The service counts the
frames (mpeg.py) and decodes such a file again from a pipe, where the read goes on to the end;
when even that falls short, the preview is refused with its own reason. It is never measured, nor
gated as too short, on part of the stream. CBR files and files with a Xing or Info header decode
as before.

The fixtures are 1 s of a 440 Hz sine, mono at 44.1 kHz, VBR (LAME quality 6), made with FFmpeg
(N-127579, libmp3lame) without metadata:

    ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -c:a libmp3lame -q:a 6 -write_xing 0 \\
        -map_metadata -1 -fflags +bitexact -flags:a +bitexact tone-vbr.mp3

tone-vbr.mp3 has no Xing header: libsndfile 1.2.2 reads 8700 of its 46080 samples (0.20 s of
1.04 s). tone-vbr-xing.mp3 is the same command without `-write_xing 0`. Both start with an empty
ID3v2 tag.
"""

import io
import struct
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
TRUNCATED = "the MP3 decodes to less audio than its frames hold"


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


# A read that stays short is refused with its own reason, never measured or gated.


def test_a_read_that_stays_short_is_refused_with_its_reason(monkeypatch):
    first = sf.read(str(VBR), dtype="float32", always_2d=True)[0]
    monkeypatch.setattr(main, "_decode_through_pipe", lambda data: first)
    with pytest.raises(main.InvalidAudioError, match=f"^{TRUNCATED}$"):
        main.decode(str(VBR))


def test_a_second_decode_that_fails_is_refused_with_the_same_reason(monkeypatch):
    def fail(data):
        raise sf.LibsndfileError(1)

    monkeypatch.setattr(main, "_decode_through_pipe", fail)
    with pytest.raises(main.InvalidAudioError, match=f"^{TRUNCATED}$"):
        main.decode(str(VBR))


def test_a_truncated_preview_is_refused_over_http(client, cdn, monkeypatch, temp_dir):
    base, server = cdn
    server.files["/api/1/1/a/b/0/preview.mp3"] = VBR.read_bytes()
    monkeypatch.setattr(preview, "validate_preview_url", lambda url: None)
    monkeypatch.setattr(main, "_decode_through_pipe", lambda data: np.zeros((0, 1), np.float32))
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
        frames=1000, samples=1000 * 1152, sample_rate=44100, length_header=False
    )
    seconds = stream.samples / 44100  # 26.1 s: 2 % is 0.52 s
    assert not main._short_of(stream.samples, stream)
    assert not main._short_of(int((seconds - 0.5) * 44100), stream)
    assert main._short_of(int((seconds - 0.6) * 44100), stream)
    short = mpeg.StreamLength(
        frames=40, samples=VBR_SAMPLES, sample_rate=44100, length_header=False
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
        assert stream.samples == len(main._decode_through_pipe(raw))
    assert mpeg.stream_length(VBR.read_bytes()) == mpeg.StreamLength(
        frames=40, samples=VBR_SAMPLES, sample_rate=44100, length_header=False
    )


def test_the_frame_count_sees_the_xing_header():
    stream = mpeg.stream_length(VBR_XING.read_bytes())
    assert stream == mpeg.StreamLength(
        frames=41, samples=41 * 1152, sample_rate=44100, length_header=True
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


def test_the_frame_count_stops_at_a_frame_of_another_stream():
    raw = VBR.read_bytes() + _sine_mp3(22050)[sniff.id3v2_end(io.BytesIO(_sine_mp3(22050)), 0) :]
    assert mpeg.stream_length(raw).frames == 40


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
    assert mpeg.stream_length(raw[:tag] + second + raw[tag:]) == mpeg.stream_length(raw)
