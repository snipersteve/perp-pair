#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE=root@43.133.181.195
NODE=/root/.nvm/versions/node/v22.22.3/bin
npm run check
npm test
npm run build
# This script updates an already provisioned observe-only deployment. Never rewrites credentials.
ssh "$REMOTE" 'grep -qx "MODE=observe" /root/deploy/perp-pair/.env && systemctl stop perp-pair'
ssh "$REMOTE" 'test ! -e /root/deploy/perp-pair/data/process.lock'
rsync -az dist web deploy package.json package-lock.json "$REMOTE:/root/perp-pair-code/"
ssh "$REMOTE" "cd /root/perp-pair-code && PATH=$NODE:\$PATH npm ci --omit=dev && install -m 644 deploy/perp-pair-tokyo.service /etc/systemd/system/perp-pair.service && systemctl daemon-reload && systemctl enable --now perp-pair && systemctl is-active perp-pair"
