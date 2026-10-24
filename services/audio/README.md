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
analysis output: `ANALYZER_VERSION` in `main.py` (it changes whenever a measurement can change
for the same input) with the estimator and, when the models are loaded, a tag for the pinned
model set as semver build metadata, e.g. `2.0.0+essentia.models-5c5c0c7f`. Every successful
(`200`) `/analyze` response carries the same string, as `analyzer_version` and
`v2.analyzerVersion`. Error responses are only `{"detail": "..."}`.

```bash
curl http://localhost:3002/health
# {"status":"degraded","analyzer_version":"2.0.0+essentia","models":false}
```

### `POST /analyze`

```bash
curl -X POST http://localhost:3002/analyze \
  -H "Content-Type: application/json" \
  -d '{"preview_url": "https://cdnt-preview.dzcdn.net/api/1/1/..."}'
```

The request body is limited to 16 KB (`413` beyond that).

Response for the 97 BPM drum pattern of `tests/signals.py` (an MP3), with the Essentia
estimators and the models loaded; lists shortened to their first items. Without the models
the perceptual fields and `v2.fingerprint` are `null`.

```json
{
  "bpm": 97,
  "key": "C",
  "mode": "Major",
  "energy": 0.778,
  "duration": 30.0,
  "source": "analyzed",
  "analyzer_version": "2.0.0+essentia.models-5c5c0c7f",
  "keyMoments": [{ "time": 1.88, "type": "onset", "intensity": 0.986, "description": "Onset" }],
  "valence": 0.389,
  "danceability": 1.0,
  "acousticness": 0.006,
  "instrumentalness": 0.85,
  "v2": {
    "version": 2,
    "analyzerVersion": "2.0.0+essentia.models-5c5c0c7f",
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
      "tonic": "C", "mode": "major", "strength": 0.94, "profile": "bgate",
      "method": "essentia.KeyExtractor", "basis": "signal"
    },
    "loudness": {
      "rmsMean": 0.099773,
      "method": "mean frame RMS, 2048-sample frames at 22050 Hz, DC removed",
      "basis": "signal"
    },
    "beats": { "times": [0.615, 1.231, 1.846], "method": "essentia.RhythmExtractor2013", "basis": "signal" },
    "energyContour": {
      "hopSeconds": 0.09288,
      "values": [0.270653, 0.150171, 0.103349],
      "method": "frame RMS, 2048-sample frames at 22050 Hz, DC removed",
      "basis": "signal"
    },
    "sections": {
      "segments": [{ "label": "A", "start": 0.0, "end": 4.923 }, { "label": "B", "start": 4.923, "end": 9.892 }],
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
        "top": [{ "label": "Electronic---Ambient", "score": 0.3183 }, { "label": "Electronic---Downtempo", "score": 0.2936 }],
        "basis": "model"
      },
      "tags": {
        "model": { "id": "msd-musicnn-1", "licence": "CC BY-NC-SA 4.0" },
        "scores": [{ "label": "electronic", "score": 0.4612 }, { "label": "ambient", "score": 0.2488 }],
        "basis": "model"
      },
      "moods": {
        "danceability": { "value": 0.9997, "range": [0.0, 1.0], "model": { "id": "danceability-msd-musicnn-1", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" },
        "acoustic": { "value": 0.0056, "range": [0.0, 1.0], "model": { "id": "mood_acoustic-discogs-effnet-1", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" },
        "instrumental": { "value": 0.85, "range": [0.0, 1.0], "model": { "id": "voice_instrumental-msd-musicnn-1", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" },
        "valence": { "value": 4.1125, "range": [1.0, 9.0], "model": { "id": "deam-msd-musicnn-2", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" },
        "arousal": { "value": 4.8876, "range": [1.0, 9.0], "model": { "id": "deam-msd-musicnn-2", "licence": "CC BY-NC-SA 4.0" }, "basis": "model" }
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
  with neither a beat nor musical pitch is `noise`: white, pink or brown noise, and noise
  carrying one tonal artefact (a whine, mains hum). Music under a noise bed, a drum take with
  human timing, a rhythm made of noise bursts, speech (also pitched up, when it spans less than
  a few semitones) and an a cappella line (one voice that moves or has no stable notes, even
  when it leaves few spectral lines) pass. When the channels cancel in the
  mono downmix (antiphase stereo), the loudest channel is analysed instead. A gate that does
  not pass leaves every measured block `null` and `keyMoments` empty.
- **Tempo** is withheld when the onsets do not repeat at a beat rate (a steady chord, a pure
  tone, chords changing every 2 s, a rubato melody), when the estimator's confidence is low,
  or when the tempo does not hold in every part of the window that has a beat (90 BPM then
  130, an accelerando; with librosa also a tempo that swings around the reported one within a
  part, see `STEADY_DRIFT_WINDOW_S`; Essentia has no such check and still reports a band
  swinging +-10 % every 12 s). A beatless intro is no evidence either way: a band that
  starts 10 s in gets its tempo. When the tempo is withheld as unsteady, `beats` are kept with Essentia,
  whose beats follow the change, and dropped with librosa, whose tracker keeps one period.
  `confidence` is on 0-1; Essentia reports 0-5.32, which is divided by 5.32 and kept in
  `rawConfidence`.
- **Key** is only estimated from musical pitch, on the harmonic part of the signal (a
  harmonic/percussive separation). It is withheld when too little of the energy is in spectral
  lines (drums, click tracks, a metronome, noise with a beat); when the lines form a single
  harmonic series (a lone tone, or mains hum on 50 or 60 Hz, whose harmonics spell a G major
  triad); when the lines and the notes of a single voice spell fewer than three pitch classes;
  or when its strength is under the estimator's minimum (Essentia 0.7: atonal material such
  as random chromatic notes or a twelve-tone row scores up to 0.69; librosa 0.3, whose
  correlation does not separate atonal from tonal material). With a beat, Essentia's key does not go through the spectral-line rules: its
  strength separates pitchless rhythm from tonal music, and the line rules withheld most keys
  of electronic dance music, which it mostly gets right (the calibration section of
  `evals/reports/audio-*.md` has the numbers). Without a beat, a pitch track of the harmonic part also
  decides: no key for one held pitch (a note with vibrato, whose sidebands hide the series, or
  a bend: its harmonics explain the lines and nothing else moves in the chromagram) or for a
  voice without stable notes (speech); a voice that moves between notes keeps the key even
  without lines (an a cappella line with vibrato). With a beat, once the lines support a key,
  the pitch track still withholds it for speech or rap over drums, and for one held pitch (a
  drone, one bass note, a held note) whose harmonics explain the harmonic part's lines; there
  the allowance does not widen with the tracked pitch's span, since a band's bass line can look
  like one held pitch to the tracker while its chords are off that pitch's harmonics. A major
  triad over its own root in the bass is acoustically one harmonic series (harmonics 4, 5 and
  6) and gets no key without a beat, and none with a beat from librosa. A sung line far out of tune, or with very wide
  vibrato, can read as a voice without stable notes and gets no key: the rule errs toward
  withholding. Tonics are spelled with sharps (Essentia's Bb is reported as A#).
- **Fingerprint** is `null` without the models, and for input the service judges not to be
  music: no beat, and a single harmonic series, one held pitch or speech (the style and mood
  models answer for any input). A pad, a melody over a drone or a band without drums keeps
  it. `styles.top` holds the 10 highest of the 400 Discogs style activations of EffNet-Discogs, `tags.scores` the 50 MusiCNN tag activations; activations
  are scores, not probabilities. Mood heads give their output with its range: 0-1 for
  danceability, acoustic and instrumental, the DEAM scale 1-9 for valence and arousal; they are
  `null` when the strongest style is a `Non-Music---` one (spoken word, field recording...).
  Each block names its model id and the licence of its weights (CC BY-NC-SA 4.0). A part whose
  model fails, or gives values that are not finite, outside that range or of the wrong width,
  is `null` on its own. Every reason for a `null` is written to the service log.

The v1 fields stay until the API reads `v2`, and are derived from it: `bpm` is `v2.tempo.bpm`
rounded, `key` and `mode` are `v2.key`, `keyMoments` are `v2.keyMoments`, and the perceptual
fields are the mood heads (valence mapped from DEAM's 1-9 onto 0-1). Each is `null` when `v2`
has nothing for it, so v1 never says more than v2. `energy` keeps the scale it had before v2:
(`v2.loudness.rmsMean` - 0.02) / 0.25, clipped to 0-1 (a loudness, not a perceptual energy).
That scale reads 0 below -34 dBFS mean RMS, so quieter input that passes the gate gets a small
floor instead, from 0.005 at -86 dBFS to 0.02 at -34 dBFS; `energy` is `null` when the gate did
not pass.

A preview that cannot be decoded, or that holds non-finite samples or samples beyond 1000
times full scale, is refused with `422`.

Errors carry only a generic `detail` (no measurements and no `analyzer_version`); the cause is
only written to the service log.

| Status | Meaning |
|---|---|
| `400` | `preview_url` is not an allowed preview URL (see below) |
| `401` | `AUDIO_SERVICE_TOKEN` is set and `X-Audio-Token` is missing or wrong |
| `413` | Request body larger than 16 KB |
| `422` | Request body is not `{"preview_url": "<string>"}`, or the preview is not analysable audio (not decodable, non-finite or absurd samples) |
| `502` | The preview could not be downloaded within the limits |
| `503` | No analysis slot became free within `QUEUE_WAIT_S`, or `MAX_QUEUED_ANALYSES` requests are already waiting; comes with `Retry-After` |
| `504` | Analysis took longer than `ANALYSIS_TIMEOUT_S` |
| `500` | Analysis failed |

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
2. **Decode** once with `soundfile`, mono at the file's own rate, at most 35 s. Each step that
   needs another rate gets a resampled copy: 22.05 kHz (`soxr`) for the librosa features, 44.1
   kHz for RhythmExtractor2013, and 16 kHz through Essentia's `Resample` at quality 4 for the
   models, as `MonoLoader(sampleRate=16000, resampleQuality=4)` does in the MTG examples. The
   STFT, the onset envelope, the harmonic part and its chromagram are computed once and shared.
3. **Gate** (`signal_features.py`): duration, the 95th percentile of the frame RMS, and for
   noise the onset periodicity (a tempogram peak, tolerant of human timing), the share of
   energy in spectral lines and whether they form one harmonic series, and a pYIN pitch track
   of the harmonic part (one moving voice is not noise). The thresholds and the fixture values behind them are in the code
   (`signal_features.py`, `estimators.py`).
4. **Tempo and key** (`estimators.py`, `AUDIO_ESTIMATOR`):
   - `essentia`: `RhythmExtractor2013` (multifeature) and `KeyExtractor` (bgate profile, on
     the harmonic part);
   - `librosa`: `librosa.feature.tempo` and `beat_track` on the onset envelope, and
     Krumhansl-Kessler profiles on the chromagram of the harmonic part.

   Both refine the tempo with a least-squares fit of the beats that fall on onsets (the
   longest regular run of them), so it is not limited to the beat tracker's frame grid and
   never changes its octave, and check that it holds in each third of the window that has a
   beat. Whether a key can be measured at all (spectral lines, harmonic series, the pYIN pitch
   track, pitch classes) is decided the same way for both.
5. **Loudness and energy contour**: RMS of non-overlapping 2048-sample frames at 22.05 kHz after
   removing DC; `loudness.rmsMean` is their mean.
6. **Sections**: novelty on beat-synchronous chroma (a fixed 0.5 s grid without a trusted beat grid),
   cut at novelty peaks at least 4 s apart; sections with similar chroma share a label.
7. **Key moments**: energy peaks, level drops, onsets, harmonic changes and silences, with
   intensities from the signal (level, size of the drop, onset strength, novelty, length);
   the strongest of each sixth of the window first, then the strongest of each type in turn,
   at most 16.
8. **Fingerprint** (`fingerprint.py`, optional): EffNet-Discogs and MusiCNN from the MTG model
   zoo, each loaded once and run once per analysis for both its predictions and the embeddings
   its heads read, at 16 kHz.

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
pins the v1 fields. `tests/test_v2.py` covers the `v2` block with both estimators: tempo within
1 BPM, tempo changes, keys and when they are withheld (drums, clicks, hum, tones), the gate
(noise, silence, short input, and music under noise or with human timing, from
`tests/signals.py`), music without a beat and single held pitches or speech (sung and played
lines with vibrato, band mixes with and without drums, a pad, a drone, speech with irregular
syllables, from `tests/music.py`), loudness, key moments, sections and the fingerprint. Every
result in both files is checked against the contract's JSON Schema after a strict JSON round
trip, and for v1/v2 agreement (`tests/checks.py`). The Essentia cases and the real-model
tests are reported as skipped without the `models` extra and the models; run
`uv sync --locked --extra models` and `uv run python download_models.py` first to include them.
`AUDIO_REQUIRE_MODELS=1` turns those skips into an error; CI's `audio models` workflow runs the
suite that way.

## Troubleshooting

- **`LibsndfileError` / "Format not recognised"**: `libsndfile` could not decode the file. MP3
  needs `libsndfile` 1.1 or newer; the `soundfile` wheels bundle one, so this usually means a
  platform without a bundled library and an old system `libsndfile`. AAC and M4A cannot be
  decoded at all: the service decodes only through `libsndfile`, which does not read them (the
  preview hosts the service accepts serve MP3).
- **`/health` says `degraded`**: run `uv run python download_models.py`, or
  `uv run python download_models.py --check` to see which model is missing or fails its checksum.
