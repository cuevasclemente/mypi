---
name: bicycle-tire-fitment-research
description: Research bicycle tire and wheel fitment for Clemente's bikes by identifying exact model/year, verifying manufacturer clearance and rim constraints, reading sidewall/photo evidence cautiously, matching tire width/tread/tubeless choices to route terrain and load, and recording confirmed bike setup details in Memoriki without inventing specs.
---

# Bicycle Tire Fitment Research

Use this skill when Clemente asks what tire sizes fit a bike, what tires to use for a route, whether a 700c/650b or tubeless setup makes sense, or what current tire/wheel specs are visible from photos or past bike records.

## Setup

- Check Memoriki first for Clemente's bike inventory, prior photos, and known setup notes:
  - `~/src/memoriki/memoriki/wiki/entities/clemente-profile.md`
  - bike entity pages such as `~/src/memoriki/memoriki/wiki/entities/cannondale-topstone.md` when present
  - MemPalace drawers under `bikes/*` when available
- For any named bike, wheel, rim, or tire, verify numeric specs from authoritative/current sources before quoting them:
  - manufacturer bike archive/current model page
  - owner manual or frame supplement
  - wheel/rim manufacturer tire-width chart
  - tire manufacturer size/ETRTO table
- Use ExaSearch/MCP for current public documentation. Do not invent tire clearance, rim internal width, weights, or prices.
- Do not read unrelated personal photo archives or conversation exports unless the prompt or existing project context authorizes it. If images are provided, inspect only the provided files.

## Workflow

### 1. Identify the exact bike and constraints

Ask or infer only what is needed:

- Bike model, generation/year, frame material, frame size if clearance varies.
- Wheel size currently installed: usually 700c/622, sometimes 650b/584.
- Current tire sidewall marking: e.g. `700x32C`, `40-622`, `650x47B`, etc.
- Brake/fork/frame/fender/rack constraints.
- Intended use: fast road, commuting, loaded touring, bikepacking, gravel, mixed pavement, bad shoulders, wet weather.
- Whether the user wants maximum clearance or a conservative no-rub setup.

If Clemente says “my Topstone” but Memoriki says it was sold or uncertain, acknowledge the mismatch and proceed with assumptions clearly labeled.

### 2. Verify frame tire clearance

Find the official max tire clearance for the exact model/generation.

Record uncertainty explicitly:

- `official max 700c tire clearance: ...`
- `official max 650b tire clearance: ...`
- whether the number assumes no fenders
- whether it is measured tire width, not nominal sidewall width
- whether older and newer generations differ

When sources conflict, prefer manufacturer/owner-manual data and say which number is conservative.

### 3. Check rim and tire compatibility

Do not treat frame clearance as the only limit.

- Determine rim internal width if possible.
- Use ISO/ETRTO thinking: bead seat diameter (`622` for 700c, `584` for 650b) and measured tire width.
- Check whether the rim supports the proposed tire width and tubeless if relevant.
- Note that nominal sizes vary by casing and rim; a `40 mm` tire can measure wider or narrower.
- Leave extra clearance for mud, wheel flex, out-of-true wheels, fenders, and loaded bikepacking.

Practical conservative margin:

- For clean pavement/all-road: avoid riding right at stated max.
- For fenders/mud: leave substantially more space; do not recommend max-clearance tires.
- For loaded touring: prioritize stability, puncture resistance, and comfort over squeezing the biggest possible tire.

### 4. Match tire choice to route terrain

Describe terrain first, then recommend size and tread.

Common patterns:

- **Paved coastal/PCH-style touring:** mostly pavement/highway shoulders, beach paths, debris, rough pavement, wind, traffic, rolling/hilly sections. Recommend slick or file-tread all-road tires, not aggressive gravel knobs.
- **Loaded pavement/light rough shoulders:** 700x38-42 is often a good target if the frame/rims allow it.
- **Fast road/unloaded:** 700x32-38 can make sense, with less comfort margin.
- **Mixed gravel/fire roads:** consider 700x40-45 or 650b x 47+ if verified compatible.
- **Mud/fenders:** reduce width below max and avoid tight knobs.

Example recommendation pattern from the Topstone source session:

> For a Pacific Coast Bicycle Route / PCH-style trip, assume mostly paved roads and shoulders with rough patches and debris. On a Topstone, a good default is 700x38-40; if loaded or comfort-first, 700x40-42. Use a slick/file-tread all-road tire with good puncture protection; full knobbies are unnecessary unless the route changes to real gravel.

### 5. Read photos and sidewalls cautiously

If the user provides a tire photo:

1. Zoom/read sidewall markings and state exactly what is visible.
2. Prefer ETRTO markings (`32-622`) over marketing names.
3. If only a brand/model is visible, do not infer width unless visible elsewhere.
4. If using image evidence, label confidence:
   - `confirmed from sidewall photo`
   - `likely from visible marking`
   - `user-reported, not photo-confirmed`
5. Do not overclaim from tread appearance or old photo metadata.

### 6. Update Memoriki when durable bike setup is confirmed

When Clemente confirms a durable fact about a bike, record it:

- Bike entity page in `~/src/memoriki/memoriki/wiki/entities/`
- MemPalace drawer such as `bikes/topstone-wheel-tire`
- Include source and uncertainty. Example:
  - `Current tire: Continental Gatorskin, probably 700x32 / 32 mm — user-reported, not photo-confirmed.`

Do not record transient shopping ideas as facts. If the bike status conflicts with existing memory, note the contradiction and ask if needed.

## Output Patterns

### Fitment answer

Use a compact table when multiple sizes are possible:

| Size | Fit confidence | Best for | Caveats |
|---|---|---|---|
| 700x32-35 | high if current wheels are 700c | fast road/unloaded | less comfort for debris/loaded touring |
| 700x38-40 | usually conservative once clearance verified | all-road/coastal touring | check fenders/rim width |
| 700x40-42 | route comfort/load | loaded bikepacking | avoid if older frame max/fenders make clearance tight |
| 650b x 47+ | only if wheel swap verified | rougher gravel/comfort | requires compatible 650b wheels, brakes, and clearance |

### Recommendation ending

End with:

- **My pick for you:** one size/tread category.
- **Why:** terrain/load/comfort reasoning.
- **Verify before buying:** exact frame generation, current rim internal width, fenders, sidewall/ETRTO marking.
- **What would change the answer:** heavier load, real gravel, fenders, wet mud, racing/road-only priorities.

## Validation Checklist

- [ ] Exact bike model/year/generation identified or assumptions labeled.
- [ ] Official frame clearance verified; no invented max tire sizes.
- [ ] Wheel/rim compatibility considered, not just frame clearance.
- [ ] Route terrain and load drive the recommendation.
- [ ] 700c vs 650b and ISO/ETRTO terminology explained when relevant.
- [ ] Photo/sidewall evidence confidence is labeled.
- [ ] Durable bike setup facts recorded in Memoriki with uncertainty if confirmed.

## Source-session techniques

- Loaded the existing bikepacking skill because the tire question was route/gear adjacent.
- Searched Memoriki for existing Topstone/fleet context before answering.
- Verified Pacific Coast Bicycle Route terrain from Adventure Cycling / Caltrans / Oregon DOT-style sources rather than assuming it was gravel.
- Warned against confusing the Pacific Coast Bicycle Route with the Pacific Crest Trail.
- Recommended 700x38-40 as a paved/coastal default and 700x40-42 for loaded comfort when compatible.
- Updated Memoriki and MemPalace after Clemente confirmed the likely current tire as Continental Gatorskin, probably 700x32 / 32 mm, while labeling the width as user-reported rather than photo-confirmed.
