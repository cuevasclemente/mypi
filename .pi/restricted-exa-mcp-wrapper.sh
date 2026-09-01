#!/usr/bin/bash
set -euo pipefail
umask 077

operator_home="${HOME:?HOME must be set}"
key_file="$operator_home/src/mypi/secure_data/exa_key"
runtime_home="$operator_home/.wayang/restricted-mcp-homes/exasearch"
if [[ ! -r "$key_file" ]]; then
  printf '%s\n' 'Restricted Exa credential is unavailable.' >&2
  exit 2
fi
exa_api_key="$(<"$key_file")"
if [[ -z "$exa_api_key" ]]; then
  printf '%s\n' 'Restricted Exa credential is empty.' >&2
  exit 2
fi
/usr/bin/mkdir -p -- "$runtime_home"
/usr/bin/chmod 700 -- "$runtime_home"
exec /usr/bin/env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="$runtime_home" \
  LANG="C.UTF-8" \
  EXA_API_KEY="$exa_api_key" \
  /usr/bin/node "$operator_home/src/mypi/node_modules/exa-mcp-server/smithery/stdio/index.cjs"
