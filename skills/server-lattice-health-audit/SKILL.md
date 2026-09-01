---
name: server-lattice-health-audit
description: Run check-only scheduled or manual health audits of Clemente's server-lattice on The-Sceptre, using documented service inventory, docker/systemd/Caddy probes, concise OK/ATTENTION reporting, and strict no-secret/no-mutation boundaries unless the user authorizes repair.
---

# Server Lattice Health Audit

## Setup
- Run from The-Sceptre when possible, with cwd `/home/clemente/src/server-lattice`.
- Treat `~/src/memoriki/memoriki/wiki/synthesis/server-lattice-current-state.md` and `server-lattice/README.md` as the service inventory source of truth.
- The recurring Wayang job is `Server Lattice Health Check` (`0 8,18 * * *`, local server time) and should produce `SERVER-LATTICE HEALTH: OK` or `SERVER-LATTICE HEALTH: ATTENTION NEEDED`.
- This workflow is **check-only**: do not restart services, edit files, delete files, rotate logs, run migrations, or change containers unless Clemente explicitly authorizes a separate repair step.
- Never read `.env`, credential, token, cookie, private-key, Matrix, OAuth, or other secret-bearing files. It is OK to reference their paths as opaque config locations.

## Workflow
1. **Confirm scope and inventory**
   - Note whether this is a scheduled audit or an interactive incident.
   - Read the server-lattice current-state page and project README enough to list expected-live, expected-down, and mothballed services.
   - Treat mothballed services plus Immich/Frigate as expected down unless docs say otherwise.

2. **Check repository and host basics**
   - Inspect `git status --short` to avoid confusing local changes with service state.
   - Check uptime/load, memory, disk, mounts, and obvious pressure signals.
   - If privileged status is needed, use the sudo workflow skill; keep commands read-only.

3. **Probe services without mutation**
   - Docker: `docker ps`, `docker compose ps` in known stack directories, and bounded `docker logs --tail/--since` only for unhealthy containers.
   - Systemd: `systemctl is-active/is-failed` for documented units and `systemctl list-timers` for scheduled maintenance/backups.
   - Reverse proxy: local HTTP probes, public HTTPS probes, TLS/SNI checks, and Caddy status when relevant.
   - App-specific smoke tests: lightweight `/health`, `/api`, login redirect, or static asset checks; avoid authenticated/user-data endpoints unless the task explicitly requires them.

4. **Classify findings**
   - `OK`: expected-live services respond, expected-down services are documented, no critical timers/backups are stale.
   - `ATTENTION NEEDED`: unhealthy containers, failed units, broken public routing, disk/memory pressure, stale backups/timers, or undocumented drift.
   - Separate known benign warnings from actionable failures.

5. **Report concisely**
   - Start with exactly `SERVER-LATTICE HEALTH: OK` or `SERVER-LATTICE HEALTH: ATTENTION NEEDED`.
   - Include bullets for checks performed, failures, suspected cause, and recommended next action.
   - If repair is needed, pause for authorization unless the user already asked for remediation.

## Common escalations
- Single web app down: use `service-health-check`.
- Authentik outage: use `authentik-forward-auth-deploy` plus service-health patterns; common symptoms include Caddy/DNS OK but Authentik dynamic routes failing.
- Backup/timer questions: use `server-lattice-backup-operations` when available.
- Scheduled Wayang job issues: use `agent-scheduled-tasks`.

## Examples
```bash
# Read-only host overview
hostnamectl; uptime; df -h; free -h

# Docker summary without secrets
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# Failed systemd units/timers
systemctl --failed --no-pager
systemctl list-timers --all --no-pager

# Public/local HTTP smoke probes
curl -fsSIL https://example.narwhalzero.net/ | head
curl -fsS http://127.0.0.1:PORT/health
```

## Validation
- Final answer starts with `SERVER-LATTICE HEALTH: OK` or `SERVER-LATTICE HEALTH: ATTENTION NEEDED`.
- No secret-bearing files were opened.
- No services, containers, files, or scheduled jobs were modified during the audit.
- Any proposed repair is clearly separated from the check-only audit.
