---
name: local-air-quality-wildfire-smoke
description: Assess local wildfire-smoke and air-quality questions for Clemente by checking official advisories, AQI/PM2.5 sensors, fire/smoke context, sensor limitations, and outdoor-exercise decision rules while minimizing exposure of precise location data.
---

# Local Air Quality and Wildfire Smoke

Use this skill when Clemente asks whether smoky smells, nearby fires, air-quality advisories, or outdoor activity plans are safe enough to proceed.

## Setup

- Prefer public, current sources: local air district, NWS alerts, AirNow/Fire and Smoke Map, EPA/NOAA smoke products, nearby official monitors, and reputable local emergency/fire incident pages.
- Use Memoriki location context only as much as needed, and avoid repeating precise home/work addresses in the final answer.
- Do not treat any single low-cost sensor as definitive. Compare nearby monitors, official PM2.5 values, wind/smoke plume context, and the user's direct smell/irritation report.
- This is health guidance, not medical care. Escalate to clinician guidance for asthma, COPD, pregnancy, heart/lung disease, or severe symptoms.

## Workflow

1. **Clarify location and activity**
   - Determine the relevant city/neighborhood or park-level area without exposing exact address.
   - Ask or infer whether the activity is light, moderate, or vigorous; vigorous exercise makes moderate smoke exposure more consequential.
   - Note personal risk factors only if Clemente volunteers them.

2. **Check official advisories first**
   - Look for NWS `Air Quality Alert`, local air district smoke advisories, and emergency-management notices.
   - Capture effective time window, affected regions, pollutant if stated, and recommended precautions.
   - Treat an active advisory as meaningful even if current AQI looks only Good/Moderate.

3. **Cross-check live measurements**
   - Compare several nearby PM2.5/AQI monitors rather than one sensor.
   - Note monitor distance, representativeness, and whether wind/fire plume location could make conditions patchy.
   - If smell or visible haze conflicts with low AQI, explain that sensors can miss localized plumes, rapid changes, or non-PM irritants, but PM2.5 is still the main wildfire-health metric.

4. **Assess fire/smoke context**
   - Check nearby fire incidents, smoke plume direction, wind, and forecast changes.
   - Separate “near a fire” from “in the smoke plume right now.”
   - Re-check if conditions are changing quickly or the user asks whether the situation materially changed.

5. **Give an action-oriented decision rule**
   - For outdoor exercise: go only if no smoke smell, no visible haze/ash, AQI/PM2.5 is acceptable, and the user feels normal.
   - Bail early if smell returns, eyes/throat/lungs feel irritated, visible ash/haze appears, or AQI crosses into Unhealthy for Sensitive Groups or worse.
   - Recommend lower intensity, shorter exposure, indoor alternatives, and keeping windows closed/filtration on when smoke is noticeable.

## Examples

### Tennis or vigorous outdoor activity

> There is an active smoke advisory for the broader valley, but monitors near the park are currently Good/Moderate and you no longer smell smoke. Going is reasonable if you treat it as “monitor and bail”: keep intensity moderate, stop if smell/irritation returns, and skip if AQI reaches 100+ or visible haze/ash appears.

### Smell but normal AQI

> A normal AQI does not prove there is no smoke at your exact location. It may mean the plume is patchy, transient, not near the monitor, or below thresholds. Your nose/irritation matters; if you smell smoke indoors or outdoors, reduce ventilation/exertion even before monitors catch up.

## Validation Checklist

- [ ] Checked official advisories, not just consumer AQI.
- [ ] Compared more than one nearby PM2.5/AQI source where possible.
- [ ] Accounted for smoke smell, haze/ash, wind/plume context, and activity intensity.
- [ ] Avoided exposing precise addresses unnecessarily.
- [ ] Gave a practical go/skip/bail decision rule and medical-safety caveat.
