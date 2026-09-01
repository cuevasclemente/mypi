---
name: mailsearch-email-archive-operations
description: "Operate Clemente's self-hosted mailsearch/email-model stack: configure the Email Search MCP, triage Caddy/Authentik/API availability, repair Proton Bridge container issues, ingest latest IMAP exports safely, reindex OpenSearch/Qdrant when needed, and search the archive for order/warranty evidence without exposing mail credentials."
---

# Mailsearch Email Archive Operations

Use this skill when Clemente asks to bring mailsearch back up, add/use the mailsearch MCP, ingest recent email, or search historical email for receipts, warranties, orders, support threads, or account records.

## Setup

Primary paths on The-Sceptre/server-lattice:

- App repo: `/home/clemente/src/server-lattice/apps/email-model`
- Search UI/API: `email-search.service`, usually on `localhost:8044`
- Public hostname: `https://mailsearch.narwhalzero.net/` behind Caddy + Authentik
- MCP entry point: `uv run email-search-mcp` or installed `email-search-mcp`
- Ingest script: `scripts/ingest_files.py` and related package entry points
- Search indices: SQLite source DB, OpenSearch, and Qdrant semantic index
- Proton Bridge compose: `/home/clemente/src/server-lattice/nextcloud/all-in-one/protonmail-bridge-compose.yaml`
- Proton Bridge local image dir: `/home/clemente/src/server-lattice/nextcloud/all-in-one/protonmail-bridge-image/`

Never read or print mail credentials, Proton Bridge credential files, OAuth tokens, Matrix credentials, `.env` secrets, or browser profile cookies. It is OK to reference secret paths in configuration. For Proton login, ask Clemente to complete authentication directly in the relevant UI/container/session.

## Workflow

### 1. Load context and identify the request

Clarify which of these is needed:

- **Service health:** mailsearch page/API is down or returns the wrong response.
- **MCP setup:** add `email-search-mcp` to pi's MCP configuration.
- **Ingestion:** fetch latest mail into the archive.
- **Search:** find an email/order/warranty thread.

Use the relevant existing skills too:

- `service-health-check` for Caddy/Auth/backend triage.
- `mcp` for MCP configuration mechanics.
- `secret-safe-oauth-migration` if credential locations/configs change.

### 2. Triage mailsearch availability

Start with non-secret, layered checks:

```bash
curl -sI -m 10 https://mailsearch.narwhalzero.net/ | head -30
curl -fsS http://localhost:8044/api/stats | python -m json.tool | head -40
systemctl is-active email-search.service
systemctl status email-search.service --no-pager
```

Expected public behavior when unauthenticated is usually a Caddy/Authentik redirect (`302` to `auth.narwhalzero.net`) with `Via: 1.1 Caddy`. That means Caddy and forward-auth are alive, not necessarily that the user is logged in.

Check backing services:

```bash
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -Ei 'opensearch|qdrant|fulltext|mail|email'
curl -fsS http://127.0.0.1:9201/_cluster/health?pretty
ss -ltnp | grep -E ':(8044|9201|6333|1143|1025)\b'
```

For service logs:

```bash
journalctl -u email-search.service -n 100 --no-pager
journalctl -u caddy --since '1 hour ago' --no-pager | grep -i 'mailsearch\|8044\|bad gateway\|error' | tail -80
```

### 3. Configure the Email Search MCP

Find the authoritative app README first:

```bash
cd /home/clemente/src/server-lattice/apps/email-model
rg -n "email-search-mcp|MCP|mcpServers" README.md pyproject.toml src -g '!**/.venv/**'
```

Typical project MCP entry:

```json
{
  "mcpServers": {
    "mailsearch": {
      "command": "uv",
      "args": ["--directory", "/home/clemente/src/server-lattice/apps/email-model", "run", "email-search-mcp"],
      "lifecycle": "lazy"
    }
  }
}
```

After editing `.mcp.json`, reload/restart pi if the current session does not pick up new MCP servers dynamically. Then validate:

```text
mcp({ })
mcp({ connect: "mailsearch" })
mcp({ server: "mailsearch" })
```

Do not put credential values in `.mcp.json`. Use environment variables or wrapper scripts that read secrets at runtime when needed.

### 4. Search the archive safely

Prefer the MCP tool if available. Otherwise use the local HTTP API or app scripts. Keep search terms focused and avoid dumping large email bodies into the transcript.

Examples:

```bash
curl -G -fsS 'http://localhost:8044/api/search' \
  --data-urlencode 'q=HIFIMAN warranty replacement' \
  --data-urlencode 'limit=10' | python -m json.tool
```

When reporting results:

- Provide sender/domain, date, subject, and concise evidence.
- Do not paste private message bodies unless necessary and appropriate.
- Distinguish exact order evidence from related support/warranty discussion.

### 5. Ingest latest mail

First determine current coverage from stats or database metadata, without printing secrets. Then verify Proton Bridge IMAP is reachable:

```bash
ss -ltn '( sport = :1143 or sport = :1025 )'
docker ps --filter name=protonmail-bridge --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

If Proton Bridge requires authentication, stop and ask Clemente to re-authenticate directly. Do not ask for credentials in chat and do not read credential files.

Run ingestion from the app directory, using the project's documented command. Examples vary by deployment; inspect `README.md`, `pyproject.toml`, and `scripts/` first. A typical pattern is:

```bash
cd /home/clemente/src/server-lattice/apps/email-model
uv run python scripts/ingest_files.py --help
# or project-specific email-ingest command
```

If ingestion adds messages to SQLite, reindex OpenSearch for keyword/API search:

```bash
cd /home/clemente/src/server-lattice/apps/email-model
uv run python scripts/index_opensearch.py
curl -fsS http://localhost:8044/api/stats | python -m json.tool | head -40
```

Only update Qdrant/semantic vectors if needed; note that it can be slower/costlier than keyword reindexing.

### 6. Repair Proton Bridge container issues

Common failure: Bridge auto-updates and the inherited image lacks runtime libraries such as `libfido2.so.1`, `nc`, or `pkill`.

Inspect safely:

```bash
docker logs --tail 100 protonmail-bridge
cd /home/clemente/src/server-lattice/nextcloud/all-in-one
docker compose -f protonmail-bridge-compose.yaml ps
```

A known local derived image fix installs:

```dockerfile
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        libfido2-1 \
        netcat-openbsd \
        procps \
    && rm -rf /var/lib/apt/lists/*
```

Then rebuild/recreate:

```bash
cd /home/clemente/src/server-lattice/nextcloud/all-in-one
docker compose -f protonmail-bridge-compose.yaml build protonmail-bridge
docker compose -f protonmail-bridge-compose.yaml up -d protonmail-bridge
sleep 30
docker ps --filter name=protonmail-bridge --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

Healthy Bridge should expose IMAP/SMTP ports such as `1143` and `1025`. If the container says unhealthy only because `nc` is missing, fix the image or healthcheck rather than assuming auth failed.

### 7. Validation checklist

- `email-search.service` active.
- `http://localhost:8044/api/stats` returns JSON and expected email count.
- `mailsearch.narwhalzero.net` reaches Caddy/Authentik externally.
- OpenSearch cluster health is green or acceptable for the deployment.
- Qdrant is listening if semantic search is expected.
- Proton Bridge is healthy and listening when IMAP ingestion is needed.
- Search finds a known target before reporting success.
- If MCP was added, a fresh/reloaded pi session can list and call mailsearch tools.

## Reporting and journaling

For operational changes, journal what changed and where. Include:

- Services restarted/rebuilt.
- Image/package dependencies added.
- Email counts before/after ingestion.
- Which indexes were updated: SQLite/OpenSearch/Qdrant.
- Any user handoff for Proton auth.
- Any cleanup intentionally deferred.

Do not record secrets, private email body dumps, or credential values.
