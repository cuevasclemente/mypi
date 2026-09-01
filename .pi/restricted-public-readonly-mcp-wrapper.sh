#!/usr/bin/bash
set -euo pipefail
umask 077

operator_home="${HOME:?HOME must be set}"
runtime_home="$operator_home/.wayang/restricted-mcp-homes/public-readonly"
set -a
# Source the private credential opaquely; never print or forward unrelated values.
. "$operator_home/src/memoriki/trading/stocks/env"
set +a
if [[ -z "${PUBLIC_API_KEY:-}" ]]; then
  printf '%s\n' 'Restricted Public credential is unavailable.' >&2
  exit 2
fi
/usr/bin/mkdir -p -- "$runtime_home"
/usr/bin/chmod 700 -- "$runtime_home"
exec /usr/bin/env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="$runtime_home" \
  LANG="C.UTF-8" \
  PUBLIC_API_KEY="$PUBLIC_API_KEY" \
  "$operator_home/src/memoriki/trading/stocks/.venv/bin/python" \
  "$operator_home/src/memoriki/trading/stocks/public_api_mcp/server.py"
