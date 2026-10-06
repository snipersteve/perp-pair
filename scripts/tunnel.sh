#!/usr/bin/env bash
set -euo pipefail
exec ssh -N -L 3321:127.0.0.1:3321 "${1:-root@43.133.181.195}"
