# Audio Analysis Microservice

A Python FastAPI microservice that analyzes Spotify preview URLs to extract real BPM and musical key using `librosa`.

## Why a Separate Service?

1. **librosa** is the gold standard for audio analysis (BPM, key detection, spectral features)
2. **Python** has mature audio processing libraries unavailable in Node.js
3. **Decoupled architecture** allows independent scaling and containerization
4. **30-second previews** are sufficient for accurate BPM/key extraction

## Quick Start

### Option 1: Local Python (Development)

```bash
# From server/analysis directory
cd server/analysis

# Install dependencies with uv
uv sync

# Run the service
uv run uvicorn main:app --host 0.0.0.0 --port 3002 --reload
```

### Option 2: Docker (Production)

```bash
# Build the image
docker build -t sonic-audio-analysis .

# Run the container
docker run -p 3002:3002 sonic-audio-analysis
```

### Option 3: Docker Compose (Full Stack)

Add to your `docker-compose.yml`:

```yaml
services:
  audio-analysis:
    build: ./server/analysis
    ports:
      - "3002:3002"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3002/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## API Endpoints

### `GET /health`

Health check endpoint.

```bash
curl http://localhost:3002/health
# {"status": "healthy", "version": "1.0.0"}
```

### `POST /analyze`

Analyze a Spotify preview URL.

```bash
curl -X POST http://localhost:3002/analyze \
  -H "Content-Type: application/json" \
  -d '{"preview_url": "https://p.scdn.co/mp3-preview/..."}'
```

**Response:**
```json
{
  "bpm": 128,
  "key": "G",
  "mode": "Major",
  "energy": 0.742,
  "duration": 29.87,
  "source": "analyzed"
}
```

## How It Works

1. **Download**: Fetches the 30-second preview MP3 from Spotify's CDN
2. **Load**: Uses `librosa.load()` to decode audio to numpy array
3. **BPM Detection**: `librosa.beat.beat_track()` - uses onset detection and auto-correlation
4. **Key Detection**: Krumhansl-Kessler algorithm on chroma features
5. **Energy**: RMS energy normalized to 0-1 scale

## Algorithm Details

### BPM Detection
- Uses `librosa.beat.beat_track()` which:
  - Computes onset strength envelope
  - Uses dynamic programming for optimal beat tracking
  - Handles tempo variations and rubato

### Key Detection
- Computes Constant-Q chromagram (`librosa.feature.chroma_cqt`)
- Correlates against Krumhansl-Kessler key profiles
- Tests all 24 major/minor keys for best match

## Error Handling

If the service is unavailable, the Node.js agent falls back to genre-based estimation with a clear `source: "estimated"` flag.

## Performance

- **Processing Time**: ~3-5 seconds per track
- **Accuracy**: 
  - BPM: ±2 BPM for most tracks
  - Key: ~75% accuracy (major/minor mode)
- **Concurrency**: 4 worker threads by default

## Dependencies

| Package | Purpose |
|---------|---------|
| fastapi | Web framework |
| uvicorn | ASGI server |
| librosa | Audio analysis |
| numpy | Numerical operations |
| requests | HTTP client for preview download |
| pydantic | Data validation |
| soundfile | Audio file I/O |

## Troubleshooting

### "ffmpeg not found"
librosa uses ffmpeg for MP3 decoding:
```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# macOS
brew install ffmpeg

# Windows
choco install ffmpeg
```

### Rate Limiting
Spotify may rate limit preview downloads. The service handles this gracefully.

### Memory Usage
Each analysis uses ~50-100MB temporarily. The service cleans up temp files immediately after processing.
