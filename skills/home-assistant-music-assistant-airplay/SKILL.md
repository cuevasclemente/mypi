---
name: home-assistant-music-assistant-airplay
description: Deploy and troubleshoot Music Assistant with Home Assistant, HomePod, and AirPlay playback on a self-hosted Docker server, including host networking, mDNS/AirPlay discovery, Caddy/Authentik forwarding, smoke tests, and sudo handoff.
---

# Home Assistant + Music Assistant + AirPlay

Use this skill when deploying, checking, or troubleshooting Music Assistant for Home Assistant/HomePod/AirPlay playback on the self-hosted Docker server.

## Known deployment shape

- App: Music Assistant standalone server Docker image `ghcr.io/music-assistant/server:latest`.
- Repo/service location: `server-lattice/music-assistant/docker-compose.yml`.
- Networking: `network_mode: host` is intentional and required for mDNS, uPnP, and AirPlay discovery.
- Local web UI: `http://127.0.0.1:8095/`.
- Relevant ports observed: `8095` for the UI/API and `8097` for Music Assistant streaming/player support.
- Public route: `music.narwhalzero.net` through Caddy with Authentik forward auth, proxying to `127.0.0.1:8095`.
- Data directory is local service state; keep it ignored by git via `.gitignore`.
- YouTube Music support uses a local PO token helper in the same Compose stack: `ytmusic-po-token-server`, image `brainicism/bgutil-ytdlp-pot-provider:1.2.1`, bound to `127.0.0.1:4416` only.

## Deployment checklist

1. Work in the `server-lattice` repository and inspect existing operations docs before changing service layout.
2. Ensure `music-assistant/docker-compose.yml` uses host networking. Do not replace host networking with a bridge network unless the user explicitly accepts losing or reworking mDNS/uPnP/AirPlay discovery.
3. Use the Music Assistant image `ghcr.io/music-assistant/server:latest` unless the user asks to pin a version.
4. Keep persistent Music Assistant state under the service data directory and ensure generated data is ignored by git.
5. Validate compose before starting:
   - `docker compose config`
   - `docker compose up -d`
6. Smoke test locally before touching external routing:
   - `curl -I http://127.0.0.1:8095/`
   - Expected first-run/setup behavior can be `302` redirect to setup.
7. Check logs for provider/player discovery:
   - AirPlay provider loads.
   - Expected discovered players have included `Living Room` and `Move 2`.

## YouTube Music PO token helper

Music Assistant's YouTube Music provider requires a PO token server. Current docs observed 2026-05-30 said Music Assistant supports PO token server version `1.2.1`; verify current docs before upgrading.

Deployment pattern in `server-lattice/music-assistant/docker-compose.yml`:

```yaml
ytmusic-po-token-server:
  image: brainicism/bgutil-ytdlp-pot-provider:1.2.1
  container_name: ytmusic-po-token-server
  restart: unless-stopped
  init: true
  ports:
    - "127.0.0.1:4416:4416"
```

Because `music-assistant-server` runs with `network_mode: host`, configure the YouTube Music provider in the Music Assistant UI with:

```text
http://127.0.0.1:4416
```

Validation:

```bash
curl -sS -o /tmp/po-token-response.json -w '%{http_code}\n' \
  -X POST http://127.0.0.1:4416/get_pot \
  -H 'Content-Type: application/json' -d '{}'
```

Do not print or share the response body or raw helper logs unnecessarily; the helper can emit generated PO token material. YouTube Music still requires Clemente to enter his username/login cookie in the Music Assistant UI. Never read, store, or print that cookie.

## Caddy + Authentik route pattern

- Add only the Music Assistant route for `music.narwhalzero.net` unless the user asks for broader Caddy changes.
- Use Authentik forward auth consistently with the server's existing Caddy conventions.
- Proxy the authenticated route to `127.0.0.1:8095`.
- Do not include Authentik tokens, secrets, cookie secrets, or private key material in notes or skills.
- After editing Caddy config, validate and reload with the server's normal commands, typically:
  - `caddy validate --config <Caddyfile-or-config-path>`
  - `caddy reload --config <Caddyfile-or-config-path>`

## Sudo handoff

Caddy deployment may require sudo. If sudo is blocked or not pre-authorized:

1. Stop before attempting privileged changes repeatedly.
2. Tell the user/operator exactly what needs privileged execution.
3. Ask them to run `sudo -v` in the appropriate shell/session, then continue only after confirmation.
4. For the privileged Caddy step, insert only the `music.narwhalzero.net` route and run Caddy validate/reload. Avoid unrelated config edits.

## Troubleshooting

### UI not reachable locally

- Confirm the container is up: `docker compose ps` from `server-lattice/music-assistant`.
- Check logs: `docker compose logs --tail=200 music-assistant` or the actual service name in compose.
- Confirm host port listening on `127.0.0.1:8095` or all interfaces.
- Re-run `curl -I http://127.0.0.1:8095/`.

### HomePod/AirPlay players not discovered

- Preserve `network_mode: host`.
- Check logs for AirPlay provider startup and zeroconf/mDNS messages.
- Confirm the server is on the same LAN/VLAN path as HomePod/AirPlay devices and that multicast is not blocked.
- If logs show a zeroconf warning about `net.ipv4.igmp_max_memberships=1024`, record it and consider a sysctl tuning only after confirming the host's multicast group pressure and the user's preference.
- Restarting Music Assistant can refresh discovery, but avoid broad network restarts without asking.

### Public route fails but local UI works

- Validate Caddy syntax.
- Confirm the route points to `127.0.0.1:8095`.
- Check Authentik forward-auth route conventions from nearby Caddy routes.
- Check Caddy logs for auth failures versus upstream connection failures.

## Safety notes

- Do not read secret files or print tokens. Reference secret paths or environment variable names only when needed.
- Do not remove Music Assistant data unless the user explicitly asks and confirms.
- Prefer minimal, auditable config changes: compose service, README/docs, `.gitignore`, and the single Caddy route.
