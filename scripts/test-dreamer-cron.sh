#!/usr/bin/env bash
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
WAYANG_DIR=${WAYANG_DIR:-"$REPO/../wayang"}
ROOT=$(mktemp -d /tmp/mypi-dreamer-cron-test.XXXXXX)
trap 'rm -rf -- "$ROOT"' EXIT
mkdir -p "$ROOT/home/.pi/agent/sessions" "$ROOT/home/.pi/agent/extensions" \
  "$ROOT/home/src/mypi" "$ROOT/home/.pi/logs" "$ROOT/bin" "$ROOT/wayang"
printf 'synthetic extension placeholder\n' >"$ROOT/home/.pi/agent/extensions/dreamer.ts"
MARKER="$ROOT/pi-launched"
cat >"$ROOT/bin/pi" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >'$MARKER'
EOF
chmod 0755 "$ROOT/bin/pi"

export HOME="$ROOT/home"
export PATH="$ROOT/bin:$PATH"
export PI_DREAM_AUTHORIZATION_RUNNER="$WAYANG_DIR/scripts/dream-authorized-sessions.mjs"
export PI_DREAM_SESSIONS_DIR="$HOME/.pi/agent/sessions"
export PI_DREAM_CWD="$HOME/src/mypi"
export WAYANG_PROJECT_POLICY_PROJECTION="$ROOT/wayang/project-access-policy.json"

# Missing projection must fail before the fake Pi launcher is reached.
if bash "$REPO/scripts/dreamer-cron.sh" >/dev/null 2>&1; then
  echo "cron unexpectedly passed missing-policy preflight" >&2
  exit 1
fi
[[ ! -e "$MARKER" ]] || { echo "cron launched Pi before policy preflight" >&2; exit 1; }

printf '{}\n' >"$ROOT/wayang/store.json"
node - "$ROOT/wayang/store.json" "$WAYANG_PROJECT_POLICY_PROJECTION" <<'NODE'
const fs = require('node:fs');
const [storePath, projectionPath] = process.argv.slice(2);
const stat = fs.statSync(storePath);
fs.writeFileSync(projectionPath, JSON.stringify({
  schema_version: 1,
  generation: 1,
  complete: true,
  source_store: { size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs, ino: Number(stat.ino) || 0 },
  projects: [],
  sessions: [],
}) + '\n', { mode: 0o600 });
NODE
chmod 0600 "$WAYANG_PROJECT_POLICY_PROJECTION"

bash "$REPO/scripts/dreamer-cron.sh" >/dev/null 2>&1
[[ -f "$MARKER" ]] || { echo "cron did not launch Pi after successful preflight" >&2; exit 1; }
grep -q -- '--no-session' "$MARKER"
grep -q -- '--no-context-files' "$MARKER"
printf 'dreamer cron preflight tests passed\n'
