---
name: memoriki
description: Interact with Clemente's personal knowledge base — LLM wiki at ~/src/memoriki and MemPalace semantic memory via MCP tools. Use when reading from or writing to memoriki, searching past knowledge, adding facts, or journaling sessions.
---

# Memoriki

Clemente's personal knowledge base: an LLM wiki (`~/src/memoriki/memoriki/wiki/`) layered on a MemPalace semantic search + knowledge graph (`~/.mempalace/`). Two access paths: static wiki files via pi's built-in tools, and dynamic semantic memory via MCP tools.

## Quick Reference

| What you need | How to do it |
|---------------|--------------|
| Read a wiki page | `read ~/src/memoriki/memoriki/wiki/<path>.md` |
| Find something in the wiki | `read ~/src/memoriki/memoriki/wiki/index.md` (catalog), then read specific pages |
| Search all of Clemente's knowledge semantically | `mcp({ search: "query" })` or call `mempalace_search` |
| Check if content already exists before filing | `mempalace_check_duplicate` |
| File new content into MemPalace | `mempalace_add_drawer` |
| Query the knowledge graph (entities/relationships) | `mempalace_kg_query` |
| Add a fact to the knowledge graph | `mempalace_kg_add` |
| Mark a fact as no longer true | `mempalace_kg_invalidate` |
| Get chronological fact timeline | `mempalace_kg_timeline` |
| Write a session diary entry | `mempalace_diary_write` |
| Read past diary entries | `mempalace_diary_read` |
| Traverse connected ideas across domains | `mempalace_traverse` |
| Find rooms bridging two knowledge wings | `mempalace_find_tunnels` |
| Get full wing→room taxonomy | `mempalace_get_taxonomy` |
| Check palace status | `mempalace_status` |

## When to Use Memoriki

**Before giving personal recommendations** — always search MemPalace first for dietary restrictions, preferences, past experiences, etc.

**When something is unclear** — check memoriki before searching the web or guessing.

**After learning something durable** — file it into the wiki (for narrative/guide content) and/or MemPalace (for discrete, searchable facts).

**After completing significant work** — write a diary entry via `mempalace_diary_write` and consider updating relevant wiki pages.

## Wiki Structure

```
~/src/memoriki/memoriki/wiki/
├── index.md           # Catalog — read this first to find pages
├── log.md             # Append-only activity log
├── entities/          # People, companies, products
├── concepts/          # Ideas, patterns, frameworks
├── sources/           # Summaries of ingested source documents
└── synthesis/         # Cross-cutting analysis
```

### Wiki Operations

**Reading:** Always start with `wiki/index.md` to find relevant pages. Use [[wiki-links]] to navigate between pages.

**Writing a new wiki page:**
1. Create the `.md` file in the appropriate directory
2. Add YAML frontmatter:
   ```yaml
   ---
   title: Page Title
   type: entity|concept|source|synthesis
   related: [[linked-page]]
   created: YYYY-MM-DD
   updated: YYYY-MM-DD
   ---
   ```
3. Update `wiki/index.md` — add entry under correct section
4. Append to `wiki/log.md`: `## [YYYY-MM-DD] operation | Description`

**Updating an existing page:** Edit the `.md` file, update the `updated:` date in frontmatter, and log the change.

### Important Rules

- **NEVER modify files in `~/src/memoriki/memoriki/raw/`** — they are immutable source documents
- **ALWAYS update `wiki/index.md`** after creating or editing a wiki page
- **ALWAYS append to `wiki/log.md`** after wiki operations
- **Use [[wiki-links]]** to connect related pages
- **Never read credential files** — directories with `.agents-do-not-read` markers are off-limits

## MemPalace (MCP)

MemPalace provides semantic search and a knowledge graph over 670+ drawers across 11 wings.

### Wings (knowledge domains)

| Wing | Topics |
|------|--------|
| `ai` | LLMs, Claude, APIs, agentic tools |
| `tech` | Self-hosting, servers, Caddy, infra |
| `culinary` | Cooking, recipes, food science |
| `culture` | Broad cultural topics |
| `japanese` | Japan travel, language, culture |
| `style` | Fashion, menswear |
| `life` | Personal, Atlanta, home |
| `bikes` | E-bikes, cycling |
| `finance` | Credit cards, rewards |
| `gaming` | League, Deadlock |
| `work` | Career, employment |

### Writing to MemPalace

When filing content into MemPalace:
1. **Check for duplicates first** with `mempalace_check_duplicate`
2. Use `mempalace_add_drawer` with the right `wing` and `room`
3. For knowledge graph facts, use `mempalace_kg_add` with subject/predicate/object
4. Content should be verbatim — never summarize before filing

### AAAK Format

MemPalace uses AAAK, a compressed memory dialect:
- Entities: 3-letter codes (ALC=Alice, JOR=Jordan)
- Emotions: *markers* (*warm*, *fierce*, *raw*)
- Structure: pipe-separated fields
- Importance: ★ to ★★★★★
- Used primarily for diary entries

When writing diary entries via `mempalace_diary_write`, learn the AAAK spec first via `mempalace_get_aaak_spec`.

## MCP Access

The MemPalace MCP server is configured in `.mcp.json`. Access tools either:
- Via the `mcp` proxy tool: `mcp({ search: "query" })`, `mcp({ tool: "mempalace_search", args: '{"query": "..."}' })`
- For commonly-used tools, add `directTools` to the server config in `.mcp.json` to register them as first-class pi tools
