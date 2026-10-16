# Audio analysis service

A Python FastAPI service that downloads a 30-second Deezer or Spotify preview and measures its
tempo, key, mode, energy and notable moments with `librosa`. When the Essentia TensorFlow models
are present and verified, it also estimates valence, danceability, acousticness and
instrumentalness.

The API (`apps/api`) calls it server to server. It is not meant to be exposed to the internet.

## Running it

### Local development

```bash
cd services/audio
uv sync
uv run python download_models.py   # optional: perceptual models (about 22 MB)
uv run uvicorn main:app --host 127.0.0.1 --port 3002 --reload
```

Decoding MP3 needs `libsndfile` 1.1 or newer (bundled with the `soundfile` wheel) or `ffmpeg`.

### Docker

```bash
docker build -t liner-notes-audio services/audio
docker run --rm -p 127.0.0.1:3002:3002 -v liner-notes-models:/app/models liner-notes-audio
```

The image runs as an unprivileged user (uid 10001). The models are not part of the image: on
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
| `AUDIO_SERVICE_TOKEN` | empty (no check) | Shared secret. When set, `POST /analyze` requires the same value in the `X-Audio-Token` header and answers `401` otherwise. |
| `MODELS_DIR` | `./models` (`/app/models` in the image) | Where the Essentia models are read from and downloaded to. |
| `ANALYSIS_TIMEOUT_S` | `60` | Seconds allowed for decoding and analysing one preview (`504` after that). |
| `MAX_CONCURRENT_ANALYSES` | `4` | Analyses allowed at once; further requests get `503` until one finishes. |
| `AUDIO_ENABLE_DOCS` | unset | Set to `1` to serve `/docs` and `/openapi.json` (off by default). |
| `AUDIO_FETCH_MODELS` | `1` | Image only: set to `0` to skip the model download on start. |
| `MODEL_FETCH_TIMEOUT_S` | `90` | Image only: time limit for the model download on start. |
| `PORT` | `3002` | Image only: port uvicorn listens on. |

## API

### `GET /health`

Always `200` while the service can measure tempo and key. `status` is `ok` when the perceptual
models are loaded and `degraded` when they are not.

```bash
curl http://localhost:3002/health
# {"status":"degraded","version":"1.0.0","models":false}
```

### `POST /analyze`

```bash
curl -X POST http://localhost:3002/analyze \
  -H "Content-Type: application/json" \
  -d '{"preview_url": "https://cdnt-preview.dzcdn.net/api/1/1/..."}'
```

Response (perceptual fields are `null` without the models):

```json
{
  "bpm": 123,
  "key": "G",
  "mode": "Major",
  "energy": 0.67,
  "duration": 29.99,
  "source": "analyzed",
  "keyMoments": [{ "time": 0.51, "type": "onset", "intensity": 0.8, "description": "Beat transition" }],
  "valence": null,
  "danceability": null,
  "acousticness": null,
  "instrumentalness": null
}
```

Errors carry a generic `detail`; the cause is only written to the service log.

| Status | Meaning |
|---|---|
| `400` | `preview_url` is not an allowed preview URL (see below) |
| `503` | `MAX_CONCURRENT_ANALYSES` analyses are already running |
| `401` | `AUDIO_SERVICE_TOKEN` is set and `X-Audio-Token` is missing or wrong |
| `422` | Request body is not `{"preview_url": "<string>"}` |
| `502` | The preview could not be downloaded within the limits |
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
2. **Decode** with `librosa.load()` at 22.05 kHz mono.
3. **Tempo**: `librosa.beat.beat_track()` (onset strength envelope and dynamic-programming beat
   tracking).
4. **Key and mode**: constant-Q chromagram (`librosa.feature.chroma_cqt`) correlated against the
   Krumhansl-Kessler profiles for all 24 major and minor keys.
5. **Energy**: mean RMS energy scaled to 0–1.
6. **Perceptual features** (optional): MusiCNN and EffNet-Discogs embeddings with classification
   heads from the MTG model zoo, computed at 16 kHz.

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

## Troubleshooting

- **`NoBackendError` / "Format not recognised"**: neither `libsndfile` nor `ffmpeg` could decode
  the file. Install `ffmpeg` (`sudo apt install ffmpeg`, `brew install ffmpeg`).
- **`/health` says `degraded`**: run `uv run python download_models.py`, or
  `uv run python download_models.py --check` to see which model is missing or fails its checksum.
