---
name: home-assistant-camera-troubleshooting
description: Diagnose Home Assistant camera integrations, especially Wyze/Thingino/ONVIF/RTSP cameras, by checking network reachability, ports, HA entities, container logs, SQLite state history, and secret-safe credential boundaries.
---

# Home Assistant Camera Troubleshooting

Use this skill when Clemente reports that a camera is unavailable, disconnected, missing from a dashboard, or no longer visible in Home Assistant.

## Setup

- Load `service-health-check` for general layered diagnostics if the problem may be a broader service outage.
- Check Memoriki/wiki for known Home Assistant paths, camera hostnames/IPs, firmware, and entity IDs.
- Never read secret files or print credentials. You may reference secret paths and verify file existence/permissions, but do not expose values.
- Prefer non-destructive tests first. Do not restart Home Assistant, cameras, containers, or network services unless the user confirms.

## Workflow

### 1. Scope the symptom

Ask or infer:
- Which camera(s) are affected?
- Is the camera offline in Home Assistant, a dashboard card, an automation, or the camera’s own web UI?
- Did anything change recently: firmware, Wi-Fi, router, HA update, entity renaming, dashboard edits?
- Is the problem live now or intermittent?

### 2. Inventory known cameras and entities

Search notes/config for camera names, IPs, and entity IDs without reading secrets.

Useful patterns:

```bash
rg -n "wyze|thingino|onvif|rtsp|camera\." /path/to/home-assistant-config \
  -g '!secrets.yaml' -g '!*.key' -g '!*.token'
```

For known HA SQLite state DBs, query entity history rather than credentials:

```bash
sqlite3 -header -column /path/to/home-assistant_v2.db \
"SELECT sm.entity_id, s.state, datetime(s.last_updated_ts,'unixepoch','localtime') AS updated
 FROM states s
 JOIN states_meta sm ON sm.metadata_id=s.metadata_id
 WHERE sm.entity_id LIKE 'camera.%'
 ORDER BY s.last_updated_ts DESC
 LIMIT 20;"
```

### 3. Check camera network reachability

From the host and, if HA runs in Docker, from inside the HA container:

```bash
for ip in 192.168.x.y 192.168.x.z; do
  echo "=== $ip ==="
  timeout 3 bash -c "</dev/tcp/$ip/80" && echo "80 open" || echo "80 closed"
  timeout 3 bash -c "</dev/tcp/$ip/554" && echo "554 open" || echo "554 closed"
done
```

Or from inside the container:

```bash
docker exec homeassistant python3 - <<'PY'
import socket
for ip in ["192.168.x.y"]:
    print("===", ip, "===")
    for port in [80, 554, 8554, 8899]:
        try:
            s = socket.create_connection((ip, port), timeout=3)
            s.close()
            print(port, "open")
        except Exception as e:
            print(port, type(e).__name__, str(e))
PY
```

Interpretation:
- Port 80 open: camera web UI reachable.
- Port 554 open: RTSP likely reachable.
- Host can reach but HA container cannot: Docker/network route problem.
- Neither can reach: camera offline, changed IP, Wi-Fi/VLAN issue.

### 4. Probe camera web endpoints safely

For Thingino/Wyze cameras, unauthenticated requests often return `401 Unauthorized`, which is useful: it proves the service is alive without needing credentials.

```bash
curl -sS -I --max-time 5 "http://CAMERA_IP/x/preview.cgi" | head -30
curl -sS --max-time 5 "http://CAMERA_IP/x/status.cgi" | head -40
```

Expected secret-safe results:
- `401 Unauthorized` with `WWW-Authenticate: Basic` means the camera is alive and protected.
- `404` on guessed snapshot paths may be normal.
- Do not brute-force or print Basic Auth credentials.

### 5. Inspect Home Assistant logs

Look for integration-specific errors:

```bash
docker logs --since 30m homeassistant 2>&1 \
  | rg -n "wyze|thingino|onvif|rtsp|camera|not found|stream|192\.168\." || true
```

Common findings:
- ONVIF/RTSP auth failures: credentials/config issue; ask user to re-enter through UI or verify secret values themselves.
- Entity not found: dashboard/automation points to stale entity ID.
- Stream timeout: RTSP URL/transport issue, camera service overloaded, or network instability.

### 6. Compare HA entity state with live reachability

If camera ports are reachable and HA state updates recently, the camera is likely working and the issue may be UI/dashboard cache, a stale card, disabled entity, or a transient reconnect.

Check enabled/disabled entities and profiles. Thingino/ONVIF cameras may expose multiple profiles, with some disabled by integration.

### 7. Fix only after isolating layer

Potential fixes by layer:
- Changed IP: update DHCP reservation or HA integration host.
- Stale dashboard entity: update dashboard card entity ID.
- Disabled entity/profile: enable desired entity in HA UI.
- Auth mismatch: have user update credentials in HA UI; do not read secrets.
- RTSP service hung: ask before restarting camera service/camera/HA.
- HA integration stuck: ask before reloading the integration or restarting HA.

## Example: Wyze/Thingino ONVIF check

Known entities:
- `camera.wyze_cam_bedroom_profile_0`
- `camera.wyze_cam_bedroom_profile_1`
- `camera.wyze_freefloat_profile_0`

Checks:

```bash
docker exec homeassistant python3 - <<'PY'
import socket
for ip in ["192.168.50.230", "192.168.50.33"]:
    print("===", ip, "===")
    for port in [80, 554]:
        try:
            s=socket.create_connection((ip, port), timeout=3); s.close(); print(port, "open")
        except Exception as e:
            print(port, type(e).__name__, str(e))
PY
```

If both ports are open and HA SQLite shows recent `idle` states for the camera entities, report that the cameras are reachable and HA is updating them; investigate dashboard/UI or transient stream behavior next.

## Validation

Before declaring resolved:
- Confirm affected camera(s) by name and entity ID.
- Confirm network reachability from the HA runtime, not just the host.
- Confirm HA entity state changed recently.
- Confirm no credentials were read or exposed.
- Ask the user to verify live video in the HA UI if you cannot view it.

## Source session patterns

- 2026-05-17 Wyze cameras in Home Assistant: identified Thingino firmware, checked ports 80/554 from HA container, queried HA SQLite entity history, probed HTTP endpoints that returned safe `401`, and recorded durable camera IP/entity mapping.
