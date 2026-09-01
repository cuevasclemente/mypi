#!/bin/bash
# Dreamer systemd/cron wrapper. Transcript enumeration and reads are authorized
# only by Wayang's metadata-only projection runner.

set -euo pipefail

: "${HOME:?HOME must be set by the invoking user or service manager}"
export TZ=${PI_DREAM_TIMEZONE:-${TZ:-UTC}}
readonly LOG_DIR="$HOME/.pi/logs"
readonly RUNNER=${PI_DREAM_AUTHORIZATION_RUNNER:-"$HOME/.pi/agent/scripts/dream-authorized-sessions.mjs"}
readonly DREAMER_EXTENSION=${PI_DREAMER_EXTENSION:-"$HOME/.pi/agent/extensions/dreamer.ts"}
readonly SESSIONS_DIR=${PI_DREAM_SESSIONS_DIR:-"$HOME/.pi/agent/sessions"}
readonly DREAM_CWD=${PI_DREAM_CWD:-"$HOME/src/mypi"}
mkdir -p "$LOG_DIR"

RUN_TS=$(date -Iseconds)
echo "=== Dream Cycle Start: $RUN_TS ==="

# Fail before agent/model launch when the runner, sessions root, projection, or
# its source-store fingerprint is unavailable/stale/malformed. `list` touches
# only names/metadata and prints no transcript bytes; output is discarded.
[[ -f "$RUNNER" && ! -L "$RUNNER" && -r "$RUNNER" \
   && -f "$DREAMER_EXTENSION" && ! -L "$DREAMER_EXTENSION" && -r "$DREAMER_EXTENSION" ]] || {
  echo "Dream runner/extension runtime is unavailable; refusing agent launch" >&2
  exit 3
}
[[ -d "$SESSIONS_DIR" && -d "$DREAM_CWD" ]] || {
  echo "Dream preflight path is unavailable; refusing agent launch" >&2
  exit 3
}
preflight=(node "$RUNNER" list --sessions-root "$SESSIONS_DIR")
if [[ -n ${WAYANG_PROJECT_POLICY_PROJECTION:-} ]]; then
  preflight+=(--projection "$WAYANG_PROJECT_POLICY_PROJECTION")
fi
"${preflight[@]}" >/dev/null || {
  echo "Dream authorization projection preflight failed; refusing agent launch" >&2
  exit 3
}

# Use a registered standard workspace so Agent Teams can deterministically
# authorize the Dream analysis children. Avoid project context and persistence:
# this mechanical background run should not create another transcript to Dream.
set +e
(
  cd "$DREAM_CWD"
  pi --print --no-session --no-context-files "dream"
) 2>&1
EXIT_CODE=$?
set -e

echo "=== Dream Cycle End: $(date -Iseconds) (exit: $EXIT_CODE) ==="
echo ""
exit "$EXIT_CODE"
