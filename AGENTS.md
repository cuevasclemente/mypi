# Global Instructions

## API Tokens & Secrets

**Never read API keys, tokens, or secrets files directly.** If you need an API key, ask the user to provide it or set it as an environment variable. Key files (e.g., `exa_key`, `.env`, `credentials.json`) should only be referenced by path for configuration purposes — never `cat`'d or `read` for their contents. The user is responsible for placing secrets where the MCP server or tool can access them.

## Memoriki

When something is unclear, you need domain knowledge, or you're looking for patterns/conventions from past work, check memoriki first at `~/src/memoriki` before searching the web or guessing.

**Two access paths:**
- **Wiki** — static markdown files at `~/src/memoriki/memoriki/wiki/`. Start with `wiki/index.md` to find pages. Use `read`, `write`, `edit`.
- **MemPalace** — semantic search + knowledge graph via MCP tools (`mempalace_search`, `mempalace_kg_query`, `mempalace_add_drawer`, etc.). Use the `mcp` proxy tool or direct tools.

Load the full memoriki skill with `/skill:memoriki` for detailed guidance.

## Communication Style

When working through features or tasks, surface questions you have to the user rather than guessing what they want. It's better to ask for clarification than to make assumptions.

## ExaSearch

When researching unfamiliar concepts, APIs, libraries, or technologies, use ExaSearch (`exasearch` MCP tools) to find current documentation and relevant context. This is preferred over relying solely on training data, especially for newer or rapidly-changing topics.

## Hook System

This project uses an agent-monitor extension (.pi/extensions/agent-monitor.ts). At the end of each agent turn, a lightweight monitor model evaluates whether the work completed represents a meaningful milestone. When triggered, it will inject a reminder to journal the work and update memoriki. You don't need to act on those reminders yourself — the monitor handles injection. But know that the journal reminder means significant work was detected.
