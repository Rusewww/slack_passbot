#!/bin/sh
# Starts the OCR sidecar on loopback, then the bot in the foreground.
#
# If either process dies the container exits, so the platform's restart policy
# can do its job — a bot running without OCR is worse than a bot that is down,
# because it silently fails every upload.

set -eu

cleanup() {
  [ -n "${SIDECAR_PID:-}" ] && kill "$SIDECAR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --host 127.0.0.1 is deliberate: the sidecar is unauthenticated and must never
# be reachable from outside the container's network namespace.
uvicorn ocr.app.main:app \
  --host 127.0.0.1 \
  --port 8000 \
  --workers 1 \
  --log-level warning &
SIDECAR_PID=$!

# Give uvicorn a moment to bind before Node probes /health.
i=0
while [ "$i" -lt 30 ]; do
  if node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 0.5
done

exec node dist/index.js
