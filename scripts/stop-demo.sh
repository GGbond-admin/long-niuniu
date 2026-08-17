#!/usr/bin/env bash
set -euo pipefail

RUN_DIR="${TMPDIR:-/tmp}/niuniu-demo"

stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping :$port ($pids)"
    kill $pids 2>/dev/null || true
    sleep 0.5
    pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

stop_pid_file() {
  local name="$1"
  local file="$RUN_DIR/$name.pid"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping $name (pid $pid)"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  fi
}

stop_pid_file backend
stop_pid_file miniapp
stop_pid_file admin

stop_port 8080
stop_port 5173
stop_port 5174

echo "Demo services stopped."
