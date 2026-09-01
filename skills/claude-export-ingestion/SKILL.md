---
name: claude-export-ingestion
description: Ingest Claude.ai project/chat export bundles into the memoriki wiki and MemPalace. Recurring workflow for when Clemente periodically exports Claude history to preserve knowledge and context.
---

# Claude Export Ingestion

Workflow for ingesting Claude.ai project and conversation export bundles into memoriki (wiki + MemPalace). Clemente periodically exports Claude history; this skill captures the proven ingestion pattern from the May 13 2026 run.

## When to Use

- User mentions a Claude export (from claude.ai) that needs processing
- You see a date-stamped export directory (e.g., `docs/may13-export/`, `~/Downloads/claude-export-may-13/`)
- User asks to "process the claude export" or similar

## Locating Exports

**Typical locations:**
- `~/Downloads/` — initial download location, often with naming like `claude-export-may-13.zip` or date-stamped directories
- `~/src/memoriki/docs/{date}-export/` — staged for processing after unzipping
- `~/src/memoriki/memoriki/raw/claude-export-{date}/` — raw archive (optional archival location)

**Discovery:**
```bash
# Look for recent Claude export directories
find ~ -maxdepth 4 -type d -iname "*claude*export*" 2>/dev/null
find ~/Downloads -name "*claude-export*" -o -name "*may*13*" 2>/dev/null
ls ~/src/memoriki/docs/
```

## Export Structure

Claude.ai exports consist of:

### Global Memory
- `global-memory-old.md` — previous snapshot of Claude's global context for Clemente
- `global-memory-new.md` — current snapshot (as of export date)

**Content:** profile-level facts, work context, top-of-mind topics, recent project focus.

**Processing:** Diff old→new. File only the **delta** — new facts present in `-new.md` that aren't in `-old.md`, or facts that have changed (e.g., job title, equity %, devices, top-of-mind shifts).

### Project Memory Files

Each Claude.ai project exports as:
- `project-{uuid}-old.md` / `project-{uuid}-new.md` — projects that existed at last export
- `project-{uuid}-NEW.md` — entirely new projects created since last export

**Content:** Project purpose/context, key learnings, current state, on-the-horizon items. Organized into structured sections.

**Processing:**
- **Old/new pairs:** Diff and file only the delta (new facts in `-new` that aren't in `-old`, or facts that contradict/supersede old ones).
- **NEW files:** Treat full content as candidate-new, but still check for duplicates before filing (user may have manually filed some content already).

### File Naming Observations

- Old/new pairs use lowercase suffixes: `-old.md`, `-new.md`
- NEW-only files use uppercase: `-NEW.md`
- File count example from May 13 export: 27 files total (8 old/new project pairs + 7 NEW projects + 1 global-memory pair)

## Diff Strategy

### For old/new pairs

1. Read both `-old.md` and `-new.md`
2. Identify facts in `-new.md` that are:
   - **Entirely new** — not mentioned in `-old.md` at all
   - **Updated** — present in old but materially changed (e.g., "considering e-bikes" → "purchased Aventon Level 4")
   - **Superseded** — old state contradicted by new (handle via KG invalidation, not refiling)
3. **File only the delta** — do not re-file facts already captured in the old version

### For NEW files

1. Treat full content as candidate-new
2. **Still check for duplicates** — user may have manually filed key facts between exports
3. File verbatim content that passes dedupe check

### Stale Facts

When new state contradicts old (e.g., "Urtopia/Cowboy as e-bike finalists" in old → "Aventon Level 4 purchased" in new):
- **Invalidate** the old KG triple via `mempalace_kg_invalidate`
- **Do not** refile the superseded fact

## Ingestion Workflow

### Pre-flight

1. **Load the memoriki skill** if not already loaded: `/skill:memoriki`
2. **Locate the export directory** and confirm file count
3. **Get MemPalace taxonomy** to understand available wings/rooms:
   ```javascript
   mcp({ tool: "mempalace_mempalace_get_taxonomy", args: "{}" })
   ```
4. **Interview the user** on scope:
   - Full pass vs. highlights only?
   - Which wiki pages to create (if any)?
   - Any specific projects to prioritize or defer?

### Processing Pattern (Proven from May 13 2026)

**Use parallel subagents** with strict scope separation and a central consolidation step:

1. **Set up shared goals** for the team:
   - Goal 1: Process export into MemPalace (drawers + KG triples, dedupe first, verbatim content)
   - Goal 2: Create/update wiki pages where content earns a durable narrative reference
   - Goal 3: Consolidated journal (single log.md entry, index.md updates, MemPalace diary)

2. **Dispatch 3 parallel subagents** (use `subagent_dispatch` with `tasks` array):
   - **MemExp-Life** → global memory delta, personal/life projects (Vinny, wardrobe, Japanese, NYC trip, weight reduction, etc.)
   - **MemExp-Tech** → work/tech/AI projects (AI landscape, generative media, tech talks, certifications, Tribe updates)
   - **MemExp-Creative** → culinary, tea, music, bikes, nutrition, hobbies

3. **Subagent identity design:**
   - Each subagent gets a `system_prompt` that specifies:
     - **Scope:** exact list of files it owns (by project UUID or topic)
     - **Tools:** `read,write,edit,bash,mcp` (MCP for MemPalace tools)
     - **Rules:** must use `mempalace_mempalace_check_duplicate` before `mempalace_mempalace_add_drawer`; must NOT touch `wiki/index.md` or `wiki/log.md` (central consolidation only)
     - **Output format:** structured report (drawers added, KG triples added/invalidated, wiki pages created, skipped items, index.md catalog suggestions)

4. **Each subagent workflow:**
   - Read assigned files (old/new pairs or NEW files)
   - Diff old→new where applicable
   - For each candidate fact:
     - Call `mempalace_mempalace_check_duplicate` with the fact text
     - If not duplicate, call `mempalace_mempalace_add_drawer` with verbatim content, correct wing/room
   - Add KG triples for relationship-shaped facts (`mempalace_mempalace_kg_add`)
   - Invalidate stale KG triples where new state contradicts old (`mempalace_mempalace_kg_invalidate`)
   - Create wiki pages where content warrants a durable narrative reference (entities, concepts, sources, synthesis)
   - Update `entities/clemente-profile.md` if global memory delta includes profile-level changes (MemExp-Life only)
   - Return structured report to orchestrator

5. **Central consolidation** (orchestrator handles after subagents complete):
   - Update `wiki/index.md` with all new wiki pages (under correct sections: Entities, Concepts, Sources, Synthesis)
   - Append single consolidated entry to `wiki/log.md` covering all buckets
   - Write MemPalace diary entry (wing: `claude`, AAAK format, topic: e.g., `"may-13-claude-export-ingest"`)

### Why This Pattern Works

- **Parallel processing** → 3x faster than serial
- **Strict scope separation** → no file conflicts between subagents
- **Central index/log consolidation** → zero write conflicts on shared files
- **`mempalace_check_duplicate` gate** → safe parallel filing without coordination
- **Verbatim content** → preserves Claude's exact wording from export
- **Diff-first for old/new pairs** → avoids duplicate filing

## MemPalace Filing Conventions

### Wings by Topic

Use existing wings from taxonomy:
- **life** → personal projects, health, relationships, hobbies
- **work** → Tribe AI, career, professional development
- **tech** → self-hosting, servers, infrastructure
- **ai** → LLMs, Claude, agentic tools, AI landscape research
- **finance** → trading, credit cards, options, portfolio
- **style** → wardrobe, menswear, fashion
- **culinary** → food, cooking, tea, wine, restaurants
- **bikes** → e-bikes, cycling, fleet planning
- **japanese** → Japanese language, travel, culture
- **gaming** → League, Deadlock
- **culture** → broad cultural topics, music, violin (for now; consider a `music` wing if scope grows)

If a topic doesn't fit existing wings, propose a new wing to the user before filing.

### Room Selection

- Run `mempalace_mempalace_get_taxonomy` to see existing rooms within each wing
- **Reuse existing rooms** when content fits (e.g., `culinary/tea`, `bikes/fleet`, `style/wardrobe-planning`)
- **Propose new rooms** for new subtopics (e.g., `culture/violin-practice`, `ai/landscape-tracking`)

### Drawer Content

- **Verbatim** from the export — do not summarize or rephrase
- **Chunk size:** typically one "fact" or "topic paragraph" per drawer (50–300 words is common)
- **Title:** short, descriptive (3–8 words)

### Knowledge Graph Triples

Use `mempalace_mempalace_kg_add` for relationship-shaped facts:
- `(clemente, plays, violin)`
- `(clemente, owns, Aventon-Level-4)`
- `(Vinny, has-condition, CKD)`
- `(clemente, passed, Claude-Architect-Foundations)`
- `(clemente, evaluating, Hamilton-vs-docETL)`

Use `mempalace_mempalace_kg_invalidate` when new state contradicts old:
- Old: `(clemente, considering, Urtopia-e-bike)`
- New state: purchased Aventon Level 4
- Action: `mempalace_kg_invalidate` with reason "purchased Aventon Level 4 instead"

## Wiki Page Decisions

### When to Create a Wiki Page

Create a wiki page when:
- **Durable narrative reference** — the topic will be consulted/updated over time (e.g., Vinny health entity, bike fleet plan)
- **Cross-cutting synthesis** — brings together facts from multiple sources (e.g., AI landscape tracking framework)
- **Milestone documentation** — completed exams, major decisions, project completions (e.g., Claude Architect Foundations passed)

**Do not** create wiki pages for:
- Transient facts that fit cleanly in MemPalace drawers
- Single-use conversational topics
- Content that's already well-covered in `entities/clemente-profile.md`

### Wiki Page Types (from memoriki schema)

- **entities/** — people, companies, products, services (e.g., `vinny.md`, `violin-setup.md`)
- **concepts/** — ideas, patterns, frameworks (e.g., `two-bike-fleet-plan.md`, `gongfu-tea-practice.md`, `nutrition-framework.md`)
- **sources/** — summaries of ingested source documents (e.g., `claude-architect-foundations-2026-05.md`)
- **synthesis/** — cross-cutting analysis (e.g., `ai-landscape-tracking-framework.md`)

### Wiki Page Frontmatter

Every new wiki page **must** include YAML frontmatter:

```yaml
---
title: Page Title
type: entity|concept|source|synthesis
related: [[linked-page]], [[another-page]]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

**Do not** use `tags:` — the memoriki schema uses `related:` for wiki-links instead.

### Updating clemente-profile.md

**MemExp-Life subagent only** updates `entities/clemente-profile.md` with profile-level deltas from global memory:
- Legal entity name (e.g., "Tribe AI (legal entity: Mercury, Inc.)")
- Current devices (e.g., Pixel 9 Pro XL)
- Top-of-mind shifts (gRPC, HDBSCAN, Nextcloud Talk AI assistant, etc.)
- Equity changes (0.15% → 0.19%)
- New recurring projects or dropped interests

**Be surgical** — match the existing terse register. Do not pad or add unnecessary narrative.

### Do NOT Touch (Subagent Rules)

Subagents **must not** modify:
- `wiki/index.md` — central consolidation only
- `wiki/log.md` — central consolidation only
- `~/src/memoriki/memoriki/raw/` — immutable source documents
- The export source files themselves (e.g., `docs/may13-export/`) — read-only for the session

## Pitfalls to Avoid

### Bulk Importing Without Review

**Don't:** Feed entire files into MemPalace without reading and curating.

**Do:** Read each file, identify 8–20 high-value facts per project, skip trivially-duplicate or already-covered content.

### Summarizing Instead of Filing Verbatim

**Don't:** Rephrase or summarize Claude's export wording.

**Do:** File the exact wording from the export. MemPalace and wiki pages preserve Claude's voice.

### Stale Info That's Been Superseded

**Don't:** File old facts that the new state has contradicted (e.g., "considering Urtopia" when "purchased Aventon Level 4" is the new state).

**Do:** Use `mempalace_kg_invalidate` to mark the old fact as no longer true, with a reason (e.g., "purchased Aventon Level 4 instead").

### Copying Secrets

**Never** copy API keys, tokens, passwords, or other secrets into wiki pages or MemPalace drawers. Reference paths or environment variable names if needed, but not the values themselves.

### Forgetting to Dedupe

**Don't:** Add drawers without checking for duplicates first.

**Do:** Always call `mempalace_mempalace_check_duplicate` before `mempalace_mempalace_add_drawer`. This is load-bearing for parallel ingestion.

### Writing to index.md/log.md from Subagents

**Don't:** Let subagents update `wiki/index.md` or `wiki/log.md` directly (write conflicts).

**Do:** Have subagents report catalog suggestions; orchestrator consolidates centrally at the end.

## Examples from May 13 2026 Run

### Files Processed

**27 total files:**
- 1 global-memory pair
- 8 project old/new pairs
- 7 NEW-only projects

**Subagent distribution:**
- **MemExp-Life:** 6 files (global memory, Vinny, wardrobe, Japanese, NYC trip, weight reduction)
- **MemExp-Tech:** 4 files (AI landscape, AI gen media, Tech Talk, Claude Architect Prep)
- **MemExp-Creative:** 7 files (tea, nutrition, bikes, culinary, music, violin, options mechanics)

### Wiki Pages Created (8)

1. `entities/vinny.md` — canonical health profile (CKD, arthritis, open GI workup)
2. `entities/violin-setup.md` — instrument, bow, strings, rosin
3. `concepts/two-bike-fleet-plan.md` — utility vs. pleasure bike decision framework
4. `concepts/ai-landscape-tracking-framework.md` — four-pillar AI tracking model
5. `concepts/gongfu-tea-practice.md` — parameters, vessels, vendor map
6. `concepts/nutrition-framework.md` — principled food prioritization
7. `concepts/music-production-setup.md` — bass/production direction
8. `sources/claude-architect-foundations-2026-05.md` — exam passed, prep observations

### Profile Updates

Updated `entities/clemente-profile.md` with:
- Mercury Inc legal entity name
- Equity 0.15% → 0.19%
- Pixel 9 Pro XL device
- Top-of-mind: gRPC, HDBSCAN, Nextcloud Talk AI assistant, options Greeks, MPL 2.0, Aventon Level 4
- Link to new Vinny entity page

### Invalidated KG Triples

Example: `(clemente, considering-e-bike, Urtopia)` and `(clemente, considering-e-bike, Cowboy)` invalidated with reason "purchased Aventon Level 4 instead".

### MemPalace Diary Entry

Wing: `claude`  
Entry ID: `diary_wing_claude_20260514_201731_ffe08e4e336c`  
Topic: `may-13-claude-export-ingest`  
Format: AAAK (compressed memory dialect)

## Session Journal Template

After ingestion, append to `wiki/log.md`:

```markdown
## [YYYY-MM-DD] ingestion | Claude export {date} processed

- Processed {N} files from `docs/{date}-export/` (X old/new pairs, Y NEW projects, 1 global-memory pair)
- Created {N} new wiki pages: [[page-1]], [[page-2]], ...
- Updated [[clemente-profile]] with {brief summary of profile changes}
- Filed {N} MemPalace drawers across {N} wings
- Added {N} KG triples, invalidated {N} stale triples
- MemPalace diary entry: `{entry_id}`
```

## Reference Session

Full example session: `~/.pi/agent/sessions/--home-clemente-src-memoriki--/2026-05-15T03-03-44-602Z_019e2997-08da-7511-89e6-bae087c84fdd.jsonl`

This session demonstrates:
- User request: "can we process the may 13th claude export?"
- Questionnaire to clarify scope (full pass vs. highlights, wiki page creation rules)
- Parallel dispatch of 3 subagents with strict scope guards
- Central consolidation of index.md, log.md, and diary entry
- Structured reporting from each subagent
- End-to-end completion with all goals marked done

## Quick Command Reference

```bash
# Locate exports
find ~ -maxdepth 4 -type d -iname "*claude*export*" 2>/dev/null

# Count files in export
ls ~/src/memoriki/docs/may13-export/ | wc -l

# Get MemPalace taxonomy (via MCP)
mcp({ tool: "mempalace_mempalace_get_taxonomy", args: "{}" })

# Check for duplicate before adding drawer
mcp({ tool: "mempalace_mempalace_check_duplicate", args: '{"content": "fact text here"}' })

# Add drawer (verbatim content)
mcp({ tool: "mempalace_mempalace_add_drawer", args: '{"wing": "life", "room": "vinny-health", "title": "CKD stage progression", "content": "exact text from export"}' })

# Add KG triple
mcp({ tool: "mempalace_mempalace_kg_add", args: '{"subject": "clemente", "predicate": "owns", "object": "Aventon-Level-4"}' })

# Invalidate stale KG triple
mcp({ tool: "mempalace_mempalace_kg_invalidate", args: '{"subject": "clemente", "predicate": "considering-e-bike", "object": "Urtopia", "reason": "purchased Aventon Level 4 instead"}' })

# Write MemPalace diary entry (AAAK format)
mcp({ tool: "mempalace_mempalace_diary_write", args: '{"agent_name": "claude", "entry": "...", "topic": "may-13-claude-export-ingest"}' })
```

## Conventions from memoriki Skill

When filing to memoriki, always follow the patterns in `/skill:memoriki`:
- **Read first:** `wiki/index.md` to understand existing pages
- **Update always:** `wiki/index.md` after creating pages; append to `wiki/log.md` after operations
- **Use [[wiki-links]]** to connect related pages
- **Never modify** `memoriki/raw/` — immutable source documents
- **AAAK format** for diary entries — get spec via `mempalace_mempalace_get_aaak_spec` if needed

## Notes

- **Frontmatter drift:** Different subagents may use slightly different frontmatter conventions (`title:` vs. implicit H1, `tags:` vs. `related:`). Not a problem, but worth standardizing if you want strict schema compliance.
- **AAAK spec mismatch:** The MemPalace AAAK spec doc lists generic wing names (`wing_user`, `wing_agent`) but actual wings are more specific (`wing_claude`, `wing_pi-coding-agent`). Minor doc gap.
- **Source files preservation:** Export source files (e.g., `docs/may13-export/`) are left untouched after ingestion. Safe to re-process if needed, or archive/delete after confirming ingestion quality.
