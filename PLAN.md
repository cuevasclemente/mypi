# Plan: Claude Code (`claude -p`) as a Pi Model Provider

## Goal

Register `claude -p` (Claude Code headless mode) as a custom pi provider so that the user can select `--provider claude-code --model sonnet` (etc.) and have pi's LLM calls served by a `claude -p` subprocess. Goals:

1. **Subscription-rate billing**: the binary's traffic counts against the user's Claude Pro/Max quota, not the metered API or "extra usage" pool.
2. **Minimal system prompt**: pi's `context.systemPrompt` is the *entire* system prompt the model sees (Claude Code's default is fully suppressed via `--system-prompt-file`, not just appended to).
3. **ToS-clean**: never extract/proxy OAuth tokens; only invoke the official `claude` binary, which authenticates itself via `~/.claude/.credentials.json`. This is the path that survives the April 2026 third-party-tools enforcement.

Two phases:

- **Phase 1 (Delegation)**: `claude -p` runs as a sub-agent. Its own tools are enabled, pi's tools are *not* exposed. Pi's user prompt is sent in, a final text result is streamed back. Fastest path to a working provider; pi's tool loop and hooks are bypassed during a turn.
- **Phase 2 (MCP bridge)**: pi's tools are exposed to claude via an in-process MCP server. Claude uses *only* pi's tools (`--strict-mcp-config --tools "mcp__pi__*"`). Pi's agent loop and the headless model's tool-use are unified.

Phase 1 ships first and gets validated end-to-end before Phase 2 work begins.

---

## ToS / Billing Anchor

(Already validated in conversation; recapped here for the implementation session.)

- Subscription quota covers `claude -p` because it's the official Claude Code binary. Spec'd at `https://code.claude.com/docs/en/legal-and-compliance`: *"Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."*
- Third-party tools authenticating directly with subscription OAuth get billed to "extra usage" at API rates (April 4, 2026 policy). Subprocess-of-`claude -p` is **not** a third-party tool in that sense — it's pi orchestrating Claude Code, with Claude Code authenticating itself.
- **Implementation must:** scrub `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the subprocess env, otherwise auth flow #3 in `claude`'s credential ladder (api key) preempts the OAuth path and bills against the wrong tier. `CLAUDE_CODE_OAUTH_TOKEN` is fine to leave alone (subscription-tied).
- **Do not pass `--bare`** — it skips OAuth credential file reads (per `claude` docs and verified live).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  pi session                                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  ExtensionAPI.registerProvider("claude-code", {     │   │
│  │    api: "claude-code-headless",                     │   │
│  │    streamSimple: streamClaudeCode,    ◄────────┐    │   │
│  │    models: [sonnet, opus, haiku],              │    │   │
│  │  })                                            │    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                     │       │
│  When pi calls the model:                           │       │
│  ┌──────────────────────────────────────────────────▼────┐ │
│  │  streamClaudeCode(model, context, options)            │ │
│  │  ┌──────────────────────────────────────────────────┐ │ │
│  │  │  spawn child:                                    │ │ │
│  │  │    claude -p \                                   │ │ │
│  │  │      --output-format stream-json --verbose \     │ │ │
│  │  │      --input-format stream-json \                │ │ │
│  │  │      --model <id> \                              │ │ │
│  │  │      --system-prompt-file <tmpfile> \            │ │ │
│  │  │      --tools "" \              ◄── Phase 1       │ │ │
│  │  │      --no-session-persistence                    │ │ │
│  │  │  stdin: NDJSON user messages from context.msgs   │ │ │
│  │  │  stdout: NDJSON system/assistant/result events   │ │ │
│  │  └──────────────────────────────────────────────────┘ │ │
│  │      │                                                │ │
│  │      ▼                                                │ │
│  │  parse events → push pi events:                       │ │
│  │    "start" → "text_start" → "text_delta"* →           │ │
│  │    "text_end" → "done"                                │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

Phase 2 adds:

```
                                       ┌────────────────────┐
   claude -p ─── stdio MCP ───────────►│ pi-tools MCP server│
   --mcp-config pi-mcp.json            │ (in same process)  │
   --strict-mcp-config                 │ exposes context.   │
   --tools "mcp__pi__*"                │ tools to claude    │
                                       └────────────────────┘
```

---

## File layout

```
~/src/mypi/plugins/claude-code/
├── index.ts              # ExtensionAPI registration + streamSimple
├── stream-parser.ts      # claude -p stream-json → pi event mapping
├── subprocess.ts         # spawn helper: env scrub, lifecycle, signals
├── system-prompt.ts      # tmpfile management for --system-prompt-file
├── models.ts             # ProviderModelConfig array (sonnet/opus/haiku)
├── README.md             # local notes
└── (Phase 2)
    ├── mcp-bridge.ts     # in-process MCP server exposing context.tools
    └── mcp-config.ts     # generate the --mcp-config JSON
```

Install path (after working): symlink or copy `~/src/mypi/plugins/claude-code/` to `~/.pi/agent/extensions/claude-code/`. Confirmed pattern from `plugins/key-switcher/`.

---

## Phase 1 — Delegation provider

### 1.1 Model definitions (`models.ts`)

Pi requires `ProviderModelConfig` entries when models are defined. We register the three useful aliases plus full IDs.

```typescript
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// Cost set to 0 — subscription-billed traffic incurs no API charge.
// Token counts ARE reported (from claude -p's usage field) for visibility.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const CLAUDE_CODE_MODELS: ProviderModelConfig[] = [
  {
    id: "sonnet",
    name: "Claude Sonnet (via Claude Code)",
    reasoning: false,           // claude -p does not expose extended thinking control via CLI
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "opus",
    name: "Claude Opus (via Claude Code)",
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "haiku",
    name: "Claude Haiku (via Claude Code)",
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  // Explicit full IDs for users who want pinning
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (CC)",  reasoning: false, input: ["text","image"], cost: ZERO_COST, contextWindow: 200000, maxTokens: 8192 },
  { id: "claude-opus-4-7",   name: "Claude Opus 4.7 (CC)",    reasoning: false, input: ["text","image"], cost: ZERO_COST, contextWindow: 1000000, maxTokens: 8192 },
  { id: "claude-haiku-4-5",  name: "Claude Haiku 4.5 (CC)",   reasoning: false, input: ["text","image"], cost: ZERO_COST, contextWindow: 200000, maxTokens: 8192 },
];
```

### 1.2 Registration (`index.ts`)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_MODELS } from "./models.js";
import { streamClaudeCode } from "./stream.js";

const CLAUDE_CREDS = join(homedir(), ".claude/.credentials.json");

export default function claudeCodeProvider(pi: ExtensionAPI) {
  // Fail loud if there's no subscription OAuth — we don't want silent
  // fall-through to ANTHROPIC_API_KEY (which would bill the wrong tier).
  if (!existsSync(CLAUDE_CREDS)) {
    pi.log?.warn?.(
      `[claude-code] ${CLAUDE_CREDS} not found. ` +
        `Run \`claude\` once to log in before using this provider.`,
    );
  }

  pi.registerProvider("claude-code", {
    name: "Claude Code (subscription)",
    // baseUrl is required by ProviderConfig, but unused because we override
    // streamSimple — set to a sentinel so misconfiguration is obvious.
    baseUrl: "subprocess://claude",
    // apiKey is required when models are defined, but our streamSimple
    // ignores it. Resolver allows a literal value here.
    apiKey: "unused-subscription-oauth",
    api: "claude-code-headless",   // custom Api string — string & {} per types.d.ts:4
    models: CLAUDE_CODE_MODELS,
    streamSimple: streamClaudeCode,
  });
}
```

### 1.3 streamSimple (`stream.ts`)

The heart of the integration. Spawns `claude -p`, feeds `context.messages` as a single user prompt (Phase 1 — delegation), parses `stream-json` events, emits pi events.

```typescript
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

export function streamClaudeCode(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // ── Prepare system prompt tempfile ──────────────────────────────────
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-claude-code-"));
    const sysPromptPath = join(tmpDir, "system.txt");
    writeFileSync(sysPromptPath, context.systemPrompt ?? "", "utf-8");

    // ── Build argv ──────────────────────────────────────────────────────
    const args = [
      "-p",
      "--model", model.id,
      "--output-format", "stream-json",
      "--input-format",  "stream-json",
      "--verbose",                       // required for stream-json deltas
      "--system-prompt-file", sysPromptPath,  // REPLACE default Claude Code system prompt
      "--tools", "",                     // Phase 1: no tools — pure text generation
      "--no-session-persistence",        // do not write ~/.claude/projects/... JSONL
      "--include-partial-messages",      // line-by-line text deltas in stream
    ];

    // ── Scrub auth env vars to force subscription OAuth ─────────────────
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;

    // ── Spawn ───────────────────────────────────────────────────────────
    const child = spawn("claude", args, {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    options?.signal?.addEventListener("abort", () => {
      child.kill("SIGTERM");
    });

    stream.push({ type: "start", partial: output });

    // ── Serialize pi's messages to one user message (Phase 1) ───────────
    // Phase 2 will keep stdin open and stream messages turn-by-turn.
    const serialized = serializeMessages(context.messages);
    const userLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: serialized },
    });
    child.stdin.write(userLine + "\n");
    child.stdin.end();

    // ── Parse stream-json output ────────────────────────────────────────
    const textBlockIndex = output.content.push({ type: "text", text: "" }) - 1;
    stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });

    const rl = readline.createInterface({ input: child.stdout });
    let resultEnvelope: any = null;

    for await (const line of rl) {
      if (!line.trim()) continue;
      let evt: any;
      try { evt = JSON.parse(line); } catch { continue; }

      if (evt.type === "stream_event") {
        // Per-token text deltas (with --include-partial-messages)
        const d = evt.event;
        if (d?.type === "content_block_delta" && d.delta?.type === "text_delta") {
          const delta = d.delta.text as string;
          const block = output.content[textBlockIndex];
          if (block.type === "text") {
            block.text += delta;
            stream.push({ type: "text_delta", contentIndex: textBlockIndex, delta, partial: output });
          }
        }
        continue;
      }

      if (evt.type === "result") {
        resultEnvelope = evt;
        // result is the terminal event; loop will end naturally on EOF
        continue;
      }

      // system/init, assistant (full-turn), user (echo) — ignored in Phase 1
      // except for usage extraction below from the final result.
    }

    // ── Finalize ────────────────────────────────────────────────────────
    rmSync(tmpDir, { recursive: true, force: true });

    const textBlock = output.content[textBlockIndex];
    if (textBlock.type === "text") {
      stream.push({ type: "text_end", contentIndex: textBlockIndex, content: textBlock.text, partial: output });
    }

    if (resultEnvelope?.usage) {
      output.usage.input  = resultEnvelope.usage.input_tokens ?? 0;
      output.usage.output = resultEnvelope.usage.output_tokens ?? 0;
      output.usage.cacheRead  = resultEnvelope.usage.cache_read_input_tokens ?? 0;
      output.usage.cacheWrite = resultEnvelope.usage.cache_creation_input_tokens ?? 0;
      output.usage.totalTokens =
        output.usage.input + output.usage.output +
        output.usage.cacheRead + output.usage.cacheWrite;
      // cost stays 0 — subscription billing
    }

    if (resultEnvelope?.is_error) {
      output.stopReason = "error";
      output.errorMessage = resultEnvelope.result ?? "claude -p reported is_error: true";
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
      return;
    }

    output.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
  })().catch((err) => {
    // … push error event
  });

  return stream;
}

// ── Helpers ────────────────────────────────────────────────────────────

function serializeMessages(messages: Context["messages"]): string {
  // Phase 1: flatten pi's message history into one user-prompt string.
  // This is lossy for multi-turn agentic state but matches the
  // "delegation" model: claude sees the whole conversation and responds
  // to whatever the most recent user turn is asking.
  //
  // Phase 2 replaces this with native multi-turn stream-json input.
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      lines.push(`### User\n${text}`);
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      lines.push(`### Assistant\n${text}`);
    } else if (msg.role === "toolResult") {
      lines.push(`### Tool result\n${JSON.stringify(msg.content)}`);
    }
  }
  return lines.join("\n\n");
}
```

### 1.4 Auth precondition check

In `index.ts` at registration time, optionally also spawn `claude -p --output-format json "ping"` once with a 5-second timeout and inspect `apiKeySource`. If it's `"none"` we're on OAuth; if `"environment"` we're going to bill API instead → warn. Skip this on first install to avoid slowing startup; gate behind an env var like `PI_CLAUDE_CODE_VERIFY_AUTH=1`.

### 1.5 Smoke test

```bash
# After symlinking the extension into ~/.pi/agent/extensions/
pi --provider claude-code --model sonnet "say hello in three words"
```

Expected: a streamed text response, no tool calls, subscription quota unaffected by API spend dashboard.

---

## Phase 2 — MCP tool bridge

Phase 1 is delegation. Phase 2 makes claude use pi's tools instead of its own. This is what makes claude-code a "true model in pi" rather than a sub-agent.

### Why MCP

`claude -p` has no flag to accept tool definitions on the command line. The `--input-format stream-json` schema accepts only `user` messages, not tool defs. The only mechanism for injecting external tools is **MCP**. That's the seam we'll use.

### Architecture changes

1. **In-process MCP server** (`mcp-bridge.ts`): translates pi's `context.tools` (`Tool[]` with `{name, description, parameters}`) into MCP `ListTools` / `CallTool` over stdio. When claude calls one, the bridge yields the call back to pi's stream as a `toolcall_end` event. Pi runs the tool, hands the result back; bridge replies on the MCP socket.
2. **Spawn args change**:
   ```
   claude -p \
     --mcp-config <tmpfile.json> \
     --strict-mcp-config \
     --tools "mcp__pi__*" \
     --system-prompt-file <sys.txt> \
     --output-format stream-json --input-format stream-json --verbose
   ```
   `--strict-mcp-config` ensures user-level `.claude/mcp.json` doesn't leak in.
3. **`--tools "mcp__pi__*"`**: restricts claude to *only* pi's MCP-exposed tools (no built-in Read/Bash/Edit). All tools are namespaced `mcp__pi__<toolname>` per MCP convention.
4. **Stream parsing changes**: now handle `assistant` events with `tool_use` content blocks. Map `mcp__pi__<name>` back to `<name>`, emit pi's `toolcall_*` events. When pi returns a tool result (which happens *outside* the streamSimple call — pi resumes the stream), this Phase 1 single-shot subprocess model breaks down.
5. **Persistent subprocess**: because pi's tool loop spans multiple `streamSimple` calls in some agent loop, we need either:
   - **(a)** One subprocess per pi turn, with claude's session resumed via `--resume <session_id>`. Pi tracks the session ID in extension state. *Simpler; pi sees one streamSimple call = one claude turn.*
   - **(b)** One persistent subprocess for the whole pi conversation, with the bridge keeping stdin open and pi pumping tool-results back through MCP. Faster (no per-turn spawn cost) but requires the extension to maintain process state across registerProvider's per-call streamSimple.

   Recommended: **(a)** to keep the streamSimple contract simple. Session-resume cost is small.

### MCP server skeleton

```typescript
// mcp-bridge.ts (sketch)
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import type { Tool } from "@earendil-works/pi-ai";

export interface BridgeOpts {
  tools: Tool[];
  onCall: (name: string, args: any) => Promise<any>;
}

export function spawnPiMcpServer(opts: BridgeOpts): { pid: number; configPath: string } {
  // Either: fork a Node subprocess that hosts the MCP server
  //   (because claude -p needs to spawn the MCP server itself per --mcp-config)
  // Or: write an mcp-config that points to `node /path/to/this/bridge-server.js`
  //   with pi's tools serialized in env or argv.
  // Sketch deferred — see Phase 2 implementation notes.
}
```

The cleanest implementation packages the MCP server as a separate script (`bridge-server.js`) that pi's extension launches via `--mcp-config` JSON. The script reads tool defs from a temp file and forwards tool-call IPC back to pi over a Unix socket. Detailed wiring is a Phase 2 deliverable.

### Phase 2 acceptance

- `pi --provider claude-code --model sonnet "read package.json and tell me the dependencies"` invokes pi's `Read` tool (visible in pi's UI as a tool call), passes the result back through MCP to claude, claude responds with the analysis. No `claude -p` built-in tools invoked.
- `claude --mcp` traffic on the wire shows only `mcp__pi__*` tool calls.

---

## Phase 3 — Multi-turn session reuse (optional, low priority)

Currently each pi turn spawns a fresh `claude -p`. Anthropic's prompt caching at the edge helps with prefix reuse, but explicit session reuse via `--resume <session_id>` would be cleaner:

- Drop `--no-session-persistence`.
- After the first turn, capture `session_id` from the `system/init` event.
- On subsequent turns, add `--resume <session_id>` and send *only* the latest user message instead of the serialized history.
- Per-pi-session state lives in `~/.pi/agent/state/claude-code-sessions.json` keyed by pi's session/conversation ID.

Trade-off: claude's session JSONL files accumulate under `~/.claude/projects/<cwd-hash>/`. Add a cleanup hook.

Defer this until Phase 2 is stable.

---

## System prompt strategy

- **Flag**: `--system-prompt-file <tmpfile>` (replace), *not* `--append-system-prompt`. Justification: user explicitly wants pi's system prompt to be the entire prompt; appending leaks Claude Code's default scaffolding (~several thousand tokens). The Claude Code docs confirm `--system-prompt` replaces "the entire default prompt."
- **Why a file, not the string flag**: pi's system prompts are large (>1KB common) and contain newlines/special chars. The file flag avoids shell-escaping hazards and the ARG_MAX ceiling.
- **Future option**: expose `useAppendSystemPrompt: boolean` per model in `models.ts` for users who want Claude Code's defaults preserved (e.g., for tool-calling reliability in Phase 1 delegation mode). Default `false`.
- **What's still injected by `claude` despite `--system-prompt`**: per the docs, `--exclude-dynamic-system-prompt-sections` is *automatically applied* when `--system-prompt` is set — so cwd/git/env injections are suppressed. Tool definitions (in Phase 2 via MCP) still come through normally.

---

## Auth precondition

```typescript
// In index.ts startup
const CLAUDE_CREDS = join(homedir(), ".claude/.credentials.json");
if (!existsSync(CLAUDE_CREDS)) {
  // Warn but don't block — user might have CLAUDE_CODE_OAUTH_TOKEN env
  // var from a CI setup instead.
}
```

Optionally in Phase 2: at registration time run `claude -p --output-format json "."` with `--max-turns 1` and check `apiKeySource === "none"` from the result envelope; if it's `"environment"` we'd be paying API rates → log a clear warning.

---

## Implementation DAG

```
1.1 models.ts (independent)            ─┐
1.4 auth check stub (independent)      ─┤
1.2 index.ts (depends on 1.1, 1.3)      │ Phase 1
1.3 stream.ts (depends on 1.1)         ─┘
              │
              ▼ smoke test (1.5)
              │
              ▼
2.1 mcp-bridge.ts (depends on Phase 1)  ─┐ Phase 2
2.2 spawn args & stream parsing changes ─┘
              │
              ▼ smoke test (2.acceptance)
              │
              ▼
3.x session reuse (depends on 2)
```

Phases 1.1 / 1.3 / 1.4 can be parallelized via subagents during implementation. 1.2 depends on the exports of 1.1 and 1.3.

---

## Open questions / risks

1. **Custom `api` string acceptance**: docs say `Api` is `KnownApi | (string & {})`, so `"claude-code-headless"` should type-check. Verify the resolver doesn't try to instantiate a built-in client for unknown API strings before our `streamSimple` is dispatched. If it does, fall back to `api: "anthropic-messages"` (which has the right *shape* of expected behaviors even though we bypass the real Messages client).
2. **`baseUrl` / `apiKey` requirement when defining models**: docs say required. The values we set are sentinels because `streamSimple` overrides everything. Confirm registry doesn't reject sentinel values (e.g. URL parsing).
3. **`--include-partial-messages` event ordering**: stream-json docs note ordering is empirical, not contractual. Smoke-test that `stream_event` deltas arrive before the corresponding `assistant` event so our `text_delta` accumulation matches the final text.
4. **`--tools ""` semantics**: claude docs say `""` disables all tools. Phase 1 depends on this. If empty-string isn't honored on this binary version (`/usr/bin/claude` was v2.1.132 in research), use `--tools "Bash(echo *)"` as a degenerate no-op subset.
5. **stdin EOF semantics with `--input-format stream-json`**: closing stdin should terminate the turn. Verify; if not, send a sentinel or rely on `--max-turns 1`.
6. **Aborting via `options.signal`**: `SIGTERM` should be enough for a forked `claude` process; if not, escalate to `SIGKILL` after 1s.
7. **Image input**: the model defs claim `input: ["text", "image"]`. Phase 1's `serializeMessages` drops images. Either trim the declared input modes to `["text"]` for Phase 1, or implement the structured-content path (base64 inline) per the `--input-format stream-json` schema's image content block shape.
8. **Phase 2 MCP transport choice**: claude -p's MCP support uses stdio (each MCP server is a child process of claude). Our bridge needs to be either:
   - a separate `bridge-server.js` script invoked by claude, communicating back to pi over Unix socket / named pipe, or
   - hosted in pi's own process with stdio piped to claude — but claude controls MCP-server lifecycle, so this is awkward.
   Lean toward the script-invoked-by-claude pattern with a Unix socket back to pi.
9. **Cost reporting**: setting cost to 0 means pi's UI will show $0.00 for this provider. Token counts will be accurate. Acceptable per user goal (subscription billing) but worth a small note in pi's session log so users don't confuse it with "free".
10. **Tool name collision in Phase 2**: pi tools like `Read` and claude's native `Read` both exist. By using `--strict-mcp-config` + `--tools "mcp__pi__*"` we prevent claude from seeing its own tools — no collision. Verify with a smoke test that claude doesn't try to call its own `Read` and discover it's been hidden.

---

## Out of scope

- Auto-installation / package management for the extension (manual symlink for now, per the established pattern with key-switcher).
- Web UI surface (`pi-web-ui` integration). The provider registers via `ExtensionAPI` so any pi runtime — CLI or web — picks it up uniformly.
- Token refresh / OAuth login flow: handled entirely by the `claude` binary; pi never touches OAuth tokens.
- `/login claude-code` flow: not needed because there's no provider-level OAuth in pi for this provider. Users authenticate via `claude` directly.
