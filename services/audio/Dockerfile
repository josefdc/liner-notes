# =============================================================================
# Liner Notes audio analysis service (FastAPI + librosa + Essentia)
# =============================================================================
# The Essentia models are not part of the image: docker-entrypoint.sh fetches and
# verifies them into /app/models (a volume) when the container starts. Without them
# the service still measures tempo and key, and /health reports "degraded".

# uv 0.12.24 with Python 3.12 on Debian trixie, pinned by digest.
FROM ghcr.io/astral-sh/uv:0.12.24-python3.12-trixie-slim@sha256:c45e18882c3b26a1631ac8b64537a2213e301b752edaa2471d32226090ccaafe

WORKDIR /app

# soundfile decodes the previews with the libsndfile in its wheel; libsndfile1 is its fallback.
# ffmpeg is no longer used by the service or CI's image checks; it stays until the image is
# slimmed down. wget serves the docker-compose healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    wget \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# Install dependencies first so code changes do not invalidate this layer. The image includes
# the "models" extra (essentia-tensorflow); the models themselves are fetched at start.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project --no-dev --extra models

COPY . /app

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra models

# Unprivileged runtime user; only the models directory is writable by it.
RUN useradd --system --uid 10001 --user-group --create-home --home-dir /home/app \
        --shell /usr/sbin/nologin app \
    && mkdir -p /app/models \
    && chown app:app /app/models

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    MODELS_DIR=/app/models \
    NUMBA_CACHE_DIR=/tmp/numba-cache

VOLUME ["/app/models"]

USER 10001:10001

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT', '3002')}/health\", timeout=5)"]

CMD ["sh", "/app/docker-entrypoint.sh"]
