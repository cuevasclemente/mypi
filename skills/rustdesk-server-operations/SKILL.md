---
name: rustdesk-server-operations
description: >-
  Operate Clemente's self-hosted RustDesk server: configure, recover, upgrade, troubleshoot hbbs/hbbr connectivity, ports/firewall/DNS, and key rotation without exposing secrets.
---

# RustDesk Server Operations

Use this skill when configuring, recovering, upgrading, or documenting Clemente's self-hosted RustDesk server (`hbbs`/ID rendezvous and `hbbr`/relay), including client connectivity failures, router/firewall ports, split-horizon DNS, and key rotation.

## Safety boundaries

- Do **not** print, copy, read aloud, journal, or expose RustDesk private keys, public-key values when treated as sensitive, client passwords, or secret files.
- If key material was exposed during troubleshooting, treat it as compromised and create a follow-up to rotate it.
- Prefer metadata-safe checks: service status, process args with secrets redacted, listener ports, config filenames, docs, and example env keys.
- Ask before making router/firewall changes that could expose the service beyond intended LAN/VPN/public boundaries.

## Ports and components

- `hbbs`: ID/rendezvous server; commonly uses TCP `21115`, TCP/UDP `21116`, TCP `21118` for web/client auxiliary paths depending on deployment.
- `hbbr`: relay server; commonly uses TCP `21117`, TCP `21119`.
- RustDesk clients may appear partly working when TCP succeeds but UDP rendezvous or hairpin NAT fails.

## Troubleshooting workflow

1. **Clarify symptom and topology**
   - Which clients, networks, and directions fail? Example: LAN-to-LAN, LAN-to-WAN hostname, VPN-to-LAN, internet-to-home.
   - Capture exact client status text: not ready, unable to connect, relay unavailable, ID server offline, etc.
   - Determine whether clients use hostname, public IP, LAN IP, or split-DNS name for ID and relay servers.

2. **Inventory repo docs/config without secrets**
   - Find RustDesk docs, compose files, systemd units/drop-ins, health scripts, Caddy/reverse-proxy snippets, and `.env.example` files.
   - Check whether live services are systemd-managed, containerized, or manually launched.
   - Record expected binary version and install path.

3. **Server health checks**
   - Check `hbbs` and `hbbr` service status and recent logs, redacting key material.
   - Verify listeners for expected TCP/UDP ports.
   - Verify health scripts or TCP/UDP probes from an allowed host.
   - Confirm both ID and relay processes use the same intended key/config directory.

4. **Network path checks**
   - Test public hostname resolution from LAN, VPN, and external contexts when possible.
   - Check router/firewall/NAT forwarding for required TCP and UDP ports, especially UDP `21116`.
   - If LAN clients fail when using the public hostname but work with the LAN IP, suspect hairpin NAT/UDP rendezvous behavior.
   - Prefer split-horizon DNS: LAN/VPN resolves the RustDesk hostname to the server LAN IP; internet resolves to the public IP.

5. **Client configuration checks**
   - RustDesk may have user-level and root/service-level config. On macOS especially, root/service config can override visible user settings.
   - Verify ID server, relay server, API server if used, and key fields are consistent across the effective config locations.
   - Do not reveal key values in logs or final answers; say only whether values match.

6. **Remediation pattern**
   - Fix one layer at a time: service binary/units, ports, router/firewall, DNS, then client effective config.
   - Restart `hbbs`/`hbbr` and watchdog services only when the intended unit/drop-in state is clear.
   - For upgrades, install official upstream binaries in a versioned directory and point systemd drop-ins there; keep rollback path.
   - After recovery, schedule key rotation if any key was exposed.

7. **Validation**
   - Validate server health script passes.
   - Test at least two representative clients in the direction that failed.
   - Test both direct LAN path and hostname path after split-DNS changes.
   - Update operations docs with ports, topology, known client config paths, and recovery steps.

## Common findings from prior sessions

- LAN clients using a public DNS name may hairpin through the router public IP; TCP can work while RustDesk UDP rendezvous/relay behavior remains broken.
- Setting LAN clients to the RustDesk server LAN IP can confirm the service is healthy and isolate hairpin DNS/NAT issues.
- On tribe-mac-like macOS clients, service/root RustDesk config can override user-visible config, so update/check both effective locations.
- Upgrading `hbbs`/`hbbr` to official upstream binaries can resolve packaged-service drift, but validate systemd drop-ins and watchdogs afterward.
