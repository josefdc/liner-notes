# =============================================================================
# Sonic Agent Audio Analysis - Production Build with uv
# Python/FastAPI microservice for BPM/Key extraction
# =============================================================================

# Use official uv image with Python 3.11 pre-installed
FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim

WORKDIR /app

# Install system dependencies for audio processing (ffmpeg, libsndfile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Enable bytecode compilation for faster startup
ENV UV_COMPILE_BYTECODE=1

# Use copy mode for linking (required for Docker layer caching)
ENV UV_LINK_MODE=copy

# Install dependencies first (for better layer caching)
# Using --no-install-project to cache dependencies separately
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project --no-dev

# Copy application code
COPY . /app

# Sync the project (installs the project itself)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# Download Essentia TensorFlow models from MTG model zoo
RUN uv run python download_models.py

# Expose port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -q --spider http://localhost:3002/health || exit 1

# Run the service using uv
CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3002"]
