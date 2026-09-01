---
name: dream-cycle-skill-extraction
description: Run a policy-authorized Pi Dream cycle that analyzes eligible session JSONL through the Wayang runner, extracts reusable workflows selectively, and leaves denied sessions unprocessed.
---

# Dream Cycle Skill Extraction

## Authorization boundary

- Transcript enumeration and bytes must come only from `~/.pi/agent/scripts/dream-authorized-sessions.mjs` or the `dream_session_read` tool backed by that runner.
- The runner validates Wayang's private, complete `project-access-policy.json` projection and its live `store.json` fingerprint before access.
- Missing, stale, unknown, malformed, contradictory, or changing policy denies. Never retry with `read`, `bash`, `grep`, `find`, `ls`, `sudo_exec`, or another direct filesystem path.
- During an active Dream turn, the runtime narrows tools to `dream_session_read`, `read`, `edit`, and `write`. Defense-in-depth guards revalidate policy and deny both targets inside the sessions root and recursive ancestor paths (including its parent, home, `/`, and canonical symlink aliases).
- A denied session must not be added to `processedSessions`. It remains eligible if policy is explicitly relaxed later.
- Policy changes are prospective: they cannot undo a skill or memory derivation created before protection.

## Setup and preflight

- Runtime runner: `~/.pi/agent/scripts/dream-authorized-sessions.mjs`
- Sessions root: `~/.pi/agent/sessions/`
- State: `~/.pi/agent/dreamer-state.json`
- Wayang must be publishing a current mode-`0600` policy projection.

Before launching an agent, the scheduled wrapper runs:

```sh
node ~/.pi/agent/scripts/dream-authorized-sessions.mjs \
  list --sessions-root ~/.pi/agent/sessions >/dev/null
```

Any nonzero result aborts the cycle before model launch. There is no direct fallback.

## Workflow

1. **Use the authorized list**
   - Accept only paths emitted by the runner-backed Dream extension.
   - Compare authorized paths with `processedSessions`.
   - Treat every authorized path absent from state as unprocessed regardless of `lastRun`; this preserves later eligibility for previously denied sessions.

2. **Analyze authorized sessions**
   - Group eligible sessions by project/date/theme.
   - Analyze directly in the reviewed Dream orchestrator with `dream_session_read`; do not spawn Agent Teams children because hardened children disable custom tools and general extension discovery.
   - Read each session in bounded segments, following `next_offset` until complete.
   - Capture primary task, workflow, techniques, result, reusable insight, and skill candidates.
   - If the runner denies or changes policy mid-read, stop that batch and leave the affected sessions unprocessed.

3. **Synthesize candidates**
   - Merge duplicates and check existing skills.
   - Prefer recurring or broadly reusable procedures.
   - Skip one-off answers, smoke tests, and project-specific trivia.

4. **Create approved skills**
   - Use valid kebab-case names and matching directories.
   - Include YAML frontmatter, setup, concrete steps, validation, and safety constraints.
   - Synchronize byte-identical content through the reviewed distribution procedure to:
     - `~/.pi/agent/skills/<skill-name>/SKILL.md`
     - `~/src/mypi/skills/<skill-name>/SKILL.md`
     - `~/src/memoriki/skills/<skill-name>/SKILL.md`

5. **Update state only after success**
   - Set `lastRun` to the cycle timestamp.
   - Add only sessions actually analyzed under runner authorization.
   - Record mtime and generated skill names (including an empty list when no skill was warranted).
   - Add new skills to `skillsIndex` with creation time, description, and authorized source-session paths.

## Validation

Use synthetic `HOME`, sessions, state, Wayang data, and projection fixtures. Do not run validation over real user sessions.

```sh
node ~/src/wayang/scripts/tests/dream-authorized-sessions.test.mjs
node ~/src/mypi/scripts/test-dream-companion-policy.mjs
```

Confirm protected and unknown synthetic sessions are denied, standard synthetic sessions are allowed, stale projections abort, and no denied path is written to Dream state.
