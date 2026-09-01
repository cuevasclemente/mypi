---
name: home-assistant-automation-troubleshooting
description: Diagnose and safely repair Home Assistant automations by inspecting YAML, traces, recorder SQLite, entity states/attributes, container logs, and reload/validation paths without reading secrets.
---

# Home Assistant Automation Troubleshooting

Use this skill when a Home Assistant automation did not fire, fired unexpectedly, or needs a safe YAML repair.

## Safety boundaries

- Do not read or print secrets: `secrets.yaml`, `.env`, credential files, `.storage/auth*`, `.storage/core.config_entries`, tokens, passwords, webhook IDs, or API keys.
- It is OK to reference secret file paths for configuration, but never display their contents.
- Prefer read-only inspection first. Before editing, back up the target YAML inside the Home Assistant config/container.
- Redact entity attributes that look like tokens, URLs with credentials, passwords, exact location data, or personal identifiers.
- Use Home Assistant validation/reload paths where possible; restart only when reload is unavailable or changes are not picked up.

## Triage workflow

1. Identify the automation by alias/entity id and expected trigger time.
2. Confirm Home Assistant/container health and current config location:
   ```sh
   docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | grep -i 'home\|hass'
   docker exec homeassistant sh -c 'ls -l /config/automations.yaml /config/home-assistant.log 2>/dev/null'
   ```
3. Inspect relevant logs without secrets:
   ```sh
   docker logs --since '2h' homeassistant 2>&1 | grep -iE 'automation|trace|error|warning|yaml|reload'
   docker exec homeassistant sh -c "grep -iE 'automation|trace|error|warning|yaml|reload' /config/home-assistant.log | tail -200"
   ```
4. Inspect automation YAML around the alias/entity id. Check trigger time, conditions, entity ids, mode, disabled flags, and last modified time.
5. Inspect saved traces. Trace data often contains the exact condition/step failure.
6. Query recorder SQLite for trigger and state evidence.
7. Inspect live entity states/attributes via Home Assistant UI/API or a safe local Python/YAML parse; focus on attributes used by conditions.
8. Make the smallest YAML change, validate parse, reload automations, then re-check logs/traces.

## Recorder SQLite examples

Run read-only queries against a copy when possible. Schema varies by Home Assistant version, so discover tables first:

```sh
docker exec homeassistant sh -c "sqlite3 /config/home-assistant_v2.db '.tables'"
```

Recent automation trigger events:

```sh
docker exec homeassistant sh -c "sqlite3 -readonly /config/home-assistant_v2.db <<'SQL'
.headers on
.mode column
SELECT datetime(e.time_fired_ts, 'unixepoch', 'localtime') AS fired,
       et.event_type,
       ed.shared_data
FROM events e
JOIN event_types et ON et.event_type_id = e.event_type_id
LEFT JOIN event_data ed ON ed.data_id = e.data_id
WHERE et.event_type = 'automation_triggered'
ORDER BY e.time_fired_ts DESC
LIMIT 50;
SQL"
```

Recent state rows for an automation or entity:

```sh
docker exec homeassistant sh -c "sqlite3 -readonly /config/home-assistant_v2.db <<'SQL'
.headers on
.mode column
SELECT datetime(s.last_updated_ts, 'unixepoch', 'localtime') AS updated,
       sm.entity_id,
       s.state,
       sa.shared_attrs
FROM states s
JOIN states_meta sm ON sm.metadata_id = s.metadata_id
LEFT JOIN state_attributes sa ON sa.attributes_id = s.attributes_id
WHERE sm.entity_id IN ('automation.bright_lights_at_evening', 'light.all_lights')
ORDER BY s.last_updated_ts DESC
LIMIT 50;
SQL"
```

If joins fail, inspect `.schema events`, `.schema states`, `.schema states_meta`, and adapt to the installed schema.

## Trace parsing examples

Saved traces are commonly in `.storage/trace.saved_traces`. This file is not a secret file, but still redact sensitive entity data before sharing.

List automation trace keys and failed conditions:

```sh
docker exec homeassistant python3 - <<'PY'
import json
from pathlib import Path
p = Path('/config/.storage/trace.saved_traces')
obj = json.loads(p.read_text())
for key, traces in obj.get('data', {}).items():
    if 'automation' not in key:
        continue
    print('\n==', key, '==')
    for tr in traces[-5:]:
        print('run_id:', tr.get('run_id'), 'state:', tr.get('state'))
        for path, node in (tr.get('trace') or {}).items():
            result = node.get('result') if isinstance(node, dict) else None
            if isinstance(result, dict) and result.get('result') is False:
                print(' failed:', path, result)
PY
```

A decisive trace message to look for is `failed_conditions` or a condition result explaining why a branch was false.

## YAML validation and safe edit pattern

Back up first:

```sh
docker exec homeassistant sh -c 'cp /config/automations.yaml /config/automations.yaml.bak.$(date +%Y%m%d-%H%M%S)'
```

Validate syntax with PyYAML if available:

```sh
docker exec homeassistant python3 - <<'PY'
import yaml
with open('/config/automations.yaml', 'r') as f:
    yaml.safe_load(f)
print('automations.yaml: YAML parse OK')
PY
```

Then use Home Assistant's configuration check/reload path when available:

```sh
docker exec homeassistant ha core check  # only if the ha CLI exists in this install
docker exec homeassistant ha automation reload  # preferred when available
```

If the container does not include the `ha` CLI, use the Home Assistant UI: Developer Tools -> YAML -> Check configuration, then reload automations. Restart Home Assistant only when reload is unavailable or the integration requires it.

## Known failure pattern: numeric_state on light brightness while off

Home Assistant `numeric_state` conditions require a numeric state/attribute. For lights that are `off`, the `brightness` attribute can be `None`/missing. A condition like this fails when the light is off:

```yaml
condition:
  - condition: numeric_state
    entity_id: light.all_lights
    attribute: brightness
    below: 220
```

Trace symptom:

```text
failed_conditions: value 'None' is non-numeric and treated as False
```

Safe fix: allow the light group to be off, or below the threshold when brightness is numeric:

```yaml
condition:
  - condition: or
    conditions:
      - condition: state
        entity_id: light.all_lights
        state: "off"
      - condition: numeric_state
        entity_id: light.all_lights
        attribute: brightness
        below: 220
```

Case note: for the `Bright Lights at Evening` automation, the 7pm trigger existed, logs and recorder did not show a YAML syntax failure, and saved traces showed the brightness condition failed because `light.all_lights` was off and its `brightness` attribute was `None`. The repair was the OR condition above, followed by backup, YAML parse validation, and automation reload/restart as needed.

## Repair checklist

- Evidence collected: trigger schedule, trace result, relevant recorder rows, logs, entity states/attributes.
- Root cause stated before editing.
- Backup made inside `/config` or equivalent.
- YAML parse/config validation passed.
- Automations reloaded or Home Assistant restarted if necessary.
- Post-fix trace/log/state evidence confirms expected behavior.
