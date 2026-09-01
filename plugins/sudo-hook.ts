import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  BoundedByteAccumulator,
  PRIVILEGED_EXEC_CANCEL_MESSAGE,
  PRIVILEGED_EXEC_LIMITS,
  PRIVILEGED_EXEC_PROTOCOL_VERSION,
  PRIVILEGED_EXEC_REQUEST_MESSAGE,
  PRIVILEGED_EXEC_RESULT_MESSAGE,
  assertPrivilegedExecRequest,
  isPrivilegedExecCancelMessage,
  isPrivilegedExecRequestMessage,
  isPrivilegedExecResultMessage,
  privilegedExecRuntimeRegistry,
  type PrivilegedExecBrokerRuntime,
  type PrivilegedExecOrigin,
  type PrivilegedExecRequest,
  type PrivilegedExecResult,
} from "./agent-teams/privileged-exec-protocol.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSWORD_ATTEMPTS = 3;
const SUDO_PATH = "/usr/bin/sudo";
const PIN_NAME = "command-guard-identity-pin";
const PIN_ACCESS_RE = new RegExp(`(?:${PIN_NAME}|PI_COMMAND_GUARD_IDENTITY_PIN)`, "i");

type WebOptions = {
  executable: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  origin: PrivilegedExecOrigin;
};

interface WebSudoBridge {
  requestPassword(sessionId: string, prompt: string, timeoutMs?: number, options?: WebOptions): Promise<string | null>;
  requestApproval(sessionId: string, prompt: string, timeoutMs?: number, options?: WebOptions): Promise<boolean>;
  cancelSession?(sessionId: string): void;
}

function runtimeKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId()
    ?? ctx.sessionManager.getSessionFile()
    ?? `ephemeral:${process.pid}:${ctx.cwd}`;
}

function webSessionId(ctx: ExtensionContext): string | null {
  const managerMap = (globalThis as any).__pi_sudo_session_managers as WeakMap<object, string> | undefined;
  if (managerMap) return managerMap.get(ctx.sessionManager as object) ?? null;
  const piMap = (globalThis as any).__pi_sudo_pi_sessions as Map<string, string> | undefined;
  const fileMap = (globalThis as any).__pi_sudo_session_files as Map<string, string> | undefined;
  const id = ctx.sessionManager.getSessionId();
  if (id && piMap?.has(id)) return piMap.get(id)!;
  const file = ctx.sessionManager.getSessionFile();
  if (file && fileMap?.has(file)) return fileMap.get(file)!;
  return null;
}

function webBridge(): WebSudoBridge | null {
  return ((globalThis as any).__pi_sudo_bridge as WebSudoBridge | undefined) ?? null;
}

function displayRequest(request: PrivilegedExecRequest, origin: PrivilegedExecOrigin): string {
  const argv = request.argv.map((value, index) => `argv[${index + 1}]: ${JSON.stringify(value)}`).join("\n") || "(no arguments)";
  const lineage = origin.lineage.length ? origin.lineage.join(" → ") : "parent session";
  return `Executable: ${request.executable}\n${argv}\nWorking directory: ${request.cwd}\nTimeout: ${request.timeoutMs} ms\nOrigin: ${origin.mode} (${lineage})`;
}

function rawSudoLikely(command: string): boolean {
  return /(^|[\s;&|()])(?:[^\s;&|()]*\/)?sudo(?=$|[\s;&|()])/m.test(command);
}

function boundedError(message: string): string {
  const bytes = Buffer.from(message || "privileged execution failed", "utf8");
  return bytes.subarray(0, PRIVILEGED_EXEC_LIMITS.maxErrorBytes).toString("utf8") || "privileged execution failed";
}

function errorResult(message: string): PrivilegedExecResult {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    stdoutBase64: "",
    stderrBase64: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    error: boundedError(message),
  };
}

async function validateExecutable(request: PrivilegedExecRequest): Promise<void> {
  assertPrivilegedExecRequest(request);
  const [actualExecutable, actualCwd] = await Promise.all([
    realpath(request.executable),
    realpath(request.cwd),
  ]);
  if (actualExecutable !== request.executable) throw new Error("Executable path must be canonical and may not be a symlink");
  if (actualCwd !== request.cwd) throw new Error("Working directory path must be canonical and may not be a symlink");

  const [executableStat, cwdStat] = await Promise.all([stat(actualExecutable), stat(actualCwd)]);
  if (!executableStat.isFile()) throw new Error("Executable must be a regular file");
  if (executableStat.uid !== 0) throw new Error("Executable must be owned by root");
  if ((executableStat.mode & 0o022) !== 0) throw new Error("Executable must not be group- or world-writable");
  if ((executableStat.mode & 0o111) === 0) throw new Error("Executable is not executable");
  if (!cwdStat.isDirectory()) throw new Error("Working directory is not a directory");
}

function runSudoValidation(password: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(SUDO_PATH, ["-k", "-S", "-p", "", "-v"], {
      cwd,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const abort = () => { child.kill("SIGTERM"); finish(false); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(`${password}\n`);
  });
}

function invalidateTimestamp(cwd: string): void {
  try {
    const child = spawn(SUDO_PATH, ["-k"], { cwd, shell: false, stdio: "ignore", env: process.env });
    child.unref();
  } catch {}
}

function executeDirect(
  request: PrivilegedExecRequest,
  password: string,
  signal?: AbortSignal,
): Promise<PrivilegedExecResult> {
  return new Promise((resolve) => {
    const stdout = new BoundedByteAccumulator();
    const stderr = new BoundedByteAccumulator();
    let settled = false;
    let timedOut = false;
    let child: ChildProcessWithoutNullStreams;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: PrivilegedExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      invalidateTimestamp(request.cwd);
      resolve(result);
    };
    const terminate = () => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };
    const abort = () => terminate();

    try {
      child = spawn(SUDO_PATH, ["-k", "-S", "-p", "", "--", request.executable, ...request.argv], {
        cwd: request.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      finish(errorResult(error instanceof Error ? error.message : String(error)));
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    timer.unref?.();

    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(`${password}\n`);
    child.on("error", (error) => finish(errorResult(error.message)));
    child.on("close", (code, closeSignal) => {
      const out = stdout.result();
      const err = stderr.result();
      if (timedOut || signal?.aborted) {
        finish({
          ok: false,
          exitCode: code,
          signal: closeSignal,
          stdoutBase64: out.base64,
          stderrBase64: err.base64,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          error: timedOut ? "privileged execution timed out" : "privileged execution cancelled",
        });
        return;
      }
      finish({
        ok: true,
        exitCode: code,
        signal: closeSignal,
        stdoutBase64: out.base64,
        stderrBase64: err.base64,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        error: null,
      });
    });
  });
}

export default function (pi: ExtensionAPI) {
  let activeCtx: ExtensionContext | null = null;
  let activeKey: string | null = null;
  let cachedPassword: string | null = null;
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let shuttingDown = false;
  const upstreamPending = new Map<string, {
    resolve: (result: PrivilegedExecResult) => void;
    abort?: () => void;
  }>();

  const clearPassword = () => {
    cachedPassword = null;
    if (cacheTimer) clearTimeout(cacheTimer);
    cacheTimer = null;
  };

  const rememberPassword = (password: string) => {
    clearPassword();
    cachedPassword = password;
    cacheTimer = setTimeout(clearPassword, CACHE_TTL_MS);
    cacheTimer.unref?.();
  };

  async function promptPassword(ctx: ExtensionContext, request: PrivilegedExecRequest, origin: PrivilegedExecOrigin, message: string): Promise<string | null> {
    const bridge = webBridge();
    const sessionId = webSessionId(ctx);
    const options: WebOptions = { ...request, argv: [...request.argv], origin: { mode: origin.mode, lineage: [...origin.lineage] } };
    if (bridge && sessionId) return bridge.requestPassword(sessionId, message, 120_000, options);
    if (!ctx.hasUI) return null;
    return (await ctx.ui.custom<string | null>((tui, theme, _keys, done) => {
      let buffer = "";
      return {
        render() {
          return [
            theme.bold(message),
            "",
            ...displayRequest(request, origin).split("\n").map((line) => theme.fg("dim", line)),
            "",
            `${"•".repeat(buffer.length)}${theme.fg("accent", "▌")}`,
            "",
            theme.fg("dim", "Enter to confirm, Escape to cancel"),
          ];
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, Key.enter)) return done(buffer || null);
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(null);
          if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
            buffer = buffer.slice(0, -1);
            tui.requestRender();
            return;
          }
          if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127) {
            buffer += data;
            tui.requestRender();
          }
        },
      };
    }, { overlay: true })) ?? null;
  }

  async function approve(ctx: ExtensionContext, request: PrivilegedExecRequest, origin: PrivilegedExecOrigin): Promise<boolean> {
    const bridge = webBridge();
    const sessionId = webSessionId(ctx);
    const options: WebOptions = { ...request, argv: [...request.argv], origin: { mode: origin.mode, lineage: [...origin.lineage] } };
    if (bridge && sessionId) return bridge.requestApproval(sessionId, "Approve exact privileged execution?", 120_000, options);
    if (!ctx.hasUI) return false;
    return ctx.ui.confirm("Approve exact privileged execution?", displayRequest(request, origin));
  }

  async function executeRoot(
    request: PrivilegedExecRequest,
    origin: PrivilegedExecOrigin,
    executionCtx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<PrivilegedExecResult> {
    if (shuttingDown) return errorResult("privileged broker is unavailable");
    try {
      await validateExecutable(request);
      if (PIN_ACCESS_RE.test(request.executable) || request.argv.some((arg) => PIN_ACCESS_RE.test(arg))) {
        return errorResult("access to command-guard identity PIN configuration is forbidden");
      }
      if (!(await approve(executionCtx, request, origin))) return errorResult("privileged execution was not approved");
      if (signal?.aborted) return errorResult("privileged execution cancelled");

      let password = cachedPassword;
      if (!password) {
        for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
          const prompt = attempt === 1 ? "Sudo password required" : `Incorrect sudo password (${attempt}/${MAX_PASSWORD_ATTEMPTS})`;
          const candidate = await promptPassword(executionCtx, request, origin, prompt);
          if (!candidate) return errorResult("sudo authentication cancelled");
          if (await runSudoValidation(candidate, request.cwd, signal)) {
            rememberPassword(candidate);
            password = candidate;
            break;
          }
        }
      }
      if (!password) return errorResult("sudo authentication failed");
      const result = await executeDirect(request, password, signal);
      if (result.ok && result.exitCode === 1 && Buffer.from(result.stderrBase64, "base64").toString("utf8").toLowerCase().includes("password")) {
        clearPassword();
      }
      return result;
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  function executeSerialized(
    request: PrivilegedExecRequest,
    origin: PrivilegedExecOrigin,
    executionCtx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<PrivilegedExecResult> {
    const task = queue.then(
      () => executeRoot(request, origin, executionCtx, signal),
      () => executeRoot(request, origin, executionCtx, signal),
    );
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  const onParentMessage = (message: unknown) => {
    if (!isPrivilegedExecResultMessage(message)) return;
    const pending = upstreamPending.get(message.requestId);
    if (!pending) return;
    upstreamPending.delete(message.requestId);
    if (pending.abort) activeCtx?.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(message.result);
  };

  process.on("message", onParentMessage);

  function executeUpstream(request: PrivilegedExecRequest, signal?: AbortSignal): Promise<PrivilegedExecResult> {
    if (typeof process.send !== "function" || !process.connected) return Promise.resolve(errorResult("parent privileged broker IPC is unavailable"));
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const abort = () => {
        if (typeof process.send === "function" && process.connected) {
          process.send({ type: PRIVILEGED_EXEC_CANCEL_MESSAGE, version: PRIVILEGED_EXEC_PROTOCOL_VERSION, requestId });
        }
      };
      upstreamPending.set(requestId, { resolve, abort });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      process.send!({
        type: PRIVILEGED_EXEC_REQUEST_MESSAGE,
        version: PRIVILEGED_EXEC_PROTOCOL_VERSION,
        requestId,
        request,
      }, (error) => {
        if (!error) return;
        upstreamPending.delete(requestId);
        signal?.removeEventListener("abort", abort);
        resolve(errorResult("failed to send privileged request to parent"));
      });
    });
  }

  const runtime: PrivilegedExecBrokerRuntime = {
    execute(request, origin, signal) {
      try { assertPrivilegedExecRequest(request); }
      catch (error) { return Promise.resolve(errorResult(error instanceof Error ? error.message : String(error))); }
      if (typeof process.send === "function" && process.connected) return executeUpstream(request, signal);
      if (!activeCtx) return Promise.resolve(errorResult("privileged broker is unavailable"));
      return executeSerialized(request, origin, activeCtx, signal);
    },
    async shutdown() {
      shuttingDown = true;
      clearPassword();
      if (activeCtx) {
        const sessionId = webSessionId(activeCtx);
        if (sessionId) webBridge()?.cancelSession?.(sessionId);
        invalidateTimestamp(activeCtx.cwd);
      }
      for (const [id, pending] of upstreamPending) {
        upstreamPending.delete(id);
        pending.resolve(errorResult("privileged broker shut down"));
      }
      await queue;
    },
  };

  pi.registerTool({
    name: "sudo_exec",
    label: "Privileged Exec",
    description: "Request explicitly approved privileged execution of one absolute executable with exact argv. No shell, stdin, or unbounded output. Raw stdout/stderr are capped at 64 KiB each.",
    promptSnippet: "Run an absolute executable with exact argv through parent-approved sudo mediation",
    promptGuidelines: [
      "Use sudo_exec instead of putting sudo in bash commands.",
      "sudo_exec accepts an absolute executable and literal argv only; it never accepts a shell command string.",
      "Every sudo_exec call requires explicit user approval in the owning parent session.",
      "Never place passwords, tokens, PINs, or other secrets in sudo_exec argv; tool arguments are visible in session history and approval UI.",
    ],
    parameters: Type.Object({
      executable: Type.String({ description: "Canonical absolute executable path; no symlinks, shells, or interpreters" }),
      argv: Type.Array(Type.String(), { description: "Exact literal arguments excluding argv[0]" }),
      cwd: Type.Optional(Type.String({ description: "Canonical absolute working directory; defaults to the session cwd" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds, maximum 300000" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const request: PrivilegedExecRequest = {
        executable: params.executable,
        argv: [...params.argv],
        cwd: params.cwd ?? await realpath(ctx.cwd),
        timeoutMs: params.timeout_ms ?? PRIVILEGED_EXEC_LIMITS.defaultTimeoutMs,
      };
      const origin: PrivilegedExecOrigin = { mode: "parent", lineage: [] };
      const result = typeof process.send === "function" && process.connected
        ? await runtime.execute(request, origin, signal)
        : await executeSerialized(request, origin, ctx, signal);
      const stdout = Buffer.from(result.stdoutBase64, "base64").toString("utf8");
      const stderr = Buffer.from(result.stderrBase64, "base64").toString("utf8");
      const lines = [
        `exit=${result.exitCode ?? result.signal ?? "none"}${result.error ? ` error=${result.error}` : ""}`,
        stdout ? `stdout${result.stdoutTruncated ? " (truncated)" : ""}:\n${stdout}` : "stdout: (empty)",
        stderr ? `stderr${result.stderrTruncated ? " (truncated)" : ""}:\n${stderr}` : "stderr: (empty)",
      ];
      if (!result.ok) throw new Error(lines.join("\n"));
      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("sudo_exec "))}${theme.fg("accent", args.executable ?? "...")}\n${theme.fg("dim", JSON.stringify(args.argv ?? []))}`, 0, 0);
    },
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && rawSudoLikely(String((event.input as any).command ?? ""))) {
      return { block: true, reason: "Raw sudo is disabled; use sudo_exec with an absolute executable and exact argv." };
    }
  });

  pi.on("user_bash", async (event) => {
    if (!rawSudoLikely(event.command)) return undefined;
    return {
      result: {
        output: "Raw sudo is disabled; use sudo_exec with an absolute executable and exact argv.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    activeKey = runtimeKey(ctx);
    shuttingDown = false;
    privilegedExecRuntimeRegistry().set(activeKey, runtime);
  });

  pi.on("session_shutdown", async () => {
    if (activeKey && privilegedExecRuntimeRegistry().get(activeKey) === runtime) {
      privilegedExecRuntimeRegistry().delete(activeKey);
    }
    process.off("message", onParentMessage);
    await runtime.shutdown();
    activeCtx = null;
    activeKey = null;
  });
}
