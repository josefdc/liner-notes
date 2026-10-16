#!/bin/sh
# Fetches and verifies the Essentia models, then starts the service. A failed or skipped
# download is not fatal: the service starts without perceptual features and /health
# reports "degraded". Set AUDIO_FETCH_MODELS=0 to skip the download.
set -eu

if [ "${AUDIO_FETCH_MODELS:-1}" != "0" ]; then
  timeout "${MODEL_FETCH_TIMEOUT_S:-90}" python download_models.py \
    || echo "Model download did not complete; starting without perceptual features." >&2
fi

exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-3002}"
