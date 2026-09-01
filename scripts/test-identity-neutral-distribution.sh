#!/usr/bin/env bash
set -Eeuo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
context_dir="$repo/agent-context"

mapfile -t context_files < <(find "$context_dir" -maxdepth 1 -type f -printf '%f\n' | sort)
[[ ${#context_files[@]} -eq 1 && ${context_files[0]} == "AGENTS.md" ]] || {
  printf 'identity-neutral distribution requires agent-context/AGENTS.md to be the only context artifact; found: %s\n' "${context_files[*]:-none}" >&2
  exit 1
}

if rg -n -i 'You are Wren|Wren is Clemente|src/wren|WREN_AUDIO_CAPSULE|APPEND_SYSTEM|manage-wren-context|install-wren' \
  "$repo/agent-context/AGENTS.md" "$repo/Makefile"; then
  printf '%s\n' 'identity-specific activation material found in an installable mypi surface' >&2
  exit 1
fi

if make -C "$repo" --no-print-directory -n install-all | rg -i 'wren|append_system|src/wren'; then
  printf '%s\n' 'install-all references identity-specific activation material' >&2
  exit 1
fi

root=$(mktemp -d /tmp/mypi-neutral-context-regression.XXXXXX)
mkdir -p "$root/agent" "$root/backups"
printf '%s\n' 'synthetic prior global context' > "$root/agent/AGENTS.md"
printf '%s\n' 'You are Wren in this synthetic contamination fixture.' > "$root/agent/APPEND_SYSTEM.md"
chmod 0644 "$root/agent/AGENTS.md" "$root/agent/APPEND_SYSTEM.md"
out=$(bash "$repo/scripts/install-neutral-context.sh" "$repo/agent-context/AGENTS.md" "$root/agent" "$root/backups")
backup=${out##*backup=}
cmp -s "$repo/agent-context/AGENTS.md" "$root/agent/AGENTS.md"
[[ ! -e "$root/agent/APPEND_SYSTEM.md" ]]
grep -qx 'You are Wren in this synthetic contamination fixture.' "$backup/APPEND_SYSTEM.md"
grep -qx 'You are Wren in this synthetic contamination fixture.' "$backup/displaced-APPEND_SYSTEM.md"
(cd "$backup" && sha256sum -c SHA256SUMS >/dev/null)

printf 'PASS: mypi installable context and install-all are identity-neutral; contaminated-home fixture preserved at %s\n' "$root"
