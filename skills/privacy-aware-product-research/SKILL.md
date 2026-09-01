---
name: privacy-aware-product-research
description: Research and recommend products by gathering requirements, checking memoriki for user preferences, verifying specs from authoritative sources, and producing evidence-based recommendations with tradeoffs.
---

# Privacy-Aware Product Research

Help users make informed purchasing decisions by combining their stated preferences, historical context from memoriki, and current authoritative product information—without fabricating specs or invading privacy.

## Setup

**Required tools:**
- MemPalace/memoriki access (`mempalace_search`, file read from `~/src/memoriki`)
- ExaSearch (`exasearch` tools) for current product documentation and reviews
- Web fetch capability for manufacturer pages and official specs

**No API keys needed** — skill operates on publicly available information.

## Workflow

### 1. Gather Requirements

Interview the user to understand:
- **Use case** — what problem are they solving? What activities/scenarios?
- **Must-have features** — privacy constraints, compatibility requirements, size/fit constraints
- **Priorities** — value, durability, privacy, performance, brand preference, aesthetics
- **Budget range** — hard limits or flexible guidelines
- **Constraints** — shipping, availability, return policy, existing ecosystem
- **What they're replacing** — if upgrading/switching, what worked and what didn't?

Ask clarifying questions rather than assuming. Surface any ambiguity early.

### 2. Search Memoriki for Context

Before researching products, check memoriki for:
- Past purchase decisions and what the user valued
- Stated privacy preferences (e.g., no cloud sync, no companion app requirements)
- Brand/vendor trust patterns
- Size/fit history (shoe width, shirt cut preferences, etc.)
- Value thresholds and quality expectations
- Previous research notes on similar categories

Use `mempalace_search` with queries like:
- `"privacy smartwatch recommendations"`
- `"shoe fit preferences width"`
- `"t-shirt quality brands"`
- `"[category] purchase history"`

Also check wiki pages for product categories, brand notes, or user profiles.

### 3. Identify Candidate Products

Based on requirements and memoriki context:
- List 3-5 candidate products that might fit
- Include at least one "safe" option and one aspirational/stretch option
- Note if you're pattern-matching from memory vs. have verified the product exists

### 4. Verify Named Products with Authoritative Sources

**Critical:** When a user names a specific SKU, model, or product, or when you suggest a specific product, **fetch current authoritative specs** before stating them.

Use ExaSearch or direct fetch to find:
- Manufacturer product pages
- Official specification sheets
- Current retailer listings (for price/availability)
- Professional reviews from reputable sources

**Never invent:**
- Weights, dimensions, materials (e.g., fabric GSM, battery mAh, shoe stack height)
- Version numbers or release dates
- Prices or availability
- Feature support (e.g., "works with X protocol")

If you cannot verify a spec quickly, **say so explicitly** and label the information as "from memory—verify before purchase."

### 5. Compare Options with Tradeoffs

Present a structured comparison:
- **Recommended option** — best fit for stated priorities, with reasoning
- **Alternative(s)** — 1-2 other options with clear tradeoffs (cheaper/heavier, more private/less featured, etc.)
- **Key differentiators** — what makes each option distinct
- **Risks/caveats** — unverified specs, limited reviews, return policy concerns, privacy red flags

Use a table or bullets to make tradeoffs scannable.

### 6. Produce Decisive Recommendation

Don't just list options—synthesize a **clear recommendation**:
- "For your use case [X] with priorities [Y], I recommend [product] because [reasoning]."
- "If [constraint] is flexible, consider [alternative] instead."
- Include next steps: where to buy, what to verify before purchase, return policy to check.

### 7. Journal Durable Insights

When the research reveals **notable user preferences** or **reusable product knowledge**, add to memoriki:

**User preference insights** (add to MemPalace or wiki user profile):
- "User prefers wide-toe-box shoes, dislikes narrow athletic fits"
- "User values privacy over features—avoids cloud-required devices"
- "User willing to pay premium for quality basics (t-shirts, bike locks)"

**Product/category knowledge** (add to relevant wiki pages or MemPalace drawers):
- "Garmin watches: avoid models requiring Garmin Connect cloud sync for basic use"
- "ASICS Gel-Resolution 9: stable court shoe, narrower than Xero Prio, size up half"
- "Bike locks: U-lock + cable combo recommended, avoid cable-only for street parking"

Use `mempalace_add_drawer` or update wiki markdown as appropriate.

## Validation Checklist

Before delivering recommendations:
- [ ] Requirements gathered and ambiguities clarified
- [ ] Memoriki searched for relevant user preferences and past decisions
- [ ] All named products verified with authoritative sources (no fabricated specs)
- [ ] Comparison includes clear tradeoffs and differentiators
- [ ] Recommendation is decisive with reasoning, not just a list
- [ ] Unverified or uncertain specs explicitly labeled
- [ ] Privacy concerns surfaced when relevant
- [ ] Notable insights journaled to memoriki for future reference

## Examples

### Example 1: Privacy-Preserving Smartwatch

**User request:** "I want a fitness watch that doesn't require cloud sync."

**Workflow:**
1. Gather: use case (running, sleep tracking?), must-have sensors (HR, GPS?), budget, phone OS
2. Search memoriki: `"privacy smartwatch"`, `"fitness tracker recommendations"`
3. Identify candidates: Garmin Forerunner 255 (offline mode), Coros Pace 3, Polar Vantage
4. Verify: fetch Garmin/Coros product pages, confirm offline sync options, check current prices
5. Compare: table with sync methods, battery life, price, feature depth
6. Recommend: "For your privacy priority and running focus, I recommend Coros Pace 3 because it syncs via Bluetooth without mandatory cloud account. Garmin Forerunner 255 is a close second but Garmin Connect app nudges toward cloud features."
7. Journal: "User values offline-first fitness devices, willing to sacrifice ecosystem integration for privacy."

### Example 2: Athletic Shoe Transition

**User request:** "I've worn Xero Prio for years, but need a tennis-specific shoe."

**Workflow:**
1. Gather: court surface (hard court?), foot shape, what they like about Xero (wide toe box, zero drop?)
2. Search memoriki: `"shoe fit preferences"`, `"Xero Prio"`
3. Identify candidates: ASICS Gel-Resolution 9, Adidas Adizero Ubersonic, K-Swiss Hypercourt
4. Verify: fetch ASICS product page, review specs (stack height, toe box width), find professional court shoe reviews
5. Compare: ASICS = stable/durable, narrower fit; Adidas = light/fast, even narrower; K-Swiss = middle ground
6. Recommend: "ASICS Gel-Resolution 9 is your best bet for court stability and durability. Warning: it's narrower than Xero Prio—order wide width or size up. If you prioritize natural feel over support, consider Vivobarefoot Primus Court (zero drop, wide toe box) but less lateral support."
7. Journal: "User has wide feet, prefers zero-drop shoes, transitioning to court sports—needs stability vs. minimalist tradeoff guidance."

### Example 3: High-Quality T-Shirts

**User request:** "I want good T-shirts that will last, not fast fashion."

**Workflow:**
1. Gather: fit preference (fitted, relaxed?), fabric (cotton, merino?), budget per shirt, use (daily wear, athletic?)
2. Search memoriki: `"t-shirt quality brands"`, `"clothing purchase history"`
3. Identify candidates: Asket, Merz b. Schwanen, Lady White Co., 3sixteen
4. Verify: fetch brand sites, confirm fabric GSM, construction details (double-needle, tubular knit?), current pricing
5. Compare: Asket = transparent sourcing, mid-weight, $40; Merz = German loopwheeled, heavy-weight, $100; Lady White = US-made, mid-heavy, $60
6. Recommend: "For durability and value, start with Asket ($40, 180 GSM organic cotton). If you want heirloom-quality, Merz b. Schwanen is worth the premium—German loopwheel construction, 240 GSM, will last 10+ years."
7. Journal: "User values quality over cheap multiples, willing to pay $40-100/shirt for long-term value."

## Notes

- **Privacy-aware** doesn't just mean device privacy—also respect user's purchasing privacy by avoiding affiliate links, tracking URLs, or biased sources.
- **Value vs. price:** User often prioritizes long-term value over upfront cost—surface this tradeoff explicitly.
- **Avoid invented numbers:** If you don't have fabric GSM, battery mAh, shoe stack height, etc., omit it rather than guess.
- **Update memoriki incrementally:** Don't wait for a "big reveal" purchase—journal insights as they emerge during research.
