---
name: server-lattice-backup-operations
description: >-
  Operate and recover The-Sceptre/server-lattice Borg backups safely: inspect systemd timers/services, journal logs, repository checks and locks, offsite sync progress, coverage gaps, script edits, watcher handoff, and Matrix/reporting without reading secret env files.
---

# Server-Lattice Backup Operations

Use this skill when Clemente asks when server-lattice backups last ran, whether a backup can run today, why a Borg backup failed, or how to adjust backup coverage on The-Sceptre/server-lattice.

## Setup

- Backup service: `server-lattice-backup.service`
- Timer: `server-lattice-backup.timer`
- Main script: `/home/clemente/src/server-lattice/backups/backup.sh`
- Typical repository path observed in logs: `/mnt/expansion/backups/server-lattice`
- The service may source secret env files; never read those files or print their contents.
- Starting/stopping/resetting the service is privileged. Use the sudo workflow/skill when root commands are explicitly authorized.

## Workflow

### 1. Check schedule and last run

Start with metadata, not secrets:

```bash
systemctl list-timers --all | grep -Ei 'backup|restic|borg|server-lattice'
systemctl status server-lattice-backup.service --no-pager --lines=80
systemctl cat server-lattice-backup.service server-lattice-backup.timer --no-pager
```

Look for:

- timer `NEXT` and `LAST` timestamps;
- service `ActiveState`, `SubState`, and `Result`;
- `ExecStart` script path;
- failed result vs currently `activating/start`;
- CPU/wall-clock time for long Borg checks.

Do not read env files listed by the unit or script.

### 2. Inspect recent logs safely

Use focused journal filters. Avoid dumping huge logs unless needed.

```bash
journalctl -u server-lattice-backup.service --no-pager -n 120 -o short-iso

journalctl -u server-lattice-backup.service --no-pager --since 'today' -o short-iso \
  | grep -E 'Verifying repository|Repository structure|latest archive|archive integrity|offsite|rsync|Backup complete|ERROR|Failed|Succeeded|Matrix notification' \
  | tail -80
```

Key events:

- archive created;
- repository integrity check started/completed;
- Borg lock or repository errors;
- offsite/rsync status;
- Matrix notification status;
- systemd `Main process exited` and final result.

### 3. Rerun safely

Before rerunning, ensure no backup is active:

```bash
systemctl show server-lattice-backup.service \
  -p ActiveState -p SubState -p Result -p ExecMainStartTimestamp -p ExecMainExitTimestamp --no-pager
```

If active/activating, do **not** start another run. Borg repository locks and a live shell script can conflict. If the user asks to rerun immediately, explain the choices:

1. wait for the current check/offsite step to finish (recommended), or
2. explicitly authorize stopping the current run, then patch/rerun.

Only after authorization:

```bash
sudo systemctl reset-failed server-lattice-backup.service
sudo systemctl start --no-block server-lattice-backup.service
```

Then monitor with `systemctl show` and focused `journalctl`.

### 4. Diagnose common failures

| Symptom | Likely issue | Action |
| --- | --- | --- |
| `failed (Result: exit-code)` after long runtime | Borg check, archive, or sync failure | Read focused journal around first `ERROR` and final exit |
| `activating/start` for a long time | Borg check or offsite sync still running | Check child processes with `ps`, do not rerun |
| Borg lock conflict | Another backup/check is active or stale lock | Confirm no active Borg process before considering lock break |
| Matrix notification failed | Env/network/API issue | Do not print token env; report notification failure separately |
| Coverage missing | Script excludes or paths too narrow | Patch script only when service inactive; validate syntax |

### 5. Patch backup coverage carefully

When updating `/home/clemente/src/server-lattice/backups/backup.sh`:

1. Confirm service is inactive/failed/succeeded, not running.
2. Read the script, but do not read sourced env/secret files.
3. Preserve comments and explicitly intentional large exclusions.
4. Make minimal edits with `edit`.
5. Validate syntax:

```bash
bash -n /home/clemente/src/server-lattice/backups/backup.sh
```

A source session identified a coverage pattern:

- add `/mnt/expansion/opencloud/` when OpenCloud data should be covered;
- prefer full `/etc/` coverage over individual Caddy/systemd files when requested;
- include home config/secrets/dotfiles by removing excludes for `.config`, `.ssh`, `.gnupg`, `.pki`, shell histories, `.Xauthority`, `.ICEauthority`, `.pulse-cookie`, `.mozilla`, `.thunderbird` when the user explicitly wants those backed up;
- keep explicitly unimportant large paths excluded (examples discussed: Seafile, Frigate, Nextcloud, Cryptomator, PryonBackup, IDriveForLinux, llama, caches, trash, Steam-style large paths).

### 6. Use a watcher when a long run must finish first

For a long-running backup, spawn a constrained subagent or leave a clear handoff that:

- polls `server-lattice-backup.service` every few minutes;
- does not modify `backup.sh` while service is active/activating;
- if the run fails, reports key log lines and stops;
- if it succeeds, patches and validates script syntax only;
- does **not** use sudo or rerun unless explicitly authorized.

Watcher prompt constraints should include:

- never read secret env files;
- never stop/restart services;
- never break Borg locks;
- report final service result, coverage changes, validation result, and the exact command the user/orchestrator must run.

## Validation

After a successful run or patch:

```bash
systemctl show server-lattice-backup.service -p ActiveState -p SubState -p Result --no-pager
journalctl -u server-lattice-backup.service --no-pager -n 80 -o short-iso
bash -n /home/clemente/src/server-lattice/backups/backup.sh
```

Report:

- last successful archive/check time;
- whether today's run started/completed;
- whether any rerun remains needed;
- whether coverage script changes were made;
- whether Matrix/report publication succeeded, without exposing credentials.

## Pitfalls

- Do not edit a shell script while the service is currently executing it; shell scripts may be read incrementally.
- Do not rerun over an active Borg check; repository locks and offsite sync can conflict.
- Do not assume a failed service means no archive was written; a later check/offsite step may have failed after archive creation.
- Do not read `backup.env`, Matrix env files, Borg passphrase files, private keys, or other credential stores.
- Avoid broad journal dumps in final responses; summarize the important status and log markers.

## Source-Session Techniques

- A 2026-05-21/22 memoriki session inspected `server-lattice-backup.timer`, `server-lattice-backup.service`, `systemctl status`, and focused `journalctl` output to determine that the scheduled run failed after a long Borg operation.
- The user started a manual rerun; the agent monitored active `borg check --repository-only` and correctly avoided editing/rerunning while active.
- The session established a watcher pattern for waiting until completion, then patching coverage and leaving privileged restart to the user/orchestrator.
