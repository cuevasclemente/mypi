---
name: home-assistant-dashboard-sensor-alerts
description: Build and safely modify Home Assistant dashboards and sensor-driven alert automations for environmental/climate devices, including Lovelace storage dashboards, entity discovery, numeric/offline-safe template guards, occupancy-aware thresholds, cooldowns, notification actions, reload validation, and secret-safe handling of Home Assistant config.
---

# Home Assistant Dashboard Sensor Alerts

Use this skill when Clemente asks to turn Home Assistant sensor data into a usable dashboard and practical alerts, especially for indoor climate, air-quality, particulate, temperature, humidity, CO2, VOC/NOx, or other environmental sensors.

This complements:

- `home-assistant-environment-sensor-research` for choosing sensors.
- `home-assistant-automation-troubleshooting` for diagnosing broken existing automations.

This skill is for **implementation and modification** of dashboards and new sensor automations.

## Setup

Typical Clemente paths and context:

- Home Assistant config: `~/src/server-lattice/home-assistant/home-assistant-config/`
- Automations: `~/src/server-lattice/home-assistant/home-assistant-config/automations.yaml`
- Lovelace storage dashboards: `~/src/server-lattice/home-assistant/home-assistant-config/.storage/lovelace*`
- Reload helper: `~/src/server-lattice/home-assistant/ha-reload-automations.sh`
- Home Assistant container: usually `homeassistant`

Safety boundaries:

- Do **not** read or print secrets: `secrets.yaml`, `.env`, `.storage/auth*`, `.storage/core.config_entries`, tokens, cookies, passwords, webhook IDs, private keys, or credential docs.
- It is OK to inspect `.storage/core.entity_registry` and `.storage/core.device_registry` for non-secret entity names, disabled flags, units, and device metadata.
- Prefer repository/config-file edits plus Home Assistant reloads. Restart Home Assistant only when needed and authorized.
- Storage files may be root-owned. Prefer `docker exec homeassistant ...` for `/config` writes when the host path is mounted into the container; otherwise use the `sudo-command-execution` skill and top-level `sudo` with user approval.
- Environmental sensors are not certified life-safety devices unless explicitly certified. Do not present hobbyist air/climate alerts as replacements for smoke, CO, or fire alarms.

## Workflow

### 1. Clarify the operational goal

Separate dashboard goals from alert goals:

- Dashboard: what signals should be visible, grouped, and graphed?
- Alerts: what should notify, whom, at what urgency, and under what occupancy state?
- Sensor robustness: can the sensor be unplugged/offline/unavailable, and should that suppress alerts?
- False positives: cooking, cleaning, candles, HVAC, open windows, and sensor warm-up can look like environmental events.

For fire-like or pollution alerts, explicitly separate:

- **Extreme particle level**: urgent regardless of occupancy.
- **High particles while away**: lower threshold because nobody is present to explain cooking/smoke.
- **High particles while occupied**: notice-level, often cooking/ventilation.
- **Temperature anomaly**: high absolute temperature or a valid large jump, kept separate from particle alerts.

### 2. Discover entities without secrets

Use MemPalace/wiki if helpful for known device names, then inspect Home Assistant metadata.

Example safe entity discovery:

```bash
python3 - <<'PY'
import json
from pathlib import Path
base = Path('/home/clemente/src/server-lattice/home-assistant/home-assistant-config/.storage')
for fn in ['core.entity_registry', 'core.device_registry']:
    obj = json.loads((base / fn).read_text())
    print('\n==', fn, '==')
    key = 'entities' if fn.endswith('entity_registry') else 'devices'
    for item in obj.get('data', {}).get(key, []):
        blob = json.dumps(item).lower()
        if 'apollo_air_1' in blob or 'air-1' in blob or '3e4ce4' in blob:
            if key == 'entities':
                print(item.get('entity_id'), '| name:', item.get('name') or item.get('original_name'), '| unit:', item.get('unit_of_measurement'), '| disabled:', item.get('disabled_by'))
            else:
                print(item.get('id'), '| name:', item.get('name_by_user') or item.get('name'), '| model:', item.get('model'))
PY
```

Record:

- Online/availability entity, if present.
- Primary readings: temperature, humidity, CO2, PM1/PM2.5/PM10, AQI, pressure, VOC/NOx, gas readings.
- Diagnostics and controls to show but not misuse: RSSI, uptime, firmware, clean sensor button, prevent sleep switch, offsets.
- Disabled or risky controls to exclude from dashboards: factory reset, unsafe calibration buttons, destructive actions.

### 3. Modify dashboards safely

Lovelace storage dashboards live under `.storage`, often as JSON files such as `lovelace.air_quality` plus a sidebar registry `lovelace_dashboards`.

Before editing:

```bash
cd ~/src/server-lattice/home-assistant/home-assistant-config/.storage
ts=$(date +%Y%m%d-%H%M%S)
cp lovelace.air_quality "lovelace.air_quality.bak.$ts"
cp lovelace_dashboards "lovelace_dashboards.bak.$ts"
```

If files are root-owned through the container mount, write via `docker exec -i homeassistant python3` and `/config/.storage/...` rather than trying to overwrite as the host user.

Dashboard design pattern:

- Markdown card explaining scope and life-safety caveat.
- Glance card for current snapshot plus online state.
- Gauge cards for the most actionable readings.
- History graphs by category:
  - climate: temperature, humidity, CO2, pressure;
  - particles: PM1/PM2.5/PM10/AQI;
  - chemistry/gases: VOC, NOx, gas readings.
- Entities card for all environment readings.
- Separate diagnostics/settings card for RSSI, IP, firmware, uptime, offsets, sleep, clean-sensor button, lights.

Example sidebar update:

```python
for item in dashboards['data']['items']:
    if item.get('id') == 'air_quality':
        item['url_path'] = 'climate'
        item['icon'] = 'mdi:home-thermometer-outline'
        item['title'] = 'Climate'
```

After dashboard storage edits, validate JSON by loading it and confirm the title/sidebar entry. A browser refresh may be enough; a Home Assistant restart may be required for some storage changes, so report that separately if not performed.

### 4. Design robust sensor alert automations

For every sensor-driven alert, include:

- A trigger with `for:` duration to avoid one-sample spikes.
- Online/availability condition, e.g. `binary_sensor.<device>_online == 'on'`.
- Numeric template guards using `| float(none)` so `unknown`, `unavailable`, and unplugged sensors do not alert.
- Occupancy conditions when needed, e.g. `binary_sensor.home_is_occupied`.
- Cooldown using `this.attributes.last_triggered` to prevent spam.
- A clear notification message with current sensor readings and a caveat about possible cooking/ventilation causes.

Example offline-safe numeric condition:

```yaml
- condition: template
  alias: Sensor readings are numeric and currently above threshold
  value_template: >-
    {% set pm25 = states('sensor.apollo_air_1_3e4ce4_pm_2_5mm_weight_concentration') | float(none) %}
    {% set pm1 = states('sensor.apollo_air_1_3e4ce4_pm_1mm_weight_concentration') | float(none) %}
    {% set aqi = states('sensor.apollo_air_1_3e4ce4_nowcast_aqi') | float(none) %}
    {{ (pm25 is number and pm25 > 75) or (pm1 is number and pm1 > 75) or (aqi is number and aqi > 150) }}
```

Example cooldown condition:

```yaml
- condition: template
  alias: Cooldown between alerts
  value_template: >-
    {{ this.attributes.last_triggered is none or (now() - this.attributes.last_triggered).total_seconds() > 3600 }}
```

Example temperature-jump guard:

```yaml
- condition: template
  alias: Temperature is high or made a large valid jump
  value_template: >-
    {% set current = states('sensor.apollo_air_1_3e4ce4_sen55_temperature') | float(none) %}
    {% if current is not number %}
      false
    {% elif trigger.id == 'high_temp' %}
      {{ current > 95 }}
    {% elif trigger.id == 'rapid_temp_jump' %}
      {% set before = trigger.from_state.state | float(none) if trigger.from_state is not none else none %}
      {% set after = trigger.to_state.state | float(none) if trigger.to_state is not none else none %}
      {{ before is number and after is number and after >= 80 and (after - before) >= 7 }}
    {% else %}
      false
    {% endif %}
```

### 5. Apply automation changes

When appending to root-owned `automations.yaml` via container, remember `docker exec -i` if piping content into the container:

```bash
docker exec homeassistant sh -c 'cp /config/automations.yaml /config/automations.yaml.bak.$(date +%Y%m%d-%H%M%S)'
docker exec -i homeassistant sh -c 'cat >> /config/automations.yaml' <<'YAML'
# automation entries here
YAML
```

If you forget `-i`, the append may silently write nothing while later validation still succeeds. Confirm aliases/counts after writing.

### 6. Validate and reload

Validate YAML locally and in the container:

```bash
python3 - <<'PY'
import yaml, pathlib
p = pathlib.Path('/home/clemente/src/server-lattice/home-assistant/home-assistant-config/automations.yaml')
obj = yaml.safe_load(p.read_text())
print('local YAML OK:', type(obj).__name__, len(obj))
for alias in ['Climate alert - extreme particles', 'Climate alert - high particles while away']:
    print(alias, sum(1 for x in obj if isinstance(x, dict) and x.get('alias') == alias))
PY

docker exec homeassistant python3 - <<'PY'
import yaml
with open('/config/automations.yaml') as f:
    obj = yaml.safe_load(f)
print('container YAML OK:', type(obj).__name__, len(obj))
PY
```

Reload automations:

```bash
~/src/server-lattice/home-assistant/ha-reload-automations.sh
```

Then inspect logs for non-secret errors:

```bash
docker logs --since '3m' homeassistant 2>&1 \
  | grep -iE 'automation|yaml|template|invalid|error|warning|climate alert|climate notice' \
  | tail -120 || true
```

If `ha core check` is unavailable in the container, report that and rely on YAML parse, reload success, and log inspection.

## Example alert tiers

For an Apollo AIR-1 style sensor, a conservative first pass:

- Extreme particles: PM2.5 > 250 for 5 min, PM1 > 150 for 5 min, or AQI > 300 for 5 min. Urgent regardless of occupancy.
- High particles while away: PM2.5/PM1 > 75 for 10 min or AQI > 150 for 10 min, only when `home_is_occupied` is `off`.
- High particles while occupied: PM2.5 > 150 for 15 min, PM1 > 100 for 15 min, or AQI > 200 for 15 min, notice-level and cooking-aware.
- Temperature anomaly: temperature > 95°F for 5 min or valid single update jump >= 7°F to at least 80°F.

Tune thresholds after reviewing real history; do not overfit on one event.

## Validation checklist

- [ ] Relevant skill(s) loaded and scope clarified.
- [ ] No secret-bearing files read or printed.
- [ ] Entity registry inspected only for non-secret metadata.
- [ ] Backups made before dashboard/automation edits.
- [ ] Dashboard JSON loads and sidebar entry is correct.
- [ ] Automations have online-state and numeric guards for unavailable/offline sensors.
- [ ] Occupied vs away behavior is intentionally different.
- [ ] Cooldowns are present to prevent notification spam.
- [ ] YAML parses locally and in the container.
- [ ] Automations reloaded successfully.
- [ ] Logs show no new YAML/template automation errors.
- [ ] Final report mentions whether dashboard storage changes may need browser refresh or HA restart.

## Source-session techniques

The source session:

- Used MemPalace to recover Home Assistant/Apollo AIR-1 context and entity names.
- Inspected Lovelace storage and entity/device registries without reading secret storage files.
- Backed up root-owned dashboard files and used `docker exec` when host writes hit permission errors.
- Renamed an air-quality dashboard to a broader Climate dashboard and grouped all exposed sensor signals.
- Added four alert automations with distinct urgency tiers, occupancy-aware particle thresholds, offline sensor guards, numeric template checks, and cooldowns.
- Validated with PyYAML, Home Assistant automation reload, and log grep.
