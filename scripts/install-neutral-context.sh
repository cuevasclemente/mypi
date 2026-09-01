#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 3 ]] || { echo 'usage: install-neutral-context.sh <agents-source> <agent-dir> <backup-root>' >&2; exit 2; }
source_file=$1
agent_dir=$2
backup_root=$3

[[ ! -L "$source_file" && -f "$source_file" && -r "$source_file" ]] || {
  echo "unsafe or unreadable source: $source_file" >&2
  exit 2
}
[[ ! -L "$agent_dir" ]] || { echo "refusing symlinked agent directory: $agent_dir" >&2; exit 2; }
mkdir -p "$agent_dir" "$backup_root"
for name in AGENTS.md APPEND_SYSTEM.md; do
  target="$agent_dir/$name"
  [[ ! -L "$target" ]] || { echo "refusing symlink target: $target" >&2; exit 2; }
  [[ ! -e "$target" || -f "$target" ]] || { echo "target is not a regular file: $target" >&2; exit 2; }
done

backup=$(mktemp -d "$backup_root/neutral-context-$(date +%Y%m%d-%H%M%S)-XXXXXX")
for name in AGENTS.md APPEND_SYSTEM.md; do
  target="$agent_dir/$name"
  if [[ -f "$target" ]]; then cp -p "$target" "$backup/$name"; else printf '%s was absent before neutral installation.\n' "$name" > "$backup/${name%.md}.absent"; fi
done
cp -p "$source_file" "$backup/candidate-AGENTS.md"
(cd "$backup" && sha256sum AGENTS.md APPEND_SYSTEM.md AGENTS.absent APPEND_SYSTEM.absent candidate-AGENTS.md 2>/dev/null > SHA256SUMS || {
  files=(); for file in AGENTS.md APPEND_SYSTEM.md AGENTS.absent APPEND_SYSTEM.absent candidate-AGENTS.md; do [[ -f "$file" ]] && files+=("$file"); done
  sha256sum "${files[@]}" > SHA256SUMS
})
(cd "$backup" && sha256sum -c SHA256SUMS >/dev/null)

staged=$(mktemp "$agent_dir/.AGENTS.md.neutral.XXXXXX")
install -m 0644 "$source_file" "$staged"
activated=0
cleanup() {
  status=$?
  trap - ERR INT TERM EXIT
  [[ ! -e "$staged" ]] || mv "$staged" "$backup/failed-staged-AGENTS.md"
  if [[ $status -ne 0 && $activated -eq 1 ]]; then
    for name in AGENTS.md APPEND_SYSTEM.md; do
      target="$agent_dir/$name"
      absent="$backup/${name%.md}.absent"
      if [[ -f "$backup/$name" ]]; then
        restore=$(mktemp "$agent_dir/.${name}.restore.XXXXXX")
        install -m 0644 "$backup/$name" "$restore"
        mv -f "$restore" "$target"
      elif [[ -f "$absent" && -f "$target" ]]; then
        mv "$target" "$backup/failed-activation-$name"
      fi
    done
    echo "neutral activation failed; restored backup: $backup" >&2
  fi
  exit "$status"
}
trap cleanup ERR INT TERM EXIT

activated=1
if [[ -f "$agent_dir/APPEND_SYSTEM.md" ]]; then
  mv "$agent_dir/APPEND_SYSTEM.md" "$backup/displaced-APPEND_SYSTEM.md"
fi
mv -f "$staged" "$agent_dir/AGENTS.md"
staged=''
cmp -s "$source_file" "$agent_dir/AGENTS.md"
[[ ! -e "$agent_dir/APPEND_SYSTEM.md" ]]
activated=0
trap - ERR INT TERM EXIT
printf 'installed neutral agent context and removed identity append; backup=%s\n' "$backup"
