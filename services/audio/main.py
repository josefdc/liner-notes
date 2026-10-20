"""
Audio analysis service for Liner Notes.

Downloads a 30-second Deezer or Spotify preview and analyses it.
Decoding goes through soundfile (libsndfile), which librosa 1.0 uses for every format; the
preview is decoded once and every step shares that signal.

The response has two layers:
- the v1 fields (bpm, key, mode, energy, keyMoments and the perceptual scores), kept until
  the API reads v2;
- `v2`, AudioFeatures v2 from packages/contract (camelCase, as the contract names them):
  a gate for too-short, silent and noise-like input, tempo and key with a confidence
  (estimators.py), loudness, the beat grid, the energy contour, neutral sections and key
  moments (signal_features.py), and the model fingerprint (Discogs styles, MusiCNN tags and
  mood heads) when essentia-tensorflow is installed (the "models" extra) and the models are
  present and verified (see download_models.py).

A gate that does not pass nulls every v2 measurement and the v1 bpm, key, mode, key moments
and perceptual scores: silence is never "C Major".

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

import librosa  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import estimators  # noqa: E402
import signal_features  # noqa: E402
from download_models import MODELS, is_verified, models_dir  # noqa: E402
from estimators import Signals, krumhansl_key, select_estimator  # noqa: E402
from guards import AnalysisSlots, RequestGuardMiddleware, ServiceBusyError  # noqa: E402
from model_labels import DISCOGS_STYLES, MSD_TAGS  # noqa: E402
from preview import PreviewDownloadError, PreviewURLError, download_preview  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("audio")

# =============================================================================
# Essentia TensorFlow (optional; the service runs without it)
# =============================================================================

ESSENTIA_AVAILABLE = False
try:
    from essentia.standard import (
        TensorflowPredict2D,
        TensorflowPredictEffnetDiscogs,
        TensorflowPredictMusiCNN,
    )

    ESSENTIA_AVAILABLE = True
except ImportError:
    pass

# =============================================================================
# Configuration
# =============================================================================

# Version of the analysis output: bump it whenever a measurement can change for the same input
# (algorithm, parameters, decoder or model change). Clients use it to tell results apart.
ANALYZER_VERSION = "2.0.0"
# AudioFeatures version of the `v2` block (packages/contract/src/audio.ts).
AUDIO_FEATURES_VERSION = 2
TOKEN_HEADER = "X-Audio-Token"
ANALYSIS_TIMEOUT_S = float(os.environ.get("ANALYSIS_TIMEOUT_S") or 60)
MAX_DECODE_SECONDS = 35.0
# Previews are decoded to this rate, and the beat tracker's onset envelope uses this hop
# (librosa's defaults). Together they set the resolution of the v1 tempo: 60 * SAMPLE_RATE /
# (BEAT_HOP_LENGTH * lag) BPM for a whole lag in frames. The v2 tempo is refined from the beat
# positions and is not limited to that grid.
SAMPLE_RATE = estimators.SAMPLE_RATE
BEAT_HOP_LENGTH = estimators.HOP_LENGTH
# The embedding models read 16 kHz audio.
MODEL_SAMPLE_RATE = 16000
# Analyses run in worker threads, at most this many at once. Further requests wait up to
# QUEUE_WAIT_S for a slot (at most MAX_QUEUED_ANALYSES of them) before a 503. The wait stays
# well below the API's 30 s client timeout and does not count against ANALYSIS_TIMEOUT_S.
MAX_CONCURRENT_ANALYSES = int(os.environ.get("MAX_CONCURRENT_ANALYSES") or 4)
MAX_QUEUED_ANALYSES = int(os.environ.get("MAX_QUEUED_ANALYSES") or 16)
QUEUE_WAIT_S = float(os.environ.get("QUEUE_WAIT_S") or 10)
RETRY_AFTER_S = 5
# Discogs styles reported in the fingerprint, highest activation first.
STYLE_TOP_K = 10
# Licence of the MTG model weights (essentia.upf.edu/models: CC BY-NC-SA 4.0, a proprietary
# licence on request).
MODEL_LICENCE = "CC BY-NC-SA 4.0"


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

# =============================================================================
# Essentia Model Loading
# =============================================================================

# Loaded predictors by role; empty without the models.
_models: dict[str, Any] = {}


def model_ref(name: str) -> dict:
    """The contract's ModelRef for a model in download_models.MODELS."""
    model = next(m for m in MODELS if m.name == name)
    return {"id": model.filename.removesuffix(".pb"), "licence": MODEL_LICENCE}


def _init_essentia_models() -> bool:
    """Load the Essentia models once their checksums are verified. Returns True on success."""
    if not ESSENTIA_AVAILABLE:
        logger.info(
            "essentia-tensorflow is not installed (uv sync --extra models); "
            "perceptual features disabled"
        )
        return False

    directory = models_dir()
    unverified = [m.filename for m in MODELS if not is_verified(m, directory)]
    if unverified:
        logger.warning(
            "Perceptual features disabled; missing or invalid models: %s "
            "(run 'uv run python download_models.py')",
            ", ".join(unverified),
        )
        return False

    files = {m.name: os.path.join(directory, m.filename) for m in MODELS}
    try:
        # Output nodes and class order follow each model's metadata file in the MTG model zoo.
        # The predictors take one output each, so the two backbones are loaded twice: once for
        # their predictions and once for the embeddings the heads read.
        loaded = {
            # EffNet-Discogs: sigmoid activations over the 400 Discogs styles, and embeddings.
            "styles": TensorflowPredictEffnetDiscogs(
                graphFilename=files["effnet"], output="PartitionedCall:0"
            ),
            "effnet": TensorflowPredictEffnetDiscogs(
                graphFilename=files["effnet"], output="PartitionedCall:1"
            ),
            # MusiCNN: sigmoid activations over the 50 MSD tags, and 200-dim embeddings.
            "tags": TensorflowPredictMusiCNN(
                graphFilename=files["musicnn"], output="model/Sigmoid"
            ),
            "musicnn": TensorflowPredictMusiCNN(
                graphFilename=files["musicnn"], output="model/dense/BiasAdd"
            ),
            # DEAM regression on MusiCNN embeddings: [valence, arousal] on the 1-9 DEAM scale.
            "valence": TensorflowPredict2D(graphFilename=files["valence"], output="model/Identity"),
            # Softmax heads: [danceable, not_danceable] and [instrumental, voice] on MusiCNN,
            # [acoustic, non_acoustic] on EffNet.
            "danceability": TensorflowPredict2D(
                graphFilename=files["danceability"], output="model/Softmax"
            ),
            "instrumentalness": TensorflowPredict2D(
                graphFilename=files["instrumentalness"], output="model/Softmax"
            ),
            "acousticness": TensorflowPredict2D(
                graphFilename=files["acousticness"], output="model/Softmax"
            ),
        }
    except Exception:
        logger.exception("Failed to load the Essentia models")
        return False

    _models.update(loaded)
    logger.info("Essentia models loaded")
    return True


# Load models at module level (once per worker)
MODELS_LOADED = _init_essentia_models()


def analyzer_version_v2() -> str:
    """ANALYZER_VERSION plus the estimator and, when loaded, every model id (a cache key)."""
    parts = [ANALYZER_VERSION, ESTIMATOR.name]
    if MODELS_LOADED:
        parts += [model_ref(m.name)["id"] for m in MODELS]
    return "+".join(parts)


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
    """Analysis result with extracted features"""

    bpm: int | None  # null when no tempo was found or the gate did not pass
    key: str | None  # null when no key could be measured or the gate did not pass
    mode: str | None  # "Major" or "Minor"; null with key
    energy: float | None  # loudness on 0-1 (see v1_energy); null when nothing was decoded
    duration: float  # seconds
    source: str = "analyzed"  # "analyzed" or "estimated"
    analyzer_version: str  # ANALYZER_VERSION of the service that measured it
    keyMoments: list[KeyMoment] = []  # Key moments detected in the audio
    # Perceptual features from Essentia (None when models unavailable or the gate did not pass)
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

# v1 energy: the mean frame RMS (DC removed) in dBFS, mapped linearly from
# [V1_ENERGY_FLOOR_DBFS, 0] dBFS to [0, 1]. Digital silence and a pure DC offset measure 0; a
# click track at 0.8 peak (mean RMS 0.011, -39 dBFS) about 0.35; full-scale noise near 1.
V1_ENERGY_FLOOR_DBFS = -60.0


def v1_energy(loudness: signal_features.Levels | None) -> float | None:
    """The v1 `energy` field: loudness on 0-1 (not perceptual energy), None without audio."""
    if loudness is None:
        return None
    if not loudness.mean > 0:
        return 0.0
    dbfs = 20 * math.log10(loudness.mean)
    return round(float(np.clip((dbfs - V1_ENERGY_FLOOR_DBFS) / -V1_ENERGY_FLOOR_DBFS, 0, 1)), 3)


def v1_tempo(signals: Signals) -> int | None:
    """librosa.beat.beat_track's tempo, rounded (v1; unchanged until the API reads v2)."""
    tempo, _ = librosa.beat.beat_track(
        onset_envelope=signals.onset_envelope, sr=signals.sr, hop_length=BEAT_HOP_LENGTH
    )
    bpm = float(np.atleast_1d(tempo)[0]) if np.size(tempo) else 0.0
    return round(bpm) if bpm > 0 and np.isfinite(bpm) else None


def v1_key(signals: Signals) -> tuple[str | None, str | None]:
    """Krumhansl-Kessler key on the constant-Q chromagram, as ("A", "Major") (v1)."""
    found = krumhansl_key(signals.chroma_mean)
    if found is None:
        return None, None
    tonic, mode, _ = found
    return tonic, mode.capitalize()


def _mean_head(head, embeddings: np.ndarray, column: int) -> float:
    return float(np.mean(head(embeddings)[:, column]))


def _model_score(value: float, low: float, high: float, name: str) -> dict:
    # Regression outputs can leave the scale the head was trained on; they are clipped to it.
    return {
        "value": round(float(np.clip(value, low, high)), 4),
        "range": [low, high],
        "model": model_ref(name),
        "basis": "model",
    }


def fingerprint(audio_16k: np.ndarray) -> dict | None:
    """
    The model fingerprint of the v2 block: Discogs style activations (top STYLE_TOP_K),
    MusiCNN tag activations (all 50) and the mood heads, averaged over the model patches.
    Activations are scores, not probabilities. None when the models are not loaded or the
    backbones fail; a head that fails is null on its own.
    """
    if not MODELS_LOADED:
        return None
    try:
        styles = np.mean(_models["styles"](audio_16k), axis=0)
        effnet = _models["effnet"](audio_16k)
        tags = np.mean(_models["tags"](audio_16k), axis=0)
        musicnn = _models["musicnn"](audio_16k)
    except Exception as e:
        logger.warning("Essentia model analysis failed: %s", e)
        return None

    def head(fn):
        try:
            return fn()
        except Exception as e:
            logger.warning("Essentia head failed: %s", e)
            return None

    deam = head(lambda: np.mean(_models["valence"](musicnn), axis=0))
    top = np.argsort(styles)[::-1][:STYLE_TOP_K]
    return {
        "styles": {
            "model": model_ref("effnet"),
            "top": [{"label": DISCOGS_STYLES[i], "score": round(float(styles[i]), 4)} for i in top],
            "basis": "model",
        },
        "tags": {
            "model": model_ref("musicnn"),
            "scores": [
                {"label": MSD_TAGS[i], "score": round(float(tags[i]), 4)}
                for i in np.argsort(tags)[::-1]
            ],
            "basis": "model",
        },
        "moods": {
            "danceability": head(
                lambda: _model_score(
                    _mean_head(_models["danceability"], musicnn, 0), 0, 1, "danceability"
                )
            ),
            "acoustic": head(
                lambda: _model_score(
                    _mean_head(_models["acousticness"], effnet, 0), 0, 1, "acousticness"
                )
            ),
            "instrumental": head(
                lambda: _model_score(
                    _mean_head(_models["instrumentalness"], musicnn, 0), 0, 1, "instrumentalness"
                )
            ),
            # One DEAM head ("valence" in download_models) gives both, on DEAM's 1-9 scale.
            "valence": None if deam is None else _model_score(deam[0], 1, 9, "valence"),
            "arousal": None if deam is None else _model_score(deam[1], 1, 9, "valence"),
        },
    }


def v1_perceptual(fp: dict | None) -> dict:
    """The v1 perceptual fields from the fingerprint, all on 0-1."""
    moods = (fp or {}).get("moods") or {}

    def value(name: str) -> float | None:
        score = moods.get(name)
        return None if score is None else round(score["value"], 3)

    valence = value("valence")
    return {
        # DEAM's 1-9 scale mapped linearly onto 0-1 (no longer switching mapping at 1.5).
        "valence": None if valence is None else round((valence - 1.0) / 8.0, 3),
        "danceability": value("danceability"),
        "acousticness": value("acoustic"),
        "instrumentalness": value("instrumental"),
    }


def _signal_block(**fields) -> dict:
    return {**fields, "basis": "signal"}


def analyze_signals(signals: Signals, estimator=None) -> dict:
    """The v1 fields and the v2 block for one decoded preview."""
    estimator = estimator or ESTIMATOR
    duration = signals.duration
    loudness = signal_features.levels(signals) if signals.native.size else None
    gate = signal_features.check_gate(signals, loudness)

    v2: dict[str, Any] = {
        "version": AUDIO_FEATURES_VERSION,
        "analyzerVersion": analyzer_version_v2(),
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
    result: dict[str, Any] = {
        "bpm": None,
        "key": None,
        "mode": None,
        "energy": v1_energy(loudness),
        "duration": round(duration, 2),
        "keyMoments": [],
        **v1_perceptual(None),
        "v2": v2,
    }
    if not gate.passed:
        return result

    tempo = _estimate(estimator.tempo, signals, "tempo")
    key = _estimate(estimator.key, signals, "key")
    harmonic = signal_features.harmony(signals, tempo.beats if tempo else None)
    moments = signal_features.key_moments(signals, loudness, harmonic)
    fp = fingerprint(signals.at(MODEL_SAMPLE_RATE))

    if tempo is not None:
        raw = tempo.raw_confidence
        v2["tempo"] = _signal_block(
            bpm=round(float(tempo.bpm), 2),
            confidence=None if tempo.confidence is None else round(tempo.confidence, 3),
            rawConfidence=None if raw is None else {"value": round(raw[0], 3), "range": [*raw[1]]},
            method=tempo.method,
        )
        times = np.sort(np.clip(np.asarray(tempo.beats, dtype=float), 0.0, duration))
        v2["beats"] = _signal_block(
            times=[round(float(t), 3) for t in times], method=tempo.method.split("+")[0]
        )
    if key is not None:
        v2["key"] = _signal_block(
            tonic=key.tonic,
            mode=key.mode,
            strength=None if key.strength is None else round(key.strength, 3),
            profile=key.profile,
            method=key.method,
        )
    level_method = (
        f"frame RMS, {signal_features.RMS_FRAME}-sample frames at {signals.sr} Hz, DC removed"
    )
    v2["loudness"] = _signal_block(rmsMean=round(loudness.mean, 5), method=f"mean {level_method}")
    v2["energyContour"] = _signal_block(
        hopSeconds=round(loudness.hop_seconds, 5),
        values=[round(float(v), 5) for v in loudness.frames],
        method=level_method,
    )
    v2["sections"] = _signal_block(segments=harmonic.segments, method=harmonic.method)
    v2["keyMoments"] = moments
    v2["fingerprint"] = fp

    v1_key_name, v1_mode = v1_key(signals)
    result.update(
        bpm=v1_tempo(signals),
        key=v1_key_name,
        mode=v1_mode,
        keyMoments=moments,
        **v1_perceptual(fp),
    )
    return result


def _estimate(method, signals: Signals, what: str):
    try:
        return method(signals)
    except Exception:
        logger.warning("The %s estimate failed; reporting it as missing", what, exc_info=True)
        return None


def decode(file_path: str) -> Signals:
    """
    Decode a file once, downmixed to mono at its own rate; the analysis resamples it (soxr)
    once per rate it needs. librosa 1.0 decodes with soundfile (libsndfile 1.1+ reads MP3).
    Previews are 30 s; never decode more than MAX_DECODE_SECONDS, whatever the file claims.
    """
    native, native_sr = librosa.load(file_path, sr=None, mono=True, duration=MAX_DECODE_SECONDS)
    return Signals(native, native_sr)


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
        "analyzer_version": ANALYZER_VERSION,
        "models": MODELS_LOADED,
    }


async def analyze_preview(request: AnalyzeRequest, http_request: Request):
    """
    Analyze a Deezer or Spotify preview URL.

    Measures BPM, key, mode and energy from the 30-second preview, and the AudioFeatures v2
    block (`v2`). When the Essentia models are loaded, also estimates valence, danceability,
    acousticness and instrumentalness (and the v2 fingerprint).
    Only https URLs on the preview CDNs (p.scdn.co, *.dzcdn.net) are accepted.
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
        analyzer_version=ANALYZER_VERSION,
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
        "analyzer_version": ANALYZER_VERSION,
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
        version=ANALYZER_VERSION,
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
