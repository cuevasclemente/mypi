---
name: food-spoilage-safety-triage
description: Assess purchased, prepared, or leftover food that may be spoiled or unsafe by verifying the exact product and expected sensory profile, checking authoritative food-safety guidance, separating quality defects from illness risk, and giving non-diagnostic red-flag escalation advice without replacing medical care.
---

# Food Spoilage Safety Triage

Use this skill when Clemente asks whether a food tasted, smelled, looked, or was stored in a way that suggests spoilage or foodborne-illness risk. This includes grocery/bakery items, restaurant leftovers, dairy/cream-filled foods, meat/seafood, prepared foods, and unfamiliar foods from local or international markets.

## Setup

- Prefer current authoritative sources for actionable safety guidance: CDC, FDA, USDA/FSIS, FoodSafety.gov, state/local health departments, university extension food-safety programs, and manufacturer/store guidance.
- For named products, search for current product/store evidence before describing expected ingredients, flavors, refrigeration needs, or shelf life.
- Treat this as **non-diagnostic triage**, not medical care. Do not tell the user they are safe or infected. Explain likely risk, what to monitor, and when to seek professional help.
- Preserve privacy when location or store context matters. Use only the detail needed to identify the product or local food rules.
- Do not read secret files or private accounts. If login or purchase history is needed, ask the user to inspect it or use browser handoff.

## Core workflow

### 1. Clarify exposure and risk context

Ask or infer:

- What food/product was it? Brand, store, label, sell-by/use-by date, lot code, and whether it was refrigerated or shelf-displayed.
- What was concerning: taste, odor, texture, visible mold, slime, gas/fizz, leaking package, bulging can, temperature abuse, undercooking, or cross-contamination?
- How much was eaten and when?
- Is the user or eater pregnant, elderly, immunocompromised, very young, or otherwise medically high-risk?
- Are symptoms present now? If yes: onset time, vomiting/diarrhea, fever, blood, hydration, and severity.

If the user has severe symptoms already, prioritize escalation before research.

### 2. Identify what is expected for the product

For a named or unfamiliar food, verify rather than guessing:

- Search the product name, brand, store, menu listing, reviews/photos, ingredient lists, or official pages.
- Distinguish exact product evidence from generic analogs.
- If the source is weak (reviews, third-party menu pages), state uncertainty.
- Identify whether the odd feature could be intentional: e.g., cream cheese filling, fermented flavor, strong cheese, fish sauce, alcohol, sourdough tang, blue cheese, natto, fermented shrimp, or intentionally mold-ripened cheese.

Example source-session pattern:

- For a 99 Ranch/BF Bakery “Mexican blueberry bun,” searches found BF/Bread Farm Bakery evidence and reviews describing a Mexican blueberry bun with blueberry purée/cream and a “blueberry cheese bread.” That made a white creamy filling plausible, but “blue-cheese funk” remained concerning.

### 3. Separate expected flavor from spoilage signs

Use cautious sensory interpretation:

- **More likely expected/quality issue:** mild tang, saltiness, sweetness imbalance, stale/dry bread, artificial fruit flavor, normal fermented/sourdough notes, or product-specific funk verified by sources.
- **More concerning:** blue-cheese/mold funk in a non-blue-cheese product, ammonia, rotten milk, putrid/sulfur odor, visible mold where not intended, slime, fuzz, gas/fizz, leaking/bulging packaging, spurting liquid, unusually warm refrigerated food, or a cream/custard filling held unrefrigerated when it should be cold.
- A sell-by date does not guarantee safety if storage or handling was poor.
- “When in doubt, throw it out” is appropriate for remaining suspect food, especially high-moisture, dairy, meat, seafood, or TCS foods.

### 4. Check authoritative storage and illness guidance

Match the food to guidance:

- CDC for food poisoning symptoms and red flags.
- USDA/FoodSafety.gov for refrigeration, power outage, meat/poultry/egg/dairy handling, and “danger zone” guidance.
- FDA/state/local rules for perishable bakery products, seafood, recalls, and retail food safety.
- Extension guidance for cream/custard/cheese-filled baked goods and shelf-stability concepts.

Important distinction:

- Commercial bakery fillings may be formulated to be shelf-stable, but ordinary cream/custard/cheese-filled pastries generally require temperature control. Do not assume a room-temperature display is unsafe, but do not assume it is safe either without product-specific evidence.

### 5. Give immediate practical steps

Typical recommendations:

1. Stop eating the food if it seems off.
2. Save the remaining item, label, packaging, receipt, and photos in a bag in the refrigerator if the store may need to inspect/refund/report it.
3. If the product is clearly spoiled or high-risk, discard it after documenting.
4. Call the store/manufacturer and ask whether the flavor/appearance is expected; provide date, lot, sell-by, and purchase location.
5. Check for recalls if relevant.
6. Monitor symptoms for the relevant window; many foodborne illnesses begin within hours, but some take days.
7. Hydrate if mild GI symptoms occur; avoid giving medication advice beyond general safety unless using a medical source and appropriate caveats.

### 6. Escalate for medical red flags

Use CDC-style red flags. Advise medical care or urgent advice for:

- Bloody diarrhea.
- Diarrhea lasting more than 3 days.
- Fever over 102°F / 38.9°C.
- Repeated vomiting or inability to keep fluids down.
- Signs of dehydration: dizziness, very little urination, dry mouth/throat, confusion, faintness.
- Severe or worsening abdominal pain.
- Neurologic symptoms: blurred vision, weakness, tingling, trouble speaking/swallowing, stiff neck, confusion, loss of balance, seizures.
- High-risk status: pregnancy, immunocompromise, older adult, infant/young child, significant chronic disease.

For poison/toxin-specific concerns, advise calling Poison Control in the U.S. at 1-800-222-1222 or using poisonhelp.org. For emergencies, advise emergency services.

## Examples

### Unfamiliar bakery item with cheese-like filling

“Search results suggest this product is normally filled with blueberry purée/cream, so a white creamy center may be expected. But a blue-cheese or ammonia funk is not typical for a sweet blueberry bun unless the store confirms it. Stop eating it, save the label/receipt, refrigerate the remainder, and call the bakery. Monitor for GI symptoms and seek care for CDC red flags such as bloody diarrhea, fever over 102°F, repeated vomiting, dehydration, or diarrhea over 3 days.”

### Leftover rice or prepared meal left out overnight

“This is a time/temperature issue rather than a smell test. Some pathogens and toxins are not reliably detectable by taste or smell. If it sat in the danger zone for many hours, the safest recommendation is to discard it; don’t rely on reheating to make it safe.”

### Mold on bread or cheese

“For ordinary bread, discard the whole loaf because mold can spread beyond what is visible. For hard cheeses, official guidance may allow trimming with a margin, but soft cheeses, cream cheese, yogurt, and prepared foods should be discarded if mold appears.”

## Validation checklist

- Did you identify the exact product and avoid inventing ingredients or storage requirements?
- Did you distinguish expected product characteristics from spoilage signs?
- Did you use current authoritative food-safety sources for actionable advice?
- Did you avoid diagnosing illness or guaranteeing safety?
- Did you give practical next steps for the remaining food and documentation?
- Did you include red-flag escalation and high-risk-person caveats?
- Did you avoid exposing precise location or purchase details beyond what was needed?

## Source-session techniques

- Loaded the relevant food-safety skill, then recognized that the issue was spoilage/illness triage rather than preservation.
- Used Exa/MCP web search to verify the named local product and store context before interpreting the flavor.
- Used CDC food-poisoning symptom guidance for red flags.
- Used USDA/FoodSafety.gov style guidance to distinguish ordinary breads from cream/custard/cheese-filled pastries that may require refrigeration.
- Recommended saving the label/receipt, calling the bakery, stopping consumption, monitoring symptoms, and escalating only for red flags or high-risk status.
