#!/usr/bin/env bash
# Brings up the throwaway mock stack, seeds it, runs the "mock" Playwright project, then always
# tears the stack down (including its anonymous Postgres volume) regardless of test outcome.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="docker compose -f $ROOT_DIR/docker-compose.test.yml"

cleanup() {
  echo "== Tearing down mock stack =="
  $COMPOSE down -v
}
trap cleanup EXIT

echo "== Building and starting mock stack =="
$COMPOSE up -d --build

echo "== Waiting for mock backend health =="
npx tsx "$ROOT_DIR/tests/scripts/wait-for-health.ts"

echo "== Seeding mock owner account =="
npx tsx "$ROOT_DIR/tests/scripts/seed-owner.ts"

echo "== Running Playwright (mock project) =="
npx playwright test --project=mock "$@"
