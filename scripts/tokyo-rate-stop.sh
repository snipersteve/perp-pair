#!/usr/bin/env bash
# Tokyo-specific emergency coordinator. Only invoked on an actual exchange 418/429.
# Stop known PM2 trading/API consumers; never auto-restart them. No file or position edits.
set -euo pipefail
export PATH=/root/.nvm/versions/node/v22.22.3/bin:$PATH
ids="$(pm2 jlist | python3 -c 'import json,sys
for p in json.load(sys.stdin):
 n=p["name"]
 if p["pm2_env"]["status"]=="online" and (n.startswith("taoli-") or n in {"pair-admin","okx-quote-service","price-pane","mint-short","gate-arb"}): print(p["pm_id"])')"
if [[ -n "$ids" ]]; then
  mapfile -t targets <<< "$ids"
  pm2 stop "${targets[@]}"
fi
