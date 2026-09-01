---
name: local-transit-trip-planning
description: Plan privacy-aware local transit trips for Clemente using Memoriki home/location context, public schedules/GTFS/live arrivals, route timing comparisons, and pragmatic wait-time rules without exposing precise addresses unnecessarily.
---

# Local Transit Trip Planning

Use this skill when Clemente asks for public-transit routing, local bus/rail comparisons, arrival timing, or pragmatic route choice rules for trips from home or other familiar local context.

## Setup

- Use Memoriki for remembered location context, preferences, and prior trip notes.
- Do **not** expose Clemente’s exact home address in responses unless he explicitly asks.
- Prefer public/open sources:
  - Agency trip planners
  - GTFS static schedules
  - GTFS-realtime or agency live-arrival text endpoints
  - Official route PDFs/maps
- For LA-area analysis, temporary GTFS work can live under `/tmp/la_gtfs`.
- Keep downloaded schedule data out of repos unless the user asks to preserve it.

## Privacy / Security Rules

- Never print exact home address values from Memoriki.
- Convert home context into a coarse origin such as:
  - “your home-area stop”
  - “nearest northbound/southbound stop”
  - “the stop near home”
- If using coordinates, round or avoid showing them.
- Do not read secrets, `.env`, API keys, or credential files.
- Public transit APIs usually do not need secrets; if an API key is required, ask the user to provide it via environment variable.

## Workflow

### 1. Clarify the trip

Ask or infer:

- Origin: home, current location, or named place.
- Destination: neighborhood, venue, station, or exact address if provided by user.
- Desired arrival/departure time.
- Constraints:
  - fastest
  - fewest transfers
  - least walking
  - most reliable
  - avoiding rail/bus
  - late-night safety
  - bike/scooter compatibility

### 2. Load local context

If the origin/destination depends on remembered personal context:

- Use Memoriki.
- Find only enough context to identify likely nearby stops or neighborhoods.
- Do not quote precise address values.

### 3. Identify candidate routes

Build a shortlist from:

- Nearby frequent bus lines.
- Rail options.
- Transfers that are actually worth it.
- Known local patterns from prior analysis.

For Clemente’s home-area Pasadena/South Pasadena/DTLA-style trips, compare:

- Direct or near-direct bus options.
- Frequency and real-time arrival reliability.
- Rail detours only if they save meaningful time or improve reliability.
- Avoid rail detours that add walking/transfer time without improving total trip time.

### 4. Use GTFS for scheduled timing

Download or reuse agency GTFS data in `/tmp/la_gtfs`.

Example static GTFS segment timing script:

```python
#!/usr/bin/env python3
from pathlib import Path
import csv
from collections import defaultdict
from datetime import timedelta

GTFS = Path("/tmp/la_gtfs")

ROUTE_SHORT_NAMES = {"487", "78"}  # edit per trip
FROM_STOP_IDS = {"HOME_AREA_STOP_ID"}  # coarse/internal only; don't print exact address
TO_STOP_IDS = {"DEST_AREA_STOP_ID"}

def read_csv(name):
    with open(GTFS / name, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))

def parse_time(t):
    # GTFS times may exceed 24:00:00
    h, m, s = map(int, t.split(":"))
    return timedelta(hours=h, minutes=m, seconds=s)

routes = read_csv("routes.txt")
trips = read_csv("trips.txt")
stop_times = read_csv("stop_times.txt")

route_ids = {
    r["route_id"]
    for r in routes
    if r.get("route_short_name") in ROUTE_SHORT_NAMES
}

trip_route = {
    t["trip_id"]: t["route_id"]
    for t in trips
    if t["route_id"] in route_ids
}

by_trip = defaultdict(list)
for st in stop_times:
    tid = st["trip_id"]
    if tid in trip_route:
        by_trip[tid].append(st)

segments = []

for tid, rows in by_trip.items():
    rows.sort(key=lambda r: int(r["stop_sequence"]))
    from_rows = [r for r in rows if r["stop_id"] in FROM_STOP_IDS]
    to_rows = [r for r in rows if r["stop_id"] in TO_STOP_IDS]

    for a in from_rows:
        for b in to_rows:
            if int(a["stop_sequence"]) < int(b["stop_sequence"]):
                dep = parse_time(a["departure_time"])
                arr = parse_time(b["arrival_time"])
                segments.append({
                    "route_id": trip_route[tid],
                    "trip_id": tid,
                    "from_stop": a["stop_id"],
                    "to_stop": b["stop_id"],
                    "dep": a["departure_time"],
                    "arr": b["arrival_time"],
                    "ride_min": round((arr - dep).total_seconds() / 60, 1),
                })

for s in sorted(segments, key=lambda x: (x["ride_min"], x["dep"]))[:30]:
    print(s)
```

Use this to compare in-vehicle time between candidate lines and segments.

### 5. Estimate wait-time pragmatically

Do not choose solely by scheduled in-vehicle time. Compare:

```text
expected_total_time =
  walk_to_stop
+ expected_wait
+ in_vehicle_time
+ transfer_penalty
+ walk_from_stop
```

Rules of thumb:

- If a faster but infrequent bus is arriving very soon, take it.
- If the faster bus is not arriving soon, prefer the more frequent line.
- For lines with similar ride time, choose higher frequency and simpler boarding.
- Add a transfer penalty of at least 5–10 minutes even when schedules look aligned.
- For rail detours, include walk time, platform time, and transfer risk.

Example pragmatic rule:

```text
If Route 487 is arriving within about 5–8 minutes, it may be fastest.
Otherwise, Route 78’s better frequency may win despite slower in-vehicle timing.
For DTLA, do not detour through South Pasadena A Line unless live timing clearly beats the direct/frequent bus path.
```

### 6. Probe live arrivals

Use official live-arrival endpoints when available. Avoid credentials.

Generic text/JSON probe pattern:

```python
#!/usr/bin/env python3
import os
import re
import requests

# Set this from an official agency stop page or documented endpoint.
# Do not include home address or private coordinates in the URL.
PREDICTION_URL = os.environ["TRANSIT_PREDICTION_URL"]

r = requests.get(PREDICTION_URL, timeout=10)
r.raise_for_status()

text = r.text.strip()
print(text[:2000])

# Extract rough minute predictions from plain-text endpoints.
mins = [int(x) for x in re.findall(r"\b(\d+)\s*min", text, flags=re.I)]
if mins:
    print("Next arrivals, minutes:", sorted(mins)[:5])
else:
    print("No minute predictions parsed; inspect endpoint format.")
```

Shell probe:

```bash
TRANSIT_PREDICTION_URL='https://example-agency.invalid/predictions?stop=STOP_ID' \
python3 live_probe.py
```

For Pasadena-style real-time text endpoints:

- Use the official stop/route page to copy the prediction URL.
- Query by public stop ID, not by home address.
- Report only route/arrival implications, not sensitive origin details.

### 7. Produce the recommendation

Final answer should include:

- Best route now.
- Backup route.
- When to switch between them.
- Expected ride/wait tradeoff.
- Any caveats about live data freshness.
- A privacy-preserving origin description.

Good format:

```text
From your home-area stop:

Best if leaving now:
- Take [route] if the next arrival is within ~N minutes.
- Ride to [destination stop/area].
- Expected ride time: ~X minutes, plus walk/wait.

Fallback:
- If [route] is not imminent, take [more frequent route].
- It is slightly slower in-vehicle but usually wins once wait time is included.

Avoid:
- [detour option], unless live arrivals show it saves at least ~10 minutes.
```

## Validation

Before giving a confident recommendation:

- Confirm route names and stop IDs from GTFS or official sources.
- Compare at least two candidate paths when plausible.
- Include live arrivals if the user asks “right now” or “soon.”
- Check that total time includes walking/waiting, not just in-vehicle time.
- State uncertainty if GTFS/live feeds are stale or incomplete.
- Do not reveal exact home address or precise coordinates.

## Examples

### Example: South Pasadena trip

```text
Use the faster express/local route only if it is arriving soon.
If not, use the more frequent local route because reduced wait time dominates.
Avoid backtracking to rail unless live arrivals make the connection clearly favorable.
```

### Example: DTLA trip

```text
For DTLA, prefer the direct/frequent bus path unless the A Line option is already nearby and has a short wait.
The South Pasadena A Line detour is usually not worth it once walking, platform wait, and transfer time are counted.
```

### Example: live-departure answer

```text
I checked public arrival data for the relevant nearby stop. If Route 487 appears within ~5–8 minutes, take it. Otherwise, Route 78 is the pragmatic choice because it runs more often and the expected wait is lower.
```
