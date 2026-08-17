#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="${TMPDIR:-/tmp}/niuniu-demo"
mkdir -p "$RUN_DIR"

cd "$ROOT"

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
    sleep 0.5
    pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

wait_port() {
  local port="$1"
  local label="$2"
  local i
  for i in {1..30}; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "✓ $label ready on :$port"
      return 0
    fi
    sleep 0.5
  done
  echo "✗ $label failed to start (see $RUN_DIR/*.log)" >&2
  return 1
}

echo "Starting Docker (PostgreSQL + Redis)..."
docker compose up -d

echo "Applying database migrations..."
pnpm --filter backend prisma:deploy

echo "Stopping old demo processes..."
stop_port 8080
stop_port 5173
stop_port 5174

echo "Starting backend, miniapp, admin..."
nohup pnpm --filter backend dev > "$RUN_DIR/backend.log" 2>&1 &
echo $! > "$RUN_DIR/backend.pid"
nohup pnpm --filter miniapp dev > "$RUN_DIR/miniapp.log" 2>&1 &
echo $! > "$RUN_DIR/miniapp.pid"
nohup pnpm --filter admin dev > "$RUN_DIR/admin.log" 2>&1 &
echo $! > "$RUN_DIR/admin.pid"

wait_port 8080 "API"
wait_port 5173 "Mini App"
wait_port 5174 "Admin"

echo
echo "Demo is running:"
echo "  Mini App   http://localhost:5173"
echo "  Admin      http://localhost:5174  (admin / admin123)"
echo "  API        http://localhost:8080"
echo
echo "Logs: $RUN_DIR/"
echo "Stop: pnpm demo:stop"
