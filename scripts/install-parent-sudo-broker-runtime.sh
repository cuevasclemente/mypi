#!/usr/bin/env bash
# Install the reviewed parent-mediated sudo broker into the active pi runtime.
# Run as the normal user (not sudo). This script does not restart Wayang.
set -euo pipefail

readonly REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
readonly RUNTIME_ROOT=${PI_AGENT_DIR:-"$HOME/.pi/agent"}
readonly EXTENSIONS="$RUNTIME_ROOT/extensions"
readonly STAMP=$(date +%Y%m%d-%H%M%S)
readonly BACKUP="$EXTENSIONS/.backups/${STAMP}-parent-sudo-broker"

[[ $EUID -ne 0 ]] || {
  printf 'Run this installer as the normal user, not root.\n' >&2
  exit 1
}

for source in \
  plugins/sudo-hook.ts \
  plugins/command-authorization-monitor.ts \
  plugins/agent-teams/privileged-exec-protocol.ts \
  plugins/agent-teams/index.ts \
  plugins/agent-teams/subagent-manager.ts \
  plugins/agent-teams/subagent-runner.ts; do
  [[ -f "$REPO_ROOT/$source" ]] || {
    printf 'Missing source: %s\n' "$REPO_ROOT/$source" >&2
    exit 1
  }
done

mkdir -p -- "$BACKUP/agent-teams" "$EXTENSIONS/agent-teams"
for relative in \
  sudo-hook.ts \
  command-authorization-monitor.ts \
  agent-teams/privileged-exec-protocol.ts \
  agent-teams/index.ts \
  agent-teams/subagent-manager.ts \
  agent-teams/subagent-runner.ts; do
  if [[ -e "$EXTENSIONS/$relative" || -L "$EXTENSIONS/$relative" ]]; then
    cp -a -- "$EXTENSIONS/$relative" "$BACKUP/$relative"
  fi
done

install -m 0644 -- "$REPO_ROOT/plugins/sudo-hook.ts" "$EXTENSIONS/sudo-hook.ts"
install -m 0644 -- "$REPO_ROOT/plugins/command-authorization-monitor.ts" "$EXTENSIONS/command-authorization-monitor.ts"
install -m 0644 -- "$REPO_ROOT/plugins/agent-teams/privileged-exec-protocol.ts" "$EXTENSIONS/agent-teams/privileged-exec-protocol.ts"
install -m 0644 -- "$REPO_ROOT/plugins/agent-teams/index.ts" "$EXTENSIONS/agent-teams/index.ts"
install -m 0644 -- "$REPO_ROOT/plugins/agent-teams/subagent-manager.ts" "$EXTENSIONS/agent-teams/subagent-manager.ts"
install -m 0644 -- "$REPO_ROOT/plugins/agent-teams/subagent-runner.ts" "$EXTENSIONS/agent-teams/subagent-runner.ts"

for pair in \
  "plugins/sudo-hook.ts:sudo-hook.ts" \
  "plugins/command-authorization-monitor.ts:command-authorization-monitor.ts" \
  "plugins/agent-teams/privileged-exec-protocol.ts:agent-teams/privileged-exec-protocol.ts" \
  "plugins/agent-teams/index.ts:agent-teams/index.ts" \
  "plugins/agent-teams/subagent-manager.ts:agent-teams/subagent-manager.ts" \
  "plugins/agent-teams/subagent-runner.ts:agent-teams/subagent-runner.ts"; do
  source=${pair%%:*}
  target=${pair#*:}
  cmp -s -- "$REPO_ROOT/$source" "$EXTENSIONS/$target" || {
    printf 'Runtime verification failed: %s\n' "$target" >&2
    exit 1
  }
done

printf 'Parent sudo broker runtime installed.\nBackup: %s\n' "$BACKUP"
printf 'Restart Wayang, then start a new/reloaded session before smoke testing.\n'
