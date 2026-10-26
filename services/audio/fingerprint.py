"""
The model fingerprint of AudioFeatures v2: Discogs style activations (EffNet-Discogs), MusiCNN
tag activations and the mood heads, from the MTG model zoo (essentia-tensorflow, the "models"
extra, and the files pinned in download_models.py).

Each backbone graph is loaded once and run once per analysis: one TensorflowPredict session per
backbone returns both its predictions (styles or tags) and the embeddings the heads read, on a
mel spectrogram computed once for both. This is the computation of TensorflowPredictEffnetDiscogs
and TensorflowPredictMusiCNN (the same TensorflowInputMusiCNN frames and patches; a test checks
the outputs are identical), without loading each graph twice to get its two outputs. The heads
run as plain TensorflowPredict sessions too (the outputs of TensorflowPredict2D): the composite
Essentia predictors log "No network created" for every patch once the most recently created
Essentia network is gone.

The input follows the MTG reference: the decoded signal resampled to 16 kHz by Essentia's
Resample at quality 4, as MonoLoader(sampleRate=16000, resampleQuality=4) does.

A part that fails, or returns values that are not finite, outside its range or of the wrong
width, is null on its own; the fingerprint is null when no part can be computed. Each null part
gets its reason (the contract's WithheldReason) in the `withheld` dict the caller passes.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading

import numpy as np

from download_models import MODELS, is_verified, models_dir
from model_labels import DISCOGS_STYLES, MSD_TAGS

logger = logging.getLogger("audio")

try:
    import essentia
    import essentia.standard as _es

    AVAILABLE = True
except ImportError:
    essentia = None
    _es = None
    AVAILABLE = False

# The embedding models read 16 kHz audio.
SAMPLE_RATE = 16000
# MonoLoader's resampling quality in the MTG examples (0 is best, 4 fastest).
RESAMPLE_QUALITY = 4
# TensorflowInputMusiCNN frames (both backbones): 512 samples, 256 apart, the first centred on 0.
FRAME_SIZE = 512
FRAME_HOP = 256
MEL_BANDS = 96
# Patches of mel frames, as the Essentia predictors cut them (the last partial patch dropped).
EFFNET_PATCH, EFFNET_PATCH_HOP, EFFNET_BATCH = 128, 62, 64  # the graph takes batches of 64
MUSICNN_PATCH, MUSICNN_PATCH_HOP = 187, 93
EFFNET_EMBEDDING = 1280
MUSICNN_EMBEDDING = 200

# Discogs styles of non-music recordings ("Non-Music---Field Recording", "---Speech", ...).
NON_MUSIC_PREFIX = "Non-Music---"
# Discogs styles reported, highest activation first.
STYLE_TOP_K = 10
# Licence of the MTG model weights (essentia.upf.edu/models: CC BY-NC-SA 4.0, a proprietary
# licence on request).
MODEL_LICENCE = "CC BY-NC-SA 4.0"

# Mood heads: model name in download_models, the backbone it reads, the output column and the
# range of that output. The softmax heads give [danceable, not_danceable], [acoustic,
# non_acoustic] and [instrumental, voice]; DEAM gives [valence, arousal] on its 1-9 scale.
HEADS = {
    "danceability": ("danceability", "musicnn", 0, (0.0, 1.0)),
    "acoustic": ("acousticness", "effnet", 0, (0.0, 1.0)),
    "instrumental": ("instrumentalness", "musicnn", 0, (0.0, 1.0)),
    "valence": ("valence", "musicnn", 0, (1.0, 9.0)),
    "arousal": ("valence", "musicnn", 1, (1.0, 9.0)),
}

# Loaded predictors by role: "effnet" and "musicnn" map mel patches to (predictions,
# embeddings); the heads map embeddings to their outputs. Empty without the models.
_models: dict = {}
# TensorFlow sessions and Essentia algorithm instances are shared by the worker threads; one
# analysis uses them at a time.
_lock = threading.Lock()


def model_ref(name: str) -> dict:
    """The contract's ModelRef for a model in download_models.MODELS."""
    model = next(m for m in MODELS if m.name == name)
    return {"id": model.filename.removesuffix(".pb"), "licence": MODEL_LICENCE}


def model_set_tag() -> str:
    """A short tag for the pinned model files (their checksums), for the analyzer version."""
    digest = hashlib.sha256("".join(sorted(m.sha256 for m in MODELS)).encode()).hexdigest()
    return digest[:8]


class _Backbone:
    """One TensorFlow graph run on mel patches, returning its predictions and embeddings."""

    def __init__(self, path: str, input_name: str, outputs: tuple[str, str], batch: int | None):
        self.input_name = input_name
        self.outputs = outputs
        self.batch = batch
        self.predict = _es.TensorflowPredict(
            graphFilename=path, inputs=[input_name], outputs=list(outputs)
        )

    def __call__(self, patches: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        n = len(patches)
        size = self.batch or max(n, 1)
        predictions, embeddings = [], []
        for start in range(0, max(n, 1), size):
            chunk = patches[start : start + size]
            batch = np.zeros((size, 1, *patches.shape[1:]), dtype=np.float32)
            batch[: len(chunk), 0] = chunk
            pool = essentia.Pool()
            pool.set(self.input_name, batch)
            out = self.predict(pool)
            predictions.append(np.reshape(out[self.outputs[0]], (size, -1))[: len(chunk)])
            embeddings.append(np.reshape(out[self.outputs[1]], (size, -1))[: len(chunk)])
        return np.concatenate(predictions), np.concatenate(embeddings)


class _Head:
    """A classification or regression head on embeddings (one TensorflowPredict session)."""

    def __init__(self, path: str, output: str):
        self.output = output
        self.predict = _es.TensorflowPredict(
            graphFilename=path, inputs=["model/Placeholder"], outputs=[output]
        )

    def __call__(self, embeddings: np.ndarray) -> np.ndarray:
        pool = essentia.Pool()
        pool.set("model/Placeholder", np.ascontiguousarray(embeddings[:, None, None, :]))
        return np.reshape(self.predict(pool)[self.output], (len(embeddings), -1))


def load() -> bool:
    """Load the models once their checksums are verified. Returns True on success."""
    if not AVAILABLE:
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
        # Node names and class order follow each model's metadata file in the MTG model zoo.
        loaded = {
            "effnet": _Backbone(
                files["effnet"],
                "serving_default_melspectrogram",
                ("PartitionedCall:0", "PartitionedCall:1"),
                EFFNET_BATCH,
            ),
            "musicnn": _Backbone(
                files["musicnn"],
                "model/Placeholder",
                ("model/Sigmoid", "model/dense/BiasAdd"),
                None,
            ),
            "valence": _Head(files["valence"], "model/Identity"),
        }
        for name in ("danceability", "acousticness", "instrumentalness"):
            loaded[name] = _Head(files[name], "model/Softmax")
    except Exception:
        logger.exception("Failed to load the Essentia models")
        return False
    _models.clear()
    _models.update(loaded)
    logger.info("Essentia models loaded")
    return True


_thread_state = threading.local()


def _algorithm(name: str, factory):
    """One Essentia algorithm instance per worker thread (see estimators._essentia_algorithm)."""
    algorithms = _thread_state.__dict__.setdefault("algorithms", {})
    if name not in algorithms:
        algorithms[name] = factory()
    return algorithms[name]


def model_input(native: np.ndarray, native_sr: int) -> np.ndarray:
    """The decoded signal at 16 kHz, resampled as MonoLoader does (Essentia, quality 4)."""
    audio = np.ascontiguousarray(native, dtype=np.float32)
    if native_sr == SAMPLE_RATE or audio.size == 0:
        return audio
    resample = _algorithm(
        f"resample-{native_sr}",
        lambda: _es.Resample(
            inputSampleRate=native_sr, outputSampleRate=SAMPLE_RATE, quality=RESAMPLE_QUALITY
        ),
    )
    return resample(audio)


def mel_frames(audio_16k: np.ndarray) -> np.ndarray:
    """TensorflowInputMusiCNN bands for every frame, shape (frames, 96)."""
    features = _algorithm("musicnn-input", _es.TensorflowInputMusiCNN)
    frames = _es.FrameGenerator(
        audio_16k, frameSize=FRAME_SIZE, hopSize=FRAME_HOP, startFromZero=False
    )
    bands = [features(frame) for frame in frames]
    return np.asarray(bands, dtype=np.float32).reshape(-1, MEL_BANDS)


def patches(mel: np.ndarray, size: int, hop: int) -> np.ndarray:
    count = (len(mel) - size) // hop + 1 if len(mel) >= size else 0
    return (
        np.stack([mel[i * hop : i * hop + size] for i in range(count)])
        if count
        else (np.zeros((0, size, mel.shape[1]), dtype=np.float32))
    )


def _checked(values, width: int, what: str) -> np.ndarray | None:
    """`values` as a (patches, width) array of finite numbers, or None (logged)."""
    array = np.asarray(values, dtype=np.float64)
    if array.ndim != 2 or array.shape[0] == 0 or array.shape[1] != width:
        logger.warning("%s: unexpected output shape %s", what, array.shape)
        return None
    if not np.all(np.isfinite(array)):
        logger.warning("%s: output is not finite", what)
        return None
    return array


def _run(role: str, data: np.ndarray, widths: tuple[int, int]):
    """A backbone's (predictions, embeddings), each checked, or (None, None) when it fails."""
    try:
        with _lock:
            predictions, embeddings = _models[role](data)
    except Exception as e:
        logger.warning("The %s model failed: %s", role, e)
        return None, None
    return (
        _checked(predictions, widths[0], f"{role} predictions"),
        _checked(embeddings, widths[1], f"{role} embeddings"),
    )


def _head(name: str, embeddings: np.ndarray | None) -> np.ndarray | None:
    """A head's output averaged over the patches, checked; None when it fails."""
    if embeddings is None:
        return None
    try:
        with _lock:
            output = _models[name](embeddings.astype(np.float32))
    except Exception as e:
        logger.warning("The %s head failed: %s", name, e)
        return None
    checked = _checked(output, 2, f"{name} head")
    return None if checked is None else checked.mean(axis=0)


def _scores(mean: np.ndarray, labels, order) -> list[dict]:
    return [{"label": labels[i], "score": round(float(mean[i]), 4)} for i in order]


def _reason(code: str, reason: str) -> dict:
    return {"code": code, "reason": reason}


MODELS_NOT_LOADED = _reason("models_not_loaded", "the audio models are not loaded")


def fingerprint(
    native: np.ndarray, native_sr: int, loaded: bool, withheld: dict | None = None
) -> dict | None:
    """
    The `fingerprint` block of the v2 result, or None (see the module docstring). Why each null
    part is null goes into `withheld` (the v2 block's `withheld`), when given: `fingerprint`
    when the block is None, else `styles`, `tags` and `moods` (per head).
    """
    withheld = {} if withheld is None else withheld
    if not loaded:
        withheld["fingerprint"] = MODELS_NOT_LOADED
        return None
    try:
        mel = mel_frames(model_input(native, native_sr))
    except Exception as e:
        logger.warning("The model input could not be computed: %s", e)
        withheld["fingerprint"] = _reason("model_failed", "the model input could not be computed")
        return None
    styles, effnet = _run(
        "effnet",
        patches(mel, EFFNET_PATCH, EFFNET_PATCH_HOP),
        (len(DISCOGS_STYLES), EFFNET_EMBEDDING),
    )
    tags, musicnn = _run(
        "musicnn",
        patches(mel, MUSICNN_PATCH, MUSICNN_PATCH_HOP),
        (len(MSD_TAGS), MUSICNN_EMBEDDING),
    )
    if styles is None and effnet is None and tags is None and musicnn is None:
        withheld["fingerprint"] = _reason(
            "model_failed", "no audio model gave a usable output (failed, non-finite or misshapen)"
        )
        return None

    embeddings = {"effnet": effnet, "musicnn": musicnn}
    outputs = {}
    moods: dict[str, dict | None] = {}
    mood_reasons: dict[str, dict] = {}
    for mood, (name, backbone, column, (low, high)) in HEADS.items():
        if name not in outputs:
            outputs[name] = _head(name, embeddings[backbone])
        output = outputs[name]
        value = None if output is None else float(output[column])
        if value is None or not low <= value <= high:
            if value is not None:
                logger.warning("The %s head gave %s, outside [%s, %s]", mood, value, low, high)
                mood_reasons[mood] = _reason(
                    "out_of_range", f"the {mood} head gave a value outside its range {low}-{high}"
                )
            else:
                mood_reasons[mood] = _reason(
                    "model_failed",
                    f"the {mood} head or the model it reads failed or gave unusable output",
                )
            moods[mood] = None
            continue
        moods[mood] = {
            "value": round(value, 4),
            "range": [low, high],
            "model": model_ref(name),
            "basis": "model",
        }

    style_mean = None if styles is None else styles.mean(axis=0)
    tag_mean = None if tags is None else tags.mean(axis=0)
    # When the strongest style is a Non-Music one (field recording, speech, comedy...), the
    # mood heads, trained on music, have nothing to describe.
    if style_mean is not None:
        top_style = DISCOGS_STYLES[int(np.argmax(style_mean))]
        if top_style.startswith(NON_MUSIC_PREFIX):
            logger.info("No moods: the strongest style is %s", top_style)
            moods = dict.fromkeys(moods)
            not_music = _reason(
                "non_music_style",
                "the strongest style score is a Non-Music style, and the mood heads describe music",
            )
            mood_reasons = dict.fromkeys(moods, not_music)
    if style_mean is None:
        withheld["styles"] = _reason(
            "model_failed", "the style model failed or gave unusable output"
        )
    if tag_mean is None:
        withheld["tags"] = _reason("model_failed", "the tag model failed or gave unusable output")
    if mood_reasons:
        withheld["moods"] = mood_reasons
    return {
        "styles": None
        if style_mean is None
        else {
            "model": model_ref("effnet"),
            "top": _scores(style_mean, DISCOGS_STYLES, np.argsort(style_mean)[::-1][:STYLE_TOP_K]),
            "basis": "model",
        },
        "tags": None
        if tag_mean is None
        else {
            "model": model_ref("musicnn"),
            "scores": _scores(tag_mean, MSD_TAGS, np.argsort(tag_mean)[::-1]),
            "basis": "model",
        },
        "moods": moods,
    }
