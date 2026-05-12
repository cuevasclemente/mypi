/**
 * Subagent Process Manager
 *
 * Manages long-lived pi subprocesses (RPC mode) for subagent communication.
 * The orchestrator (main agent) spawns, messages, polls, and stops subagents.
 *
 * Supports nested subagents: subagents can spawn their own subagents.
 * When a parent is stopped, all descendants are stopped recursively.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SubagentSpec {
  /** Unique ID for this subagent */
  id: string;
  /** Parent subagent ID (if spawned by another subagent) */
  parentId?: string;
  /** Agent configuration */
  agentName: string;
  /** System prompt for the subagent */
  systemPrompt: string;
  /** Tool list (comma-separated, passed to --tools) */
  tools?: string;
  /** Model override */
  model?: string;
  /** Working directory */
  cwd?: string;
}

export interface SubagentMessage {
  role: "assistant" | "toolResult";
  content: string;
  details?: any;
  timestamp: number;
}

export interface SubagentStatus {
  id: string;
  agentName: string;
  status: "idle" | "running" | "error" | "stopped";
  messages: SubagentMessage[];
  lastActivity: number;
  errorMessage?: string;
  parentId?: string;
  childIds: string[];
}

export interface SubagentSummary {
  id: string;
  agentName: string;
  status: "idle" | "running" | "error" | "stopped";
  messageCount: number;
  lastActivity: number;
  parentId?: string;
  childCount: number;
}

// ── Internal state ──────────────────────────────────────────────────────────

interface AgentState {
  spec: SubagentSpec;
  process: ChildProcess;
  status: SubagentStatus["status"];
  messages: SubagentMessage[];
  pendingResolve?: (msg: SubagentMessage | null) => void;
  buffer: string;
  tmpDir: string | null;
  tmpSpecPath: string | null;
}

// ── RPC protocol helpers ────────────────────────────────────────────────────

interface RpcRequest {
  type: string;
  message?: string;
  images?: any[];
}

function writeRpc(stdin: NodeJS.WritableStream | null, request: RpcRequest): void {
  if (!stdin) throw new Error("Subagent stdin not available");
  stdin.write(JSON.stringify(request) + "\n");
}

// ── Subagent Manager ────────────────────────────────────────────────────────

export type SubagentNotifyHandler = (agentId: string, content: string) => void;

export class SubagentManager {
  private agents = new Map<string, AgentState>();
  private notifyHandler?: SubagentNotifyHandler;

  /**
   * Set the handler called when a subagent's unsupervised turn finishes.
   * "Unsupervised" means no `send()` call is awaiting a reply — e.g., the
   * initial `sendAsync` from spawn, or a turn the subagent kicks off itself.
   * The handler receives the subagent's final assistant message so the
   * orchestrator can surface it without polling.
   */
  setNotifyHandler(handler: SubagentNotifyHandler | undefined): void {
    this.notifyHandler = handler;
  }

  // ── Tree helpers ───────────────────────────────────────────────────────

  /** Get direct children of an agent */
  private getChildren(agentId: string): string[] {
    const children: string[] = [];
    for (const [id, state] of this.agents) {
      if (state.spec.parentId === agentId) {
        children.push(id);
      }
    }
    return children;
  }

  /** Get all descendants (children, grandchildren, etc.) in pre-order */
  private getDescendants(agentId: string): string[] {
    const result: string[] = [];
    for (const childId of this.getChildren(agentId)) {
      result.push(childId);
      result.push(...this.getDescendants(childId));
    }
    return result;
  }

  /** Build a tree representation for listing */
  private buildTree(): Array<{ id: string; depth: number; state: AgentState }> {
    const roots: string[] = [];
    for (const [id, state] of this.agents) {
      if (!state.spec.parentId || !this.agents.has(state.spec.parentId)) {
        roots.push(id);
      }
    }

    const result: Array<{ id: string; depth: number; state: AgentState }> = [];
    const visit = (id: string, depth: number) => {
      const state = this.agents.get(id);
      if (!state) return;
      result.push({ id, depth, state });
      for (const childId of this.getChildren(id)) {
        visit(childId, depth + 1);
      }
    };

    for (const rootId of roots) {
      visit(rootId, 0);
    }
    return result;
  }

  // ── Spawn ──────────────────────────────────────────────────────────────

  /**
   * Spawn a new subagent using pi RPC mode.
   * The subagent stays alive and can receive follow-up prompts.
   * If parentId is provided, the subagent is registered as a child.
   * When the parent is stopped, all descendants are stopped recursively.
   */
  async spawn(spec: SubagentSpec): Promise<SubagentStatus> {
    if (this.agents.has(spec.id)) {
      throw new Error(`Subagent "${spec.id}" already exists`);
    }

    const args: string[] = ["--mode", "rpc", "--no-session"];
    if (spec.model) args.push("--model", spec.model);
    if (spec.tools) args.push("--tools", spec.tools);

    // Write system prompt to temp file
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-team-agent-"));
    const tmpSpecPath = path.join(tmpDir, "spec.md");

    await withFileMutationQueue(tmpSpecPath, async () => {
      await fs.promises.writeFile(tmpSpecPath, spec.systemPrompt, {
        encoding: "utf-8",
        mode: 0o600,
      });
    });

    args.push("--append-system-prompt", tmpSpecPath);

    const cwd = spec.cwd ?? process.cwd();
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: SubagentMessage[] = [];

    const agentState: AgentState = {
      spec: { ...spec },
      process: proc,
      status: "idle",
      messages,
      pendingResolve: undefined,
      buffer: "",
      tmpDir,
      tmpSpecPath,
    };

    this.agents.set(spec.id, agentState);

    // Parse RPC JSONL output
    let responseBuffer = "";

    proc.stdout.on("data", (data: Buffer) => {
      responseBuffer += data.toString();
      const lines = responseBuffer.split("\n");
      responseBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          this.handleRpcEvent(spec.id, event);
        } catch {
          // skip parse errors
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.trim()) {
        messages.push({
          role: "toolResult",
          content: `[stderr] ${text.trim()}`,
          timestamp: Date.now(),
        });
      }
    });

    proc.on("close", (code) => {
      if (agentState.status !== "stopped") {
        agentState.status = code === 0 ? "idle" : "error";
      }
      if (agentState.pendingResolve) {
        agentState.pendingResolve(null);
        agentState.pendingResolve = undefined;
      }
    });

    proc.on("error", (err) => {
      agentState.status = "error";
      agentState.messages.push({
        role: "toolResult",
        content: `Process error: ${err.message}`,
        timestamp: Date.now(),
      });
      if (agentState.pendingResolve) {
        agentState.pendingResolve(null);
        agentState.pendingResolve = undefined;
      }
    });

    return this.getStatus(spec.id);
  }

  /** Handle an event from an RPC subprocess */
  private handleRpcEvent(agentId: string, event: any): void {
    const state = this.agents.get(agentId);
    if (!state) return;

    if (event.type === "message_update" && event.assistantMessageEvent) {
      const e = event.assistantMessageEvent;
      if (e.type === "text_delta") {
        // Accumulated in message_end
      } else if (e.type === "tool_call") {
        state.messages.push({
          role: "assistant",
          content: `[tool_call: ${e.name}] ${JSON.stringify(e.arguments)}`,
          timestamp: Date.now(),
        });
      }
    }

    if (event.type === "message_end" && event.message) {
      const msg = event.message;
      if (msg.role === "assistant") {
        const text = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        if (text.trim()) {
          state.messages.push({
            role: "assistant",
            content: text,
            details: {
              usage: msg.usage,
              model: msg.model,
              stopReason: msg.stopReason,
            },
            timestamp: Date.now(),
          });
        }
      }
    }

    if (event.type === "agent_end") {
      state.status = "idle";
      const lastMsg = state.messages[state.messages.length - 1];
      if (state.pendingResolve) {
        // Someone is awaiting a reply (a `send` is pending) — deliver to them.
        state.pendingResolve(
          lastMsg ?? {
            role: "assistant" as const,
            content: "(no response)",
            timestamp: Date.now(),
          },
        );
        state.pendingResolve = undefined;
      } else if (lastMsg && lastMsg.role === "assistant" && lastMsg.content.trim() && this.notifyHandler) {
        // Unsupervised turn finished (e.g., the initial sendAsync from spawn).
        // Push the final message to the orchestrator so the human sees it without polling.
        try {
          this.notifyHandler(agentId, lastMsg.content);
        } catch {
          // ignore handler errors
        }
      }
    }
  }

  // ── Communication ──────────────────────────────────────────────────────

  /** Send a message to a subagent and wait for its response */
  async send(agentId: string, text: string): Promise<SubagentMessage | null> {
    const state = this.agents.get(agentId);
    if (!state) throw new Error(`Subagent "${agentId}" not found`);
    if (state.status === "stopped" || state.status === "error") {
      throw new Error(`Subagent "${agentId}" is ${state.status}`);
    }

    state.status = "running";

    return new Promise<SubagentMessage | null>((resolve) => {
      state.pendingResolve = resolve;

      try {
        writeRpc(state.process.stdin, { type: "prompt", message: text });
      } catch (err: any) {
        state.status = "error";
        resolve({
          role: "toolResult",
          content: `Failed to send: ${err.message}`,
          timestamp: Date.now(),
        });
      }
    });
  }

  /** Send a message without waiting for response (fire-and-forget) */
  async sendAsync(agentId: string, text: string): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) throw new Error(`Subagent "${agentId}" not found`);
    if (state.status === "stopped" || state.status === "error") {
      throw new Error(`Subagent "${agentId}" is ${state.status}`);
    }
    state.status = "running";
    writeRpc(state.process.stdin, { type: "prompt", message: text });
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Get the latest messages from a subagent (non-blocking) */
  getMessages(agentId: string): SubagentMessage[] {
    const state = this.agents.get(agentId);
    if (!state) return [];
    return [...state.messages];
  }

  /** Get messages since a given timestamp */
  getMessagesSince(agentId: string, since: number): SubagentMessage[] {
    const state = this.agents.get(agentId);
    if (!state) return [];
    return state.messages.filter((m) => m.timestamp >= since);
  }

  /** Get status of a specific subagent */
  getStatus(agentId: string): SubagentStatus {
    const state = this.agents.get(agentId);
    if (!state) {
      return {
        id: agentId,
        agentName: "unknown",
        status: "stopped",
        messages: [],
        lastActivity: 0,
        errorMessage: "Agent not found",
        childIds: [],
      };
    }
    return {
      id: agentId,
      agentName: state.spec.agentName,
      status: state.status,
      messages: [...state.messages],
      lastActivity:
        state.messages.length > 0
          ? state.messages[state.messages.length - 1].timestamp
          : 0,
      parentId: state.spec.parentId,
      childIds: this.getChildren(agentId),
    };
  }

  /** Get summary of all subagents as a flat list */
  list(): SubagentSummary[] {
    return Array.from(this.agents.entries()).map(([id, state]) => ({
      id,
      agentName: state.spec.agentName,
      status: state.status,
      messageCount: state.messages.length,
      lastActivity:
        state.messages.length > 0
          ? state.messages[state.messages.length - 1].timestamp
          : 0,
      parentId: state.spec.parentId,
      childCount: this.getChildren(id).length,
    }));
  }

  /**
   * Get a tree representation of all agents.
   * Returns entries with depth for indentation display.
   */
  listTree(): Array<{ id: string; depth: number; summary: SubagentSummary }> {
    return this.buildTree().map(({ id, depth, state }) => ({
      id,
      depth,
      summary: {
        id,
        agentName: state.spec.agentName,
        status: state.status,
        messageCount: state.messages.length,
        lastActivity:
          state.messages.length > 0
            ? state.messages[state.messages.length - 1].timestamp
            : 0,
        parentId: state.spec.parentId,
        childCount: this.getChildren(id).length,
      },
    }));
  }

  // ── Stop ───────────────────────────────────────────────────────────────

  /**
   * Stop a subagent and all its descendants (recursive cascade).
   * Children are stopped first, then the agent itself.
   */
  async stop(agentId: string): Promise<number> {
    const state = this.agents.get(agentId);
    if (!state) return 0;

    let stoppedCount = 0;

    // Recursively stop all descendants first
    for (const childId of [...this.getChildren(agentId)]) {
      stoppedCount += await this.stop(childId);
    }

    state.status = "stopped";

    // Resolve any pending promise
    if (state.pendingResolve) {
      state.pendingResolve({
        role: "toolResult",
        content: "Subagent stopped",
        timestamp: Date.now(),
      });
      state.pendingResolve = undefined;
    }

    // Kill the process
    try {
      state.process.stdin?.end();
      state.process.kill("SIGTERM");
      setTimeout(() => {
        if (!state.process.killed) {
          state.process.kill("SIGKILL");
        }
      }, 5000);
    } catch {
      // Process may already be dead
    }

    // Cleanup temp files
    if (state.tmpSpecPath) {
      try { fs.unlinkSync(state.tmpSpecPath); } catch { /* ignore */ }
    }
    if (state.tmpDir) {
      try { fs.rmdirSync(state.tmpDir); } catch { /* ignore */ }
    }

    this.agents.delete(agentId);
    stoppedCount++;
    return stoppedCount;
  }

  /** Stop all subagents. Descendants stopped first. */
  async stopAll(): Promise<number> {
    let totalStopped = 0;
    // Stop from leaves upward: find root agents and stop them (cascade handles children)
    const roots = Array.from(this.agents.keys()).filter(
      (id) => !this.agents.get(id)?.spec.parentId || !this.agents.has(this.agents.get(id)!.spec.parentId!),
    );
    for (const rootId of roots) {
      totalStopped += await this.stop(rootId);
    }
    // Clean up any orphans
    const remaining = Array.from(this.agents.keys());
    for (const id of remaining) {
      totalStopped += await this.stop(id);
    }
    return totalStopped;
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Check if a subagent exists */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /** Check if agentId is a descendant of potentialAncestor */
  isDescendant(agentId: string, potentialAncestor: string): boolean {
    const descendants = this.getDescendants(potentialAncestor);
    return descendants.includes(agentId);
  }

  /** Get the total count including all descendants */
  familySize(agentId: string): number {
    return 1 + this.getDescendants(agentId).length;
  }

  /** Wait for a subagent to become idle. Respects the provided AbortSignal for cancellation. */
  async waitForIdle(
    agentId: string,
    timeoutMs: number = 300000,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) throw new Error(`Subagent "${agentId}" not found`);
    if (state.status === "idle" || state.status === "stopped") return;

    await new Promise<void>((resolve, reject) => {
      let resolved = false;
      const finish = (err?: Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
        if (err) reject(err);
        else resolve();
      };

      const timeout = setTimeout(() => {
        finish(new Error(`Timeout waiting for subagent "${agentId}"`));
      }, timeoutMs);

      const abortListener = signal
        ? () => finish(new Error(`Wait for subagent "${agentId}" cancelled`))
        : null;
      if (signal) {
        if (signal.aborted) {
          finish(new Error(`Wait for subagent "${agentId}" cancelled`));
          return;
        }
        signal.addEventListener("abort", abortListener!, { once: true });
      }

      const check = () => {
        if (resolved) return;
        if (state.status === "idle" || state.status === "stopped") {
          finish();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }
}

// ── Pi invocation helper ──────────────────────────────────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}