#!/usr/bin/bash
set -euo pipefail
umask 077

operator_home="${HOME:?HOME must be set}"
runtime_home="$operator_home/.wayang/restricted-mcp-homes/mempalace"
/usr/bin/mkdir -p -- "$runtime_home"
/usr/bin/chmod 700 -- "$runtime_home"
exec /usr/bin/env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="$runtime_home" \
  LANG="C.UTF-8" \
  "$operator_home/src/memoriki/.venv/bin/python3" \
  -m mempalace.mcp_server \
  --palace "$operator_home/src/memoriki"
