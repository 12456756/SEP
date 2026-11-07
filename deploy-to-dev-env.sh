#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
The legacy shared development server has been retired from this repository.
This script is intentionally disabled so a development deploy cannot target
the production SEP server. Configure and verify a dedicated development
environment before restoring this entry point.
EOF
exit 2
