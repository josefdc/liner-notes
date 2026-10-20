# Audio analysis service

A Python FastAPI service that downloads a 30-second Deezer or Spotify preview and measures its
tempo and key (each with a confidence), loudness, beat grid, energy contour, neutral sections
and notable moments, with Essentia or `librosa`. When the Essentia TensorFlow models are present
and verified, it also reports a model fingerprint: Discogs style activations, MusiCNN tags and
mood heads (danceability, acoustic, instrumental, valence, arousal). Too-short, silent and
noise-like input is gated: nothing is measured, and the response says why.

The API (`apps/api`) calls it server to server. It is not meant to be exposed to the internet.

## Running it

### Local development

Python 3.12 and [uv](https://docs.astral.sh/uv/) 0.9.17 or newer are required. Older uv
cannot parse the relative `exclude-newer = "14 days"` in `pyproject.toml`: it warns, ignores
the whole `[tool.uv]` table and re-resolves the lock with newer packages. `--locked` makes
that an error instead of a rewritten `uv.lock`.

```bash
cd services/audio
uv sync --locked                    # librosa estimators only
uv sync --locked --extra models     # optional: Essentia estimators and the model runtime
uv run python download_models.py   # optional: perceptual models (about 22 MB)
uv run uvicorn main:app --host 127.0.0.1 --port 3002 --reload
```

Without the `models` extra the service uses the librosa estimators; without the extra or without
the downloaded models it runs without the fingerprint and perceptual features, and `/health`
reports `degraded`. Audio is decoded by `soundfile` with the
`libsndfile` bundled in its wheel (1.1 or newer reads MP3); `ffmpeg` is not needed.

### Docker

```bash
docker build -t liner-notes-audio services/audio
docker run --rm -p 127.0.0.1:3002:3002 -v liner-notes-models:/app/models liner-notes-audio
```

The image includes the `models` extra and runs as an unprivileged user (uid 10001). The models are not part of the image: on
start, the container downloads them into `/app/models` (a volume, so they survive container
re-creation) and checks each file against the SHA-256 pinned in `download_models.py`. If the
download fails or times out, the service starts anyway without perceptual features and
`/health` reports `degraded`.

In the full stack the service is built and started by the root `docker-compose.yml`
(`sonic-analysis`).

## Configuration

All settings are optional environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `CORS_ORIGINS` | empty (no CORS headers) | Comma-separated browser origins allowed to call the service. `*` is ignored and credentials are never allowed. |
| `AUDIO_SERVICE_TOKEN` | empty (no check) | Shared secret. When set, `POST /analyze` requires the same value in the `X-Audio-Token` header and answers `401` otherwise, before reading the body. The API does not send this header yet (#26): setting it today makes every analysis fail. |
| `AUDIO_ESTIMATOR` | `essentia` when installed, else `librosa` | Tempo and key estimator for `v2` (see "How it works"). `essentia` without the extra falls back to `librosa`. The choice is part of `v2.analyzerVersion`. |
| `MODELS_DIR` | `./models` (`/app/models` in the image) | Where the Essentia models are read from and downloaded to. |
| `ANALYSIS_TIMEOUT_S` | `60` | Seconds allowed for decoding and analysing one preview (`504` after that). |
| `MAX_CONCURRENT_ANALYSES` | `4` | Analyses that run at once (also the size of the worker thread pool). |
| `MAX_QUEUED_ANALYSES` | `16` | Requests that may wait for a free slot; any beyond that get `503` at once. |
| `QUEUE_WAIT_S` | `10` | Seconds a request waits for a free slot before `503`. Keep it below the API's 30 s client timeout; the wait does not count against `ANALYSIS_TIMEOUT_S`. |
| `AUDIO_ENABLE_DOCS` | unset | Set to `1` to serve `/docs` and `/openapi.json` (off by default). |
| `AUDIO_FETCH_MODELS` | `1` | Image only: set to `0` to skip the model download on start. |
| `MODEL_FETCH_TIMEOUT_S` | `90` | Image only: time limit for the model download on start. |
| `PORT` | `3002` | Image only: port uvicorn listens on. |

## API

### `GET /health` (and `HEAD /health`)

Always `200` while the service can measure tempo and key. `status` is `ok` when the perceptual
models are loaded and `degraded` when they are not. `analyzer_version` is the version of the
analysis output (`ANALYZER_VERSION` in `main.py`); it changes whenever a measurement can change
for the same input, and every successful (`200`) `/analyze` response carries it. Error
responses are only `{"detail": "..."}`.

```bash
curl http://localhost:3002/health
# {"status":"degraded","analyzer_version":"2.0.0","models":false}
```

### `POST /analyze`

```bash
curl -X POST http://localhost:3002/analyze \
  -H "Content-Type: application/json" \
  -d '{"preview_url": "https://cdnt-preview.dzcdn.net/api/1/1/..."}'
```

The request body is limited to 16 KB (`413` beyond that).

Response for the 97 BPM drum pattern of `tests/test_v2.py` (an MP3), with the Essentia
estimators and the models loaded; lists shortened to their first items. Without the models
the perceptual fields and `v2.fingerprint` are `null`.

```json
{
  "bpm": 96,
  "key": "C",
  "mode": "Major",
  "energy": 0.666,
  "duration": 30.0,
  "source": "analyzed",
  "analyzer_version": "2.0.0",
  "keyMoments": [{ "time": 1.88, "type": "onset", "intensity": 0.986, "description": "Onset" }],
  "valence": 0.389,
  "danceability": 1.0,
  "acousticness": 0.006,
  "instrumentalness": 0.77,
  "v2": {
    "version": 2,
    "analyzerVersion": "2.0.0+essentia+msd-musicnn-1+discogs-effnet-bs64-1+deam-msd-musicnn-2+danceability-msd-musicnn-1+mood_acoustic-discogs-effnet-1+voice_instrumental-msd-musicnn-1",
    "window": { "kind": "preview-30s", "durationSeconds": 30.0 },
    "gate": { "passed": true, "reason": null },
    "tempo": {
      "bpm": 97.0,
      "confidence": 0.783,
      "rawConfidence": { "value": 4.165, "range": [0.0, 5.32] },
      "method": "essentia.RhythmExtractor2013+beat-regression",
      "basis": "signal"
    },
    "key": {
      "tonic": "C", "mode": "major", "strength": 0.944, "profile": "bgate",
      "method": "essentia.KeyExtractor", "basis": "signal"
    },
    "loudness": {
      "rmsMean": 0.09977,
      "method": "mean frame RMS, 2048-sample frames at 22050 Hz, DC removed",
      "basis": "signal"
    },
    "beats": { "times": [0.615, 1.231, 1.846], "method": "essentia.RhythmExtractor2013", "basis": "signal" },
    "energyContour": {
      "hopSeconds": 0.09288,
      "values": [0.27065, 0.15017, 0.10335],
      "method": "frame RMS, 2048-sample frames at 22050 Hz, DC removed",
      "basis": "signal"
    },
    "sections": {
      "segments": [{ "label": "A", "start": 0.0, "end": 30.0 }],
      "method": "novelty-on-beat-chroma",
      "basis": "signal"
    },
    "keyMoments": [
      { "time": 1.88, "type": "onset", "intensity": 0.986, "description": "Onset" },
      { "time": 4.96, "type": "energy_peak", "intensity": 0.933, "description": "Energy peak" }
    ],
    "fingerprint": {
      "styles": {
        "model": { "id": "discogs-effnet-bs64-1", "licence": "CC BY-NC-SA 4.0" },
        "top": [{ "label": "Electronic---Ambient", "score": 0.3468 }, { "label": "Electronic---Downtempo", "score": 0.2959 }],
        "basis": "model"
      },
      "tags": {
        "model": { "id": "msd-musicnn-1", "licence": "CC BY-NC-SA 4.0" },
        "scores": [{ "label": "electronic", "score": 0.4495 }, { "label": "ambient", "score": 0.2302 }],
        "basis": "model"
      },
      "moods": {
        "danceability": { "value": 0.9997, "range": [0, 1], "model": { "id": "danceability-msd-musicnn-1", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" },
        "acoustic": { "value": 0.0065, "range": [0, 1], "model": { "id": "mood_acoustic-discogs-effnet-1", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" },
        "instrumental": { "value": 0.7698, "range": [0, 1], "model": { "id": "voice_instrumental-msd-musicnn-1", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" },
        "valence": { "value": 4.1118, "range": [1, 9], "model": { "id": "deam-msd-musicnn-2", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" },
        "arousal": { "value": 4.8089, "range": [1, 9], "model": { "id": "deam-msd-musicnn-2", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" }
      }
    }
  }
}
```

`v2` is AudioFeatures v2 from `packages/contract` (`src/audio.ts`); the tests validate every
`v2` the service produces against `packages/contract/schemas/audio-features.schema.json`. Its
times are seconds from the start of the preview. Every block is `null` when it was not measured:

- **Gate.** Input shorter than 4 s (including a zero-length file) is `too_short`; input whose
  loudest frames stay under -60 dBFS (digital silence, a DC offset, dither) is `silence`; input
  with neither rhythm nor pitch (white, pink or brown noise) is `noise`. A gate that does not
  pass leaves every measured block `null` and `keyMoments` empty, and nulls the v1 `bpm`, `key`,
  `mode`, `keyMoments` and perceptual fields too: silence is never "C Major".
- **Tempo** is withheld when the onsets do not repeat at a beat rate (a steady chord, a pure
  tone, chords changing every 2 s) or the estimator's confidence is low. `confidence` is on
  0-1; Essentia reports 0-5.32, which is divided by 5.32 and kept in `rawConfidence`.
- **Key** is withheld when fewer than three pitch classes sound (a pure tone, mains hum) or its
  strength is low. Tonics are spelled with sharps (Essentia's Bb is reported as A#).
- **Fingerprint** is `null` without the models. `styles.top` holds the 10 highest of the 400
  Discogs style activations of EffNet-Discogs, `tags.scores` the 50 MusiCNN tag activations;
  activations are scores, not probabilities. Mood heads give their output with its range:
  0-1 for danceability, acoustic and instrumental, the DEAM scale 1-9 for valence and arousal.
  Each block names its model id and the licence of its weights (CC BY-NC-SA 4.0).

The v1 fields stay until the API reads `v2`. `bpm`, `key` and `mode` are measurements and are
never filled with a default: `bpm` is the beat tracker's tempo, quantised to its frame grid
(120 BPM reads 117), and `null` when no tempo is found or the gate did not pass; `key` and
`mode` are `null` when the chroma profile is flat or the gate did not pass. `energy` is the
mean frame RMS in dBFS mapped from [-60, 0] dBFS to [0, 1] (a loudness, not a perceptual energy),
`null` for a zero-length file.

Errors carry only a generic `detail` (no measurements and no `analyzer_version`); the cause is
only written to the service log.

| Status | Meaning |
|---|---|
| `400` | `preview_url` is not an allowed preview URL (see below) |
| `401` | `AUDIO_SERVICE_TOKEN` is set and `X-Audio-Token` is missing or wrong |
| `413` | Request body larger than 16 KB |
| `422` | Request body is not `{"preview_url": "<string>"}` |
| `502` | The preview could not be downloaded within the limits |
| `503` | No analysis slot became free within `QUEUE_WAIT_S`, or `MAX_QUEUED_ANALYSES` requests are already waiting; comes with `Retry-After` |
| `504` | Analysis took longer than `ANALYSIS_TIMEOUT_S` |
| `500` | Decoding or analysis failed |

## Which URLs are fetched

`preview.py` only downloads a URL when all of these hold:

- the scheme is `https` and the port is the default (443);
- there is no userinfo (`user:pass@`);
- the host is a lowercase DNS name, not an IP literal, and is either `p.scdn.co` (Spotify) or a
  subdomain of `dzcdn.net` (Deezer, for example `cdnt-preview.dzcdn.net`);
- the URL only contains RFC 3986 characters and is at most 2048 characters long.

The download does not follow redirects, ignores proxy settings from the environment, requires a
`200` response with an `audio/*` content type and no content encoding, and stops at 2 MB
(previews are about 0.5 MB). Connect and read timeouts are 5 s and 10 s, and the whole download
must finish within 20 s. The temporary file is removed after the analysis, whatever the outcome.

## How it works

1. **Download** the preview as described above.
2. **Decode** once with `librosa.load()` (`soundfile`), mono at the file's own rate, at most
   35 s. Each step that needs another rate gets a resampled copy (`soxr`): 22.05 kHz for the
   librosa features, 44.1 kHz for Essentia's estimators, 16 kHz for the models. The STFT, the
   onset envelope and the constant-Q chromagram are computed once and shared.
3. **Gate** (`signal_features.py`): duration, the 95th percentile of the frame RMS, and for
   noise the onset periodicity, the spectral flatness (100 Hz-5 kHz) and the chroma flatness.
   The thresholds and the fixture values that justify them are in the code.
4. **Tempo and key** (`estimators.py`, `AUDIO_ESTIMATOR`):
   - `essentia`: `RhythmExtractor2013` (multifeature) and `KeyExtractor` (bgate profile);
   - `librosa`: `librosa.feature.tempo` and `beat_track` on the onset envelope, and
     Krumhansl-Kessler profiles on the chromagram.

   Both refine the tempo with a least-squares fit of the beat times, so it is not limited to
   the beat tracker's frame grid, and never change its octave.
5. **Loudness and energy contour**: RMS of non-overlapping 2048-sample frames at 22.05 kHz after
   removing DC; `loudness.rmsMean` is their mean.
6. **Sections**: novelty on beat-synchronous chroma (a fixed 0.5 s grid without a beat grid),
   cut at novelty peaks at least 4 s apart; sections with similar chroma share a label.
7. **Key moments**: energy peaks, level drops, onsets, harmonic changes and silences, with
   intensities from the signal (level, size of the drop, onset strength, novelty, length);
   the strongest of each sixth of the window first, at most 16.
8. **Fingerprint** (optional): EffNet-Discogs and MusiCNN from the MTG model zoo, with their
   classification heads, at 16 kHz.

The accuracy of these measurements against reference data has not been evaluated yet; treat
them as measurements of the preview, not of the full recording.

## Tests and checks

```bash
cd services/audio
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

The tests run without network access: a local HTTP server stands in for the CDN.
`tests/test_fixtures.py` runs the real analysis on audio generated at test time: click tracks at
85, 120, 140 and 174 BPM, an A major triad, the progressions C–F–G–C and Am–Dm–E–Am, silence,
1 s clips, white noise and a DC offset, as WAV and MP3, plus 44.1 kHz stereo MP3 variants, and
pins the v1 fields (the v1 tempo tolerance is the beat tracker's grid, explained in
`tempo_bounds`). `tests/test_v2.py` checks the `v2` block against the contract's JSON Schema
after a strict JSON round trip, with every installed estimator: tempo within 1 BPM, keys,
the gate, loudness, key moments, sections, and the fingerprint when the models are loaded
(skipped otherwise: run `uv sync --locked --extra models` and `uv run python download_models.py`
first to include it).

## Troubleshooting

- **`LibsndfileError` / "Format not recognised"**: `libsndfile` could not decode the file. MP3
  needs `libsndfile` 1.1 or newer; the `soundfile` wheels bundle one, so this usually means a
  platform without a bundled library and an old system `libsndfile`. AAC and M4A cannot be
  decoded at all: librosa 1.0 decodes only through `libsndfile`, which does not read them (the
  preview hosts the service accepts serve MP3).
- **`/health` says `degraded`**: run `uv run python download_models.py`, or
  `uv run python download_models.py --check` to see which model is missing or fails its checksum.
