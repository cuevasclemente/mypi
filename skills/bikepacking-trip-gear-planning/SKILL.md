---
name: bikepacking-trip-gear-planning
description: Plan Clemente's bikepacking trips and gear choices with verified product specs, route-aware food storage/safety guidance, pack-system tradeoffs, stove/tea-kit selection, and receipt/spend allocation without inventing SKU details.
---

# Bikepacking Trip Gear Planning

## Setup
- Use this when Clemente asks about bikepacking gear, packing systems, route logistics, outdoor food storage, or post-purchase receipt validation.
- For named products/SKUs, follow the global named-reference rule: verify current specs from official manufacturer pages or reputable retailers before quoting weights, dimensions, volumes, prices, or materials.
- Use ExaSearch/MCP for current product and route information when needed. Do not rely on memory for numeric specs.
- If a receipt or attachment is provided, use tool-accessible file paths from the prompt; do not read unrelated files.

## Workflow

### 1. Clarify the trip and role of the item
Ask just enough context to avoid generic recommendations:
- Route and terrain: coastal roads, gravel, singletrack, developed campgrounds, remote public land.
- Trip length, season, weather, and resupply frequency.
- Bike/rack constraints, existing bags, and companion gear sharing.
- Use intensity: emergency-only, daily comfort item, cooking full meals, commuting/utility, etc.
- Priorities: convenience, pack volume, weight, durability, cost, repairability, or comfort.

Example framing:
> If the stove is mostly for morning tea and you plan to eat at restaurants, I’ll weight convenience and fast boiling more than simmer control or big-pot stability.

### 2. Verify named products before comparing
For each named product:
1. Search official docs or manufacturer pages.
2. Record the verified source mentally or cite it in the answer when important.
3. Quote only confirmed numeric specs.
4. If specs conflict, say so and prefer official/current pages.

Common comparison dimensions:
- Bags/panniers: volume per bag/pair, weight, mounting system, rack position, waterproofing, repairability, carry options, off-road stability.
- Stoves: fuel type, integrated vs stove-only, boil convenience, regulator, ignition, pot compatibility, wind behavior, stability, packed size, real use case.
- Bikes: posture, handlebar type, mounts, tire clearance, road/gravel efficiency, beginner friendliness, utility setup.

### 3. Route-aware food storage guidance
Do not default to bear-hang advice. Match the route and land manager rules:
- Developed campground with lockers: use food lockers for food, trash, toiletries, sunscreen, and scented items.
- Bear country or canister-required areas: follow legal requirements; canister/Ursack/hang depends on local rules.
- Non-bear but critter-heavy areas: plan for raccoons, rodents, skunks, birds, and ants. Use sealed panniers/dry bags/hard containers and keep food away from the tent when appropriate.
- Urban/coastal bikepacking: bears may be irrelevant, but human theft, gulls, raccoons, and campground rules can matter.

For LA-to-San-Diego coastal bikepacking, the source-session pattern was: bear tie/hang is usually not the typical need; use campground lockers if present and critter-aware sealed storage otherwise. Also clarify if the user means Pacific Coast/PCH rather than the Pacific Crest Trail, where bikes are generally not allowed.

### 4. Make recommendation tiers
Provide a concise decision rather than an exhaustive catalog:
- Best fit for Clemente's stated use.
- Good alternative if priorities differ.
- Overkill / avoid unless a condition applies.
- Practical caveats and accessories.

Example stove output structure:
- "Best tea system": integrated boil kit if morning tea is the primary use and volume is available.
- "Best flexible stove": regulated canister stove if cooking/simmering may matter.
- "Overkill": remote canister or large systems for restaurant-focused trips unless stability/cold-weather use matters.
- Reminders: lighter/ignition, fuel stabilizer, pot size for two cups, wind management.

### 5. Receipt and spend allocation
When Clemente provides a gear receipt:
1. Parse line items, quantities, discounts, subtotal, tax, rewards/credits, and final charge.
2. Verify arithmetic: line-item subtotal, tax, total, credits, paid amount.
3. Allocate items into useful categories (bags/cargo, clothing, kitchen, repair/tools, safety, hygiene, consumables, etc.).
4. Pro-rate tax and credits across categories unless the user asks otherwise.
5. Highlight high-cost categories, duplicate/return candidates, and whether purchases align with the trip plan.

Do not expose personal/payment details beyond what is necessary for the analysis.

## Output Patterns

### Product comparison table
Use tables when specs are central:

| Item | Role | Verified specs | Best for | Caveats |
|---|---|---:|---|---|
| Product A | Integrated boil kit | weight/volume only if verified | morning tea convenience | limited cooking |
| Product B | Stove-only | weight/regulator/ignition if verified | flexible cooking | needs separate pot |

### Recommendation summary
End with:
- "My pick for you"
- "Why"
- "What would change my answer"
- "Small things to remember/pack"

## Validation
- Check every quoted numeric product spec against a current source.
- Make route/legal caveats explicit for food storage.
- If using receipt math, show enough arithmetic that subtotal/tax/credits/final paid can be audited.
- Avoid pretending a gravel bike, hybrid, touring setup, or bikepacking setup is universally best; tie the answer to Clemente's actual use case.

## Source-session techniques
- Compared Ortlieb Gravel-Pack vs Back-Roller by volume, weight, materials, mounting system, and bikepacking suitability.
- Compared Jetboil/SOTO/MSR-style stove options by actual morning-tea needs, not theoretical expedition cooking.
- Treated Southern California coastal food storage as critter/campground-rule logistics rather than automatic bear-hang logistics.
- Parsed an REI eReceipt into categories and pro-rated tax/rewards to validate how spending was allocated.
