---
name: sudo-command-execution
description: Execute authorized sudo/root commands from pi safely, especially with pi command guard and sudo hooks. Use when privileged commands are needed, sudo behaves differently in the agent harness, or commands must modify systemd, /etc, mounts, kernel sysctls, Docker services, or other root-owned resources.
---

# Sudo Command Execution

Use this skill when a task requires privileged commands in pi, especially service control, `/etc` edits, mount/sysctl changes, Docker/systemd repair, package operations, or other root-owned resources.

## Core Rule: Make `sudo` the Top-Level Command

When running privileged work through pi, the bash command should begin with `sudo`, rather than embedding `sudo` inside a larger non-sudo shell script.

Preferred pattern for multi-step privileged work:

```bash
sudo bash -lc 'set -euo pipefail
cd /path/to/project
# privileged steps here, without inner sudo
install -m 0644 local.conf /etc/example.conf
systemctl daemon-reload
systemctl restart example.service
'
```

Avoid this pattern in pi:

```bash
set -euo pipefail
sudo install -m 0644 local.conf /etc/example.conf
sudo systemctl restart example.service
```

Why: pi's command guard / sudo hook can treat a command that merely contains `sudo` differently from a command whose top-level executable is `sudo`. Interior `sudo` calls can fail with password/TTY errors or hook parsing issues even after the user authorized the operation.

## Safety Workflow

1. **Confirm authorization and scope**
   - For disruptive or root-level changes, make sure the user has explicitly authorized the specific class of action.
   - If command guard asks for an identity check, do not bypass it. Ask the user to complete the guard/Wayang prompt or run the command in a real terminal.
   - Never read, print, copy, unset, export, or modify the command guard identity PIN file.

2. **Prefer one bounded root shell**
   - Use `sudo bash -lc '...'` or `sudo bash <<'ROOT' ... ROOT` for a short, auditable sequence.
   - Keep the script narrowly scoped to the requested operation.
   - Inside that shell, do not prefix every line with `sudo`.
   - Do not run sudo commands in parallel; handle one privileged prompt/approval flow at a time.
   - Avoid `sudo bash /tmp/script.sh` when possible; guard policy may distrust root execution of scripts from `/tmp`. Prefer inline heredoc or a reviewed project-local script path.

3. **Make backups before editing root-owned config**
   - For systemd units, Caddy configs, mount units, sysctl files, etc., create a timestamped backup before writing.
   - Avoid permanent deletion; use safe-delete/trash/move-to-holding-area patterns for cleanup when possible.

4. **Validate immediately**
   - Print non-secret status after changes: `systemctl is-active`, `systemctl status --no-pager`, `sysctl key`, `findmnt`, `docker compose ps`, HTTP health checks, etc.
   - Do not print secrets or secret-bearing environment files.

5. **If blocked**
   - If command guard blocks a top-level sudo command, stop and report the block.
   - If sudo itself asks for a password/TTY, ask the user to run `sudo -v` or the exact command in an interactive terminal; do not use `sudo -S` or ask for/store the password.
   - Consider splitting a broad root script into smaller top-level `sudo ...` commands so the guard can assess each action precisely.

## Examples

### Apply sysctl values persistently and live

```bash
sudo bash -lc 'set -euo pipefail
cat > /etc/sysctl.d/99-example.conf <<"EOF"
fs.inotify.max_user_watches = 2097152
EOF
sysctl --system
sysctl fs.inotify.max_user_watches
'
```

### Install a systemd unit and start it

```bash
sudo bash -lc 'set -euo pipefail
install -m 0644 /home/user/project/service.service /etc/systemd/system/service.service
systemctl daemon-reload
systemctl reset-failed service.service
systemctl start service.service
systemctl is-active service.service
'
```

### Edit a root-owned file safely

```bash
sudo bash -lc 'set -euo pipefail
backup="/etc/example.conf.backup.$(date +%Y%m%d-%H%M%S)"
cp -a /etc/example.conf "$backup"
python3 - <<"PY"
from pathlib import Path
path = Path("/etc/example.conf")
text = path.read_text()
text = text.replace("old", "new")
path.write_text(text)
PY
echo "backup: $backup"
'
```
