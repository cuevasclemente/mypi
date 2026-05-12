#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${EXA_API_KEY:-}" ]]; then
  key_file="${EXA_API_KEY_FILE:-$HOME/src/mypi/secure_data/exa_key}"
  if [[ ! -r "$key_file" ]]; then
    echo "EXA_API_KEY is unset and key file is not readable: $key_file" >&2
    exit 2
  fi
  export EXA_API_KEY="$(<"$key_file")"
fi

exec node "$HOME/src/mypi/node_modules/exa-mcp-server/smithery/stdio/index.cjs"
