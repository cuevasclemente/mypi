---
name: pi-extension-distribution
description: Package, install, and back up personal pi extensions, hooks, skills, agents, teams, and configuration from a source repo such as mypi into ~/.pi/agent safely and repeatably.
---

# pi Extension Distribution

## Setup
- Source repo is usually `~/src/mypi`; target pi context is `~/.pi/agent/`.
- Understand the artifact types: `extensions/`, `skills/`, `agents/`, `teams/`, hooks/monitors, and project config.
- Never read secrets. Distribution scripts may reference secret paths or env var names but must not copy secret contents unless explicitly designed for that.
- Prefer recoverable deletion and backups; never `rm -rf` user configuration without confirmation.

## Workflow
1. **Inventory source and target**
   - List source artifacts and the corresponding target paths.
   - Check for `.agents-do-not-read` or other secret markers.
   - Identify generated/build outputs that should not be installed.

2. **Design an install manifest**
   - Map each source path to a target path.
   - Decide whether install is copy, symlink, build-then-copy, or merge.
   - Include file mode requirements for executable hooks/scripts.

3. **Implement Makefile/script targets**
   - Use targets such as `make install`, `make backup`, `make diff`, and `make validate`.
   - Create target directories with `mkdir -p`.
   - Copy only allowlisted files.
   - Keep backups in a timestamped directory before replacing existing pi context files.

4. **Validate installed artifacts**
   - Run pi extension build/type checks if available.
   - Start pi in a safe project and confirm extensions load.
   - For hook changes, confirm the hook fires in a small test session.

5. **Journal and state tracking**
   - Record installed artifacts and target paths.
   - If this created durable pi behavior, journal it in project docs or Memoriki.

## Example Makefile shape
```make
PI_HOME ?= $(HOME)/.pi/agent
install-skills:
	mkdir -p $(PI_HOME)/skills
	cp -R skills/* $(PI_HOME)/skills/

install-extensions:
	mkdir -p $(PI_HOME)/extensions
	cp extensions/*.ts $(PI_HOME)/extensions/

validate:
	pi --version
```

## Common pitfalls
- Copying stale generated files over active extensions.
- Installing hooks without executable permissions or missing dependencies.
- Losing local edits in `~/.pi/agent`; always diff or back up first.
- Treating secrets as distributable config.

## Patterns from source sessions
- A distribution system was requested for `~/src/mypi` so pi configuration can be installed repeatably.
- Session-end checklist and sudo hook work required installing modified pi extensions/features into the user context.
- Accidental session deletion reinforced the need for backups and recoverable operations.