#!/usr/bin/env bash
# US-5: brings up just the throwaway Postgres (not the app container — these tests talk to the
# DB directly through app.models/app.routers, not over HTTP), runs pytest, always tears down.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
COMPOSE="docker compose -f $ROOT_DIR/docker-compose.test.yml"

cleanup() {
  echo "== Tearing down test database =="
  $COMPOSE down -v
}
trap cleanup EXIT

echo "== Starting throwaway Postgres =="
$COMPOSE up -d db

echo "== Waiting for Postgres health =="
until $COMPOSE ps db | grep -q "healthy"; do sleep 1; done

echo "== Running pytest =="
cd "$BACKEND_DIR"
PYTHON="python3"
if [ -x "$BACKEND_DIR/.venv/bin/python" ]; then
  PYTHON="$BACKEND_DIR/.venv/bin/python"
fi
"$PYTHON" -m pytest tests/ "$@"
