#!/usr/bin/env bash
# Поднимает статический сервер, прогоняет оба набора и гасит сервер за собой.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8199}"
npx --yes http-server -p "$PORT" -s . > /dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# Ждём, пока сервер начнёт отвечать
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/index.html" > /dev/null && break
  sleep 0.5
done

BASE="http://127.0.0.1:$PORT" node tests/match.mjs
BASE="http://127.0.0.1:$PORT" node tests/social.mjs
BASE="http://127.0.0.1:$PORT" node tests/lobby.mjs
BASE="http://127.0.0.1:$PORT" node tests/video.mjs
