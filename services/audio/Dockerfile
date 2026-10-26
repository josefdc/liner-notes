# =============================================================================
# Liner Notes audio analysis service (FastAPI + librosa + Essentia)
# =============================================================================
# The Essentia models are not part of the image: docker-entrypoint.sh fetches and
# verifies them into /app/models (a volume) when the container starts. Without them
# the service still measures tempo and key, and /health reports "degraded".
#
# linux/amd64 only: essentia-tensorflow (the "models" extra) has no Linux aarch64 wheel.
#
# Two stages: uv builds the virtual environment, and a slim Python image with the same
# interpreter runs it. The runtime has no uv, ffmpeg or wget: soundfile decodes the previews
# (MP3 and WAV) with the libsndfile bundled in its wheel, and the health check is Python.

# Stage 1: uv 0.12.24 with Python 3.12 on Debian trixie, pinned by digest.
FROM ghcr.io/astral-sh/uv:0.12.24-python3.12-trixie-slim@sha256:c45e18882c3b26a1631ac8b64537a2213e301b752edaa2471d32226090ccaafe AS builder

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# Dependencies only (the project is not a package), so code changes do not invalidate this
# layer. The image includes the "models" extra (essentia-tensorflow); the models themselves are
# fetched at start.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project --no-dev --extra models

# Stage 2: Python 3.12.15 on Debian trixie, the interpreter the builder's environment was made
# with (its python links to /usr/local/bin/python3), pinned by digest.
FROM python:3.12.15-slim-trixie@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS runtime

WORKDIR /app

COPY --from=builder /app/.venv /app/.venv

# The environment only runs with the interpreter it was built for: a change to either base
# image that splits them fails the build here.
RUN venv=$(sed -n 's/^version_info = //p' /app/.venv/pyvenv.cfg) \
    && here=$(python -B -c 'import platform; print(platform.python_version())') \
    && if [ "$venv" != "$here" ]; then \
        echo "environment built with Python $venv, runtime has $here" >&2; exit 1; \
    fi

COPY . /app

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
