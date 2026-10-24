"""
Audio analysis service for Liner Notes.

Downloads a 30-second Deezer or Spotify preview and analyses it. The preview is decoded once
(soundfile, libsndfile) and every step shares that signal.

The response has two layers:
- `v2`, AudioFeatures v2 from packages/contract (camelCase, as the contract names them):
  a gate for too-short, silent and noise-like input, tempo and key with a confidence
  (estimators.py), loudness, the beat grid, the energy contour, neutral sections and key
  moments (signal_features.py), and the model fingerprint (fingerprint.py: Discogs styles,
  MusiCNN tags and mood heads) when essentia-tensorflow is installed (the "models" extra) and
  the models are present and verified (see download_models.py);
- the v1 fields (bpm, key, mode, energy, keyMoments and the perceptual scores), kept until the
  API reads v2. They are derived from `v2` and never say more than it: a tempo, key, level or
  model score that v2 withholds is null in v1 too, and silence is never "C Major".

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
import math
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any

# Keep TensorFlow's C++ logging to warnings and errors.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import fingerprint  # noqa: E402
import signal_features  # noqa: E402
from estimators import Signals, select_estimator  # noqa: E402
from guards import AnalysisSlots, RequestGuardMiddleware, ServiceBusyError  # noqa: E402
from preview import PreviewDownloadError, PreviewURLError, download_preview  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("audio")

# =============================================================================
# Configuration
# =============================================================================

# Version of the analysis output: bump it whenever a measurement can change for the same input
# (algorithm, parameters, decoder or model change). The full version (analyzer_version())
# adds the estimator and the model set as semver build metadata.
ANALYZER_VERSION = "2.1.0"
# AudioFeatures version of the `v2` block (packages/contract/src/audio.ts).
AUDIO_FEATURES_VERSION = 2
TOKEN_HEADER = "X-Audio-Token"
ANALYSIS_TIMEOUT_S = float(os.environ.get("ANALYSIS_TIMEOUT_S") or 60)
MAX_DECODE_SECONDS = 35.0
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
    "2.1.0+essentia.models-1a2b3c4d". Every result and /health carry it. (The API's audio
    cache is keyed by track, not by this version, so a version change does not by itself
    invalidate cached results.)
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


class KeyMoment(BaseModel):
    """A significant moment detected in the audio"""

    time: float  # Time in seconds
    type: str  # "energy_peak" | "energy_drop" | "onset" | "harmonic_change" | "silence"
    intensity: float  # 0-1 scale for marker visualization
    description: str  # Human-readable description


class AudioAnalysisResult(BaseModel):
    """Analysis result: the v1 fields, derived from the v2 block, and the v2 block"""

    bpm: int | None  # v2 tempo rounded; null when v2 has no tempo
    key: str | None  # v2 key tonic; null when v2 has no key
    mode: str | None  # "Major" or "Minor"; null with key
    energy: float | None  # v2 loudness on 0-1 (see v1_energy); null when v2 has none
    duration: float  # seconds
    source: str = "analyzed"  # "analyzed" or "estimated"
    analyzer_version: str  # analyzer_version() of the service that measured it
    keyMoments: list[KeyMoment] = []  # Key moments detected in the audio
    # Perceptual features from the v2 mood heads (None without them)
    valence: float | None = None
    danceability: float | None = None
    acousticness: float | None = None
    instrumentalness: float | None = None
    # AudioFeatures v2 (packages/contract/schemas/audio-features.schema.json)
    v2: dict[str, Any] | None = None


class HealthResponse(BaseModel):
    """Health check response"""

    status: str  # "ok", or "degraded" when the perceptual models are not loaded
    analyzer_version: str
    models: bool  # Whether the Essentia models are verified and loaded


# =============================================================================
# Audio Analysis Functions
# =============================================================================

# v1 energy keeps the scale the service had before v2 (the API calls "energy" above 0.7 high
# and the web shows it as a percentage): (mean frame RMS - 0.02) / 0.25, clipped to 0-1. That
# reads 0 for any mean RMS up to 0.02 (-34 dBFS), the same as silence, so input that passes
# the gate gets at least a small floor instead: V1_ENERGY_FLOOR at -86 dBFS mean RMS (the
# quietest the gate passes: 5% of frames at -60 dBFS) rising linearly in dB to
# V1_ENERGY_FLOOR_TOP at -34 dBFS. Where the old scale gives more, it is used unchanged.
# Gated input has no energy (null).
V1_ENERGY_OFFSET = 0.02
V1_ENERGY_SPAN = 0.25
V1_ENERGY_FLOOR = 0.005
V1_ENERGY_FLOOR_TOP = 0.02
V1_ENERGY_FLOOR_DBFS = (-86.0, -34.0)


class InvalidAudioError(ValueError):
    """The preview cannot be analysed: not decodable, or non-finite or absurd samples. The
    message is one of a fixed set (no paths or decoder output) and is returned with the 422."""


def v1_energy(rms_mean: float) -> float:
    """The v1 `energy` field for input that passed the gate (see V1_ENERGY_OFFSET)."""
    scaled = float(np.clip((rms_mean - V1_ENERGY_OFFSET) / V1_ENERGY_SPAN, 0, 1))
    low, high = V1_ENERGY_FLOOR_DBFS
    dbfs = 20 * math.log10(rms_mean) if rms_mean > 0 else low
    position = float(np.clip((dbfs - low) / (high - low), 0, 1))
    floor = V1_ENERGY_FLOOR + (V1_ENERGY_FLOOR_TOP - V1_ENERGY_FLOOR) * position
    return round(max(scaled, floor), 3)


def v1_fields(v2: dict) -> dict:
    """The v1 fields, derived from the v2 block (null wherever v2 has nothing)."""
    tempo, key, loudness = v2["tempo"], v2["key"], v2["loudness"]
    moods = (v2["fingerprint"] or {}).get("moods") or {}

    def mood(name: str) -> float | None:
        score = moods.get(name)
        return None if score is None else round(score["value"], 3)

    valence = mood("valence")
    return {
        "bpm": None if tempo is None else round(tempo["bpm"]),
        "key": None if key is None else key["tonic"],
        "mode": None if key is None else key["mode"].capitalize(),
        "energy": None if loudness is None else v1_energy(loudness["rmsMean"]),
        "duration": round(v2["window"]["durationSeconds"], 2),
        "keyMoments": v2["keyMoments"],
        # DEAM's 1-9 scale mapped linearly onto 0-1.
        "valence": None if valence is None else round((valence - 1.0) / 8.0, 3),
        "danceability": mood("danceability"),
        "acousticness": mood("acoustic"),
        "instrumentalness": mood("instrumental"),
    }


def _signal_block(**fields) -> dict:
    return {**fields, "basis": "signal"}


def _estimate(method, signals: Signals, what: str):
    """An estimator call; a failure is logged and reported as missing, not as an error."""
    try:
        return method(signals)
    except Exception:
        logger.warning("The %s estimate failed; reporting it as missing", what, exc_info=True)
        return None


def analyze_signals(signals: Signals, estimator=None) -> dict:
    """The v2 block for one decoded preview, and the v1 fields derived from it."""
    estimator = estimator or ESTIMATOR
    duration = signals.duration
    loudness = signal_features.levels(signals) if signals.native.size else None
    gate = signal_features.check_gate(signals, loudness)

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
    }
    if not gate.passed:
        return {**v1_fields(v2), "v2": v2}

    tempo = _estimate(estimator.tempo, signals, "tempo")
    key = _estimate(estimator.key, signals, "key")
    if key is None and (reason := signals.key_withheld()):
        logger.info("No key: %s", reason)

    # A beat grid is trusted when the tempo holds, or when the tracker follows tempo changes;
    # librosa's tracker keeps one period, so after a change its grid drifts off the music.
    trusted_beats = tempo is not None and (tempo.steady or tempo.beats_follow_changes)
    if trusted_beats:
        times = np.sort(np.clip(np.asarray(tempo.beats, dtype=float), 0.0, duration))
        v2["beats"] = _signal_block(
            times=[round(float(t), 3) for t in times], method=tempo.method.split("+")[0]
        )
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
    else:
        v2["fingerprint"] = fingerprint.fingerprint(
            signals.native, signals.native_sr, MODELS_LOADED
        )
    return {**v1_fields(v2), "v2": v2}


def decode(file_path: str) -> Signals:
    """
    Decode a file once (soundfile, libsndfile 1.1+ reads MP3), downmixed to mono at its own
    rate; the analysis resamples it once per rate it needs. Previews are 30 s; never decode
    more than MAX_DECODE_SECONDS, whatever the file claims.

    Raises InvalidAudioError (a 422) when the file cannot be decoded, or holds non-finite or
    absurd sample values (beyond MAX_SAMPLE_MAGNITUDE). When the channels cancel in the
    downmix (antiphase stereo), the loudest channel is analysed instead.
    """
    try:
        with sf.SoundFile(file_path) as f:
            frames = min(f.frames, int(MAX_DECODE_SECONDS * f.samplerate)) if f.frames >= 0 else -1
            data = f.read(frames, dtype="float32", always_2d=True)
            sr = f.samplerate
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
    """
    Analyse a file: the v1 fields (bpm, key, mode, energy, duration, keyMoments and the
    perceptual scores) plus the `v2` block.
    """
    return analyze_signals(decode(file_path))


class AnalysisTimeoutError(Exception):
    """Decoding and analysis did not finish within ANALYSIS_TIMEOUT_S."""


async def analyze_preview_url(url: str) -> dict:
    """Download a validated preview, analyse it in the thread pool and remove the file."""
    file_path = await download_preview(url)
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

    Returns the AudioFeatures v2 block (`v2`) and the v1 fields derived from it (BPM, key,
    mode, energy and, with the Essentia models, valence, danceability, acousticness and
    instrumentalness). Only https URLs on the preview CDNs (p.scdn.co, *.dzcdn.net) are
    accepted.
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

    return AudioAnalysisResult(
        bpm=result["bpm"],
        key=result["key"],
        mode=result["mode"],
        energy=result["energy"],
        duration=result["duration"],
        source="analyzed",
        analyzer_version=result["v2"]["analyzerVersion"],
        keyMoments=[KeyMoment(**m) for m in result.get("keyMoments", [])],
        valence=result.get("valence"),
        danceability=result.get("danceability"),
        acousticness=result.get("acousticness"),
        instrumentalness=result.get("instrumentalness"),
        v2=result.get("v2"),
    )


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
