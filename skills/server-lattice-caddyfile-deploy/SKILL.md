---
name: server-lattice-caddyfile-deploy
description: Safely edit and deploy The-Sceptre/server-lattice Caddyfile routes, especially new Caddy reverse-proxy and Authentik forward-auth routes, using the repository Caddyfile as canonical and copying it to /etc/caddy.
---

# Server-Lattice Caddyfile Deploy

Use this skill whenever modifying Caddy routes for services on The-Sceptre/server-lattice.

## Core rule

`/home/clemente/src/server-lattice/caddy/Caddyfile` is the canonical source. Do **not** hand-edit `/etc/caddy/Caddyfile` for normal changes. Edit the server-lattice Caddyfile, validate it, then copy it into `/etc/caddy/Caddyfile` and reload Caddy.

Only touch `/etc/caddy/Caddyfile` directly for emergency recovery, and immediately reconcile the same change back to the server-lattice source.

## Workflow

1. Inspect source and deployed state:
   ```bash
   diff -u /etc/caddy/Caddyfile /home/clemente/src/server-lattice/caddy/Caddyfile | sed -n '1,260p'; true
   ```
   If the source has unrelated pending differences, do not blindly deploy them. Ask Clemente or reconcile the source first.

2. Edit only the canonical source:
   - `/home/clemente/src/server-lattice/caddy/Caddyfile`
   - Update related docs when appropriate, e.g. `docs/OPERATIONS.md` and service `README.md`.

3. Validate the source without requiring root log access:
   ```bash
   caddy adapt --config /home/clemente/src/server-lattice/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-adapt.json
   ```
   `caddy validate` may fail as non-root if it cannot open `/var/log/caddy/access.log`; `adapt` is still useful for syntax checks.

4. Deploy with one bounded top-level sudo command, preserving a backup:
   ```bash
   sudo bash -lc 'set -euo pipefail
   src=/home/clemente/src/server-lattice/caddy/Caddyfile
   backup="/etc/caddy/Caddyfile.backup.$(date +%Y%m%d-%H%M%S)"
   cp -a /etc/caddy/Caddyfile "$backup"
   install -m 0644 "$src" /etc/caddy/Caddyfile
   caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   systemctl reload caddy
   systemctl is-active caddy
   echo "backup: $backup"
   '
   ```

5. Smoke test:
   ```bash
   curl -k -sS -I --max-time 15 https://SUBDOMAIN.narwhalzero.net/ | sed -n '1,24p'
   journalctl -u caddy --since '5 minutes ago' --no-pager
   ```

## Authentik forward-auth gotcha

For Caddy `forward_auth` routes, a public 404 from Authentik usually means the proxy provider was not created or not added to the embedded outpost. Create/check:

- Proxy Provider, mode `forward_single`, `external_host=https://subdomain.narwhalzero.net`
- Application linked to that provider
- Embedded outpost `b33bdede-6d10-4db6-ac61-cfd226d7a98b` includes the provider pk

Use the Authentik API token only via shell variable/indirection and never print it.

## Notes

- DNS for `*.narwhalzero.net` may already wildcard to the server, but still check with `getent hosts`.
- The Caddyfile currently has a LAN/VPN TLS gate managed via Caddy admin API hooks; do not remove or reformat related comments/snippets casually.
- Do not run `caddy fmt --overwrite` on the production Caddyfile unless Clemente explicitly asks; it can create broad noisy diffs.
