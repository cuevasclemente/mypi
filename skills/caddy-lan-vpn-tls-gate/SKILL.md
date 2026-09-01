---
name: caddy-lan-vpn-tls-gate
description: Configure and recover Caddy JSON-admin TLS handshake gates for LAN/VPN-only self-hosted services, including SNI source-IP drop policies, Caddyfile/JSON reconciliation, systemd persistence, Authentik coexistence, and validation from allowed and disallowed clients.
---

# Caddy LAN/VPN TLS Gate

Use this skill when a public DNS name should only complete TLS for clients on a local network or VPN, while preserving Caddy/Authentik routing for allowed clients. It is especially useful when HTTP-layer auth redirects or route matchers are too late because the service should be hidden at the TLS handshake.

## Setup

- A Caddy v2 server with the local admin API enabled, usually `http://127.0.0.1:2019`.
- Sudo/root access for deploying Caddy config or systemd drop-ins.
- Known allowed CIDRs, for example LAN and VPN ranges.
- Canonical repo/config path for durable changes, not only runtime JSON.
- Do not read secret files. Reference credential/token paths only when configuring tools.

## Workflow

1. **Inspect the current routing and handoff**
   - Read the relevant project Caddyfile, journals, and service docs.
   - Identify hostnames to gate, e.g. `wayang.narwhalzero.net` and `openclaw.narwhalzero.net`.
   - Confirm whether Authentik forward auth should remain behind the gate for allowed clients.

2. **Prefer TLS connection policies for handshake-level denial**
   - Caddyfile request matchers run after TLS. If disallowed clients must not reach Authentik/HTTP, use JSON admin config under `apps.tls.automation.policies` or `apps.tls.connection_policies` as appropriate for the installed Caddy version.
   - Match on both SNI/server names and remote IP ranges.
   - Configure a default/drop policy for matching SNI from non-allowed source IPs.

3. **Prototype through the local admin API**
   - Use `caddy adapt` and/or read the current runtime JSON from `/config/`.
   - Apply the smallest possible JSON patch to add the gate.
   - Avoid one-shot `POST` scripts for persistent config fragments if reruns should be idempotent; use `PATCH`/replace semantics so restart/reload hooks can run repeatedly.

4. **Persist the runtime fix**
   - Store JSON fragments and apply scripts in the infrastructure repo, for example:
     - `caddy/lan-vpn-tls-gate.json`
     - `caddy/apply-lan-vpn-tls-gate.sh`
     - `caddy/caddy-lan-vpn-tls-gate.service.d.conf`
   - Install the apply script to a root-owned path, such as `/usr/local/bin/apply-lan-vpn-tls-gate.sh`.
   - Add a Caddy systemd drop-in with `ExecStartPost=` and `ExecReload=` so the JSON gate is reapplied after restarts/reloads.

5. **Keep Authentik and canonical hostnames aligned**
   - If a service was renamed, update Authentik application/provider names, `external_host`, and redirect URIs in place rather than creating duplicate providers.
   - Keep legacy hostnames as Caddy redirects where appropriate, and ensure the gate applies to the new canonical hostname.

## Validation

- From localhost or an allowed VPN/LAN client:
  - TLS handshake succeeds.
  - Service reaches the expected Authentik redirect or app response.
- From a disallowed source:
  - TLS handshake is dropped or fails before HTTP routing.
  - There is no Authentik authorize stampede.
- Restart/reload Caddy and re-check that the gate survives.
- Validate the apply script can run twice without creating duplicate policies or failing.

Example checks:

```bash
curl -vk --resolve wayang.example.net:443:PUBLIC_IP https://wayang.example.net/
sudo systemctl reload caddy
curl -s http://127.0.0.1:2019/config/ | jq '.apps.tls'
```

## Pitfalls

- A Caddyfile-only matcher may produce surprising `425 Too Early` behavior or run too late for the security goal.
- Runtime admin JSON changes are lost on restart unless reconciled into repo config and systemd lifecycle hooks.
- `POST`-style admin API scripts can fail on the second run; design for idempotency.
- Coordinate with concurrent sessions changing Caddy, DNS, Authentik, or service names to avoid overwriting each other.

## Source-session techniques

- The 2026-05-13/14 Caddy LAN/VPN sessions used Caddy admin JSON patches, `tls_connection_policies`, SNI plus remote-IP matching, a `drop` policy, a systemd drop-in, and a journal handoff to make a runtime fix durable.
