#!/bin/sh
# Fetches and verifies the Essentia models, then starts the service. A failed or skipped
# download is not fatal: the service starts without perceptual features and /health
# reports "degraded". Set AUDIO_FETCH_MODELS=0 to skip the download.
set -eu

# While the download runs, this shell is the container's main process. The download runs in
# the background so that TERM/INT are handled at once (a shell only runs traps between
# foreground commands); the handler stops the download and exits.
child=""
stop() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 143
}
trap stop TERM INT

if [ "${AUDIO_FETCH_MODELS:-1}" != "0" ]; then
  timeout "${MODEL_FETCH_TIMEOUT_S:-90}" python download_models.py &
  child=$!
  status=0
  wait "$child" || status=$?
  child=""
  if [ "$status" -ne 0 ]; then
    echo "Model download did not complete; starting without perceptual features." >&2
  fi
fi

trap - TERM INT
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-3002}"
