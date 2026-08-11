import { Buffer } from "node:buffer";
import * as path from "node:path";

/** Wire protocol shared by child agents and their trusted parent process. */
export const PRIVILEGED_EXEC_PROTOCOL_VERSION = 1 as const;
export const PRIVILEGED_EXEC_REQUEST_MESSAGE = "pi:privileged-exec:request" as const;
export const PRIVILEGED_EXEC_CANCEL_MESSAGE = "pi:privileged-exec:cancel" as const;
export const PRIVILEGED_EXEC_RESULT_MESSAGE = "pi:privileged-exec:result" as const;

/** All limits are measured in UTF-8 bytes unless the name says otherwise. */
export const PRIVILEGED_EXEC_LIMITS = Object.freeze({
  maxRequestIdBytes: 128,
  maxExecutableBytes: 4 * 1024,
  maxCwdBytes: 4 * 1024,
  maxArgCount: 256,
  maxArgBytes: 64 * 1024,
  maxArgvBytes: 256 * 1024,
  maxTimeoutMs: 5 * 60 * 1000,
  defaultTimeoutMs: 2 * 60 * 1000,
  maxStreamBytes: 64 * 1024,
  maxErrorBytes: 4 * 1024,
} as const);

/**
 * v1 deliberately excludes shells, privilege frontends, environment wrappers,
 * and general-purpose interpreters. This is a second line of defence: the
 * executor must also verify the canonical file is root-owned and not writable
 * by group/other before asking for approval.
 */
export const PRIVILEGED_EXEC_DENIED_BASENAMES = Object.freeze([
  "sudo", "su", "pkexec", "env",
  "sh", "bash", "dash", "zsh", "fish", "ksh", "csh", "tcsh",
  "node", "nodejs", "deno", "bun",
  "python", "python2", "python3", "perl", "ruby", "php", "lua",
  "busybox", "xargs",
] as const);

export interface PrivilegedExecRequest {
  /** Canonical absolute path; never a shell command or PATH lookup. */
  executable: string;
  /** Exact arguments, excluding argv[0]. No quoting or shell parsing occurs. */
  argv: string[];
  /** Canonical absolute working directory. */
  cwd: string;
  timeoutMs: number;
}

/** Fixed-shape result. stdout/stderr are independently bounded raw bytes. */
export interface PrivilegedExecOrigin {
  mode: "parent" | "long-lived" | "one-shot";
  /** Trusted parent-derived subagent IDs from root to immediate requester. */
  lineage: string[];
}

export interface PrivilegedExecResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdoutBase64: string;
  stderrBase64: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error: string | null;
}

/** Child-supplied identity, origin, lineage, and session fields are forbidden. */
export interface PrivilegedExecRequestMessage {
  type: typeof PRIVILEGED_EXEC_REQUEST_MESSAGE;
  version: typeof PRIVILEGED_EXEC_PROTOCOL_VERSION;
  requestId: string;
  request: PrivilegedExecRequest;
}

export interface PrivilegedExecCancelMessage {
  type: typeof PRIVILEGED_EXEC_CANCEL_MESSAGE;
  version: typeof PRIVILEGED_EXEC_PROTOCOL_VERSION;
  requestId: string;
}

export interface PrivilegedExecResultMessage {
  type: typeof PRIVILEGED_EXEC_RESULT_MESSAGE;
  version: typeof PRIVILEGED_EXEC_PROTOCOL_VERSION;
  requestId: string;
  result: PrivilegedExecResult;
}

export type PrivilegedExecIpcMessage =
  | PrivilegedExecRequestMessage
  | PrivilegedExecCancelMessage
  | PrivilegedExecResultMessage;

export interface PrivilegedExecBrokerRuntime {
  execute(
    request: PrivilegedExecRequest,
    origin: PrivilegedExecOrigin,
    signal?: AbortSignal,
  ): Promise<PrivilegedExecResult>;
  shutdown(): Promise<void>;
}

/** Process-global registry is keyed by pi session ID/file, never by cwd alone. */
export function privilegedExecRuntimeRegistry(): Map<string, PrivilegedExecBrokerRuntime> {
  const global = globalThis as typeof globalThis & {
    __pi_privileged_exec_sessions?: Map<string, PrivilegedExecBrokerRuntime>;
  };
  global.__pi_privileged_exec_sessions ??= new Map();
  return global.__pi_privileged_exec_sessions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Lexically canonical POSIX path. Filesystem/symlink canonicalization is executor-owned. */
export function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && (value === "/" || !value.endsWith("/"));
}

export function isDeniedPrivilegedExecutable(executable: string): boolean {
  const basename = path.posix.basename(executable).toLowerCase();
  return (PRIVILEGED_EXEC_DENIED_BASENAMES as readonly string[]).includes(basename)
    || /^python(?:\d+(?:\.\d+)*)?$/.test(basename)
    || /^perl\d+(?:\.\d+)*$/.test(basename)
    || /^ruby\d+(?:\.\d+)*$/.test(basename)
    || /^php\d+(?:\.\d+)*$/.test(basename);
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9._:-]+$/.test(value)
    && utf8Bytes(value) <= PRIVILEGED_EXEC_LIMITS.maxRequestIdBytes;
}

/** Returns a stable, non-sensitive reason, or null when valid. */
export function validatePrivilegedExecRequest(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["executable", "argv", "cwd", "timeoutMs"])) {
    return "request must contain exactly executable, argv, cwd, and timeoutMs";
  }
  if (!isCanonicalAbsolutePath(value.executable)) return "executable must be a canonical absolute path";
  if (utf8Bytes(value.executable) > PRIVILEGED_EXEC_LIMITS.maxExecutableBytes) return "executable is too long";
  if (isDeniedPrivilegedExecutable(value.executable)) return "executable is forbidden by v1 policy";
  if (!isCanonicalAbsolutePath(value.cwd)) return "cwd must be a canonical absolute path";
  if (utf8Bytes(value.cwd) > PRIVILEGED_EXEC_LIMITS.maxCwdBytes) return "cwd is too long";
  if (!Array.isArray(value.argv)) return "argv must be an array";
  if (value.argv.length > PRIVILEGED_EXEC_LIMITS.maxArgCount) return "argv has too many entries";

  let argvBytes = 0;
  for (const arg of value.argv) {
    if (typeof arg !== "string" || arg.includes("\0")) return "argv entries must be NUL-free strings";
    const size = utf8Bytes(arg);
    if (size > PRIVILEGED_EXEC_LIMITS.maxArgBytes) return "argv entry is too long";
    argvBytes += size;
    if (argvBytes > PRIVILEGED_EXEC_LIMITS.maxArgvBytes) return "argv is too large";
  }
  if (!Number.isSafeInteger(value.timeoutMs)
    || (value.timeoutMs as number) < 1
    || (value.timeoutMs as number) > PRIVILEGED_EXEC_LIMITS.maxTimeoutMs) {
    return "timeoutMs is outside the permitted range";
  }
  return null;
}

export function isPrivilegedExecRequest(value: unknown): value is PrivilegedExecRequest {
  return validatePrivilegedExecRequest(value) === null;
}

export function assertPrivilegedExecRequest(value: unknown): asserts value is PrivilegedExecRequest {
  const reason = validatePrivilegedExecRequest(value);
  if (reason !== null) throw new TypeError(`Invalid privileged exec request: ${reason}`);
}

function isCanonicalBoundedBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length <= PRIVILEGED_EXEC_LIMITS.maxStreamBytes
    && decoded.toString("base64") === value;
}

export function isPrivilegedExecResult(value: unknown): value is PrivilegedExecResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "ok", "exitCode", "signal", "stdoutBase64", "stderrBase64",
    "stdoutTruncated", "stderrTruncated", "error",
  ])) return false;
  if (typeof value.ok !== "boolean"
    || typeof value.stdoutTruncated !== "boolean"
    || typeof value.stderrTruncated !== "boolean") return false;
  if (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0)) return false;
  if (value.signal !== null && (typeof value.signal !== "string" || !/^[A-Z][A-Z0-9]{0,31}$/.test(value.signal))) return false;
  if (value.error !== null && (typeof value.error !== "string"
    || value.error.length === 0
    || value.error.includes("\0")
    || utf8Bytes(value.error) > PRIVILEGED_EXEC_LIMITS.maxErrorBytes)) return false;
  if (value.ok && (value.error !== null || (value.exitCode === null) === (value.signal === null))) return false;
  if (!value.ok && value.error === null) return false;
  if (!isCanonicalBoundedBase64(value.stdoutBase64) || !isCanonicalBoundedBase64(value.stderrBase64)) return false;
  return true;
}

export function isPrivilegedExecRequestMessage(value: unknown): value is PrivilegedExecRequestMessage {
  return isRecord(value)
    && hasExactKeys(value, ["type", "version", "requestId", "request"])
    && value.type === PRIVILEGED_EXEC_REQUEST_MESSAGE
    && value.version === PRIVILEGED_EXEC_PROTOCOL_VERSION
    && validRequestId(value.requestId)
    && isPrivilegedExecRequest(value.request);
}

export function isPrivilegedExecCancelMessage(value: unknown): value is PrivilegedExecCancelMessage {
  return isRecord(value)
    && hasExactKeys(value, ["type", "version", "requestId"])
    && value.type === PRIVILEGED_EXEC_CANCEL_MESSAGE
    && value.version === PRIVILEGED_EXEC_PROTOCOL_VERSION
    && validRequestId(value.requestId);
}

export function isPrivilegedExecResultMessage(value: unknown): value is PrivilegedExecResultMessage {
  return isRecord(value)
    && hasExactKeys(value, ["type", "version", "requestId", "result"])
    && value.type === PRIVILEGED_EXEC_RESULT_MESSAGE
    && value.version === PRIVILEGED_EXEC_PROTOCOL_VERSION
    && validRequestId(value.requestId)
    && isPrivilegedExecResult(value.result);
}

export function isPrivilegedExecIpcMessage(value: unknown): value is PrivilegedExecIpcMessage {
  return isPrivilegedExecRequestMessage(value)
    || isPrivilegedExecCancelMessage(value)
    || isPrivilegedExecResultMessage(value);
}

export interface BoundedByteResult {
  bytes: Buffer;
  base64: string;
  totalBytes: number;
  truncated: boolean;
}

/** Retains the first limit bytes while continuing to account for discarded bytes. */
export class BoundedByteAccumulator {
  readonly limit: number;
  #chunks: Buffer[] = [];
  #retainedBytes = 0;
  #totalBytes = 0;

  constructor(limit = PRIVILEGED_EXEC_LIMITS.maxStreamBytes) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("limit must be a non-negative safe integer");
    this.limit = limit;
  }

  append(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("chunk must be raw bytes");
    this.#totalBytes = Math.min(Number.MAX_SAFE_INTEGER, this.#totalBytes + chunk.byteLength);
    const available = this.limit - this.#retainedBytes;
    if (available <= 0 || chunk.byteLength === 0) return;
    const retained = Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, available));
    this.#chunks.push(Buffer.from(retained));
    this.#retainedBytes += retained.byteLength;
  }

  get retainedBytes(): number { return this.#retainedBytes; }
  get totalBytes(): number { return this.#totalBytes; }
  get truncated(): boolean { return this.#totalBytes > this.#retainedBytes; }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks, this.#retainedBytes);
  }

  toBase64(): string {
    return this.toBuffer().toString("base64");
  }

  result(): BoundedByteResult {
    const bytes = this.toBuffer();
    return { bytes, base64: bytes.toString("base64"), totalBytes: this.totalBytes, truncated: this.truncated };
  }
}
