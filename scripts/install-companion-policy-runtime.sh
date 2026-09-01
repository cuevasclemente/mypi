#!/usr/bin/env bash
# Backup-first, allowlisted distribution for Dream + Agent Teams companion policy.
# Run as the normal user. Installed/private artifacts are never printed.
set -euo pipefail
umask 077

readonly REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
readonly RUNTIME_ROOT=${PI_AGENT_DIR:-"$HOME/.pi/agent"}
readonly WAYANG_RUNNER_SOURCE=${WAYANG_DREAM_RUNNER_SOURCE:-"$HOME/src/wayang/scripts/dream-authorized-sessions.mjs"}
readonly MEMORIKI_SKILL_ROOT=${MEMORIKI_SKILL_ROOT:-"$HOME/src/memoriki/skills"}
readonly STAMP=$(date +%Y%m%d-%H%M%S)
readonly BACKUP="$RUNTIME_ROOT/.backups/${STAMP}-companion-policy-$$"

[[ $EUID -ne 0 ]] || { echo "Run this installer as the normal user, not root." >&2; exit 1; }

sources=(
  "plugins/dreamer.ts"
  "plugins/agent-teams/index.ts"
  "plugins/agent-teams/goals.ts"
  "plugins/agent-teams/companion-policy.ts"
  "plugins/agent-teams/child-policy-guard.ts"
  "plugins/agent-teams/durable-report-lifecycle.ts"
  "plugins/agent-teams/durable-reports.ts"
  "plugins/agent-teams/privileged-exec-protocol.ts"
  "plugins/agent-teams/subagent-manager.ts"
  "plugins/agent-teams/subagent-runner.ts"
  "plugins/agent-teams/README.md"
  "plugins/agent-teams/SKILL.md"
  "skills/dream-cycle-skill-extraction/SKILL.md"
  "scripts/dreamer-cron.sh"
)
for source in "${sources[@]}"; do
  [[ -f "$REPO_ROOT/$source" ]] || { echo "Missing reviewed source: $source" >&2; exit 2; }
done
[[ -f "$WAYANG_RUNNER_SOURCE" && ! -L "$WAYANG_RUNNER_SOURCE" ]] || {
  echo "Missing reviewed Wayang Dream runner source" >&2
  exit 2
}

mkdir -p -- "$BACKUP" "$RUNTIME_ROOT/extensions" "$RUNTIME_ROOT/skills" "$RUNTIME_ROOT/scripts"
chmod 0700 "$BACKUP"
if [[ -L "$RUNTIME_ROOT/extensions/agent-teams" ]]; then
  mkdir -p "$BACKUP/extensions"
  cp -a -- "$RUNTIME_ROOT/extensions/agent-teams" "$BACKUP/extensions/agent-teams"
  unlink -- "$RUNTIME_ROOT/extensions/agent-teams"
fi
mkdir -p -- "$RUNTIME_ROOT/extensions/agent-teams" \
  "$RUNTIME_ROOT/skills/dream-cycle-skill-extraction" \
  "$RUNTIME_ROOT/skills/agent-teams"

pairs=(
  "plugins/dreamer.ts:extensions/dreamer.ts"
  "plugins/agent-teams/index.ts:extensions/agent-teams/index.ts"
  "plugins/agent-teams/goals.ts:extensions/agent-teams/goals.ts"
  "plugins/agent-teams/companion-policy.ts:extensions/agent-teams/companion-policy.ts"
  "plugins/agent-teams/child-policy-guard.ts:extensions/agent-teams/child-policy-guard.ts"
  "plugins/agent-teams/durable-report-lifecycle.ts:extensions/agent-teams/durable-report-lifecycle.ts"
  "plugins/agent-teams/durable-reports.ts:extensions/agent-teams/durable-reports.ts"
  "plugins/agent-teams/privileged-exec-protocol.ts:extensions/agent-teams/privileged-exec-protocol.ts"
  "plugins/agent-teams/subagent-manager.ts:extensions/agent-teams/subagent-manager.ts"
  "plugins/agent-teams/subagent-runner.ts:extensions/agent-teams/subagent-runner.ts"
  "plugins/agent-teams/README.md:extensions/agent-teams/README.md"
  "plugins/agent-teams/SKILL.md:extensions/agent-teams/SKILL.md"
  "skills/dream-cycle-skill-extraction/SKILL.md:skills/dream-cycle-skill-extraction/SKILL.md"
  "plugins/agent-teams/SKILL.md:skills/agent-teams/SKILL.md"
  "scripts/dreamer-cron.sh:dreamer-cron.sh"
)

# Review and back up every existing active target without printing contents.
for pair in "${pairs[@]}"; do
  source=${pair%%:*}
  target=${pair#*:}
  source_path="$REPO_ROOT/$source"
  target_path="$RUNTIME_ROOT/$target"
  if [[ -e "$target_path" || -L "$target_path" ]]; then
    mkdir -p -- "$BACKUP/$(dirname -- "$target")"
    cp -a -- "$target_path" "$BACKUP/$target"
    if cmp -s -- "$source_path" "$target_path"; then status=same; else status=different; fi
    mode=$(stat -c '%a' -- "$target_path" 2>/dev/null || echo unknown)
    size=$(stat -c '%s' -- "$target_path" 2>/dev/null || echo unknown)
    printf 'reviewed active target: %s (%s, mode=%s, size=%s)\n' "$target" "$status" "$mode" "$size"
  else
    printf 'reviewed active target: %s (absent)\n' "$target"
  fi
done

runner_target="$RUNTIME_ROOT/scripts/dream-authorized-sessions.mjs"
if [[ -e "$runner_target" || -L "$runner_target" ]]; then
  mkdir -p "$BACKUP/scripts"
  cp -a -- "$runner_target" "$BACKUP/scripts/dream-authorized-sessions.mjs"
  if cmp -s -- "$WAYANG_RUNNER_SOURCE" "$runner_target"; then status=same; else status=different; fi
  printf 'reviewed active target: scripts/dream-authorized-sessions.mjs (%s, mode=%s, size=%s)\n' \
    "$status" "$(stat -c '%a' -- "$runner_target")" "$(stat -c '%s' -- "$runner_target")"
else
  printf 'reviewed active target: scripts/dream-authorized-sessions.mjs (absent)\n'
fi

for pair in "${pairs[@]}"; do
  source=${pair%%:*}
  target=${pair#*:}
  target_path="$RUNTIME_ROOT/$target"
  [[ -L "$target_path" ]] && unlink -- "$target_path"
  mkdir -p -- "$(dirname -- "$target_path")"
  mode=0644
  [[ $target == dreamer-cron.sh ]] && mode=0755
  install -m "$mode" -- "$REPO_ROOT/$source" "$target_path"
done
[[ -L "$runner_target" ]] && unlink -- "$runner_target"
install -m 0644 -- "$WAYANG_RUNNER_SOURCE" "$runner_target"

# Runtime first, then durable skill archive. Do not inspect or print existing
# Memoriki content; this approved source copy is written directly.
archive_target="$MEMORIKI_SKILL_ROOT/dream-cycle-skill-extraction/SKILL.md"
mkdir -p -- "$(dirname -- "$archive_target")"
[[ -L "$archive_target" ]] && unlink -- "$archive_target"
install -m 0644 -- "$REPO_ROOT/skills/dream-cycle-skill-extraction/SKILL.md" "$archive_target"

for pair in "${pairs[@]}"; do
  source=${pair%%:*}
  target=${pair#*:}
  cmp -s -- "$REPO_ROOT/$source" "$RUNTIME_ROOT/$target" || {
    echo "Runtime verification failed: $target" >&2
    exit 1
  }
done
cmp -s -- "$WAYANG_RUNNER_SOURCE" "$runner_target" || {
  echo "Runtime verification failed: scripts/dream-authorized-sessions.mjs" >&2
  exit 1
}

printf 'Companion policy runtime installed and byte-compared.\nBackup: %s\n' "$BACKUP"
printf 'Reload Pi extensions or restart Wayang-managed Pi runtimes before use.\n'
