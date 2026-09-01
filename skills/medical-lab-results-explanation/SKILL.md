---
name: medical-lab-results-explanation
description: Help Clemente understand human medical lab results from PDFs, screenshots, or authenticated portals by extracting values safely, comparing them with reference ranges, explaining common markers such as lipid panels in plain language, identifying clinician follow-up questions, and giving non-diagnostic lifestyle/risk-context guidance without replacing medical care.
---

# Medical Lab Results Explanation

Use this skill when Clemente asks for help understanding human medical lab results, especially reports from PDFs, screenshots, photos, or authenticated health portals. This skill complements:
- `meal-timing-nutrition-research` for nutrition-specific evidence and lifestyle questions.
- `secret-safe-browser-automation` for authenticated portal access.
- Wearable/fitness skills only when lab interpretation intersects with device metrics.

## Setup

1. Identify the input type:
   - Uploaded PDF
   - Screenshot/photo
   - Text pasted from portal
   - Authenticated web portal
2. Confirm what Clemente wants:
   - Quick “is this concerning?” overview
   - Marker-by-marker explanation
   - Questions to ask a clinician
   - Lifestyle implications
   - Comparison to prior results
3. If using a file:
   - Confirm the file exists before extracting.
   - For PDFs, prefer text extraction first, preserving layout:
     ```bash
     pdftotext -layout /path/to/lab-report.pdf - | head -200
     ```
   - Use OCR/image tools only when text extraction is insufficient.
4. If using an authenticated portal:
   - Do not ask for or handle passwords, MFA codes, or recovery information.
   - Use browser status/snapshot tools to inspect non-secret page state.
   - Use `browser_wait_for_user` or equivalent for login, MFA, consent, or navigation that requires private credentials.
   - Treat portal contents as sensitive medical information.

## Safety and Privacy Boundaries

- Do **not** diagnose disease, prescribe medication, or tell Clemente to start/stop medication.
- Do **not** claim a result is “fine” in an absolute medical sense. Prefer: “not obviously alarming in isolation” or “worth discussing with your clinician.”
- Do **not** include private patient identifiers in notes, examples, final answers, or skills.
- Do **not** reproduce exact personal lab values in durable memory unless Clemente explicitly requests that and it is appropriate; prefer summaries such as “LDL was above the lab’s optimal range.”
- Do **not** read secret files or credential stores.
- Encourage clinician follow-up for:
  - Markedly abnormal values
  - Symptoms
  - New or worsening abnormalities
  - Pregnancy, chronic disease, immunosuppression, or medication changes
  - Conflicting results or unclear reference ranges
- For urgent red flags, advise prompt medical care rather than analysis.

## Workflow

### 1. Extract and structure the data

Create a concise structured table with:

| Test | Result | Reference/target range | Plain-language interpretation |
|---|---:|---:|---|

If exact values are shown to the user in the immediate response, keep them only in the conversation and avoid copying them to long-term memory unless requested.

For each marker:
- Preserve units.
- Note whether the result is below, within, or above the stated reference range.
- If the lab provides a risk category, use the lab’s category rather than inventing one.
- If reference ranges vary by age, sex, pregnancy status, fasting status, or lab method, say so.

### 2. Interpret in context, not as a diagnosis

Explain that lab interpretation depends on:
- Age and sex assigned at birth when relevant
- Fasting vs non-fasting status
- Current medications/supplements
- Blood pressure
- Smoking/vaping status
- Diabetes or insulin resistance
- Kidney, liver, thyroid, inflammatory, or autoimmune conditions
- Family history of early cardiovascular disease or inherited lipid disorders
- Recent illness, heavy exercise, alcohol intake, or diet changes
- Prior results/trends

Ask targeted follow-up questions when needed rather than over-interpreting.

### 3. Lipid panel explanation pattern

For lipid panels, explain:

- **Total cholesterol**: Combined cholesterol measure; useful but less specific than LDL/non-HDL/ApoB context.
- **Triglycerides**: Blood fats influenced by recent meals, alcohol, insulin resistance, diabetes, weight change, and some medications; fasting status matters.
- **HDL cholesterol**: Often called “good cholesterol,” but very high or low HDL does not fully determine risk by itself.
- **LDL cholesterol**: Common treatment target; higher LDL generally increases long-term cardiovascular risk, but decisions depend on overall risk.
- **Total cholesterol / HDL ratio**: A rough risk indicator; less central than LDL, non-HDL, ApoB, and global risk assessment.
- **Non-HDL cholesterol**: Total cholesterol minus HDL; captures cholesterol in atherogenic particles and can be useful when triglycerides are elevated.
- **Optional advanced markers**:
  - **Lp(a)**: Consider discussing once-in-a-lifetime testing if family history of early heart disease or unexplained high risk.
  - **ApoB**: Consider discussing if risk is uncertain, triglycerides are elevated, metabolic risk is present, or LDL/non-HDL interpretation is unclear.

### 4. Frame concern level carefully

Use calibrated language:
- “This does not look like an emergency in isolation.”
- “This is worth reviewing with your primary care clinician.”
- “This may affect long-term cardiovascular risk rather than indicating an immediate problem.”
- “The trend matters; one result is less informative than repeated results.”
- “The lab’s reference range is not the same as your personalized target.”

Avoid:
- “You are healthy.”
- “You have heart disease.”
- “You need a statin.”
- “Ignore this.”

### 5. Offer practical, non-prescriptive next steps

Depending on the result category, suggest discussion topics and general lifestyle measures:

- Confirm fasting status if triglycerides/glucose are relevant.
- Recheck timing: often weeks to months depending on clinician guidance and degree of abnormality.
- Discuss overall cardiovascular risk calculation with clinician.
- Ask whether secondary causes should be checked, such as thyroid, diabetes, kidney/liver issues, medications, alcohol, or recent illness.
- Lifestyle basics:
  - More soluble fiber and minimally processed plant foods
  - Replace saturated fats with unsaturated fats where appropriate
  - Regular aerobic activity plus resistance training
  - Weight management if relevant and desired
  - Limit alcohol if triglycerides are high
  - Smoking cessation support if relevant
  - Sleep and blood pressure management

Do not present lifestyle steps as guaranteed treatment.

## Authenticated Portal Handling

When Clemente wants help finding or interpreting additional tests in a portal:

1. Use browser status/snapshot tools to understand the current page.
2. Ask Clemente to log in or complete MFA directly.
3. Use `browser_wait_for_user` for credential, MFA, CAPTCHA, consent, or sensitive navigation steps.
4. Avoid copying more portal content than necessary.
5. Summarize only the requested lab data and interpretation.
6. Offer to compare against prior tests only if Clemente authorizes reviewing them.

## Examples

### Example: concise lipid-panel response

> Here’s the plain-language read. I’m comparing each item to the lab’s own reference range, but cardiovascular risk depends on the whole picture: age, blood pressure, smoking, diabetes, medications, and family history.

| Test | Relative result | Meaning |
|---|---|---|
| Total cholesterol | Above the lab’s preferred range | A broad cholesterol measure; useful but not the main standalone decision point. |
| Triglycerides | Within range | Less concerning, especially if this was non-fasting. |
| HDL | In range | Generally favorable, but HDL does not erase LDL-related risk. |
| LDL | Above optimal | Worth discussing as part of long-term cardiovascular risk. |
| Non-HDL | Above preferred range | Captures atherogenic cholesterol particles; useful alongside LDL. |

> Nothing here sounds like an immediate emergency from the numbers alone, but it is worth discussing with your clinician. Helpful context: was this fasting, and do you have high blood pressure, diabetes, smoking history, or family history of early heart disease?

### Example: follow-up questions

Ask:
- “Was the blood draw fasting?”
- “Any prior lipid panels for trend comparison?”
- “Any family history of heart attack, stroke, or very high cholesterol at a young age?”
- “Any diabetes, high blood pressure, kidney disease, thyroid disease, or relevant medications?”
- “Are you looking for a clinician-facing summary, a lifestyle plan, or just interpretation?”

### Example: clinician discussion prompts

> Good questions for your clinician:
> - What is my 10-year and lifetime cardiovascular risk?
> - Is my LDL/non-HDL level high enough to warrant treatment, or should we start with lifestyle and recheck?
> - Should we check ApoB or Lp(a), especially if there is family history?
> - Are secondary causes worth screening for?

## Validation and Quality Checklist

Before responding, verify:

- [ ] Lab source was handled privacy-safely.
- [ ] Units and reference ranges were preserved.
- [ ] Each result was compared to the report’s own range when available.
- [ ] No diagnosis or medication directive was given.
- [ ] Abnormal values were framed with appropriate urgency.
- [ ] Relevant risk-context questions were asked.
- [ ] The explanation distinguished population reference ranges from personalized clinical targets.
- [ ] Portal credentials/MFA were never requested or handled.
- [ ] No private identifiers or exact personal lab values were stored in durable memory.
- [ ] If results seemed urgent or symptom-linked, clinician/urgent-care escalation was recommended.

## Source-Session Techniques to Reuse

- For uploaded lab PDFs, confirm file existence, then extract layout-preserved text with:
  ```bash
  pdftotext -layout ... - | head -200
  ```
- Convert extracted lab data into a concise table.
- Explain each lipid-panel component: total cholesterol, triglycerides, HDL, LDL, ratio, and non-HDL.
- Distinguish “not alarming in isolation” from “worth discussing with a clinician.”
- Ask risk-context follow-ups: fasting status, blood pressure, smoking, diabetes, family history, and prior trends.
- Suggest discussing Lp(a) and ApoB when family history or risk uncertainty makes them relevant.
- For authenticated portal work, use browser status/snapshot and wait-for-user login/MFA flows rather than requesting credentials.
- Treat all portal-derived medical content as sensitive.
