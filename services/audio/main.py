"""
Audio analysis service for Liner Notes.

Downloads a 30-second Deezer or Spotify preview and measures:
- tempo (librosa.beat.beat_track)
- key and mode (Krumhansl-Kessler profiles on a constant-Q chromagram)
- energy and notable moments
- valence, danceability, acousticness and instrumentalness, when the Essentia TensorFlow
  models are present and verified (see download_models.py)

Run locally:
    uv run uvicorn main:app --host 127.0.0.1 --port 3002

Settings (environment variables, all optional):
    CORS_ORIGINS           comma-separated browser origins allowed to call the service
    AUDIO_SERVICE_TOKEN    shared secret; when set, /analyze requires X-Audio-Token
    MODELS_DIR             directory with the Essentia models (default: ./models)
    ANALYSIS_TIMEOUT_S     seconds allowed for decoding and analysis (default: 60)
"""

import asyncio
import hmac
import logging
import os
from concurrent.futures import ThreadPoolExecutor

# Keep TensorFlow's C++ logging to warnings and errors.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import librosa  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import Depends, FastAPI, Header, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from download_models import MODELS, is_verified, models_dir  # noqa: E402
from preview import PreviewDownloadError, PreviewURLError, download_preview  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("audio")

# =============================================================================
# Essentia TensorFlow (optional; the service runs without it)
# =============================================================================

ESSENTIA_AVAILABLE = False
try:
    from essentia.standard import (
        MonoLoader,
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

VERSION = "1.0.0"
TOKEN_HEADER = "X-Audio-Token"
ANALYSIS_TIMEOUT_S = float(os.environ.get("ANALYSIS_TIMEOUT_S") or 60)


def _cors_origins() -> list[str]:
    origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    if "*" in origins:
        logger.warning("Ignoring '*' in CORS_ORIGINS; list explicit origins instead")
        origins = [o for o in origins if o != "*"]
    return origins


app = FastAPI(
    title="Liner Notes audio analysis",
    description="Measures tempo, key and audio features from 30-second previews",
    version=VERSION,
)

# The API calls this service server to server; browsers only need CORS when an origin is
# configured explicitly. Credentials are never allowed.
CORS_ORIGINS = _cors_origins()
if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", TOKEN_HEADER],
    )

# Thread pool for CPU-bound audio processing
executor = ThreadPoolExecutor(max_workers=4)

# =============================================================================
# Essentia Model Loading
# =============================================================================

_musicnn_extractor = None
_effnet_extractor = None
_valence_model = None
_danceability_model = None
_acousticness_model = None
_instrumentalness_model = None


def _init_essentia_models() -> bool:
    """Load the Essentia models once their checksums are verified. Returns True on success."""
    global _musicnn_extractor, _effnet_extractor
    global _valence_model, _danceability_model, _acousticness_model, _instrumentalness_model

    if not ESSENTIA_AVAILABLE:
        logger.info("essentia-tensorflow is not installed; perceptual features disabled")
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

    model_files = {m.name: os.path.join(directory, m.filename) for m in MODELS}
    try:
        # MusiCNN: raw audio → 200-dim embeddings
        _musicnn_extractor = TensorflowPredictMusiCNN(
            graphFilename=model_files["musicnn"],
            output="model/dense/BiasAdd",
        )

        # EffNet-Discogs: raw audio → 1280-dim embeddings
        _effnet_extractor = TensorflowPredictEffnetDiscogs(
            graphFilename=model_files["effnet"],
            output="PartitionedCall:1",
        )

        # Classification heads
        # DEAM: regression model → [valence, arousal]
        _valence_model = TensorflowPredict2D(
            graphFilename=model_files["valence"],
            output="model/Identity",
        )

        # Danceability: softmax → [danceable, not_danceable]
        _danceability_model = TensorflowPredict2D(
            graphFilename=model_files["danceability"],
            output="model/Softmax",
        )

        # Mood acoustic: softmax → [acoustic, non_acoustic]
        _acousticness_model = TensorflowPredict2D(
            graphFilename=model_files["acousticness"],
            output="model/Softmax",
        )

        # Voice/instrumental: softmax → [instrumental, voice]
        _instrumentalness_model = TensorflowPredict2D(
            graphFilename=model_files["instrumentalness"],
            output="model/Softmax",
        )
    except Exception:
        logger.exception("Failed to load the Essentia models")
        return False

    logger.info("Essentia models loaded")
    return True


# Load models at module level (once per worker)
MODELS_LOADED = _init_essentia_models()

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

    bpm: int
    key: str
    mode: str  # "Major" or "Minor"
    energy: float  # 0-1 scale
    duration: float  # seconds
    source: str = "analyzed"  # "analyzed" or "estimated"
    keyMoments: list[KeyMoment] = []  # Key moments detected in the audio
    # Perceptual features from Essentia (None when models unavailable)
    valence: float | None = None
    danceability: float | None = None
    acousticness: float | None = None
    instrumentalness: float | None = None


class HealthResponse(BaseModel):
    """Health check response"""

    status: str  # "ok", or "degraded" when the perceptual models are not loaded
    version: str
    models: bool  # Whether the Essentia models are verified and loaded


# =============================================================================
# Audio Analysis Functions
# =============================================================================

# Pitch class mapping
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Kessler key profiles for major and minor
# These are correlation weights for determining key
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def detect_key_krumhansl(chroma: np.ndarray) -> tuple[str, str]:
    """
    Detect key using Krumhansl-Kessler algorithm.

    Args:
        chroma: Chromagram (12 x time frames)

    Returns:
        Tuple of (key, mode) e.g., ("C", "Major")
    """
    # Sum chroma over time to get overall pitch class distribution
    chroma_sum = np.sum(chroma, axis=1)
    chroma_sum = chroma_sum / (np.sum(chroma_sum) + 1e-10)  # Normalize

    best_corr = -2
    best_key = 0
    best_mode = "Major"

    # Try all 12 keys for both major and minor
    for shift in range(12):
        # Rotate the chroma to align with each potential key
        rotated = np.roll(chroma_sum, -shift)

        # Correlate with major profile
        major_corr = np.corrcoef(rotated, MAJOR_PROFILE)[0, 1]
        if major_corr > best_corr:
            best_corr = major_corr
            best_key = shift
            best_mode = "Major"

        # Correlate with minor profile
        minor_corr = np.corrcoef(rotated, MINOR_PROFILE)[0, 1]
        if minor_corr > best_corr:
            best_corr = minor_corr
            best_key = shift
            best_mode = "Minor"

    return PITCH_CLASSES[best_key], best_mode


def compute_energy(y: np.ndarray) -> float:
    """
    Compute a normalized energy metric (0-1).
    Based on RMS energy relative to typical music ranges.
    """
    rms = librosa.feature.rms(y=y)[0]
    mean_rms = np.mean(rms)

    # Normalize to 0-1 range (typical RMS for music is 0.05-0.3)
    energy = np.clip((mean_rms - 0.02) / 0.25, 0, 1)
    return float(energy)


def detect_key_moments(y: np.ndarray, sr: int) -> list[dict]:
    """
    Detect significant moments in the audio using librosa.

    Detects:
    - Energy peaks/drops (RMS analysis)
    - Beat onsets (librosa.onset.onset_detect)
    - Harmonic changes (chroma variance)
    - Silence breaks (amplitude thresholds)

    Returns:
        List of key moment dictionaries sorted by time
    """
    moments = []

    # 1. RMS Energy analysis for peaks/drops
    rms = librosa.feature.rms(y=y)[0]
    rms_times = librosa.times_like(rms, sr=sr)

    # Find energy peaks (top 10% of energy moments)
    if len(rms) > 0:
        threshold = np.percentile(rms, 90)
        peak_indices = np.where(rms > threshold)[0]

        # Cluster nearby peaks and take representative (at least 2 seconds apart)
        last_peak_time = -3.0
        for idx in peak_indices:
            if idx < len(rms_times):
                current_time = float(rms_times[idx])
                if current_time - last_peak_time > 2.0:
                    moments.append(
                        {
                            "time": round(current_time, 2),
                            "type": "energy_peak",
                            "intensity": float(min(rms[idx] / (threshold + 1e-10), 1.0)),
                            "description": "Energy peak / Drop",
                        }
                    )
                    last_peak_time = current_time

    # 2. Energy drops (sudden decrease in energy)
    if len(rms) > 1:
        rms_diff = np.diff(rms)
        drop_threshold = np.percentile(rms_diff, 5)  # Bottom 5% = sudden drops
        drop_indices = np.where(rms_diff < drop_threshold)[0]

        for idx in drop_indices[:3]:  # Limit to top 3 drops
            if idx < len(rms_times):
                moments.append(
                    {
                        "time": round(float(rms_times[idx]), 2),
                        "type": "energy_drop",
                        "intensity": float(min(abs(rms_diff[idx] / (drop_threshold - 1e-10)), 1.0)),
                        "description": "Breakdown / Drop",
                    }
                )

    # 3. Onset detection for significant beat transitions
    try:
        onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units="frames")
        onset_times = librosa.frames_to_time(onset_frames, sr=sr)
        onset_strength = librosa.onset.onset_strength(y=y, sr=sr)

        if len(onset_frames) > 0 and len(onset_strength) > 0:
            # Get onset strengths at detected frames
            valid_frames = onset_frames[onset_frames < len(onset_strength)]
            if len(valid_frames) > 0:
                frame_strengths = onset_strength[valid_frames]
                strength_threshold = np.percentile(onset_strength, 85)

                # Find significant onsets
                for i, _ in enumerate(valid_frames[:10]):
                    if frame_strengths[i] > strength_threshold and i < len(onset_times):
                        moments.append(
                            {
                                "time": round(float(onset_times[i]), 2),
                                "type": "onset",
                                "intensity": 0.8,
                                "description": "Beat transition",
                            }
                        )
    except Exception:
        pass  # Onset detection can fail on some audio

    # 4. Harmonic changes via chroma variance
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_times = librosa.times_like(chroma, sr=sr)

        if chroma.shape[1] > 10:
            # Calculate rolling variance of chroma
            window_size = 10
            chroma_var = np.array(
                [np.var(chroma[:, max(0, i - window_size) : i + 1]) for i in range(chroma.shape[1])]
            )

            # Find sudden harmonic changes
            var_threshold = np.percentile(chroma_var, 90)
            harmonic_changes = np.where(chroma_var > var_threshold)[0]

            last_harmonic_time = -3.0
            for idx in harmonic_changes[:5]:
                if idx < len(chroma_times):
                    current_time = float(chroma_times[idx])
                    if current_time - last_harmonic_time > 2.0:
                        moments.append(
                            {
                                "time": round(current_time, 2),
                                "type": "harmonic_change",
                                "intensity": 0.7,
                                "description": "Harmonic shift",
                            }
                        )
                        last_harmonic_time = current_time
    except Exception:
        pass  # Chroma analysis can fail on some audio

    # 5. Silence detection
    silence_threshold = 0.01
    silence_indices = np.where(rms < silence_threshold)[0]

    if len(silence_indices) > 0:
        last_silence_time = -2.0
        for idx in silence_indices[:3]:
            if idx < len(rms_times):
                current_time = float(rms_times[idx])
                if current_time - last_silence_time > 1.0 and current_time > 0.5:
                    moments.append(
                        {
                            "time": round(current_time, 2),
                            "type": "silence",
                            "intensity": 0.5,
                            "description": "Silence break",
                        }
                    )
                    last_silence_time = current_time

    # Sort by time and deduplicate (remove moments within 0.5s of each other)
    moments.sort(key=lambda x: x["time"])

    deduplicated = []
    last_time = -1.0
    for m in moments:
        if m["time"] - last_time > 0.5:
            deduplicated.append(m)
            last_time = m["time"]

    return deduplicated[:10]  # Return top 10 moments


def analyze_perceptual_features(file_path: str) -> dict:
    """
    Analyze perceptual audio features using Essentia TensorFlow models.

    Uses pre-trained MusiCNN and EffNet-Discogs models from the MTG model zoo:
    - Valence: DEAM regression model (emotional positivity, 0=sad to 1=happy)
    - Danceability: MusiCNN classifier (probability of being danceable)
    - Acousticness: EffNet classifier (probability of being acoustic)
    - Instrumentalness: MusiCNN classifier (probability of being instrumental)

    All models process audio at 16kHz. MusiCNN embeddings are computed once
    and reused for valence, danceability, and instrumentalness heads.

    Returns:
        dict with valence, danceability, acousticness, instrumentalness (all 0-1),
        or empty dict if models are unavailable.
    """
    if not MODELS_LOADED:
        return {}

    try:
        # Load audio at 16kHz mono (required by the embedding models)
        audio = MonoLoader(filename=file_path, sampleRate=16000, resampleQuality=4)()

        # MusiCNN embeddings (200-dim per frame, reused for 3 classification heads)
        musicnn_embeddings = _musicnn_extractor(audio)

        # --- Valence (DEAM regression) ---
        # Output shape: (N, 2) → columns are [valence, arousal] per frame
        valence_preds = _valence_model(musicnn_embeddings)
        valence_mean = np.mean(valence_preds, axis=0)
        valence_raw = float(valence_mean[0])  # First column = valence

        # DEAM annotations are in [1, 9]; normalize to [0, 1]
        if valence_raw > 1.5:
            valence = (valence_raw - 1.0) / 8.0
        else:
            # Already in ~[0, 1] range (some model versions output normalized values)
            valence = valence_raw
        valence = float(np.clip(valence, 0, 1))

        # --- Danceability (softmax classifier) ---
        # Output shape: (N, 2) → [danceable, not_danceable] per frame
        dance_preds = _danceability_model(musicnn_embeddings)
        danceability = float(np.clip(np.mean(dance_preds[:, 0]), 0, 1))

        # --- Instrumentalness (softmax classifier) ---
        # Output shape: (N, 2) → [instrumental, voice] per frame
        inst_preds = _instrumentalness_model(musicnn_embeddings)
        instrumentalness = float(np.clip(np.mean(inst_preds[:, 0]), 0, 1))

        # --- Acousticness (EffNet-based, separate embedding model) ---
        # EffNet embeddings: 1280-dim per frame
        effnet_embeddings = _effnet_extractor(audio)
        # Output shape: (N, 2) → [acoustic, non_acoustic] per frame
        acoustic_preds = _acousticness_model(effnet_embeddings)
        acousticness = float(np.clip(np.mean(acoustic_preds[:, 0]), 0, 1))

        return {
            "valence": round(valence, 3),
            "danceability": round(danceability, 3),
            "acousticness": round(acousticness, 3),
            "instrumentalness": round(instrumentalness, 3),
        }

    except Exception as e:
        logger.warning("Essentia perceptual analysis failed: %s", e)
        return {}


def analyze_audio_file(file_path: str) -> dict:
    """
    Perform full audio analysis on a file.

    Returns dict with bpm, key, mode, energy, duration, keyMoments,
    and optionally valence, danceability, acousticness, instrumentalness.
    """
    # Load audio (librosa handles MP3 via audioread/ffmpeg)
    y, sr = librosa.load(file_path, sr=22050, mono=True)

    # Get duration
    duration = librosa.get_duration(y=y, sr=sr)

    # Beat tracking for BPM
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)

    # Handle tempo being an array in newer librosa versions
    if isinstance(tempo, np.ndarray):
        bpm = float(tempo[0]) if len(tempo) > 0 else 120.0
    else:
        bpm = float(tempo)

    # Chromagram for key detection
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key, mode = detect_key_krumhansl(chroma)

    # Energy
    energy = compute_energy(y)

    # Detect key moments (drops, peaks, transitions)
    key_moments = detect_key_moments(y, sr)

    result = {
        "bpm": round(bpm),
        "key": key,
        "mode": mode,
        "energy": round(energy, 3),
        "duration": round(duration, 2),
        "keyMoments": key_moments,
    }

    # Perceptual features via Essentia (if models are loaded)
    perceptual = analyze_perceptual_features(file_path)
    result.update(perceptual)

    return result


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


def require_token(x_audio_token: str | None = Header(default=None)) -> None:
    """Reject the request when AUDIO_SERVICE_TOKEN is set and the header does not match."""
    expected = os.environ.get("AUDIO_SERVICE_TOKEN", "")
    if not expected:
        return
    supplied = x_audio_token or ""
    if not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Liveness and model status. Always 200 while the service can analyse tempo and key;
    status is "degraded" when the perceptual models are not loaded.
    """
    return {
        "status": "ok" if MODELS_LOADED else "degraded",
        "version": VERSION,
        "models": MODELS_LOADED,
    }


@app.post("/analyze", response_model=AudioAnalysisResult, dependencies=[Depends(require_token)])
async def analyze_preview(request: AnalyzeRequest):
    """
    Analyze a Deezer or Spotify preview URL.

    Measures BPM, key, mode and energy from the 30-second preview. When the Essentia models
    are loaded, also estimates valence, danceability, acousticness and instrumentalness.
    Only https URLs on the preview CDNs (p.scdn.co, *.dzcdn.net) are accepted.
    """
    try:
        result = await analyze_preview_url(request.preview_url)
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
        keyMoments=[KeyMoment(**m) for m in result.get("keyMoments", [])],
        valence=result.get("valence"),
        danceability=result.get("danceability"),
        acousticness=result.get("acousticness"),
        instrumentalness=result.get("instrumentalness"),
    )


@app.get("/")
async def root():
    """Root endpoint with API info."""
    return {
        "service": "Liner Notes audio analysis",
        "version": VERSION,
        "models": MODELS_LOADED,
        "endpoints": {
            "/health": "Health and model status",
            "/analyze": "POST - Analyze a preview URL",
        },
    }


# =============================================================================
# Main Entry Point
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT") or 3002))
