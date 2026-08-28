import { createHash, createHmac, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { MemoryReviewOutcome } from "./state.js";

export const LEDGER_SCHEMA_VERSION = 1 as const;
export const LEDGER_RETENTION_DAYS = 90;
export const SOURCE_CLASSES = ["interactive", "rpc", "scheduled", "subagent", "unknown"] as const;
export const ASSISTANT_OUTCOMES = ["stop", "length", "tool_use", "error", "aborted", "unknown"] as const;
export type MemorySourceClass = (typeof SOURCE_CLASSES)[number];
export type AssistantOutcome = (typeof ASSISTANT_OUTCOMES)[number];
export type CompactionCause = "extension_threshold" | "native_threshold" | "manual" | "overflow" | "unknown";

export interface UsageComponents {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
}

interface LedgerBase {
  schema_version: 1;
  event_id: string;
  timestamp: string;
  day: string;
  event: "context_usage" | "request_usage" | "compaction_usage" | "review" | "compaction";
  source_class: MemorySourceClass;
  session_local_id: string;
  generation: number;
}

export interface ContextUsageLedgerRecord extends LedgerBase {
  event: "context_usage";
  context_tokens: number;
}

export interface RequestUsageLedgerRecord extends LedgerBase, UsageComponents {
  event: "request_usage";
  provider_local_id: string;
  model_local_id: string;
  outcome: AssistantOutcome;
}

export interface CompactionUsageLedgerRecord extends LedgerBase, UsageComponents {
  event: "compaction_usage";
  provider_local_id: string;
  model_local_id: string;
  outcome: AssistantOutcome;
}

export interface ReviewLedgerRecord extends LedgerBase {
  event: "review";
  outcome: MemoryReviewOutcome;
}

export interface CompactionLedgerRecord extends LedgerBase {
  event: "compaction";
  cause: CompactionCause;
  context_tokens: number;
}

export type MemoryLedgerRecord =
  | ContextUsageLedgerRecord
  | RequestUsageLedgerRecord
  | CompactionUsageLedgerRecord
  | ReviewLedgerRecord
  | CompactionLedgerRecord;

export type LedgerEventInput =
  | { event: "context_usage"; generation: number; context_tokens: number; dedupe_key: string }
  | ({ event: "request_usage"; generation: number; provider: string; model: string; outcome: AssistantOutcome; dedupe_key: string } & UsageComponents)
  | ({ event: "compaction_usage"; generation: number; provider: string; model: string; outcome: AssistantOutcome; dedupe_key: string } & UsageComponents)
  | { event: "review"; generation: number; outcome: MemoryReviewOutcome; dedupe_key: string }
  | { event: "compaction"; generation: number; cause: CompactionCause; context_tokens: number; dedupe_key: string };

export interface LedgerIdentity {
  sessionId: string;
  sourceClass: MemorySourceClass;
  /** Current branch leaf/boundary; used only inside the HMAC event ID input. */
  boundaryId: string;
}

export interface LedgerAggregate extends UsageComponents {
  schema_version: 1;
  aggregate_id: string;
  day: string;
  event: MemoryLedgerRecord["event"];
  source_class: MemorySourceClass;
  dimension: string;
  count: number;
  context_tokens: number;
}

export interface LedgerMaintenanceResult {
  cutoffDay: string;
  retained: MemoryLedgerRecord[];
  agedOutCount: number;
  duplicateCount: number;
  prunedCount: number;
  aggregates: LedgerAggregate[];
  aggregateAppendCount: number;
}

const HMAC_ID = /^h1:[a-f0-9]{64}$/u;
const AGGREGATE_ID = /^a1:[a-f0-9]{64}$/u;

function hmac(key: string | Buffer, namespace: string, raw: string): string {
  return `h1:${createHmac("sha256", key).update(namespace).update("\0").update(raw).digest("hex")}`;
}

function utcDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function tokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function strictKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function validUsage(value: Record<string, unknown>): boolean {
  return tokenCount(value.input_tokens)
    && tokenCount(value.output_tokens)
    && tokenCount(value.cache_read_tokens)
    && tokenCount(value.cache_write_tokens)
    && tokenCount(value.total_tokens);
}

function validOutcome(value: unknown): value is AssistantOutcome {
  return typeof value === "string" && (ASSISTANT_OUTCOMES as readonly string[]).includes(value);
}

export function isMemoryLedgerRecord(value: unknown): value is MemoryLedgerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== 1
    || typeof record.event_id !== "string" || !HMAC_ID.test(record.event_id)
    || typeof record.timestamp !== "string" || !canonicalTimestamp(record.timestamp)
    || typeof record.day !== "string" || record.day !== utcDay(record.timestamp)
    || typeof record.source_class !== "string" || !(SOURCE_CLASSES as readonly string[]).includes(record.source_class)
    || typeof record.session_local_id !== "string" || !HMAC_ID.test(record.session_local_id)
    || !validGeneration(record.generation)
  ) return false;

  const base = ["schema_version", "event_id", "timestamp", "day", "event", "source_class", "session_local_id", "generation"];
  const usage = ["provider_local_id", "model_local_id", "outcome", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens"];
  switch (record.event) {
    case "context_usage":
      return strictKeys(record, [...base, "context_tokens"]) && tokenCount(record.context_tokens);
    case "request_usage":
    case "compaction_usage":
      return strictKeys(record, [...base, ...usage])
        && typeof record.provider_local_id === "string" && HMAC_ID.test(record.provider_local_id)
        && typeof record.model_local_id === "string" && HMAC_ID.test(record.model_local_id)
        && validOutcome(record.outcome)
        && validUsage(record);
    case "review":
      return strictKeys(record, [...base, "outcome"])
        && ["wrote", "read_only", "not_relevant", "blocked"].includes(String(record.outcome));
    case "compaction":
      return strictKeys(record, [...base, "cause", "context_tokens"])
        && ["extension_threshold", "native_threshold", "manual", "overflow", "unknown"].includes(String(record.cause))
        && tokenCount(record.context_tokens);
    default:
      return false;
  }
}

function validAggregateDimension(event: unknown, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (event === "context_usage") return value === "context";
  if (event === "request_usage" || event === "compaction_usage") {
    return /^(?:stop|length|tool_use|error|aborted|unknown)\|h1:[a-f0-9]{64}\|h1:[a-f0-9]{64}$/u.test(value);
  }
  if (event === "review") return /^(?:wrote|read_only|not_relevant|blocked)$/u.test(value);
  if (event === "compaction") return /^(?:extension_threshold|native_threshold|manual|overflow|unknown)$/u.test(value);
  return false;
}

export function isLedgerAggregate(value: unknown): value is LedgerAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return strictKeys(record, [
    "schema_version", "aggregate_id", "day", "event", "source_class", "dimension", "count", "context_tokens",
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens",
  ])
    && record.schema_version === 1
    && typeof record.aggregate_id === "string" && AGGREGATE_ID.test(record.aggregate_id)
    && typeof record.day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(record.day)
    && canonicalTimestamp(`${record.day}T00:00:00.000Z`)
    && typeof record.event === "string" && ["context_usage", "request_usage", "compaction_usage", "review", "compaction"].includes(record.event)
    && typeof record.source_class === "string" && (SOURCE_CLASSES as readonly string[]).includes(record.source_class)
    && validAggregateDimension(record.event, record.dimension)
    && Number.isSafeInteger(record.count) && (record.count as number) >= 1
    && tokenCount(record.context_tokens)
    && validUsage(record);
}

function assertPrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("metadata directory must be a regular directory");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("metadata directory permissions must exclude group and other access");
  }
}

function openPrivateFile(filePath: string): number {
  assertPrivateDirectory(path.dirname(filePath));
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("metadata target must be a regular file");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("metadata target is not private");
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_APPEND | noFollow, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1))) {
      throw new Error("metadata file descriptor is not private and uniquely linked");
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function parseAndRecover<T>(fd: number, validate: (value: unknown) => value is T): T[] {
  const raw = fs.readFileSync(fd, "utf8");
  if (!raw) return [];
  let complete = raw;
  if (!raw.endsWith("\n")) {
    const newline = raw.lastIndexOf("\n");
    complete = newline < 0 ? "" : raw.slice(0, newline + 1);
    fs.ftruncateSync(fd, Buffer.byteLength(complete));
    fs.fsyncSync(fd);
  }
  const records: T[] = [];
  for (const line of complete.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { throw new Error("metadata file contains malformed complete JSONL"); }
    if (!validate(parsed)) throw new Error("metadata file contains unsupported or unsafe fields");
    records.push(parsed);
  }
  return records;
}

interface LockOwner {
  version: 1;
  pid: number;
  nonce: string;
  created_ms: number;
}

export interface MetadataLockOptions {
  waitMs?: number;
  staleMs?: number;
  now?: () => number;
  pid?: number;
  nonce?: string;
}

export function fsyncParentDirectory(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* portable directory handles may reject close/fsync */ }
    }
  }
}

function validLockOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return strictKeys(owner, ["version", "pid", "nonce", "created_ms"])
    && owner.version === 1
    && Number.isSafeInteger(owner.pid) && (owner.pid as number) >= 1
    && typeof owner.nonce === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(owner.nonce)
    && typeof owner.created_ms === "number" && Number.isFinite(owner.created_ms) && owner.created_ms >= 0;
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const ownerPath = path.join(lockPath, "owner.json");
    const ownerStat = fs.lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return null;
    if (process.platform !== "win32" && (ownerStat.mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    return validLockOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameOwner(left: LockOwner | null, right: LockOwner): boolean {
  return Boolean(left)
    && left!.version === right.version
    && left!.pid === right.pid
    && left!.nonce === right.nonce
    && left!.created_ms === right.created_ms;
}

function verifiedDeadPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function restoreMovedLock(movedPath: string, lockPath: string): void {
  try {
    if (!fs.existsSync(lockPath)) fs.renameSync(movedPath, lockPath);
  } catch { /* retain the moved unknown-owner lock for manual recovery */ }
}

function removeMovedOwnedLock(movedPath: string, expected: LockOwner): boolean {
  if (!sameOwner(readLockOwner(movedPath), expected)) return false;
  try {
    fs.unlinkSync(path.join(movedPath, "owner.json"));
    fs.rmdirSync(movedPath);
    fsyncParentDirectory(movedPath);
    return true;
  } catch {
    return false;
  }
}

export function acquireMetadataLock(filePath: string, options: MetadataLockOptions = {}): () => void {
  assertPrivateDirectory(path.dirname(filePath));
  const lockPath = `${filePath}.lock`;
  const now = options.now ?? (() => Date.now());
  const waitMs = Math.max(0, Math.min(options.waitMs ?? 2_000, 10_000));
  const staleMs = Math.max(1_000, options.staleMs ?? 30_000);
  const owner: LockOwner = {
    version: 1,
    pid: options.pid ?? process.pid,
    nonce: options.nonce ?? randomUUID(),
    created_ms: now(),
  };
  if (!validLockOwner(owner)) throw new Error("invalid metadata lock owner");
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      owner.created_ms = now();
      const ownerPath = path.join(lockPath, "owner.json");
      const ownerFd = fs.openSync(ownerPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeSync(ownerFd, `${JSON.stringify(owner)}\n`, undefined, "utf8");
        fs.fsyncSync(ownerFd);
      } finally {
        fs.closeSync(ownerFd);
      }
      fsyncParentDirectory(ownerPath);
      return () => {
        if (!sameOwner(readLockOwner(lockPath), owner)) return;
        const movedPath = `${lockPath}.release-${owner.pid}-${owner.nonce}`;
        try { fs.renameSync(lockPath, movedPath); }
        catch { return; }
        if (!removeMovedOwnedLock(movedPath, owner)) restoreMovedLock(movedPath, lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLockOwner(lockPath);
      if (existing && now() - existing.created_ms > staleMs && verifiedDeadPid(existing.pid)) {
        const movedPath = `${lockPath}.reclaim-${owner.pid}-${owner.nonce}`;
        try {
          fs.renameSync(lockPath, movedPath);
          if (removeMovedOwnedLock(movedPath, existing)) continue;
          restoreMovedLock(movedPath, lockPath);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        }
      }
      if (Date.now() >= deadline) throw new Error("metadata file is busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function normalizedUsage(input: UsageComponents): UsageComponents {
  return {
    input_tokens: Math.max(0, Math.round(input.input_tokens)),
    output_tokens: Math.max(0, Math.round(input.output_tokens)),
    cache_read_tokens: Math.max(0, Math.round(input.cache_read_tokens)),
    cache_write_tokens: Math.max(0, Math.round(input.cache_write_tokens)),
    total_tokens: Math.max(0, Math.round(input.total_tokens)),
  };
}

export class MetadataLedger {
  readonly filePath: string;
  private readonly key: string | Buffer;
  private readonly now: () => Date;

  constructor(options: { filePath: string; hmacKey: string | Buffer; now?: () => Date }) {
    if (!path.isAbsolute(options.filePath)) throw new Error("ledger path must be absolute");
    const keyLength = Buffer.isBuffer(options.hmacKey) ? options.hmacKey.byteLength : Buffer.byteLength(options.hmacKey, "utf8");
    if (keyLength < 32) throw new Error("ledger HMAC key must contain at least 32 bytes");
    this.filePath = options.filePath;
    this.key = options.hmacKey;
    this.now = options.now ?? (() => new Date());
  }

  localId(namespace: string, rawId: string): string {
    return hmac(this.key, namespace, rawId);
  }

  append(identity: LedgerIdentity, input: LedgerEventInput): { written: boolean; record: MemoryLedgerRecord } {
    if (!identity.sessionId || !identity.boundaryId) throw new Error("ledger identity is unavailable");
    if (!(SOURCE_CLASSES as readonly string[]).includes(identity.sourceClass)) throw new Error("invalid source class");
    if ((input.event === "request_usage" || input.event === "compaction_usage") && (!input.provider || !input.model)) {
      throw new Error("usage provider and model identities are required");
    }
    const timestamp = this.now().toISOString();
    const base: LedgerBase = {
      schema_version: LEDGER_SCHEMA_VERSION,
      event_id: hmac(this.key, "event", `${identity.sessionId}\0${identity.boundaryId}\0${input.dedupe_key}`),
      timestamp,
      day: utcDay(timestamp),
      event: input.event,
      source_class: identity.sourceClass,
      session_local_id: hmac(this.key, "session", identity.sessionId),
      generation: input.generation,
    };
    let record: MemoryLedgerRecord;
    if (input.event === "context_usage") {
      record = { ...base, event: input.event, context_tokens: Math.max(0, Math.round(input.context_tokens)) };
    } else if (input.event === "request_usage") {
      record = {
        ...base,
        event: "request_usage",
        provider_local_id: hmac(this.key, "provider", input.provider),
        model_local_id: hmac(this.key, "model", `${input.provider}\0${input.model}`),
        outcome: input.outcome,
        ...normalizedUsage(input),
      };
    } else if (input.event === "compaction_usage") {
      record = {
        ...base,
        event: "compaction_usage",
        provider_local_id: hmac(this.key, "provider", input.provider),
        model_local_id: hmac(this.key, "model", `${input.provider}\0${input.model}`),
        outcome: input.outcome,
        ...normalizedUsage(input),
      };
    } else if (input.event === "review") {
      record = { ...base, event: input.event, outcome: input.outcome };
    } else if (input.event === "compaction") {
      record = { ...base, event: input.event, cause: input.cause, context_tokens: Math.max(0, Math.round(input.context_tokens)) };
    } else {
      const exhaustive: never = input;
      throw new Error(`unsupported ledger event: ${String(exhaustive)}`);
    }
    if (!isMemoryLedgerRecord(record)) throw new Error("refusing unsafe ledger record");

    const release = acquireMetadataLock(this.filePath);
    let fd: number | undefined;
    try {
      const existedBeforeAppend = fs.existsSync(this.filePath);
      fd = openPrivateFile(this.filePath);
      const records = parseAndRecover(fd, isMemoryLedgerRecord);
      if (records.some((existing) => existing.event_id === record.event_id)) return { written: false, record };
      fs.writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
      fs.fsyncSync(fd);
      if (!existedBeforeAppend && process.platform !== "win32" && !fsyncParentDirectory(this.filePath)) {
        throw new Error("ledger parent directory could not be synchronized after first creation");
      }
      return { written: true, record };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      release();
    }
  }

  readValidated(): MemoryLedgerRecord[] {
    const release = acquireMetadataLock(this.filePath);
    let fd: number | undefined;
    try {
      fd = openPrivateFile(this.filePath);
      return parseAndRecover(fd, isMemoryLedgerRecord);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      release();
    }
  }
}

function cutoffDay(now: Date, retentionDays: number): string {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new Error("retentionDays must be positive");
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start - (retentionDays - 1) * 86_400_000).toISOString().slice(0, 10);
}

function dimension(record: MemoryLedgerRecord): string {
  if (record.event === "context_usage") return "context";
  if (record.event === "request_usage" || record.event === "compaction_usage") {
    return `${record.outcome}|${record.provider_local_id}|${record.model_local_id}`;
  }
  if (record.event === "review") return record.outcome;
  return record.cause;
}

function zeroUsage(): UsageComponents {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0 };
}

function aggregateAgedOut(records: readonly MemoryLedgerRecord[]): LedgerAggregate[] {
  const groups = new Map<string, Omit<LedgerAggregate, "schema_version" | "aggregate_id">>();
  for (const record of records) {
    const recordDimension = dimension(record);
    const key = `${record.day}\0${record.event}\0${record.source_class}\0${recordDimension}`;
    const existing = groups.get(key) ?? {
      day: record.day,
      event: record.event,
      source_class: record.source_class,
      dimension: recordDimension,
      count: 0,
      context_tokens: 0,
      ...zeroUsage(),
    };
    existing.count++;
    if (record.event === "context_usage" || record.event === "compaction") existing.context_tokens += record.context_tokens;
    if (record.event === "request_usage" || record.event === "compaction_usage") {
      existing.input_tokens += record.input_tokens;
      existing.output_tokens += record.output_tokens;
      existing.cache_read_tokens += record.cache_read_tokens;
      existing.cache_write_tokens += record.cache_write_tokens;
      existing.total_tokens += record.total_tokens;
    }
    groups.set(key, existing);
  }
  return [...groups.values()].map((group) => {
    const canonical = JSON.stringify(group);
    return { schema_version: 1 as const, aggregate_id: `a1:${createHash("sha256").update(canonical).digest("hex")}`, ...group };
  }).sort((a, b) => a.day.localeCompare(b.day) || a.event.localeCompare(b.event) || a.source_class.localeCompare(b.source_class) || a.dimension.localeCompare(b.dimension));
}

export function aggregateAndPruneLedger(
  records: readonly MemoryLedgerRecord[],
  now: Date,
  retentionDays = LEDGER_RETENTION_DAYS,
): LedgerMaintenanceResult {
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
  const cutoff = cutoffDay(now, retentionDays);
  const seen = new Set<string>();
  const unique: MemoryLedgerRecord[] = [];
  let duplicateCount = 0;
  for (const record of records) {
    if (seen.has(record.event_id)) duplicateCount++;
    else { seen.add(record.event_id); unique.push(record); }
  }
  const agedOut = unique.filter((record) => record.day < cutoff);
  const retained = unique.filter((record) => record.day >= cutoff);
  return {
    cutoffDay: cutoff,
    retained,
    agedOutCount: agedOut.length,
    duplicateCount,
    prunedCount: records.length - retained.length,
    aggregates: aggregateAgedOut(agedOut),
    aggregateAppendCount: 0,
  };
}

function appendAggregates(fd: number, aggregates: readonly LedgerAggregate[]): number {
  const existing = parseAndRecover(fd, isLedgerAggregate);
  const ids = new Set(existing.map((record) => record.aggregate_id));
  let appended = 0;
  for (const aggregate of aggregates) {
    if (!isLedgerAggregate(aggregate)) throw new Error("refusing unsafe aggregate record");
    if (ids.has(aggregate.aggregate_id)) continue;
    fs.writeSync(fd, `${JSON.stringify(aggregate)}\n`, undefined, "utf8");
    ids.add(aggregate.aggregate_id);
    appended++;
  }
  fs.fsyncSync(fd);
  return appended;
}

function rewritePrivateFile(filePath: string, body: string): void {
  const temporary = `${filePath}.prune-${process.pid}-${randomUUID()}`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(fd, body, undefined, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, filePath);
    if (process.platform !== "win32" && !fsyncParentDirectory(filePath)) {
      throw new Error("metadata parent directory could not be synchronized after atomic replacement");
    }
  }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* generated metadata-only temp file */ }
    throw error;
  }
}

export function maintainLedgerFile(
  filePath: string,
  aggregatePath: string,
  now: Date,
  retentionDays = LEDGER_RETENTION_DAYS,
): LedgerMaintenanceResult {
  if (!path.isAbsolute(filePath) || !path.isAbsolute(aggregatePath)) throw new Error("ledger and aggregate paths must be absolute");
  if (path.resolve(filePath) === path.resolve(aggregatePath)) throw new Error("aggregate path must differ from ledger path");
  const lockPaths = [filePath, aggregatePath].sort();
  const releases: Array<() => void> = [];
  let ledgerFd: number | undefined;
  let aggregateFd: number | undefined;
  try {
    for (const lockPath of lockPaths) releases.push(acquireMetadataLock(lockPath));
    ledgerFd = openPrivateFile(filePath);
    const records = parseAndRecover(ledgerFd, isMemoryLedgerRecord);
    const result = aggregateAndPruneLedger(records, now, retentionDays);
    const aggregateExistedBeforeMaintenance = fs.existsSync(aggregatePath);
    aggregateFd = openPrivateFile(aggregatePath);
    result.aggregateAppendCount = appendAggregates(aggregateFd, result.aggregates);
    if (!aggregateExistedBeforeMaintenance && process.platform !== "win32" && !fsyncParentDirectory(aggregatePath)) {
      throw new Error("aggregate parent directory could not be synchronized after first creation");
    }
    fs.closeSync(aggregateFd);
    aggregateFd = undefined;
    fs.closeSync(ledgerFd);
    ledgerFd = undefined;
    const body = result.retained.map((record) => JSON.stringify(record)).join("\n");
    rewritePrivateFile(filePath, body ? `${body}\n` : "");
    return result;
  } finally {
    if (aggregateFd !== undefined) fs.closeSync(aggregateFd);
    if (ledgerFd !== undefined) fs.closeSync(ledgerFd);
    for (const release of releases.reverse()) release();
  }
}
