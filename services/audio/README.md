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

In the full stack the service is built and started by `deploy/compose.prod.yml` (`audio`),
with the models on a volume and no published port.

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
model set as semver build metadata, e.g. `2.3.3+essentia.models-5c5c0c7f`. Every successful
(`200`) `/analyze` response carries the same string, as `v2.analyzerVersion`. Error responses are only `{"detail": "..."}`.

```bash
curl http://localhost:3002/health
# {"status":"degraded","analyzer_version":"2.3.3+essentia","models":false}
```

### `POST /analyze`

```bash
curl -X POST http://localhost:3002/analyze \
  -H "Content-Type: application/json" \
  -d '{"preview_url": "https://cdnt-preview.dzcdn.net/api/1/1/..."}'
```

The request body is limited to 16 KB (`413` beyond that).

Response for the 97 BPM drum pattern of `tests/signals.py` (an MP3), with the Essentia
estimators and the models loaded; lists shortened to their first items. The response is the
`v2` block and nothing else (the v1 fields `bpm`, `key`, `mode`, `energy`, the perceptual scores
and the rest went with analyzer 2.3.0). Without the models `v2.fingerprint` is `null` and
`v2.withheld.fingerprint` says so.

```json
{
  "v2": {
    "version": 2,
    "analyzerVersion": "2.3.3+essentia.models-5c5c0c7f",
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
    },
    "withheld": {}
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
  130, an accelerando; a band whose tempo swings +-10-12 % every 12 s can still pass, since
  each part's median stays within 5 %). A beatless intro is no evidence either way: a band
  that starts 10 s in gets its tempo. When the tempo is withheld as unsteady, `beats` are kept with Essentia,
  whose beats follow the change, and dropped with librosa, whose tracker keeps one period.
  `beats.times` holds only the beats with sound under them (an RMS within 50 ms of the beat,
  its mean removed, no more than 60 dB under the loudest frame and at least 3e-5, or
  -90.5 dBFS, which is above 16-bit dither): trackers keep counting through silence
  (Essentia put 23 beats in 10 s of digital silence before a band), so the grid can have
  gaps. Trackers also count through an intro or an ending that has sound but no beat (a
  pad, a drone, hum or hiss): a run of four or more beats with sound under them at either end
  of the grid, none on an onset, whose spacing is more than 4 % off the grid next to it is
  left out too (Essentia counted 15 and 23 beats under the pads before two bands, 6.8 and
  12.8 % off). The gain is in intros. On the evals harness's 30 s clips at seed 1 (100
  Ballroom and 100 GiantSteps Tempo tracks, Ballroom's beat annotations aligned to each
  clip's window), it left out 15 beats in three runs: two intros (a fade-in, and a crescendo
  with three beats before the first annotated beat) and the end of one Ballroom clip, where
  it removed as many beats on the annotated beat as off it. At clip ends it is about even.
  The tempo is still fitted to the tracked beats on onsets, and the
  steadiness check and the sections still use every tracked beat. Known limits: beats a
  tracker counts through a beatless intro at the band's own spacing are still reported (a
  rubato piano intro, and some hum and hiss intros: 3 of 27 tried stayed within 4 % of the
  band), as are runs of one to three beats, and a long run out of phase with the band. One
  onset on any beat of an intro (a click, a breath, a pickup note) ends the run there, and
  the beats before it are reported. Onsets count relative to the clip's own beats, so a band
  on under a tenth of the window leaves its pad's beats in.
  `confidence` is on 0-1; Essentia reports 0-5.32, which is divided by 5.32 and kept in
  `rawConfidence`.
- **Key** is only estimated from musical pitch, on the harmonic part of the signal (a
  harmonic/percussive separation). It is withheld when too little of the energy is in spectral
  lines (drums, click tracks, a metronome, noise with a beat); when the lines form a single
  harmonic series (a lone tone, or mains hum on 50 or 60 Hz, whose harmonics spell a G major
  triad); when the lines and the notes of a single voice spell fewer than three pitch classes;
  or when its strength is under the estimator's minimum (0.4 for both). One pitched source has
  no key either, whatever its strength: when the harmonic part's spectral lines keep the same
  proportions over the whole window (followed in 2 s steps) and rise and fall together, and
  what they spell is one note, or two a fourth, a fifth or a tritone apart, the key is withheld
  as "one pitched source". That catches most cowbells, but one note repeated on a bass only
  sometimes: lines next to the note often count as notes of their own. A chord is three
  pitch classes, or two a second, a third, a sixth or a seventh apart; a fifth or a third about
  as loud as the root below it is a chord tone, not one of the root's harmonics. What the tests
  and controls show holds: held chords faded, swelling, getting louder, with tremolo or pumped
  by a sidechain, chord stabs, bass and chord riffs on one chord, one-bar riffs, triads whose
  third is 1.5-6 dB softer than a root doubled an octave down (every root, both modes, three
  timbres), seventh chords whose fifth folds into a doubled root and whose third is 6-12 dB
  down, a third 10-25 cents off over a doubled root, and sus2 and sus4 chords over their root
  lose no key to this rule, and it never gives them its reason. It is not proven beyond those
  levels and tunings, and two limits are known and pinned in the tests: a fourth (G2 under C3)
  whose third is 15 dB down reads as two notes a fourth apart (librosa's right C major is
  withheld), and a sine bass 15 dB louder than a triad over it reads as one note (the right A
  major is withheld with both estimators). A major third sung or played 8 cents flat or more
  over its root two octaves down reads as the root's fifth harmonic, so such a still chord can
  count as one source too. A bell is not caught (its tierce is a minor third over the hum, as in
  a chord), nor are several drums (toms, tabla strokes with partials of their own). Neither strength
  separates atonal material from tonal music: random chromatic notes or a twelve-tone row can
  still get a key, and so can a bell or a few tuned drums whose partials spell three classes. The spectral-line rules are
  what keep keys off pitchless sound, and they also withhold many keys of electronic dance
  music, whose synthesizers leave few narrow lines (the calibration section of
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
  6) and gets no key, with or without a beat. A sung line far out of tune, or with very wide
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
  is `null` on its own.

**Why a value is `null`** is in `v2.withheld`, per field: a stable `code` and the check in
words (`reason`), e.g. `"key": {"code": "one_pitched_source", "reason": "the partials hold
still, rise and fall together and spell no chord"}`. Every measured block left `null` has
one (`tempo`, `key`, `loudness`, `beats`, `energyContour`, `sections`, `fingerprint`); within a
fingerprint, so do `styles`, `tags` and each of `moods` that is `null`; a measured value never
has one. A code and its `reason` name the check that fired, not a cause
(`tests/test_withheld_codes.py` checks every reason text against a list of instrument and source
words): `no_sustained_pitch` is as true of a
drum loop as of a dense mix whose key a listener would name. The codes (the contract's
`AudioWithheldCode`):

| field | code | the check |
|---|---|---|
| every block | `gate_silence`, `gate_noise`, `gate_too_short` | the gate did not pass |
| tempo, beats | `no_beat` | onset periodicity under 0.2: nothing repeats at a beat rate |
| tempo, beats | `tempo_out_of_range` | the estimate is outside the 40-208 BPM the service accepts |
| tempo, beats | `too_few_beats` | fewer than 4 tracked beats, or fewer than 6 beat intervals to check the tempo holds (a short clip) |
| tempo, beats | `low_confidence` | under the estimator's minimum (Essentia 1.5 of 5.32, librosa 0.3); it does not rank octave errors, and no rule here catches them |
| tempo, beats | `unsteady_tempo` | a third of the window that has a beat disagrees with the tempo (Essentia keeps its beat grid, with no reason; librosa's grid is null with this code) |
| tempo, beats | `no_tempo_estimate` | an estimator that gives no reasons (only the evals' beat-this) gave no tempo |
| key | `no_sustained_pitch` | under 10 % of the 60 Hz-5 kHz energy is in spectral lines |
| key | `speech_like` | one pitch line whose held pitch is off the semitone grid (no stable notes) |
| key | `one_harmonic_series` | the lines form one harmonic series, and the chromagram holds still |
| key | `one_held_pitch` | one pitch track spanning under 350 cents whose harmonics explain the lines (over a beat: those of the harmonic part) |
| key | `no_pitch_track` | without a beat, the pitch track failed |
| key | `few_pitch_classes` | fewer than three pitch classes |
| key | `one_pitched_source` | the partials hold still, rise and fall together and spell one note or an open interval |
| key | `low_key_strength` | key strength under 0.4 |
| key | `no_key_estimate` | the estimator named no key |
| fingerprint | `models_not_loaded`, `not_music`, `model_failed` | no models; no beat, and the key rules found one harmonic series, one held pitch or one pitch line without stable notes; no model part gave usable output |
| styles, tags, moods | `model_failed` | that model or head failed, or gave non-finite or misshapen output |
| moods | `out_of_range` | the head's output is outside its range |
| moods | `non_music_style` | the strongest Discogs style is a `Non-Music---` one |
| any | `estimate_failed` | the estimator raised (logged), or gave a non-finite tempo |

A preview that cannot be decoded, or that holds non-finite samples or samples beyond 1000
times full scale, is refused with `422`.

The service decodes only through `libsndfile`, which reads no MP4 (M4A) or AAC. A preview is
refused with `422` and its own reason, `it is an MP4 (M4A) or AAC file, a format the service
does not decode`, in these cases only:

- the host declares one of these types: `audio/mp4`, `audio/m4a`, `audio/x-m4a`, `audio/m4b`,
  `audio/x-m4b`, `audio/mpeg4`, `application/mp4`, `audio/aac`, `audio/aacp`, `audio/x-aac`,
  `audio/aac-adts`, `audio/x-hx-aac-adts`, `audio/vnd.dlna.adts`, `audio/mp4a-latm`,
  `audio/mpeg4-generic`, `audio/3gpp`, `audio/3gpp2` or `video/mp4`. The preview is refused
  before its body is read.
- the first bytes show the format (`sniff.py`), after up to four ID3v2 tags:
  - an MP4 file: a `ftyp` box naming an MP4, QuickTime or 3GPP brand, either first or behind up
    to three `free`, `skip` or `wide` boxes. HEIC and AVIF images do not count.
  - an ADIF stream (the `ADIF` magic).
  - an ADTS stream: a frame header within the first 4 kB, then more headers with the same
    stream parameters, each where the previous frame's length puts it. At the start, two
    frames are enough; further in, four are needed.
  - a LOAS stream: three frames in a row, the first within the first 4 kB.

A file that starts with an MP3 frame, or with the magic of one of the containers listed here,
is never refused this way: WAV (`RIFF`, `RIFX`, `RF64`, W64), AIFF, CAF, FLAC, Ogg, AU, IRCAM,
NIST, PARIS, AVR, PVF, VOC and MATLAB 5. Any other file that cannot be decoded gets the generic
reason.

The API has no reason code for this refusal yet. The user still sees "the audio analysis
failed", and the precise reason is only in the API's error detail.

Errors carry only a fixed `detail` (no measurements and no `analyzer_version`); the cause is
only written to the service log.

| Status | Meaning |
|---|---|
| `400` | `preview_url` is not an allowed preview URL (see below) |
| `401` | `AUDIO_SERVICE_TOKEN` is set and `X-Audio-Token` is missing or wrong |
| `413` | Request body larger than 16 KB |
| `422` | Request body is not `{"preview_url": "<string>"}`, or the preview is not analysable audio (MP4 (M4A) or AAC, not decodable, non-finite or absurd samples) |
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
`200` response with an MP3, WAV, FLAC or Ogg content type (a missing one is refused) and no
content encoding. It stops at 2 MB (previews are about 0.5 MB). Connect and read timeouts are 5 s
and 10 s, and the whole download must finish within 20 s. The temporary file is removed after the
analysis, whatever the outcome.

## How it works

1. **Download** the preview as described above.
2. **Decode** once with `soundfile`, mono at the file's own rate, at most 35 s. An MP4 (M4A) or
   AAC file that `sniff.py` recognises by its first bytes is refused first (see the error
   statuses above), since `libsndfile` reads neither. Each step that needs another rate gets a
   resampled copy: 22.05 kHz (`soxr`) for the librosa features, 44.1 kHz for
   RhythmExtractor2013, and 16 kHz through Essentia's `Resample` at quality 4 for the models, as
   `MonoLoader(sampleRate=16000, resampleQuality=4)` does in the MTG examples. The STFT, the
   onset envelope, the harmonic part and its chromagram are computed once and shared.
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
pins the rounded tempo, key, loudness and the reasons for what it withholds. `tests/test_v2.py` covers the `v2` block with both estimators: tempo within
1 BPM, tempo changes, keys and when they are withheld (drums, clicks, hum, tones), the gate
(noise, silence, short input, and music under noise or with human timing, from
`tests/signals.py`), music without a beat and single held pitches or speech (sung and played
lines with vibrato, band mixes with and without drums, a pad, a drone, speech with irregular
syllables, from `tests/music.py`), loudness, key moments, sections and the fingerprint. Service tests pin exactly which one-pitch-class seeds get a key (equality, both directions)
and that the single-source rule withholds no key of the chord families at seeds 700-729 (held
chords faded, swelling, getting louder, with tremolo or a sidechain pump, chord stabs, riffs on
one chord and one-bar riffs), of triads at C3-D#3 with a third 1.5-6 dB softer than a doubled
root, or of sus chords, and that a third 10-25 cents off and a seventh over a doubled root
whose third is quiet still make a chord; the two known limits are pinned as expected failures;
seeds 600-629 and 800-829 are evaluation-only `evals/audio` controls. These seeded families, and the pitchless ones, take minutes: they carry the pytest
marker `seeded`, and the ci workflow runs them in two jobs next to `python`
(`uv run pytest -m "not seeded"`): `python-seeded`, the one-pitch-class pins, the pitchless
families and the softer thirds, and `python-seeded-chords`, the chord families and the seventh
chords (`-k "chords_keep_the_key or seventh_chord"` and its complement). The
seeded tests that run the key estimators also carry the marker `estimators`: the audio-models
workflow, with Essentia, runs `-m "not seeded or estimators"` for their Essentia half; the
others do not depend on the estimator. A plain `uv run pytest` runs everything. Every
result in both files is checked against the contract's JSON Schema after a strict JSON round
trip, and for its reasons: every `null` has one and no measured value has one
(`tests/checks.py`). `tests/test_v1_removed.py` checks that the response is the `v2` block alone. The Essentia cases and the real-model
tests are reported as skipped without the `models` extra and the models; run
`uv sync --locked --extra models` and `uv run python download_models.py` first to include them.
`AUDIO_REQUIRE_MODELS=1` turns those skips into an error; CI's `audio models` workflow runs the
suite that way.

## Troubleshooting

- **`LibsndfileError` / "Format not recognised"**: `libsndfile` could not decode the file. MP3
  needs `libsndfile` 1.1 or newer; the `soundfile` wheels bundle one, so this usually means a
  platform without a bundled library and an old system `libsndfile`. AAC and M4A are not
  decoded at all: the service decodes only through `libsndfile`, which does not read them. It
  refuses the forms it recognises with their own `422` reason (see the error statuses above);
  the preview hosts the service accepts serve MP3.
- **`/health` says `degraded`**: run `uv run python download_models.py`, or
  `uv run python download_models.py --check` to see which model is missing or fails its checksum.
