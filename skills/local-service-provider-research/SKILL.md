---
name: local-service-provider-research
description: Find and evaluate local service providers near Clemente, such as luthiers, repair shops, contractors, clinics, or specialty stores, using privacy-aware location handling, Memoriki preferences, current source verification, fit ranking, contact scripts, and explicit uncertainty without exposing Clemente's precise home address.
---

# Local Service Provider Research

Use this skill when Clemente asks for a nearby professional or local business: e.g. a luthier for a classical guitar, appliance repair, bike fitting, alteration tailor, specialty shop, contractor, or other location-dependent service.

## Setup

- Start from Clemente's privacy and convenience needs.
- Use Memoriki when the request says "near me/home" or implies personal fit, but avoid revealing exact stored addresses in chat.
- Use ExaSearch or current web sources for live business details when available; if search tools fail, state that limitation and rely on known/public leads cautiously.
- Never read credential files, cookies, private account data, or maps/browser profiles.
- For regulated/medical/legal services, stay within non-professional guidance and recommend confirming licensing/credentials directly.

## Workflow

1. **Clarify scope only when needed**
   - Ask if the service type, urgency, budget, travel radius, or specialization is unclear.
   - If Clemente asks for "near my home," use a neighborhood/city-level anchor from Memoriki rather than printing the exact address.
   - For sensitive categories, ask whether to use stored location context.

2. **Identify what makes a provider a good fit**
   - Translate the object/problem into provider criteria.
   - Example: for a classical/flamenco guitar, prioritize nylon-string/classical specialists, luthiers who handle older instruments, crack/neck/bridge repair experience, and reputable referral sources over generic guitar setup shops.
   - Separate must-haves, nice-to-haves, and disqualifiers.

3. **Search and verify current details**
   - Prefer official provider pages, professional association listings, manufacturer/dealer pages, and clearly maintained contact pages.
   - Cross-check address, phone, service scope, appointment requirements, and whether repairs are in-house or referral-only.
   - If using aggregators or maps snippets, label them as less authoritative.
   - If a website is missing or stale, say so and suggest calling.

4. **Rank by fit, not just distance**
   - Bucket results: best specialist, best nearby practical option, best referral source, backup/generalist.
   - Include why each provider is on the list and what uncertainty remains.
   - Avoid exposing Clemente's exact starting address; use approximate areas and travel framing such as "Pasadena," "Alhambra-adjacent," or "west side backup."

5. **Give an action plan**
   - Provide 2-5 recommended calls/emails in priority order.
   - Include a short call script tailored to the problem.
   - Suggest what photos or information to prepare: model, age, serial number, symptoms, photos of damage, desired turnaround, budget ceiling.
   - For high-value/fragile items, recommend asking about insurance, storage, written estimates, and whether they subcontract.

6. **Record durable preferences if appropriate**
   - If Clemente confirms a provider was good/bad, ask before recording a durable preference in Memoriki.
   - Record only non-secret, useful facts: provider name, category, area, outcome, and date.

## Example answer structure

```markdown
## Best leads
1. Provider A — best specialist fit
   - Why: ...
   - Verify: ...
   - Contact: ...
2. Provider B — closest practical option

## Questions to ask
- Do you repair [specific item] in-house?
- Have you worked on [classical/flamenco/brand/material] before?
- Can you inspect before quoting?

## What to bring/send
- Photos of ...
- Short symptom history ...
```

## Validation checklist

- Did you avoid printing Clemente's precise home address?
- Are current contact details sourced or clearly marked uncertain?
- Did you distinguish specialists from generalists/referral sources?
- Did you give Clemente a concrete next step rather than a raw list?

## Source-session techniques

- Luthier search session: used Memoriki to infer local context, connected to ExaSearch, handled search-credit failure explicitly, then produced a ranked Pasadena/nearby list with official/contact uncertainty and follow-up call guidance.
