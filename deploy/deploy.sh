#!/usr/bin/env bash
# Deploys zoofyautomation to the shared VPS (zoofyautomation.norwen.nl). Run from the local machine.
# Required env vars: VPS_HOST, VPS_USER
# Optional: SSH_KEY (path to private key), APP_DIR (default /opt/zoofyautomation), SESSION_SECRET,
# N8N_API_KEY
#
# Shares the box with Norwen and resumechecker under nginx with an existing *.norwen.nl
# wildcard cert — no certbot run. Postgres runs in Docker on host port 5435 (5432-5434 taken).
set -euo pipefail

: "${VPS_HOST:?Set VPS_HOST (IP or hostname)}"
: "${VPS_USER:?Set VPS_USER}"
APP_DIR="${APP_DIR:-/opt/zoofyautomation}"
DB_HOST_PORT="${DB_HOST_PORT:-5435}"
DOMAIN="zoofyautomation.norwen.nl"
SSH_OPTS=()
if [[ -n "${SSH_KEY:-}" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY")
fi

REMOTE="$VPS_USER@$VPS_HOST"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== Syncing code to $REMOTE:$APP_DIR =="
ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p $APP_DIR"
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.venv' --exclude '__pycache__' --exclude '.git' --exclude 'node_modules' --exclude '.env' \
  "$ROOT_DIR/backend" "$ROOT_DIR/frontend" "$ROOT_DIR/docker-compose.yml" \
  "$REMOTE:$APP_DIR/"

echo "== Starting Postgres via docker compose (host port $DB_HOST_PORT) =="
ssh "${SSH_OPTS[@]}" "$REMOTE" "cd $APP_DIR && DB_HOST_PORT=$DB_HOST_PORT docker compose up -d"

REMOTE_ENV_EXISTS=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "[ -f $APP_DIR/backend/.env ] && echo yes || echo no")
if [[ "$REMOTE_ENV_EXISTS" == "yes" && -z "${SESSION_SECRET:-}" && -z "${N8N_API_KEY:-}" ]]; then
  echo "== .env already exists on the box — leaving it untouched =="
else
  echo "== Writing .env =="
  SESSION_SECRET_TO_WRITE="${SESSION_SECRET:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}"
  N8N_API_KEY_TO_WRITE="${N8N_API_KEY:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cat > $APP_DIR/backend/.env" <<EOF
DATABASE_URL=postgresql+asyncpg://zoofyautomation:zoofyautomation@localhost:$DB_HOST_PORT/zoofyautomation
SESSION_SECRET=$SESSION_SECRET_TO_WRITE
N8N_API_KEY=$N8N_API_KEY_TO_WRITE
EOF
  echo "-- N8N_API_KEY written (save this for the n8n HTTP Request credential): $N8N_API_KEY_TO_WRITE"
fi

echo "== Installing Python deps =="
ssh "${SSH_OPTS[@]}" "$REMOTE" "cd $APP_DIR/backend && python3 -m venv .venv && ./.venv/bin/pip install --upgrade pip -q && ./.venv/bin/pip install -q -r requirements.txt"

echo "== Deploying systemd service =="
scp "${SSH_OPTS[@]}" "$ROOT_DIR/deploy/zoofyautomation.service" "$REMOTE:/tmp/zoofyautomation.service"
ssh "${SSH_OPTS[@]}" "$REMOTE" "sudo mv /tmp/zoofyautomation.service /etc/systemd/system/zoofyautomation.service && sudo systemctl daemon-reload && sudo systemctl enable --now zoofyautomation && sudo systemctl restart zoofyautomation"

echo "== Health check =="
HEALTH_CODE=""
for attempt in 1 2 3 4 5; do
  sleep 2
  HEALTH_CODE=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8001/api/health" || true)
  if [[ "$HEALTH_CODE" == "200" ]]; then
    break
  fi
  echo "-- Attempt $attempt: HTTP ${HEALTH_CODE:-<no response>}, retrying..."
done
if [[ "$HEALTH_CODE" != "200" ]]; then
  echo "!! Health check failed after 5 attempts (last: HTTP ${HEALTH_CODE:-<no response>})."
  echo "!! Check: ssh $REMOTE 'journalctl -u zoofyautomation -n 50 --no-pager'"
  exit 1
fi
echo "-- Health check passed (HTTP 200)"

echo "== Configuring Nginx for $DOMAIN (reusing existing *.norwen.nl cert) =="
ssh "${SSH_OPTS[@]}" "$REMOTE" "cat <<'NGINXCONF' | sudo tee /etc/nginx/sites-available/zoofyautomation >/dev/null
$(cat "$ROOT_DIR/deploy/nginx.conf.template")
NGINXCONF
sudo ln -sf /etc/nginx/sites-available/zoofyautomation /etc/nginx/sites-enabled/zoofyautomation
sudo nginx -t && sudo systemctl reload nginx"

echo "== Verifying $DOMAIN responds =="
curl -s -o /dev/null -w "HTTP %{http_code}\n" "https://$DOMAIN/api/health" || echo "!! Could not reach https://$DOMAIN yet — check DNS for the *.norwen.nl wildcard"

echo "== Done. Deployed to https://$DOMAIN =="
