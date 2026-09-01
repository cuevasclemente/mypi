---
name: home-assistant-environment-sensor-research
description: Research and recommend Home Assistant-compatible indoor environment sensors and air-quality monitors by verifying current device specs/integration support, matching CO2/PM/VOC/temp/humidity/radon needs to room and automation goals, preferring local/private protocols such as Zigbee, BLE, or ESPHome, and explaining sensor limitations and safety caveats without inventing product details.
---

# Home Assistant Environment Sensor Research

Use this skill when Clemente asks for indoor air-quality, temperature, humidity, CO2, VOC, particulate, radon, or general environmental monitors that should work with Home Assistant.

## Setup

- Check Memoriki/MemPalace for current smart-home context and preferences:
  - Home Assistant + Zigbee2MQTT on The-Sceptre.
  - Preference for local-first, privacy-preserving devices over cloud-required apps.
  - Budget/value matters, especially for purely informational sensors.
- Use current sources before naming products:
  - Manufacturer product pages for sensor package, price, and variants.
  - Home Assistant integration docs for official support.
  - Zigbee2MQTT device pages for Zigbee devices and exposed entities.
  - ESPHome/project docs for local Wi-Fi devices.
- Do not read Home Assistant secrets/tokens or device credentials.

## Workflow

### 1. Clarify the monitoring goal

Ask or infer which signals matter:

- **CO2**: ventilation/stale-room signal; useful for bedroom, office, crowded living spaces.
- **PM1/PM2.5/PM10**: smoke, wildfire leakage, cooking, dust, candles/incense.
- **Temperature/humidity**: comfort, HVAC/dehumidifier automation, mold risk.
- **VOC/NOx/gas-index sensors**: relative air-chemistry hints; often noisy and less actionable.
- **Radon**: specialized long-term safety monitoring.
- **Display vs hidden sensor**, battery vs mains, and room count.

Separate “health/ventilation truth” from “cheap distributed automation sensors.”

### 2. Verify Home Assistant compatibility

For each candidate, verify the path to HA:

- **Zigbee**: find the exact model on Zigbee2MQTT and note exposed entities.
- **ESPHome/local Wi-Fi**: confirm native ESPHome/local API and whether cloud is optional.
- **BLE**: check HA integration requirements and Bluetooth proxy needs.
- **Cloud integration**: note privacy and reliability tradeoffs.

Do not assume a device works because it has an app or uses a common radio.

### 3. Compare sensor packages, not brand names

Build recommendations around what the device actually measures:

- CO2 sensors are the differentiator for ventilation; multiple non-CO2 devices do not substitute for one good CO2 monitor.
- PM sensors are best for particle events, not gases.
- VOC/gas indices are relative and may respond to cooking, cleaning products, alcohol vapors, or solvents.
- Temperature sensors inside warm ESP32 enclosures may need offsets; note manufacturer caveats.

### 4. Handle safety claims carefully

- A hobbyist/environment monitor is **not** a certified CO alarm, smoke alarm, combustible-gas detector, or life-safety device unless the manufacturer and certification explicitly say so.
- Gas sensors such as MiCS-style options can be interesting for graphs but are not replacements for real safety detectors.
- Recommend certified alarms separately for CO/smoke/natural gas safety.

### 5. Match recommendations to Clemente’s likely use cases

Useful patterns:

- **Best single “air-quality truth” sensor**: prioritize CO2 + PM + temp/humidity + local HA support.
- **Best budget distributed sensing**: cheaper Zigbee temp/humidity/PM devices in multiple rooms, accepting no CO2.
- **Best practical hybrid**: one richer CO2/PM monitor in bedroom/office plus cheaper sensors elsewhere.
- **Budget-sensitive informational use**: avoid expensive all-in-one devices unless CO2 or radon meaningfully changes behavior.

### 6. Produce a decisive answer

Include:

- Recommended device/category and why.
- Alternatives by budget and protocol.
- Exact verified measurements and HA integration path.
- What is missing from each option.
- Caveats about availability, variants, and safety limitations.

## Example output structure

```markdown
Recommendation: one local CO2+PM monitor in the bedroom/office, then cheaper Zigbee temp/humidity sensors elsewhere.

| Option | HA path | Measures | Best for | Caveats |
|---|---|---|---|---|
| Apollo AIR-1 w/ CO2 | ESPHome/local | PM, CO2 variant, VOC/NOx, temp/humidity | budget local all-in-one | temp offset; gas sensor not safety-rated |
| AirGradient ONE | local/open integration | CO2, PM, TVOC/NOx, temp/humidity | richer air-quality insight | pricier |
| Zigbee temp/RH monitor | Zigbee2MQTT | temp/humidity | room comfort coverage | no CO2/PM |
```

## Validation checklist

- [ ] Requirements and budget/room-count constraints are clear.
- [ ] Each named SKU/model is verified with a current authoritative source.
- [ ] HA integration path is explicit and not guessed.
- [ ] Sensor measurements and missing signals are stated.
- [ ] CO2, PM, VOC/gas, temp, humidity, and radon are not conflated.
- [ ] Life-safety caveats are explicit.
- [ ] Privacy/cloud requirements are surfaced.
- [ ] No invented prices/specs/availability.

## Source-session techniques

- Used the privacy-aware product-research workflow before recommending devices.
- Searched Memoriki for Clemente’s Home Assistant/Zigbee setup.
- Verified Apollo AIR-1 variants and sensor caveats from the manufacturer page.
- Checked Home Assistant/Airthings/Aranet and Zigbee2MQTT pages for integration support.
- Compared AirGradient-style CO2+PM monitoring against cheaper distributed Zigbee/PM/temp sensors.
