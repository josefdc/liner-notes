"""
Audio analysis service for Liner Notes.

Downloads a 30-second Deezer or Spotify preview and analyses it. The preview is decoded once
(soundfile, libsndfile) and every step shares that signal. MP4 (M4A) and AAC previews are
refused as a format the service does not decode (libsndfile cannot read them; the preview hosts
serve MP3).

The response is `{"v2": ...}`: AudioFeatures v2 from packages/contract (camelCase, as the
contract names them). It holds a gate for too-short, silent and noise-like input, tempo and key
with a confidence (estimators.py), loudness, the beat grid, the energy contour, neutral
sections and key moments (signal_features.py), and the model fingerprint (fingerprint.py:
Discogs styles, MusiCNN tags and mood heads) when essentia-tensorflow is installed (the
"models" extra) and the models are present and verified (see download_models.py). Every value
the service leaves null has its reason in `v2.withheld`: a stable code and the check in words.

Run locally:
    uv run uvicorn main:app --host 127.0.0.1 --port 3002

Settings (environment variables, all optional):
    CORS_ORIGINS           comma-separated browser origins allowed to call the service
    AUDIO_SERVICE_TOKEN    shared secret; when set, /analyze requires X-Audio-Token
    AUDIO_ESTIMATOR        tempo and key estimator: essentia (default when installed) or librosa
    MODELS_DIR             directory with the Essentia models (default: ./models)
    ANALYSIS_TIMEOUT_S     seconds allowed for decoding and analysis (default: 60)
    MAX_CONCURRENT_ANALYSES  analyses that run at once (default: 4)
    MAX_QUEUED_ANALYSES    requests that may wait for a free slot (default: 16)
    QUEUE_WAIT_S           seconds a request waits for a slot before a 503 (default: 10)
    AUDIO_ENABLE_DOCS      set to 1 to serve /docs and /openapi.json
"""

import asyncio
import logging
import os
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any, BinaryIO

# Keep TensorFlow's C++ logging to warnings and errors.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import fingerprint  # noqa: E402
import mpeg  # noqa: E402
import signal_features  # noqa: E402
import sniff  # noqa: E402
from estimators import (  # noqa: E402
    NO_KEY_ESTIMATE,
    STEADY_TEMPO_PARTS,
    KeyEstimate,
    Signals,
    TempoEstimate,
    Withheld,
    select_estimator,
)
from guards import AnalysisSlots, RequestGuardMiddleware, ServiceBusyError  # noqa: E402
from preview import (  # noqa: E402
    PreviewDownloadError,
    PreviewURLError,
    UnsupportedFormatError,
    download_preview,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("audio")
# httpx logs every request with its full URL at info level, and a preview URL is signed (Deezer's
# hdnea/hmac query): only its warnings and errors are logged. The service names no preview URL.
for _client_logger in ("httpx", "httpcore"):
    logging.getLogger(_client_logger).setLevel(logging.WARNING)

# =============================================================================
# Configuration
# =============================================================================

# Version of the analysis output: bump it whenever a measurement can change for the same input
# (algorithm, parameters, decoder or model change). The full version (analyzer_version())
# adds the estimator and the model set as semver build metadata.
# 2.3.0 adds `withheld` (no measurement changed). The API's audio cache is keyed by this version,
# so while the service names it, cached blocks without reasons are measured again; results the
# API already stored, and cache rows it serves while the service is down, keep their older
# blocks (without reasons) until they expire.
# 2.3.1: an Essentia tempo, its confidence and its beats no longer depend on what the process
# analysed before (estimators._rand_lock); each is what a new process measures first.
# 2.3.2: beats a tracker counted through silence are left out of the reported beat grid
# (signal_features.audible_beats); tempo, confidence and sections are unchanged.
# 2.3.3: so are runs of beats counted through an intro or an ending without a beat
# (signal_features.beats_on_the_grid); tempo, confidence and sections are unchanged.
# 2.3.4: the measured grid starts where the band's onsets start, so in the tests one onset (a
# click, a breath) under a beat of an intro of a band with such a start no longer keeps the
# intro's beats (known limits in signal_features.py), and a run on the grid's spacing but off
# its phase is left out too. A run off the grid, or whose part from its first onset is off it,
# is left out as a whole, so a band's sparse or drifting first or last beats in such a run are
# missing with it; tempo, confidence and sections are unchanged.
# 2.3.6 (2.3.5 names a key rule that was tried and not shipped): an MP3 without a Xing or Info
# header is decoded to the end of its stream, where libsndfile stopped at mpg123's length
# estimate (a fraction of a VBR stream: in the tests the gate called a 6.3 s stream too short at
# 1.2 s, and the 30 s files measured for this were read as 5.3 to 18.8 s), or refused when it
# cannot be (mpeg.py, decode()). Every other file decodes as before.
ANALYZER_VERSION = "2.3.6"
# AudioFeatures version of the `v2` block (packages/contract/src/audio.ts).
AUDIO_FEATURES_VERSION = 2
TOKEN_HEADER = "X-Audio-Token"
ANALYSIS_TIMEOUT_S = float(os.environ.get("ANALYSIS_TIMEOUT_S") or 60)
MAX_DECODE_SECONDS = 35.0
# An MP3 without a Xing or Info header whose decode falls short of its counted frames by more
# than both of these is decoded again from a pipe (mpeg.py, decode()). Read whole, such a file
# decodes to exactly its frames; read to mpg123's length estimate, the VBR files measured for
# this lost 37.6 to 82 % of their length (0.54 of the issue's 3.06 s file).
TRUNCATED_READ_SECONDS = 0.1
TRUNCATED_READ_SHARE = 0.02
# Decoded samples beyond this magnitude are not audio (a float WAV can hold 1e30); float
# overs of a few times full scale are fine.
MAX_SAMPLE_MAGNITUDE = 1000.0
# When the mono downmix keeps less than this share of the channels' RMS (antiphase stereo:
# the channels cancel), the loudest channel is analysed instead of the silent downmix.
DOWNMIX_CANCELLATION = 0.1
# Analyses run in worker threads, at most this many at once. Further requests wait up to
# QUEUE_WAIT_S for a slot (at most MAX_QUEUED_ANALYSES of them) before a 503. The wait stays
# well below the API's 30 s client timeout and does not count against ANALYSIS_TIMEOUT_S.
MAX_CONCURRENT_ANALYSES = int(os.environ.get("MAX_CONCURRENT_ANALYSES") or 4)
MAX_QUEUED_ANALYSES = int(os.environ.get("MAX_QUEUED_ANALYSES") or 16)
QUEUE_WAIT_S = float(os.environ.get("QUEUE_WAIT_S") or 10)
RETRY_AFTER_S = 5
# The blocks a gate that did not pass leaves null (the contract's AUDIO_MEASURED_BLOCKS).
MEASURED_BLOCKS = ("tempo", "key", "loudness", "beats", "energyContour", "sections", "fingerprint")


def _cors_origins() -> list[str]:
    origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    if "*" in origins:
        logger.warning("Ignoring '*' in CORS_ORIGINS; list explicit origins instead")
        origins = [o for o in origins if o != "*"]
    return origins


def _service_token() -> str:
    return os.environ.get("AUDIO_SERVICE_TOKEN", "")


# Thread pool for CPU-bound audio processing, one thread per analysis slot
executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_ANALYSES)

# Tempo and key estimator for v2 (AUDIO_ESTIMATOR; Essentia when installed).
ESTIMATOR = select_estimator()
# Load models at module level (once per worker)
MODELS_LOADED = fingerprint.load()


def analyzer_version(estimator_name: str | None = None) -> str:
    """
    ANALYZER_VERSION with the estimator (the service's, unless named) and, when the models are
    loaded, a tag for the pinned model set as semver build metadata, e.g.
    "2.3.6+essentia.models-1a2b3c4d". Every result and /health carry it. (The API's audio
    cache is keyed by track and this version, so a version change measures again; a row of
    another version is served, labelled with its analyzer, only when the service cannot say its
    version.)
    """
    build = [estimator_name or ESTIMATOR.name]
    if MODELS_LOADED:
        build.append(f"models-{fingerprint.model_set_tag()}")
    return f"{ANALYZER_VERSION}+{'.'.join(build)}"


# =============================================================================
# Data Models
# =============================================================================


class AnalyzeRequest(BaseModel):
    """Request body for audio analysis"""

    preview_url: str = Field(min_length=1, max_length=2048)


class AudioAnalysisResult(BaseModel):
    """Analysis result: the AudioFeatures v2 block, nothing else"""

    # packages/contract/schemas/audio-features.schema.json
    v2: dict[str, Any]


class HealthResponse(BaseModel):
    """Health check response"""

    status: str  # "ok", or "degraded" when the perceptual models are not loaded
    analyzer_version: str
    models: bool  # Whether the Essentia models are verified and loaded


# =============================================================================
# Audio Analysis Functions
# =============================================================================


class InvalidAudioError(ValueError):
    """The preview cannot be analysed: in a format the service does not decode, not decodable,
    or non-finite or absurd samples. The message is one of a fixed set (no paths or decoder
    output) and is returned with the 422."""


# Why an MP4 (M4A) or AAC preview is refused, when the host declared it as such or sniff.py
# recognises its first bytes. Those forms never get the generic decode failure and are never
# decoded: under an .mp3 name, libsndfile's MP3 decoder can find spurious frames in an ADTS
# stream (a tenth of a second of the 1 s test fixture, which the gate then calls too short).
# A form sniff.py does not recognise gets the generic reason.
UNSUPPORTED_FORMAT = "it is an MP4 (M4A) or AAC file, a format the service does not decode"
# Why an MP3 is refused when even a read to the end of the stream falls short of its counted
# frames by more than TRUNCATED_READ_SECONDS and TRUNCATED_READ_SHARE (decode()), or when that
# read fails: it is not measured, nor gated as too short, on that part of the preview.
TRUNCATED_MP3 = "the MP3 decodes to less audio than its MPEG audio frames hold"
MP3_READ_FAILED = "the MP3 could not be decoded to the end of its MPEG audio frames"


# Why the gate measured nothing, for each block it leaves null (v2.withheld).
GATE_WITHHELD = {
    "silence": Withheld("the preview is silent", code="gate_silence"),
    "noise": Withheld("no beat and no musical pitch in the preview", code="gate_noise"),
    "too_short": Withheld("the preview is too short to measure", code="gate_too_short"),
}
ESTIMATE_FAILED = Withheld("the estimator failed (logged by the service)", code="estimate_failed")
# An estimator that only answers tempo() or key() (one the evals run) gives None without a reason.
NO_TEMPO_ESTIMATE = Withheld("the tempo estimator gave no tempo", code="no_tempo_estimate")
UNSTEADY_TEMPO = Withheld("the tempo does not hold over the window", code="unsteady_tempo")
UNSTEADY_BEATS = Withheld(
    "the tempo does not hold over the window, and this beat tracker keeps one period",
    code="unsteady_tempo",
)
# The steadiness check needs 2 * STEADY_TEMPO_PARTS beat intervals; with fewer (a short clip) it
# cannot say whether the tempo holds, which is not evidence that it changes.
UNCHECKED_TEMPO = Withheld(
    f"fewer than {2 * STEADY_TEMPO_PARTS} beat intervals, too few to check the tempo holds",
    code="too_few_beats",
)


def _unsteady(tempo: TempoEstimate) -> Withheld:
    """Why a tempo that is not steady is withheld: it changes, or it cannot be checked."""
    if tempo.steadiness is not None and not tempo.steadiness.enough_beats:
        return UNCHECKED_TEMPO
    return UNSTEADY_TEMPO


def _signal_block(**fields) -> dict:
    return {**fields, "basis": "signal"}


def _estimate(estimator, what: str, signals: Signals):
    """
    An estimator's measure_tempo or measure_key: the estimate or why there is none (Withheld).
    An estimator with only tempo() or key() gives no reason for a None. A failure is logged and
    reported as withheld, not as an error.
    """
    estimate, missing = (
        (TempoEstimate, NO_TEMPO_ESTIMATE) if what == "tempo" else (KeyEstimate, NO_KEY_ESTIMATE)
    )
    measure = getattr(estimator, f"measure_{what}", None) or getattr(estimator, what)
    try:
        found = measure(signals)
    except Exception:
        logger.warning("The %s estimate failed; reporting it as missing", what, exc_info=True)
        return ESTIMATE_FAILED
    if isinstance(found, estimate | Withheld):
        return found
    return missing


def analyze_signals(signals: Signals, estimator=None) -> dict:
    """The response for one decoded preview: {"v2": the AudioFeatures v2 block}."""
    estimator = estimator or ESTIMATOR
    duration = signals.duration
    loudness = signal_features.levels(signals) if signals.native.size else None
    gate = signal_features.check_gate(signals, loudness)
    withheld: dict[str, Any] = {}

    v2: dict[str, Any] = {
        "version": AUDIO_FEATURES_VERSION,
        "analyzerVersion": analyzer_version(estimator.name),
        "window": {"kind": "preview-30s", "durationSeconds": round(duration, 3)},
        "gate": {"passed": gate.passed, "reason": gate.reason},
        "tempo": None,
        "key": None,
        "loudness": None,
        "beats": None,
        "energyContour": None,
        "sections": None,
        "keyMoments": [],
        "fingerprint": None,
        "withheld": withheld,
    }
    if not gate.passed:
        reason = GATE_WITHHELD[gate.reason].entry()
        withheld.update(dict.fromkeys(MEASURED_BLOCKS, reason))
        return {"v2": v2}

    tempo = _estimate(estimator, "tempo", signals)
    key = _estimate(estimator, "key", signals)
    if isinstance(tempo, Withheld):
        logger.info("No tempo: %s", tempo)
        withheld["tempo"] = withheld["beats"] = tempo.entry()
        tempo = None
    if isinstance(key, Withheld):
        logger.info("No key: %s", key)
        withheld["key"] = key.entry()
        key = None

    # A beat grid is trusted when the tempo holds, or when the tracker follows tempo changes;
    # librosa's tracker keeps one period, so after a change its grid drifts off the music.
    trusted_beats = tempo is not None and (tempo.steady or tempo.beats_follow_changes)
    if trusted_beats:
        times = np.sort(np.clip(np.asarray(tempo.beats, dtype=float), 0.0, duration))
        # Beats a tracker counted through silence are not reported; the tempo, the steadiness
        # check and the sections are measured from the tracked beats as before. A reported
        # tempo with every beat left out would give `times: []`, with no reason. That has not
        # happened on any probe or recording measured (a tempo needs onsets that repeat, and
        # the trackers put beats on them), so no reason is defined for it.
        # Runs counted through an intro or an ending without a beat are not reported either.
        times = signal_features.beats_on_the_grid(signals, times, loudness)
        times = signal_features.audible_beats(signals, times, loudness)
        v2["beats"] = _signal_block(
            times=[round(float(t), 3) for t in times], method=tempo.method.split("+")[0]
        )
    elif tempo is not None:
        unsteady = _unsteady(tempo)
        withheld["beats"] = (UNSTEADY_BEATS if unsteady is UNSTEADY_TEMPO else unsteady).entry()
    if tempo is not None:
        if tempo.steady:
            raw = tempo.raw_confidence
            v2["tempo"] = _signal_block(
                bpm=round(float(tempo.bpm), 2),
                confidence=None if tempo.confidence is None else round(tempo.confidence, 3),
                rawConfidence=None
                if raw is None
                else {"value": round(raw[0], 3), "range": [*raw[1]]},
                method=tempo.method,
            )
        else:
            logger.info(
                "No tempo: %.2f BPM does not hold over the window%s",
                tempo.bpm,
                "" if tempo.beats_follow_changes else " (and no beats)",
            )
            withheld["tempo"] = _unsteady(tempo).entry()
    if key is not None:
        v2["key"] = _signal_block(
            tonic=key.tonic,
            mode=key.mode,
            strength=None if key.strength is None else round(key.strength, 3),
            profile=key.profile,
            method=key.method,
        )
    # Sections and harmonic changes use the beat grid only when it is trusted; otherwise a
    # fixed 0.5 s grid.
    harmonic = signal_features.harmony(signals, tempo.beats if trusted_beats else None)
    level_method = (
        f"frame RMS, {signal_features.RMS_FRAME}-sample frames at {signals.sr} Hz, DC removed"
    )
    v2["loudness"] = _signal_block(rmsMean=round(loudness.mean, 6), method=f"mean {level_method}")
    v2["energyContour"] = _signal_block(
        hopSeconds=round(loudness.hop_seconds, 5),
        values=[round(float(v), 6) for v in loudness.frames],
        method=level_method,
    )
    v2["sections"] = _signal_block(segments=harmonic.segments, method=harmonic.method)
    v2["keyMoments"] = signal_features.key_moments(signals, loudness, harmonic)
    if MODELS_LOADED and (reason := signals.not_music()):
        logger.info("No fingerprint: %s", reason)
        withheld["fingerprint"] = {"code": "not_music", "reason": reason}
    else:
        # Reasons for a null fingerprint, or for its null parts, go into `withheld`.
        v2["fingerprint"] = fingerprint.fingerprint(
            signals.native, signals.native_sr, MODELS_LOADED, withheld
        )
    return {"v2": v2}


def _rereader(source: str | BinaryIO) -> Callable[[], bytes] | None:
    """
    A function that reads the whole file again after it was decoded: a path, or a binary file
    object from its current position. None for an integer file descriptor (soundfile closes it)
    and for a file object that cannot tell its position (a pipe), which the decoder refuses.
    """
    if isinstance(source, (str, bytes, os.PathLike)):

        def read_path() -> bytes:
            with open(source, "rb") as f:
                return f.read()

        return read_path
    if not all(hasattr(source, name) for name in ("read", "seek", "tell")):
        return None
    try:
        start = source.tell()
    except (OSError, ValueError):  # io.UnsupportedOperation is both
        return None

    def read_object() -> bytes:
        source.seek(start)
        return source.read()

    return read_object


def _feed(fd: int, data: bytes) -> None:
    """Write ``data`` into the pipe ``fd`` and close it; a reader that stops early ends it."""
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view) :]
    except OSError:  # BrokenPipeError: the reader closed its end
        pass
    finally:
        os.close(fd)


# Samples per read from the pipe (one MPEG-1 layer II or III frame; two MPEG-2/2.5 layer III
# frames, three layer I frames): a read that fails loses its block.
PIPE_BLOCK = 1152


def _decode_through_pipe(data: bytes) -> tuple[np.ndarray, bool]:
    """
    Decode an MPEG audio stream (from its first frame: libsndfile cannot skip a large ID3v2 tag
    or one with a footer on a pipe) read from a pipe, at most MAX_DECODE_SECONDS. libsndfile
    cannot ask mpg123 for a length on a pipe, so the read goes on until the stream ends. It is
    read in blocks of PIPE_BLOCK samples, and a block that fails (libsndfile fails on a cut last
    frame) ends it: the samples and whether a read failed. Raises when the pipe cannot be made,
    fed or opened, and leaves no descriptor open.
    """
    blocks: list[np.ndarray] = []
    failed = False
    read_end: int | None = None
    feeder: threading.Thread | None = None
    try:
        read_end, write_end = os.pipe()
        feeder = threading.Thread(target=_feed, args=(write_end, data), daemon=True)
        try:
            feeder.start()  # from here on _feed closes the write end
        except BaseException:
            feeder = None
            os.close(write_end)
            raise
        with sf.SoundFile(read_end, closefd=False) as f:
            channels, left = f.channels, int(MAX_DECODE_SECONDS * f.samplerate)
            while left > 0:
                try:
                    block = f.read(min(PIPE_BLOCK, left), dtype="float32", always_2d=True)
                except (sf.LibsndfileError, RuntimeError, EOFError):
                    failed = True
                    break
                if not len(block):
                    break
                blocks.append(block)
                left -= len(block)
    finally:
        if read_end is not None:
            os.close(read_end)
        if feeder is not None:
            feeder.join()
    samples = np.concatenate(blocks) if blocks else np.zeros((0, channels), np.float32)
    return samples, failed


def _short_of(decoded: int, stream: mpeg.StreamLength) -> bool:
    """Whether ``decoded`` samples fall short of the counted frames (up to MAX_DECODE_SECONDS)."""
    expected = min(stream.samples, int(MAX_DECODE_SECONDS * stream.sample_rate))
    shortfall = (expected - decoded) / stream.sample_rate
    return shortfall > max(
        TRUNCATED_READ_SECONDS, TRUNCATED_READ_SHARE * expected / stream.sample_rate
    )


def _whole_mpeg_stream(raw: bytes, data: np.ndarray, sr: int) -> np.ndarray:
    """
    The decoded MPEG audio ``data``, or the whole stream when libsndfile stopped at mpg123's
    estimate of its length (a VBR file without a Xing or Info header; see mpeg.py). The frames
    are counted, and a decode that falls short of them by more than TRUNCATED_READ_SECONDS and
    TRUNCATED_READ_SHARE is decoded again from a pipe, from the first frame. A file with a Xing
    or Info header that gives its frame count, one whose frames cannot be counted, and one that
    decoded to its frames keep the first decode. Raises InvalidAudioError when the second decode
    still falls short by more than that: MP3_READ_FAILED when it failed, TRUNCATED_MP3 when it
    ended early. Such a file is not measured, nor gated, on the part that decoded.
    """
    stream = mpeg.stream_length(raw)
    if stream is None or stream.length_header or stream.sample_rate != sr:
        return data
    if not _short_of(len(data), stream):
        return data
    try:
        whole, failed = _decode_through_pipe(raw[stream.start :])
    except (sf.LibsndfileError, RuntimeError, EOFError, OSError) as e:
        raise InvalidAudioError(MP3_READ_FAILED) from e
    logger.info(
        "The MP3 decoded to %.2f s of the %.2f s its %d frames hold; decoded again to %.2f s",
        len(data) / sr,
        stream.seconds,
        stream.frames,
        len(whole) / sr,
    )
    if _short_of(len(whole), stream):
        raise InvalidAudioError(MP3_READ_FAILED if failed else TRUNCATED_MP3)
    return whole


def decode(file_path: str | BinaryIO) -> Signals:
    """
    Decode a file (a path, or a binary file object such as the evals' in-memory clips) once
    (soundfile, libsndfile 1.1+ reads MP3), downmixed to mono at its own rate; the analysis
    resamples it once per rate it needs. Previews are 30 s; never decode more than
    MAX_DECODE_SECONDS, whatever the file claims.

    An MP3 is decoded to the end of its stream even when mpg123 estimated a shorter length (a
    VBR file without a Xing or Info header; _whole_mpeg_stream).

    Raises InvalidAudioError (a 422) for a file sniff.py recognises as MP4 (M4A) or AAC
    (UNSUPPORTED_FORMAT, before any decoding), when the file cannot be decoded, when an MP3
    does not decode to its frames (TRUNCATED_MP3, MP3_READ_FAILED), or when it holds non-finite
    or absurd sample values (beyond MAX_SAMPLE_MAGNITUDE). When the channels cancel in the
    downmix (antiphase stereo), the loudest channel is analysed instead.
    """
    if sniff.is_mp4_or_aac(file_path):
        raise InvalidAudioError(UNSUPPORTED_FORMAT)
    reread = _rereader(file_path)
    try:
        with sf.SoundFile(file_path) as f:
            frames = min(f.frames, int(MAX_DECODE_SECONDS * f.samplerate)) if f.frames >= 0 else -1
            data = f.read(frames, dtype="float32", always_2d=True)
            sr = f.samplerate
            mpeg_audio = f.format == "MP3"
        if mpeg_audio and reread is not None:
            data = _whole_mpeg_stream(reread(), data, sr)
    except (sf.LibsndfileError, RuntimeError, EOFError) as e:
        raise InvalidAudioError("the file could not be decoded as audio") from e
    if not np.all(np.isfinite(data)):
        raise InvalidAudioError("the decoded audio contains non-finite samples")
    if data.size and float(np.max(np.abs(data))) > MAX_SAMPLE_MAGNITUDE:
        raise InvalidAudioError("the decoded audio holds samples far beyond full scale")
    if not data.size:
        return Signals(np.zeros(0, np.float32), sr)
    mono = np.mean(data, axis=1, dtype=np.float32)
    if data.shape[1] > 1:
        channel_rms = np.sqrt(np.mean(np.square(data, dtype=np.float64), axis=0))
        mono_rms = float(np.sqrt(np.mean(np.square(mono, dtype=np.float64))))
        if mono_rms < DOWNMIX_CANCELLATION * float(np.mean(channel_rms)):
            channel = int(np.argmax(channel_rms))
            logger.info("The channels cancel in the downmix; analysing channel %d", channel)
            mono = np.ascontiguousarray(data[:, channel])
    return Signals(mono, sr)


def analyze_audio_file(file_path: str) -> dict:
    """Analyse a file: {"v2": the AudioFeatures v2 block}."""
    return analyze_signals(decode(file_path))


class AnalysisTimeoutError(Exception):
    """Decoding and analysis did not finish within ANALYSIS_TIMEOUT_S."""


async def analyze_preview_url(url: str) -> dict:
    """Download a validated preview, analyse it in the thread pool and remove the file."""
    try:
        file_path = await download_preview(url)
    except UnsupportedFormatError as e:
        # Refused by its declared type before the body was read: a format, not a download,
        # failure.
        raise InvalidAudioError(UNSUPPORTED_FORMAT) from e
    try:
        loop = asyncio.get_running_loop()
        work = loop.run_in_executor(executor, analyze_audio_file, file_path)
        try:
            return await asyncio.wait_for(work, timeout=ANALYSIS_TIMEOUT_S)
        except TimeoutError as e:
            raise AnalysisTimeoutError from e
    finally:
        try:
            os.remove(file_path)
        except OSError:
            pass


# =============================================================================
# API Endpoints
# =============================================================================


async def health_check():
    """
    Liveness and model status (GET and HEAD). Always 200 while the service can analyse tempo
    and key; status is "degraded" when the perceptual models are not loaded.
    """
    return {
        "status": "ok" if MODELS_LOADED else "degraded",
        "analyzer_version": analyzer_version(),
        "models": MODELS_LOADED,
    }


async def analyze_preview(request: AnalyzeRequest, http_request: Request):
    """
    Analyze a Deezer or Spotify preview URL.

    Returns {"v2": the AudioFeatures v2 block}, with why each null value is null in
    `v2.withheld`. Only https URLs on the preview CDNs (p.scdn.co, *.dzcdn.net) are accepted.
    """
    slots: AnalysisSlots = http_request.app.state.analysis_slots
    try:
        async with slots.slot():
            result = await analyze_preview_url(request.preview_url)
    except ServiceBusyError as e:
        logger.warning("Analysis refused, service busy: %s", e)
        raise HTTPException(
            status_code=503,
            detail="The analysis service is busy; try again",
            headers={"Retry-After": str(RETRY_AFTER_S)},
        ) from None
    except PreviewURLError as e:
        logger.info("Rejected preview URL: %s", e)
        raise HTTPException(
            status_code=400,
            detail="preview_url must be an https URL on a supported preview CDN",
        ) from None
    except PreviewDownloadError as e:
        logger.warning("Preview download failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not download the preview") from None
    except AnalysisTimeoutError:
        logger.warning("Analysis exceeded %s s", ANALYSIS_TIMEOUT_S)
        raise HTTPException(status_code=504, detail="Audio analysis timed out") from None
    except InvalidAudioError as e:
        logger.warning("Preview not analysable: %s", e)
        raise HTTPException(
            status_code=422, detail=f"The preview is not analysable audio: {e}"
        ) from None
    except Exception:
        logger.exception("Audio analysis failed")
        raise HTTPException(status_code=500, detail="Audio analysis failed") from None

    return AudioAnalysisResult(v2=result["v2"])


async def root():
    """Root endpoint with API info."""
    return {
        "service": "Liner Notes audio analysis",
        "analyzer_version": analyzer_version(),
        "models": MODELS_LOADED,
        "endpoints": {
            "/health": "Health and model status",
            "/analyze": "POST - Analyze a preview URL",
        },
    }


@asynccontextmanager
async def lifespan(application: FastAPI):
    # Created here so the semaphore belongs to the loop that serves the requests.
    application.state.analysis_slots = AnalysisSlots(
        MAX_CONCURRENT_ANALYSES, MAX_QUEUED_ANALYSES, QUEUE_WAIT_S
    )
    yield


def create_app() -> FastAPI:
    """Build the application from the current environment."""
    docs_enabled = os.environ.get("AUDIO_ENABLE_DOCS") == "1"
    application = FastAPI(
        # The interactive docs and schema are off unless explicitly enabled.
        docs_url="/docs" if docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if docs_enabled else None,
        title="Liner Notes audio analysis",
        description="Measures tempo, key and audio features from 30-second previews",
        version=analyzer_version(),
        lifespan=lifespan,
    )
    application.add_api_route(
        "/health", health_check, methods=["GET", "HEAD"], response_model=HealthResponse
    )
    application.add_api_route(
        "/analyze", analyze_preview, methods=["POST"], response_model=AudioAnalysisResult
    )
    application.add_api_route("/", root, methods=["GET"])

    # The API calls this service server to server; browsers only need CORS when an origin is
    # configured explicitly. Credentials are never allowed.
    origins = _cors_origins()
    if origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type", TOKEN_HEADER],
        )
    # Added last so it runs first: the token and the body size are checked before the
    # application reads anything.
    application.add_middleware(
        RequestGuardMiddleware,
        token=_service_token,
        token_header=TOKEN_HEADER,
        protected_paths=frozenset({"/analyze"}),
    )
    return application


app = create_app()


# =============================================================================
# Main Entry Point
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT") or 3002))
