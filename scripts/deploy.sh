#!/usr/bin/env bash
# New host install / atomic code release. Never copies .env, keys, DB, or changes Caddy.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -eq 0 ]; then echo "Current deployment is Tokyo: use scripts/deploy-tokyo.sh. Legacy deploy requires an explicit remote." >&2; exit 1; fi
REMOTE="$1"
if ! [[ "$REMOTE" =~ ^[a-zA-Z0-9_.@:-]+$ ]]; then echo "Invalid remote" >&2; exit 1; fi
npm ci
npm run check
npm test
npm run build
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ssh "$REMOTE" "node -e 'if(Number(process.versions.node.split(\".\")[0])<22)process.exit(1)'"
ssh "$REMOTE" "mkdir -p /opt/perp-pair/releases/$RELEASE"
rsync -az package.json package-lock.json dist web deploy .env.example "$REMOTE:/opt/perp-pair/releases/$RELEASE/"
ssh "$REMOTE" "RELEASE='$RELEASE' bash -s" <<'SH'
set -euo pipefail
BASE=/opt/perp-pair
cd "$BASE/releases/$RELEASE"
npm ci --omit=dev
id perp-pair >/dev/null 2>&1 || useradd --system --home /var/lib/perp-pair --shell /usr/sbin/nologin perp-pair
install -d -o perp-pair -g perp-pair -m 700 /var/lib/perp-pair
if [ ! -f /etc/perp-pair.env ]; then
  umask 077
  {
    printf 'MODE=observe\nLIVE_TRADING=false\nHOST=127.0.0.1\nPORT=3321\nDATA_DIR=/var/lib/perp-pair\n'
    printf 'ADMIN_PASSWORD='
    openssl rand -hex 24
  } > /etc/perp-pair.env
  chown root:perp-pair /etc/perp-pair.env
  chmod 640 /etc/perp-pair.env
fi
# Existing live installs: deploy code only. Operator drains/restarts explicitly.
if grep -Eq '^MODE=live[[:space:]]*$' /etc/perp-pair.env; then
  echo "Live install detected. Release staged at $BASE/releases/$RELEASE; NOT restarted or switched."
  exit 0
fi
systemctl stop perp-pair 2>/dev/null || true
ln -sfn "$BASE/releases/$RELEASE" "$BASE/current.new"
mv -Tf "$BASE/current.new" "$BASE/current"
install -m 644 deploy/perp-pair.service /etc/systemd/system/perp-pair.service
systemctl daemon-reload
systemctl enable --now perp-pair
systemctl is-active perp-pair
echo "Observe-only service at 127.0.0.1:3321. Env: /etc/perp-pair.env (password never printed)."
SH
