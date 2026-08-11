/**
 * Subagent Runner - Spawns pi subprocesses for agent execution
 *
 * Handles process spawning, JSON event parsing, streaming updates,
 * usage tracking, and abort propagation.
 *
 * Identities are designed by the orchestrator at dispatch time:
 * each task carries its own name + systemPrompt. There is no registry
 * of predefined agent identities — the orchestrator is responsible for
 * articulating the role, scope, and constraints for every subagent it
 * dispatches.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  BoundedByteAccumulator,
  PRIVILEGED_EXEC_PROTOCOL_VERSION,
  PRIVILEGED_EXEC_RESULT_MESSAGE,
  isPrivilegedExecCancelMessage,
  isPrivilegedExecRequestMessage,
  isPrivilegedExecResult,
  type PrivilegedExecOrigin,
  type PrivilegedExecRequest,
  type PrivilegedExecResult,
} from "./privileged-exec-protocol.js";
import {
  authorizeSubagentLaunch,
  sanitizedChildProcessEnvironment,
  validateChildPolicyGuardPath,
  type SubagentLaunchAuthorization,
} from "./companion-policy.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/**
 * Identity for a one-shot subagent.
 *
 * `name` is a short label used in logs / display only. The orchestrator should
 * choose something descriptive (e.g. "PdfScout-Downloads", "RouteAuditor").
 * `systemPrompt` is the body that defines the subagent's role and constraints —
 * it should be designed for the specific task at hand.
 */
export interface IdentitySpec {
  name: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
}

export interface SubagentExecutionPolicy {
  parentCwd: string;
  parentTools: string[];
  parentSessionId?: string;
  parentSessionFile?: string;
}

export interface SubagentResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SubagentResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Parent-owned privileged execution entrypoint for one-shot children.
 *
 * The runner constructs `origin` from its trusted call-site arguments. Child
 * IPC is deliberately unable to supply or override identity or lineage.
 */
export type OneShotPrivilegedExecHandler = (
  request: PrivilegedExecRequest,
  origin: PrivilegedExecOrigin,
  signal: AbortSignal,
) => Promise<PrivilegedExecResult>;

// ── Constants ───────────────────────────────────────────────────────────────

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
  usage: UsageStats,
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

// ── Pi invocation ───────────────────────────────────────────────────────────

function isPiEntrypointScript(scriptPath: string | undefined): boolean {
  if (!scriptPath) return false;
  const basename = path.basename(scriptPath).toLowerCase();
  if (/^pi(\.cmd|\.exe)?$/.test(basename)) return true;

  const normalized = scriptPath.split(path.sep).join("/");
  return (
    normalized.includes("/@earendil-works/pi-coding-agent/") ||
    normalized.includes("/pi-coding-agent/")
  );
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (
    currentScript &&
    !isBunVirtualScript &&
    fs.existsSync(currentScript) &&
    isPiEntrypointScript(currentScript)
  ) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

// ── Concurrency helper ────────────────────────────────────────────────────

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Temp prompt file ──────────────────────────────────────────────────────

async function writePromptToTempFile(
  name: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = name.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return { dir: tmpDir, filePath };
}

// ── One-shot privileged IPC ───────────────────────────────────────────────

function privilegedExecError(error: string): PrivilegedExecResult {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    stdoutBase64: "",
    stderrBase64: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    error,
  };
}

// ── Single agent execution ────────────────────────────────────────────────

export async function runSingleAgent(
  defaultCwd: string,
  identity: IdentitySpec,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SubagentResult[]) => SubagentDetails,
  privilegedExecHandler?: OneShotPrivilegedExecHandler,
  trustedParentLineage: readonly string[] = [],
  executionPolicy?: SubagentExecutionPolicy,
): Promise<SubagentResult> {
  const trimmedPrompt = identity.systemPrompt?.trim() ?? "";
  if (!trimmedPrompt) {
    return {
      agent: identity.name,
      task,
      exitCode: 1,
      messages: [],
      stderr: `Identity "${identity.name}" has empty system_prompt. The orchestrator must design the identity at creation time.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  if (!executionPolicy) {
    return {
      agent: identity.name,
      task,
      exitCode: 1,
      messages: [],
      stderr: "Companion policy context is unavailable; subagent launch denied.",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }
  const targetCwd = cwd ?? defaultCwd;
  const authorize = (): SubagentLaunchAuthorization => authorizeSubagentLaunch({
    parentCwd: executionPolicy.parentCwd,
    targetCwd,
    parentTools: executionPolicy.parentTools,
    requestedTools: identity.tools,
    parentSessionId: executionPolicy.parentSessionId,
    parentSessionFile: executionPolicy.parentSessionFile,
  });
  let launchAuthorization: SubagentLaunchAuthorization;
  try {
    launchAuthorization = authorize();
  } catch (error) {
    return {
      agent: identity.name,
      task,
      exitCode: 1,
      messages: [],
      stderr: error instanceof Error ? error.message : "Companion policy denied subagent launch.",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SubagentResult = {
    agent: identity.name,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: identity.model,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [
          { type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" },
        ],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    const tmp = await writePromptToTempFile(identity.name, trimmedPrompt);
    tmpPromptDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      // Final fail-closed check and option derivation at the process-creation
      // boundary. A newly protected project must remove risky tools before
      // argv is built, not merely update the propagated environment.
      const guardPath = validateChildPolicyGuardPath();
      launchAuthorization = authorize();
      const args: string[] = [
        "--mode", "json", "-p", "--no-session", "--no-extensions", "--extension", guardPath,
      ];
      if (identity.model) args.push("--model", identity.model);
      if (launchAuthorization.effectiveTools.length > 0) {
        args.push("--tools", launchAuthorization.effectiveTools.join(","));
      } else {
        args.push("--no-tools");
      }
      args.push("--append-system-prompt", tmpPromptPath!);
      args.push(`Task: ${task}`);
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: targetCwd,
        shell: false,
        env: sanitizedChildProcessEnvironment(launchAuthorization),
        // fd 3 is a dedicated Node IPC channel. stdin remains intentionally
        // ignored: privileged requests never share JSON/stdin transport.
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let buffer = "";
      const boundedStderr = new BoundedByteAccumulator();
      const privilegedRequests = new Map<string, AbortController>();
      const seenPrivilegedRequestIds = new Set<string>();
      const origin: PrivilegedExecOrigin = {
        mode: "one-shot",
        lineage: [...trustedParentLineage, identity.name],
      };

      const sendPrivilegedResult = (requestId: string, result: PrivilegedExecResult) => {
        if (typeof proc.send !== "function" || !proc.connected) return;
        proc.send({
          type: PRIVILEGED_EXEC_RESULT_MESSAGE,
          version: PRIVILEGED_EXEC_PROTOCOL_VERSION,
          requestId,
          result,
        }, () => { /* child exit/disconnect races are expected */ });
      };

      const abortPrivilegedRequests = () => {
        for (const controller of privilegedRequests.values()) controller.abort();
        privilegedRequests.clear();
      };

      proc.on("message", (message: unknown) => {
        if (isPrivilegedExecCancelMessage(message)) {
          const controller = privilegedRequests.get(message.requestId);
          if (controller) {
            privilegedRequests.delete(message.requestId);
            controller.abort();
            sendPrivilegedResult(message.requestId, privilegedExecError("privileged request cancelled"));
          }
          return;
        }
        // Exact protocol validation rejects child-asserted origin, lineage,
        // session, or identity fields as well as malformed requests.
        if (!isPrivilegedExecRequestMessage(message)) return;
        if (seenPrivilegedRequestIds.has(message.requestId)) {
          sendPrivilegedResult(message.requestId, privilegedExecError("duplicate privileged request id"));
          return;
        }
        seenPrivilegedRequestIds.add(message.requestId);
        let liveAuthorization: SubagentLaunchAuthorization;
        try {
          liveAuthorization = authorize();
        } catch {
          sendPrivilegedResult(message.requestId, privilegedExecError("companion policy denied privileged execution"));
          return;
        }
        if (!liveAuthorization.allowPrivilegedExec) {
          sendPrivilegedResult(message.requestId, privilegedExecError("sudo_exec is outside the propagated child tool policy"));
          return;
        }
        if (!privilegedExecHandler) {
          sendPrivilegedResult(message.requestId, privilegedExecError("parent privileged request handler is unavailable"));
          return;
        }

        const controller = new AbortController();
        privilegedRequests.set(message.requestId, controller);
        void privilegedExecHandler(message.request, origin, controller.signal)
          .then((result) => isPrivilegedExecResult(result)
            ? result
            : privilegedExecError("parent privileged request handler returned an invalid result"))
          .catch(() => privilegedExecError("parent privileged request handler failed"))
          .then((result) => {
            if (privilegedRequests.get(message.requestId) !== controller) return;
            privilegedRequests.delete(message.requestId);
            sendPrivilegedResult(message.requestId, result);
          });
      });

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        boundedStderr.append(data);
        currentResult.stderr = boundedStderr.toBuffer().toString("utf8");
      });

      proc.on("close", (code) => {
        abortPrivilegedRequests();
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        abortPrivilegedRequests();
        resolve(1);
      });
      proc.on("disconnect", abortPrivilegedRequests);

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          abortPrivilegedRequests();
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
          }, 5000).unref();
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}

// ── Parallel runner ───────────────────────────────────────────────────────

export interface ParallelTask {
  identity: IdentitySpec;
  task: string;
  cwd?: string;
}

export async function runParallelAgents(
  tasks: ParallelTask[],
  defaultCwd: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SubagentResult[]) => SubagentDetails,
  privilegedExecHandler?: OneShotPrivilegedExecHandler,
  trustedParentLineage: readonly string[] = [],
  executionPolicy?: SubagentExecutionPolicy,
): Promise<SubagentResult[]> {
  const allResults: SubagentResult[] = new Array(tasks.length);

  for (let i = 0; i < tasks.length; i++) {
    allResults[i] = {
      agent: tasks[i].identity.name,
      task: tasks[i].task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  }

  const emitParallelUpdate = () => {
    if (onUpdate) {
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      onUpdate({
        content: [
          {
            type: "text",
            text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
          },
        ],
        details: makeDetails([...allResults]),
      });
    }
  };

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const result = await runSingleAgent(
      defaultCwd,
      t.identity,
      t.task,
      t.cwd,
      undefined,
      signal,
      (partial) => {
        if (partial.details?.results[0]) {
          allResults[index] = partial.details.results[0];
          emitParallelUpdate();
        }
      },
      makeDetails,
      privilegedExecHandler,
      trustedParentLineage,
      executionPolicy,
    );
    allResults[index] = result;
    emitParallelUpdate();
    return result;
  });

  return results;
}

// ── Chain runner ──────────────────────────────────────────────────────────

export interface ChainStep {
  identity: IdentitySpec;
  task: string;
  cwd?: string;
}

export async function runChainAgents(
  chain: ChainStep[],
  defaultCwd: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SubagentResult[]) => SubagentDetails,
  privilegedExecHandler?: OneShotPrivilegedExecHandler,
  trustedParentLineage: readonly string[] = [],
  executionPolicy?: SubagentExecutionPolicy,
): Promise<SubagentResult[]> {
  const results: SubagentResult[] = [];
  let previousOutput = "";

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

    const chainUpdate: OnUpdateCallback | undefined = onUpdate
      ? (partial) => {
          const currentResult = partial.details?.results[0];
          if (currentResult) {
            const allResults = [...results, currentResult];
            onUpdate({
              content: partial.content,
              details: makeDetails(allResults),
            });
          }
        }
      : undefined;

    const result = await runSingleAgent(
      defaultCwd,
      step.identity,
      taskWithContext,
      step.cwd,
      i + 1,
      signal,
      chainUpdate,
      makeDetails,
      privilegedExecHandler,
      trustedParentLineage,
      executionPolicy,
    );
    results.push(result);

    const isErr =
      result.exitCode !== 0 ||
      result.stopReason === "error" ||
      result.stopReason === "aborted";
    if (isErr) {
      return results;
    }
    previousOutput = getFinalOutput(result.messages);
  }

  return results;
}
