---
name: gut-health-supplement-evidence-review
description: Evaluate probiotics, prebiotics, fiber supplements, greens powders, and gut-health products by verifying current labels and strains, checking guideline/NIH/NCCIH/clinical evidence, separating condition-specific benefits from wellness marketing, comparing mechanisms such as psyllium vs resistant dextrin, and giving practical non-diagnostic trial guidance with safety caveats.
---

# Gut-Health Supplement Evidence Review

Use this skill when Clemente asks about probiotics such as Align, greens powders such as AG1, prebiotics, fiber products such as psyllium or Fibersol, or general “gut health” supplements.

## Setup

Preferred sources:

- Official product pages and supplement-facts labels for current ingredients, strains, CFU, dose, and certifications.
- NIH Office of Dietary Supplements and NCCIH pages for broad evidence/safety framing.
- GI society guidelines (AGA, ACG, WGO) for probiotics and IBS/diarrhea contexts.
- PubMed/systematic reviews for specific ingredients or strain/use-case combinations.
- Manufacturer pages can establish product contents, but do not treat marketing claims as efficacy proof.

If ExaSearch is unavailable, use direct public fetches/searches where appropriate and label any unverified product details.

## Core principles

- Do **not** treat “probiotics” as one category. Effects are strain-, dose-, condition-, and duration-specific.
- “More CFU” and “more strains” do not automatically mean better.
- Third-party certifications (for example NSF Certified for Sport) mainly support quality/contaminant control, not clinical efficacy.
- For general wellness, lifestyle basics and dietary fiber often have stronger practical evidence than expensive blends.
- Stay within non-diagnostic medical boundaries; encourage clinician input for red flags, immunocompromise, severe disease, pregnancy-specific uncertainty, or complex GI conditions.

## Workflow

### 1. Clarify the target problem

Identify the actual use case:

- IBS-type bloating/irregularity.
- Constipation, loose stools, or mixed stool pattern.
- Antibiotic-associated diarrhea prevention.
- Recurrent C. difficile or inflammatory bowel disease adjuncts.
- General “gut health” or microbiome optimization.
- Convenience nutrition / multivitamin replacement.

If the goal is vague, explain that supplement evidence is usually condition-specific.

### 2. Verify named products before judging them

For each named SKU:

- Fetch the official label/product page if possible.
- Record full strain IDs when given, not just genus/species.
- Note CFU and whether guaranteed **through expiration** or merely at manufacture.
- Identify proprietary blends or missing strain details.
- Check serving size, cost, sweeteners, allergens, storage requirements, and certifications.

If a label cannot be verified, say so clearly and avoid invented strain/CFU details.

### 3. Evaluate probiotics strain-by-strain

Good probiotic review includes:

- Full strain designation, e.g. *Lacticaseibacillus rhamnosus* GG, *Saccharomyces boulardii* CNCM I-745, *Bifidobacterium* 35624 lineage.
- Human evidence for the user’s symptom, not generic microbiome claims.
- Dose/duration used in studies when available.
- Expected effect size: usually modest, not transformative.
- Safety cautions for immunocompromised people, central lines, critical illness, severe pancreatitis, and complex GI disease.

Practical guidance: trial one product for 4–8 weeks, track symptoms, stop if no clear benefit.

### 4. Evaluate greens powders and “all-in-one” blends

For products like AG1:

- Separate multivitamin/mineral role, greens/adaptogen role, prebiotic/fiber role, and probiotic role.
- Verify whether probiotic strains and doses are disclosed.
- Explain that bundled convenience may be useful, but targeted evidence is usually weaker than for a specific supplement matched to a symptom.
- Call out high cost, proprietary blends, duplicated nutrients with other supplements, and interactions/contraindications.

Default framing: fine if liked and affordable, but not the first recommendation for targeted gut symptoms.

### 5. Compare fiber and prebiotic supplements by mechanism

Distinguish:

- **Psyllium**: viscous gel-forming soluble fiber; stronger evidence for stool normalization, constipation, LDL lowering, and post-meal glucose blunting. Needs water and gradual titration.
- **Resistant dextrin/maltodextrin products (e.g. Fibersol)**: low-viscosity soluble fiber; easier to mix, often better adherence, more subtle functional effects.
- **Inulin/chicory/FOS/GOS**: fermentable prebiotics; can help microbes but often more gas/bloating.
- **PHGG**: often a tolerable soluble fiber option for IBS-type symptoms.

Match the product to the goal: constipation/LDL/metabolic effects vs invisible fiber boost vs microbiome feeding.

### 6. Give practical, safe trial advice

- Start low and increase gradually.
- Avoid stacking many supplements at once; otherwise you cannot identify what works.
- Track symptoms, stool pattern, bloating, and adherence.
- Give water/medication-spacing cautions for psyllium and other gel-forming fibers.
- Stop if no benefit or if adverse symptoms appear.

## Example output pattern

```markdown
Bottom line: Align is plausible for IBS-type symptoms because it uses a studied Bifidobacterium 35624 lineage, but expected benefits are modest. I would not buy AG1 for its probiotic effect; its value is convenience, not targeted probiotic evidence.

For default gut-health supplementation:
1. Food/fiber diversity first.
2. Psyllium or PHGG if stool regularity is the goal.
3. A single strain-specific probiotic trial for 4–8 weeks if symptoms match evidence.
4. Expensive blends only if convenience/adherence is worth the cost.
```

## Validation checklist

- [ ] Named product label/strain/dose verified or uncertainty stated.
- [ ] Condition/use case is explicit.
- [ ] Guideline or authoritative evidence checked for medical claims.
- [ ] Marketing claims are separated from clinical evidence.
- [ ] Strain specificity and CFU-through-expiration issues are addressed.
- [ ] Safety boundaries and clinician-escalation situations are included.
- [ ] Practical trial duration and stop rule are provided.
- [ ] No invented product specs, prices, strain IDs, or clinical effect sizes.

## Source-session techniques

- Tried ExaSearch first, then used direct public fetches when Exa credits were unavailable.
- Verified AG1 official pages for certification/marketing claims while noting difficulty extracting full supplement facts.
- Used NIH/NCCIH-style evidence framing for probiotics.
- Compared Fibersol and psyllium by mechanism: low-viscosity invisible fiber vs gel-forming viscous fiber.
- Presented recommendations as non-diagnostic, practical trials rather than cures.
