/**
 * Agent Teams Extension
 *
 * Provides subagent management and orchestration for pi.
 *
 * Architecture:
 *   - The main pi agent IS the orchestrator.
 *   - Subagents are spawned as long-lived pi RPC subprocesses.
 *   - The orchestrator spawns, messages, polls, and stops subagents.
 *   - Identities are designed by the orchestrator at creation time —
 *     there is NO registry of predefined agent identities. Every
 *     spawn/dispatch carries a freshly-authored name + system prompt
 *     tailored to the task.
 *   - Goals guide long-horizon workflows.
 *
 * Tools:
 *   - subagent_spawn    : Create a long-lived subagent with a designed identity
 *   - subagent_send     : Send a message to a subagent
 *   - subagent_poll     : Poll a subagent for new messages/output
 *   - subagent_stop     : Stop a subagent
 *   - subagent_list     : List all running subagents
 *   - subagent_dispatch : One-shot parallel/chain dispatch (stateless)
 *   - goals_*           : Goal management tools
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type Goal,
  formatGoalsForPrompt,
} from "./goals.js";
import {
  SubagentManager,
  type SubagentSpec,
} from "./subagent-manager.js";
import {
  runParallelAgents,
  runChainAgents,
  runSingleAgent,
  type IdentitySpec,
  type SubagentDetails,
  type SubagentResult,
  formatUsageStats,
  getFinalOutput,
  MAX_PARALLEL_TASKS,
} from "./subagent-runner.js";

// ── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── State ──────────────────────────────────────────────────────────────
  const subagentManager = new SubagentManager();
  let goals: Goal[] = [];
  let nextGoalId = 1;

  // Wire up subagent → orchestrator notifications.
  // When a subagent prefixes its output with [NOTIFY], the message is queued
  // for the orchestrator's next turn so it sees it without polling.
  subagentManager.setNotifyHandler((agentId, content) => {
    try {
      pi.sendMessage(
        {
          customType: "subagent-notify",
          content: `[from subagent: ${agentId}]\n${content}`,
          display: true,
          details: { agentId, content },
        },
        { deliverAs: "nextTurn" },
      );
    } catch {
      // ignore — sendMessage may throw if session is shutting down
    }
  });

  pi.registerMessageRenderer("subagent-notify", (message, _options, theme) => {
    const details = (message as any).details as { agentId?: string; content?: string } | undefined;
    const agentId = details?.agentId ?? "subagent";
    const body = details?.content ?? message.content;
    const header = theme.fg("accent", theme.bold(`↑ notify from "${agentId}"`));
    return new Text(`${header}\n${theme.fg("toolOutput", body)}`, 0, 0);
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  function persistGoals(): void {
    pi.appendEntry("team-goals", { goals });
  }

  function restoreGoals(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    const goalEntry = entries
      .filter((e: any) => e.type === "custom" && e.customType === "team-goals")
      .pop() as { data?: { goals: Goal[] } } | undefined;
    if (goalEntry?.data?.goals) {
      goals = goalEntry.data.goals;
      nextGoalId = goals.length + 1;
    }
  }

  // ── Session events ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    restoreGoals(ctx);
  });

  pi.on("session_shutdown", async () => {
    await subagentManager.stopAll();
  });

  // ── Inject goals context ───────────────────────────────────────────────

  pi.on("before_agent_start", async () => {
    if (goals.length === 0) return;
    const activeGoals = goals.filter((g) => !g.completed);
    if (activeGoals.length === 0) return;

    const goalsText = formatGoalsForPrompt(activeGoals);
    return {
      message: {
        customType: "team-goals-context",
        content: `## Active Goals\n\n${goalsText}\n\nUse the \`goals\` tools to check, update, and manage progress on these goals.`,
        display: false,
      },
    };
  });

  // ── Commands ───────────────────────────────────────────────────────────

  pi.registerCommand("goals", {
    description: "List active goals",
    handler: async (_args, ctx) => {
      if (goals.length === 0) {
        ctx.ui.notify("No active goals. Use /goals:add to create one.", "info");
        return;
      }
      const lines = goals
        .map((g, i) => {
          const icon = g.completed ? "✓" : "○";
          const type = g.checkCommand ? "programmatic" : "qualitative";
          const progress = g.progress ? `\n   Progress: ${g.progress}` : "";
          return `${icon} [${i + 1}] ${g.description} (${type})${progress}`;
        })
        .join("\n\n");
      ctx.ui.notify(`Goals:\n\n${lines}`, "info");
    },
  });

  pi.registerCommand("goals:add", {
    description: "Add a new goal (description or description | checkCommand)",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /goals:add <description> [| <check command>]", "error");
        return;
      }

      const pipeIdx = args.indexOf("|");
      let description = args;
      let checkCommand: string | undefined;

      if (pipeIdx !== -1) {
        description = args.slice(0, pipeIdx).trim();
        checkCommand = args.slice(pipeIdx + 1).trim() || undefined;
      }

      const goal: Goal = {
        id: `goal-${nextGoalId++}`,
        description,
        checkCommand,
        completed: false,
        createdAt: Date.now(),
      };

      goals.push(goal);
      persistGoals();

      const type = checkCommand ? ` (check: \`${checkCommand}\`)` : " (qualitative)";
      ctx.ui.notify(`Goal added: ${description}${type}`, "success");
    },
  });

  pi.registerCommand("goals:done", {
    description: "Mark a goal as completed by index number",
    handler: async (args, ctx) => {
      const idx = parseInt(args?.trim() ?? "", 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= goals.length) {
        ctx.ui.notify(
          `Invalid goal index. Use /goals to see numbered goals. Current: ${goals.length} goal(s).`,
          "error",
        );
        return;
      }
      goals[idx].completed = true;
      goals[idx].completedAt = Date.now();
      goals[idx].progress = "Completed";
      persistGoals();
      ctx.ui.notify(`Goal marked complete: ${goals[idx].description}`, "success");
    },
  });

  pi.registerCommand("subagents", {
    description: "List active subagents",
    handler: async (_args, ctx) => {
      const tree = subagentManager.listTree();
      if (tree.length === 0) {
        ctx.ui.notify("No active subagents.", "info");
        return;
      }
      const indent = (depth: number) => "  ".repeat(depth) + (depth > 0 ? "└─ " : "");
      const lines = tree
        .map((entry) => {
          const s = entry.summary;
          const childrenStr = s.childCount > 0 ? ` [${s.childCount} child${s.childCount > 1 ? "ren" : ""}]` : "";
          return `${indent(entry.depth)}[${s.id}] ${s.agentName} - ${s.status} (${s.messageCount} msgs)${childrenStr}`;
        })
        .join("\n");
      ctx.ui.notify(`Active Subagents:\n\n${lines}`, "info");
    },
  });

  // ── Style-specific spawn-time guidance ──────────────────────────────────────────

  type SpawnStyle = "team-member" | "worker" | "minimal";

  /**
   * Produce the spawn-time augmentation appended to a subagent's system prompt.
   * Every style includes the universal end-of-turn-message-is-your-reply rule.
   * Beyond that, each style adds the coaching appropriate to its pattern.
   */
  function styleGuidance(style: SpawnStyle): string {
    const universal = [
      "",
      "",
      "## Reporting Back",
      "You are a subagent in a team coordinated by an orchestrator.",
      "",
      "At the end of each of your turns, your final assistant message is automatically delivered to whoever is listening:",
      "- If the orchestrator (or a teammate) is awaiting a direct reply to a message they sent you, your final message goes to them.",
      "- Otherwise (e.g., the initial task you were spawned with, or a turn you initiated), your final message is surfaced in the orchestrator's chat.",
      "",
      "Always end your turn with a clear, useful final message. That IS your report. Do not invent special markers or prefixes — the plumbing is automatic. Be concise; long monologues clutter the orchestrator's view.",
    ];

    if (style === "minimal") {
      return universal.join("\n");
    }

    if (style === "worker") {
      return universal
        .concat([
          "",
          "## Working Style: Service Worker",
          "You are a service-style worker, not a project owner. The orchestrator owns the decomposition; you handle one request at a time and reply to each one.",
          "",
          "How to operate:",
          "- After your initial acknowledgement, idle. Wait for the next message.",
          "- Each incoming message is a single, scoped request. Do exactly what is asked, nothing more.",
          "- Reply tersely. Confirmation, key result, file path written — that's usually enough.",
          "- If a request is ambiguous or out of your scope, say so briefly and stop. Do not improvise around it.",
          "- Do NOT create your own goal list. Goals don't fit this pattern — there is no project, just a stream of small requests.",
          "- Do NOT spawn your own subagents. You are a leaf in the tree.",
          "",
          "A good per-request reply often looks like:",
          "```",
          "Defined `serendipity` → ~/dict/serendipity.txt: <one-sentence definition>",
          "```",
        ])
        .join("\n");
    }

    // team-member (default)
    return universal
      .concat([
        "",
        "## Working Style: Team Member",
        "You own a substantial task. The orchestrator handed you a goal; you decide how to break it down and execute it.",
        "",
        "## Tracking Your Own Work With Goals",
        "You have access to the same `goals_add` / `goals_check` / `goals_update` / `goals_list` tools the orchestrator has. Your goal list is *your own* (independent of the orchestrator's).",
        "",
        "You are strongly encouraged to create your own goals as soon as you receive a non-trivial task:",
        "- Decompose the task into 2–6 concrete goals.",
        "- Use `check_command` for any goal that can be programmatically verified (file exists, test passes, grep finds X). Use qualitative goals for the rest.",
        "- As you work, run `goals_check` to see which programmatic goals have flipped to done.",
        "- Mark qualitative goals complete via `goals_update` when you finish them.",
        "",
        "Why this matters: at the end of each turn, your goal list is the natural skeleton of your report. Instead of inventing structure on the fly, glance at your goals and tell the orchestrator: which ones are done, which ones are blocked, which ones are still open. This makes your final message clear, honest, and easy for the orchestrator to act on.",
        "",
        "A good final message often looks like:",
        "```",
        "Done with the assigned work.",
        "✓ Goal 1: <short description> — verified by <check>",
        "✓ Goal 2: <short description>",
        "✗ Goal 3: <short description> — blocked because <reason>",
        "… Goal 4: <short description> — still in progress; next step is <X>",
        "```",
      ])
      .join("\n");
  }

  // ── Tool: subagent_spawn ───────────────────────────────────────────────

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: [
      "Spawn a new subagent as a long-lived process with a designed identity.",
      "The subagent runs autonomously in the background — spawn returns immediately.",
      "Send follow-up messages via subagent_send, poll for output via subagent_poll.",
      "There are NO predefined agent identities — you MUST design the subagent's identity",
      "at spawn time by writing a system_prompt that articulates its role, scope, and constraints.",
    ].join(" "),
    promptSnippet: "Spawn a long-lived subagent with a custom-designed identity and an initial task (returns immediately — use poll to check progress)",
    promptGuidelines: [
      "Design each subagent's identity for the specific task. The system_prompt should declare WHO this subagent is, WHAT it owns, and WHAT it must not do.",
      "Choose a descriptive id that reflects the role (e.g., 'pdf-scout-downloads', not 'agent-1').",
      "Subagents inherit no role memory — every spawn is a fresh identity.",
      "Spawn returns immediately — the subagent works in the background. Spawn ALL subagents first, then use subagent_poll to check progress.",
      "Active goals are automatically injected into the subagent's context. Use goals_add before spawning to define objectives.",
      "The subagent inherits your current model by default. Only override model when the user asks for a specific model or when the task needs special capabilities.",
      "Use subagent_send to communicate iteratively, subagent_poll to check progress, subagent_stop when done.",
      "For one-shot stateless work, prefer subagent_dispatch.",
      "Pick a `style` that matches the pattern: 'team-member' (default) for substantive owned work that decomposes into goals; 'worker' for narrow request/reply roles like a dictionary or thesaurus that don't have a project to plan; 'minimal' when your system_prompt already says everything needed and you want no auto-injected coaching.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description:
          "Unique, descriptive ID for this subagent (e.g., 'pdf-scout-downloads'). Used for routing messages.",
      }),
      parent_id: Type.Optional(
        Type.String({ description: "Parent subagent ID if spawned from another subagent" }),
      ),
      system_prompt: Type.String({
        description:
          "REQUIRED. The system prompt that designs this subagent's identity — its role, scope, constraints, and reporting format. Write it fresh for each spawn; do not assume a registry of predefined identities.",
      }),
      task: Type.String({ description: "Initial task for the subagent" }),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool names to allow" })),
      model: Type.Optional(Type.String({ description: "Model override for the subagent. Defaults to the orchestrator's current model." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
      style: Type.Optional(
        Type.Union(
          [Type.Literal("team-member"), Type.Literal("worker"), Type.Literal("minimal")],
          {
            description:
              "Coaching style for this subagent. 'team-member' (default): owns a substantial task, decomposes it into its own goals, reports goal-shaped status. 'worker': narrow role serving requests one-at-a-time, no goals, terse per-request replies. 'minimal': only the universal end-of-turn-message-is-your-reply rule; orchestrator owns all other guidance via system_prompt.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const systemPrompt = params.system_prompt?.trim();
      if (!systemPrompt) {
        return {
          content: [
            {
              type: "text",
              text:
                "subagent_spawn requires a non-empty 'system_prompt'. Design the subagent's identity (role, scope, constraints) explicitly at creation time — there are no predefined identities to reference.",
            },
          ],
          details: {},
          isError: true,
        };
      }

      // Validate parent exists if specified
      if (params.parent_id && !subagentManager.has(params.parent_id)) {
        return {
          content: [{ type: "text", text: `Parent subagent "${params.parent_id}" not found.` }],
          details: {},
          isError: true,
        };
      }

      // Inject active goals into the subagent's system prompt
      const activeGoals = goals.filter((g) => !g.completed);
      let enrichedPrompt = systemPrompt;
      if (activeGoals.length > 0) {
        const goalsContext = formatGoalsForPrompt(activeGoals);
        enrichedPrompt = `${systemPrompt}\n\n## Active Team Goals\nThe following goals are being tracked by the orchestrator. Work towards these goals as applicable to your scope.\n\n${goalsContext}`;
      }

      // Teach the subagent how reporting works (style-dependent).
      const style: SpawnStyle = (params.style as SpawnStyle | undefined) ?? "team-member";
      enrichedPrompt += styleGuidance(style);

      // Default model: use orchestrator's model if not specified
      const orchestratorModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const model = params.model || orchestratorModel;

      const spec: SubagentSpec = {
        id: params.id,
        parentId: params.parent_id,
        agentName: params.id,
        systemPrompt: enrichedPrompt,
        tools: params.tools,
        model,
        cwd: params.cwd || ctx.cwd,
      };

      try {
        const status = await subagentManager.spawn(spec);

        // Send initial task as fire-and-forget so multiple subagents can be spawned in parallel.
        // Use subagent_poll to check progress and get responses.
        await subagentManager.sendAsync(params.id, params.task);

        const updatedStatus = subagentManager.getStatus(params.id);

        return {
          content: [
            {
              type: "text",
              text: `Subagent "${spec.id}" (${spec.agentName}) spawned${spec.parentId ? ` as child of "${spec.parentId}"` : ""}.\nStatus: ${updatedStatus.status}\nUse subagent_poll to check progress and retrieve output.`,
            },
          ],
          details: { status: updatedStatus },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to spawn subagent: ${err.message}` }],
          details: {},
          isError: true,
        };
      }
    },
    renderCall(args, theme, _context) {
      const id = args.id || "...";
      const parentStr = args.parent_id ? theme.fg("muted", ` child of ${args.parent_id}`) : "";
      const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
      let text =
        theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", id) + parentStr;
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return new Text(`${icon} ${theme.fg("toolOutput", content.split("\n")[0])}`, 0, 0);
    },
  });

  // ── Tool: subagent_send ────────────────────────────────────────────────

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: [
      "Send a message to a running subagent and wait for its response.",
      "Use this to follow up, provide more context, or ask for revisions.",
    ].join(" "),
    promptSnippet: "Send a follow-up message to a running subagent",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent ID to send to" }),
      message: Type.String({ description: "Message to send to the subagent" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!subagentManager.has(params.id)) {
        return {
          content: [{ type: "text", text: `Subagent "${params.id}" not found. Use subagent_list to see active agents.` }],
          details: {},
          isError: true,
        };
      }

      try {
        const response = await subagentManager.send(params.id, params.message);
        if (!response) {
          return {
            content: [{ type: "text", text: `Subagent "${params.id}" did not produce a response. It may have stopped.` }],
            details: {},
          };
        }

        const status = subagentManager.getStatus(params.id);
        return {
          content: [
            {
              type: "text",
              text: `Response from "${params.id}":\n\n${response.content}`,
            },
          ],
          details: { status },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to send to subagent: ${err.message}` }],
          details: {},
          isError: true,
        };
      }
    },
    renderCall(args, theme, _context) {
      const preview = args.message
        ? args.message.length > 60
          ? `${args.message.slice(0, 60)}...`
          : args.message
        : "...";
      const text =
        theme.fg("toolTitle", theme.bold("send ")) +
        theme.fg("accent", args.id || "...") +
        theme.fg("dim", ` "${preview}"`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "→");
      if (expanded) return new Text(`${icon} ${theme.fg("toolOutput", content)}`, 0, 0);
      return new Text(`${icon} ${theme.fg("toolOutput", content.split("\n")[0])}`, 0, 0);
    },
  });

  // ── Tool: subagent_poll ────────────────────────────────────────────────

  pi.registerTool({
    name: "subagent_poll",
    label: "Poll Subagent",
    description: [
      "Check a subagent's status and retrieve new messages since last poll.",
      "Pass no 'id' to poll all subagents.",
      "Set wait:true with an id to block until the subagent finishes, then return full output.",
      "The orchestrator should poll subagents to monitor their progress.",
    ].join(" "),
    promptSnippet: "Check subagent status and retrieve new messages",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Subagent ID to poll. Omit to poll all." })),
      wait: Type.Optional(Type.Boolean({ description: "If true, block until the subagent is idle, then return full output. Only valid when 'id' is provided." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (params.id) {
        if (!subagentManager.has(params.id)) {
          return {
            content: [
              {
                type: "text",
                text: `Subagent "${params.id}" not found. Use subagent_list to see active agents.`,
              },
            ],
            details: {},
          };
        }

        // If wait is requested, block until idle, then return full output
        if (params.wait) {
          try {
            await subagentManager.waitForIdle(params.id, 300000, signal); // 5 min timeout, abortable
          } catch (err: any) {
            const status = subagentManager.getStatus(params.id);
            return {
              content: [{ type: "text", text: `${err.message}. Current status: ${status.status} (${status.messages.length} msgs).` }],
              details: { status },
              isError: true,
            };
          }

          const status = subagentManager.getStatus(params.id);
          const allMsgs = status.messages;
          const msgText = allMsgs
            .map((m) => `[${m.role}] ${m.content}`)
            .join("\n\n");

          return {
            content: [
              {
                type: "text",
                text: `## ${params.id} (${status.agentName}) — COMPLETE\nStatus: ${status.status}\nMessages: ${status.messages.length}\n\n${msgText || "(no output)"}`,
              },
            ],
            details: { status },
          };
        }

        // Quick poll — return recent messages
        const status = subagentManager.getStatus(params.id);
        const latestMsgs = status.messages.slice(-5);
        const msgText = latestMsgs
          .map((m) => `[${m.role}] ${m.content.slice(0, 200)}`)
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `## ${params.id} (${status.agentName})\nStatus: ${status.status}\nMessages: ${status.messages.length}\n\nRecent:\n${msgText || "(no messages yet)"}`,
            },
          ],
          details: { status },
        };
      }

      // Poll all
      const tree = subagentManager.listTree();
      if (tree.length === 0) {
        return {
          content: [{ type: "text", text: "No active subagents." }],
          details: {},
        };
      }

      const indent = (depth: number) => "  ".repeat(depth) + (depth > 0 ? "└─ " : "");
      const lines = tree.map((entry) => {
        const s = entry.summary;
        const status = subagentManager.getStatus(s.id);
        const lastMsg = status.messages[status.messages.length - 1];
        const preview = lastMsg
          ? lastMsg.content.slice(0, 80)
          : "(no messages)";
        const childrenStr = s.childCount > 0 ? ` [${s.childCount} child${s.childCount > 1 ? "ren" : ""}]` : "";
        return `${indent(entry.depth)}[${s.id}] ${s.agentName} - ${s.status} (${s.messageCount} msgs)${childrenStr} | Last: ${preview}`;
      });

      return {
        content: [{ type: "text", text: `Active Subagents:\n\n${lines.join("\n\n")}` }],
        details: { summaries: tree.map((e) => e.summary) },
      };
    },
    renderCall(args, theme, _context) {
      const id = args.id || "all";
      const text = theme.fg("toolTitle", theme.bold("poll ")) + theme.fg("accent", id);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      if (expanded) return new Text(theme.fg("toolOutput", content), 0, 0);
      const firstLine = content.split("\n")[0];
      const rest = content.split("\n").length - 1;
      return new Text(
        `${theme.fg("toolOutput", firstLine)}${rest > 0 ? theme.fg("dim", ` (+${rest} lines)`) : ""}`,
        0,
        0,
      );
    },
  });

  // ── Tool: subagent_stop ───────────────────────────────────────────────

  pi.registerTool({
    name: "subagent_stop",
    label: "Stop Subagent",
    description: "Stop a running subagent by ID. Use 'all' to stop all subagents.",
    promptSnippet: "Stop a running subagent",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent ID to stop, or 'all' to stop all" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (params.id === "all") {
        const list = subagentManager.list();
        await subagentManager.stopAll();
        return {
          content: [
            {
              type: "text",
              text: `Stopped ${list.length} subagent(s).`,
            },
          ],
          details: {},
        };
      }

      if (!subagentManager.has(params.id)) {
        return {
          content: [{ type: "text", text: `Subagent "${params.id}" not found.` }],
          details: {},
        };
      }

      const familySize = subagentManager.familySize(params.id);
      const status = subagentManager.getStatus(params.id);
      const stoppedCount = await subagentManager.stop(params.id);

      const cascade = familySize > 1 ? ` (${stoppedCount} total including descendants)` : "";

      return {
        content: [
          {
            type: "text",
            text: `Stopped subagent "${params.id}" (${status.agentName})${cascade}. ${status.messages.length} message(s) generated.`,
          },
        ],
        details: { finalStatus: status, stoppedCount, familySize },
      };
    },
    renderCall(args, theme, _context) {
      const text = theme.fg("toolTitle", theme.bold("stop ")) + theme.fg("accent", args.id || "...");
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return new Text(`${icon} ${theme.fg("toolOutput", content)}`, 0, 0);
    },
  });

  // ── Tool: subagent_list ────────────────────────────────────────────────

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List all active subagents with their status and message counts.",
    parameters: Type.Object({}),
    async execute() {
      const summaries = subagentManager.list();

      if (summaries.length === 0) {
        return {
          content: [{ type: "text", text: "No active subagents." }],
          details: { summaries: [] },
        };
      }

      const lines = summaries.map((s, i) => {
        return `${i + 1}. [${s.id}] ${s.agentName} - ${s.status} | ${s.messageCount} messages`;
      });

      const running = summaries.filter((s) => s.status === "running").length;
      const idle = summaries.filter((s) => s.status === "idle").length;

      return {
        content: [
          {
            type: "text",
            text: `Active Subagents: ${summaries.length} total (${running} running, ${idle} idle)\n\n${lines.join("\n")}`,
          },
        ],
        details: { summaries },
      };
    },
    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("list")), 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      return new Text(theme.fg("toolOutput", content), 0, 0);
    },
  });

  // ── Tool: subagent_dispatch (one-shot parallel/chain) ──────────────────

  const IdentityFields = {
    name: Type.String({
      description:
        "Short, descriptive label for this subagent (used in logs/UI), e.g. 'PdfScout-Downloads'.",
    }),
    system_prompt: Type.String({
      description:
        "Designed system prompt for this subagent. Articulate its role, scope, and constraints — there are no predefined identities to reference.",
    }),
    task: Type.String({ description: "Task to delegate" }),
    tools: Type.Optional(Type.String({ description: "Comma-separated tool names to allow" })),
    model: Type.Optional(Type.String({ description: "Model override for this subagent. Defaults to the orchestrator's current model." })),
    cwd: Type.Optional(Type.String({ description: "Working directory for the subprocess" })),
  };

  const TaskItem = Type.Object({
    name: IdentityFields.name,
    system_prompt: IdentityFields.system_prompt,
    task: IdentityFields.task,
    tools: IdentityFields.tools,
    model: IdentityFields.model,
    cwd: IdentityFields.cwd,
  });

  const ChainItem = Type.Object({
    name: IdentityFields.name,
    system_prompt: IdentityFields.system_prompt,
    task: Type.String({
      description: "Task. May include {previous} placeholder for prior step's output.",
    }),
    tools: IdentityFields.tools,
    model: IdentityFields.model,
    cwd: IdentityFields.cwd,
  });

  const parseTools = (tools?: string): string[] | undefined => {
    if (!tools) return undefined;
    const parsed = tools.split(",").map((t) => t.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : undefined;
  };

  pi.registerTool({
    name: "subagent_dispatch",
    label: "Dispatch Subagents",
    description: [
      "Dispatch tasks to one-shot subagents (single, parallel, or chain).",
      "Each task carries its own designed identity (name + system_prompt) — there are NO predefined identities.",
      "Use this for stateless work that doesn't need ongoing communication.",
      "For long-lived subagents with iterative messaging, use subagent_spawn/send/poll/stop.",
    ].join(" "),
    promptSnippet: "Dispatch one-shot subagents with custom-designed identities (single, parallel, or chain)",
    promptGuidelines: [
      "Design each subagent's identity at dispatch time: write a system_prompt that defines role, scope, and constraints for the specific task.",
      "Choose descriptive names (e.g., 'RouteAuditor', 'PdfScout-Downloads') — they appear in logs and help you track which subagent produced which result.",
      "Use parallel mode when subtasks are independent.",
      "Use chain mode when later steps depend on earlier output — pass context via the {previous} placeholder.",
      "Each subagent inherits your current model by default. Only override model when needed.",
      "For ongoing back-and-forth with a stateful subagent, use subagent_spawn instead.",
    ],
    parameters: Type.Object({
      name: Type.Optional(IdentityFields.name),
      system_prompt: Type.Optional(IdentityFields.system_prompt),
      task: Type.Optional(IdentityFields.task),
      tools: Type.Optional(IdentityFields.tools),
      model: Type.Optional(IdentityFields.model),
      cwd: Type.Optional(IdentityFields.cwd),
      tasks: Type.Optional(
        Type.Array(TaskItem, {
          description: "Array of {name, system_prompt, task, ...} for parallel execution",
        }),
      ),
      chain: Type.Optional(
        Type.Array(ChainItem, {
          description: "Array of {name, system_prompt, task, ...} for sequential execution",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.name && params.system_prompt && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SubagentResult[]): SubagentDetails => ({
          mode,
          results,
        });

      if (modeCount !== 1) {
        return {
          content: [
            {
              type: "text",
              text:
                "Invalid parameters. Provide exactly one mode:\n" +
                "  • single: name + system_prompt + task\n" +
                "  • parallel: tasks: [{name, system_prompt, task}, ...]\n" +
                "  • chain: chain: [{name, system_prompt, task}, ...]\n\n" +
                "Each task must carry its own designed identity (no predefined identities exist).",
            },
          ],
          details: makeDetails("single")([]),
          isError: true,
        };
      }

      // ── Helper: resolve model with orchestrator default ──
      const resolveModel = (explicit?: string): string | undefined => {
        if (explicit) return explicit;
        return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      };

      // ── Single mode ──
      if (hasSingle) {
        const identity: IdentitySpec = {
          name: params.name!,
          systemPrompt: params.system_prompt!,
          tools: parseTools(params.tools),
          model: resolveModel(params.model),
        };
        const result = await runSingleAgent(
          ctx.cwd,
          identity,
          params.task!,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
        );
        const isError =
          result.exitCode !== 0 ||
          result.stopReason === "error" ||
          result.stopReason === "aborted";
        const errorMsg =
          result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
        return {
          content: [
            {
              type: "text",
              text: isError
                ? `Agent ${result.stopReason || "failed"}: ${errorMsg}`
                : getFinalOutput(result.messages) || "(no output)",
            },
          ],
          details: makeDetails("single")([result]),
          isError,
        };
      }

      // ── Parallel mode ──
      if (hasTasks) {
        if (params.tasks!.length > MAX_PARALLEL_TASKS) {
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
            isError: true,
          };
        }

        const results = await runParallelAgents(
          params.tasks!.map((t) => ({
            identity: {
              name: t.name,
              systemPrompt: t.system_prompt,
              tools: parseTools(t.tools),
              model: resolveModel(t.model),
            },
            task: t.task,
            cwd: t.cwd,
          })),
          ctx.cwd,
          signal,
          onUpdate,
          makeDetails("parallel"),
        );

        const successCount = results.filter((r) => r.exitCode === 0).length;
        const summaries = results.map((r) => {
          const output = getFinalOutput(r.messages);
          const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
          return `[${r.agent}] ${r.exitCode === 0 ? "✓" : "✗"}: ${preview || "(no output)"}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `${successCount}/${results.length} subagents succeeded\n\n${summaries.join("\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      // ── Chain mode ──
      const results = await runChainAgents(
        params.chain!.map((c) => ({
          identity: {
            name: c.name,
            systemPrompt: c.system_prompt,
            tools: parseTools(c.tools),
            model: resolveModel(c.model),
          },
          task: c.task,
          cwd: c.cwd,
        })),
        ctx.cwd,
        signal,
        onUpdate,
        makeDetails("chain"),
      );

      const lastResult = results[results.length - 1];
      const hasError = results.some(
        (r) => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted",
      );

      if (hasError) {
        const errResult = results.find(
          (r) => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted",
        )!;
        const errorMsg =
          errResult.errorMessage || errResult.stderr || getFinalOutput(errResult.messages) || "(no output)";
        return {
          content: [
            {
              type: "text",
              text: `Chain stopped at step ${errResult.step} (${errResult.agent}): ${errorMsg}`,
            },
          ],
          details: makeDetails("chain")(results),
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: getFinalOutput(lastResult.messages) || "(no output)",
          },
        ],
        details: makeDetails("chain")(results),
      };
    },

    renderCall(args, theme, _context) {
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = (step.task ?? "").replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg("accent", step.name || "(unnamed)") +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = (t.task ?? "").length > 40 ? `${t.task.slice(0, 40)}...` : t.task ?? "";
          text += `\n  ${theme.fg("accent", t.name || "(unnamed)")}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const name = args.name || "...";
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", name);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError =
          r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const finalOutput = getFinalOutput(r.messages);

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
        if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;

        if (expanded) {
          text += `\n${theme.fg("muted", "─── Task ───")}\n${theme.fg("dim", r.task)}`;
          if (isError && r.errorMessage)
            text += `\n${theme.fg("error", r.errorMessage)}`;
          text += `\n${theme.fg("muted", "─── Output ───")}\n${theme.fg("toolOutput", finalOutput || "(no output)")}`;
          const usageStr = formatUsageStats(r.usage, r.model);
          if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        } else {
          if (isError && r.errorMessage)
            text += `\n${theme.fg("error", r.errorMessage)}`;
          else if (finalOutput)
            text += `\n${theme.fg("toolOutput", finalOutput.split("\n").slice(0, 3).join("\n"))}`;
          const usageStr = formatUsageStats(r.usage, r.model);
          if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        }
        return new Text(text, 0, 0);
      }

      // Parallel or chain mode
      const modeLabel = details.mode === "parallel" ? "parallel" : "chain";
      const successCount = details.results.filter((r) => r.exitCode === 0).length;
      const icon =
        successCount === details.results.length
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");

      let text =
        icon +
        " " +
        theme.fg("toolTitle", theme.bold(`${modeLabel} `)) +
        theme.fg("accent", `${successCount}/${details.results.length} tasks`);

      for (const r of details.results) {
        const rIcon =
          r.exitCode === -1
            ? theme.fg("warning", "⏳")
            : r.exitCode === 0
              ? theme.fg("success", "✓")
              : theme.fg("error", "✗");
        const stepLabel =
          details.mode === "chain" && r.step ? theme.fg("muted", `Step ${r.step}: `) : "";
        text += `\n  ${stepLabel}${theme.fg("accent", r.agent)} ${rIcon}`;
        const output = getFinalOutput(r.messages);
        if (output)
          text += ` ${theme.fg("dim", output.slice(0, 80))}`;
      }

      // Aggregate usage
      const totalUsage = details.results.reduce(
        (acc, r) => {
          acc.input += r.usage.input;
          acc.output += r.usage.output;
          acc.cacheRead += r.usage.cacheRead;
          acc.cacheWrite += r.usage.cacheWrite;
          acc.cost += r.usage.cost;
          acc.turns += r.usage.turns;
          return acc;
        },
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      );
      const usageStr = formatUsageStats(totalUsage);
      if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;

      return new Text(text, 0, 0);
    },
  });

  // ── Goals Tools ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "goals_list",
    label: "List Goals",
    description: "List all active goals and their status.",
    parameters: Type.Object({
      all: Type.Optional(
        Type.Boolean({ description: "Include completed goals. Default: false." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const showAll = params.all ?? false;
      const filtered = showAll ? goals : goals.filter((g) => !g.completed);

      if (filtered.length === 0) {
        return {
          content: [{ type: "text", text: "No goals defined. Use goals_add to create goals." }],
          details: {},
        };
      }

      const lines = filtered.map((g, i) => {
        const icon = g.completed ? "✓" : "○";
        const typeLabel = g.checkCommand ? ` [check: \`${g.checkCommand}\`]` : " [qualitative]";
        const progress = g.progress ? `\n   Progress: ${g.progress}` : "";
        return `${icon} ${i + 1}. ${g.description}${typeLabel}${progress}`;
      });

      const completed = goals.filter((g) => g.completed).length;
      const total = goals.length;

      return {
        content: [
          {
            type: "text",
            text: `Goals: ${completed}/${total} completed\n\n${lines.join("\n\n")}`,
          },
        ],
        details: { goals: filtered },
      };
    },
    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("goals list")), 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      return new Text(theme.fg("toolOutput", content), 0, 0);
    },
  });

  pi.registerTool({
    name: "goals_add",
    label: "Add Goal",
    description: [
      "Add a new goal for the agent team to work towards.",
      "Goals can be programmatic (with a check command that exits 0 when met) or qualitative.",
    ].join(" "),
    promptSnippet: "Add a goal with optional check command",
    promptGuidelines: [
      "Use goals_add to define long-horizon objectives for agent team workflows.",
      "Programmatic goals should have a check command that exits 0 when the goal is met.",
      "Qualitative goals should have clear, verifiable descriptions.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Goal description" }),
      check_command: Type.Optional(
        Type.String({
          description:
            "Bash command to check if goal is met (exit 0 = met). E.g., 'npm test', 'grep -q PASS ./results.txt'",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const goal: Goal = {
        id: `goal-${nextGoalId++}`,
        description: params.description,
        checkCommand: params.check_command,
        completed: false,
        createdAt: Date.now(),
      };

      goals.push(goal);
      persistGoals();

      const type = goal.checkCommand ? "programmatic" : "qualitative";
      return {
        content: [
          {
            type: "text",
            text: `Goal ${goals.length} added (${type}): ${goal.description}${goal.checkCommand ? `\nCheck: \`${goal.checkCommand}\`` : ""}`,
          },
        ],
        details: { goal },
      };
    },
    renderCall(args, theme, _context) {
      const preview = args.description
        ? args.description.length > 60
          ? `${args.description.slice(0, 60)}...`
          : args.description
        : "...";
      const text =
        theme.fg("toolTitle", theme.bold("goals add ")) + theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      return new Text(theme.fg("success", "✓ ") + theme.fg("toolOutput", content), 0, 0);
    },
  });

  pi.registerTool({
    name: "goals_check",
    label: "Check Goals",
    description: [
      "Check all programmatic goals by running their check commands.",
      "Goals whose check commands exit 0 are automatically marked complete.",
      "Qualitative goals must be manually marked complete via goals_update.",
    ].join(" "),
    promptSnippet: "Check programmatic goals by running their check commands",
    promptGuidelines: [
      "Use goals_check to verify programmatic goals after completing work.",
      "Programmatic goals are auto-marked complete when their check command exits 0.",
      "Qualitative goals require manual progress updates via goals_update.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Check a specific goal by index (1-based). Omit to check all." })),
    }),
    async execute(_toolCallId, params) {
      const toCheck = params.id
        ? (() => {
            const idx = parseInt(params.id, 10) - 1;
            if (isNaN(idx) || idx < 0 || idx >= goals.length) return [];
            return [goals[idx]];
          })()
        : [...goals];

      if (toCheck.length === 0) {
        return {
          content: [{ type: "text", text: "No goals to check." }],
          details: {},
        };
      }

      const results: string[] = [];
      for (const goal of toCheck) {
        if (goal.completed) {
          results.push(`✓ ${goal.description} (already completed)`);
          continue;
        }
        if (!goal.checkCommand) {
          results.push(`○ ${goal.description} (qualitative - cannot auto-check)`);
          continue;
        }

        try {
          const result = await pi.exec("bash", ["-c", goal.checkCommand], {
            timeout: 30000,
          });

          if (result.code === 0) {
            goal.completed = true;
            goal.completedAt = Date.now();
            goal.progress = `Auto-checked: ${result.stdout?.trim() || "(check passed)"}`;
            results.push(`✓ ${goal.description} - MET: ${result.stdout?.trim() || "(passed)"}`);
          } else {
            results.push(
              `○ ${goal.description} - NOT MET (exit ${result.code}): ${result.stderr?.trim() || result.stdout?.trim() || "(no output)"}`,
            );
          }
        } catch (err: any) {
          results.push(`✗ ${goal.description} - CHECK ERROR: ${err.message}`);
        }
      }

      persistGoals();

      const met = toCheck.filter((g) => g.completed).length;
      return {
        content: [
          {
            type: "text",
            text: `Checked ${toCheck.length} goal(s): ${met} met\n\n${results.join("\n")}`,
          },
        ],
        details: { results, goals: toCheck },
      };
    },
    renderCall(args, theme, _context) {
      const text =
        theme.fg("toolTitle", theme.bold("goals check")) +
        (args.id ? " " + theme.fg("accent", `#${args.id}`) : "");
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      return new Text(theme.fg("toolOutput", content), 0, 0);
    },
  });

  pi.registerTool({
    name: "goals_update",
    label: "Update Goal",
    description: [
      "Update a goal's status or progress notes.",
      "Use this to mark qualitative goals as complete or add progress notes.",
    ].join(" "),
    promptSnippet: "Update a goal's progress or mark it complete",
    parameters: Type.Object({
      index: Type.Number({ description: "Goal index (1-based) to update" }),
      progress: Type.Optional(Type.String({ description: "Progress note to set" })),
      completed: Type.Optional(
        Type.Boolean({ description: "Set to true to mark as complete, false to re-open" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const idx = params.index - 1;
      if (idx < 0 || idx >= goals.length || !goals[idx]) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid goal index ${params.index}. Use goals_list to see available goals (${goals.length} total).`,
            },
          ],
          details: {},
        };
      }

      const goal = goals[idx];
      if (params.completed !== undefined) {
        goal.completed = params.completed;
        if (params.completed) goal.completedAt = Date.now();
        else goal.completedAt = undefined;
      }
      if (params.progress !== undefined) {
        goal.progress = params.progress;
      }

      persistGoals();

      const status = goal.completed ? "✓ COMPLETED" : "○ IN PROGRESS";
      return {
        content: [
          {
            type: "text",
            text: `Goal ${params.index} updated: ${goal.description}\nStatus: ${status}\nProgress: ${goal.progress || "(none)"}`,
          },
        ],
        details: { goal },
      };
    },
    renderCall(args, theme, _context) {
      const text =
        theme.fg("toolTitle", theme.bold("goals update ")) + theme.fg("accent", `#${args.index}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return new Text(icon + " " + theme.fg("toolOutput", content), 0, 0);
    },
  });

  pi.registerTool({
    name: "goals_remove",
    label: "Remove Goal",
    description: "Remove a goal by index number.",
    parameters: Type.Object({
      index: Type.Number({ description: "Goal index (1-based) to remove" }),
    }),
    async execute(_toolCallId, params) {
      const idx = params.index - 1;
      if (idx < 0 || idx >= goals.length || !goals[idx]) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid goal index ${params.index}. Use goals_list to see available goals (${goals.length} total).`,
            },
          ],
          details: {},
        };
      }

      const removed = goals.splice(idx, 1)[0];
      persistGoals();

      return {
        content: [
          {
            type: "text",
            text: `Removed goal: ${removed.description}`,
          },
        ],
        details: { removed },
      };
    },
    renderCall(args, theme, _context) {
      const text =
        theme.fg("toolTitle", theme.bold("goals remove ")) + theme.fg("accent", `#${args.index}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      return new Text(theme.fg("toolOutput", content), 0, 0);
    },
  });
}