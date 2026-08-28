import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MetadataLedger,
  acquireMetadataLock,
  aggregateAndPruneLedger,
  fsyncParentDirectory,
  isLedgerAggregate,
  isMemoryLedgerRecord,
  maintainLedgerFile,
  type MemoryLedgerRecord,
} from "./ledger.js";

const FIXTURE_KEY = "fixture-only-memory-ledger-key-00000000000000000000";
const USAGE = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, cache_write_tokens: 5, total_tokens: 175 };

function fixture(now = new Date("2026-08-27T12:00:00.000Z")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-ledger-"));
  fs.chmodSync(root, 0o700);
  const filePath = path.join(root, "ledger.jsonl");
  const aggregatePath = path.join(root, "aged-aggregates.jsonl");
  const ledger = new MetadataLedger({ filePath, hmacKey: FIXTURE_KEY, now: () => now });
  return { root, filePath, aggregatePath, ledger, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("request usage records components and HMAC provider/model/session IDs without raw IDs or paths", () => {
  const f = fixture();
  try {
    const identity = { sessionId: "raw-session-secret-id", boundaryId: "raw-branch-leaf", sourceClass: "interactive" as const };
    const input = {
      event: "request_usage" as const,
      generation: 1,
      provider: "raw-provider-id",
      model: "raw-model-id",
      outcome: "tool_use" as const,
      ...USAGE,
      dedupe_key: "request-1",
    };
    assert.equal(f.ledger.append(identity, input).written, true);
    assert.equal(f.ledger.append(identity, input).written, false);
    const raw = fs.readFileSync(f.filePath, "utf8");
    assert.doesNotMatch(raw, /raw-session-secret-id|raw-branch-leaf|raw-provider-id|raw-model-id|dedupe_key|memory|path|content/ui);
    const record = JSON.parse(raw.trim());
    assert.equal(isMemoryLedgerRecord(record), true);
    assert.equal(record.event, "request_usage");
    assert.equal(record.total_tokens, 175);
    assert.match(record.provider_local_id, /^h1:[a-f0-9]{64}$/u);
    assert.match(record.model_local_id, /^h1:[a-f0-9]{64}$/u);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(f.filePath).mode & 0o077, 0);
      assert.equal(fs.statSync(f.root).mode & 0o077, 0);
    }
  } finally { f.cleanup(); }
});

test("event HMAC dedupe is branch-boundary aware without persisting raw branch IDs", () => {
  const f = fixture();
  try {
    const input = { event: "context_usage" as const, generation: 1, context_tokens: 10, dedupe_key: "same-generation-event" };
    const first = f.ledger.append(
      { sessionId: "same-session", boundaryId: "raw-branch-a", sourceClass: "interactive" },
      input,
    );
    const second = f.ledger.append(
      { sessionId: "same-session", boundaryId: "raw-branch-b", sourceClass: "interactive" },
      input,
    );
    assert.equal(first.written, true);
    assert.equal(second.written, true);
    assert.notEqual(first.record.event_id, second.record.event_id);
    const raw = fs.readFileSync(f.filePath, "utf8");
    assert.doesNotMatch(raw, /raw-branch-a|raw-branch-b/u);
  } finally { f.cleanup(); }
});

test("ledger records compaction-summary usage and recovers only a trailing partial record", () => {
  const f = fixture();
  try {
    f.ledger.append(
      { sessionId: "session-a", boundaryId: "branch-a", sourceClass: "scheduled" },
      {
        event: "compaction_usage", generation: 1, provider: "provider", model: "summary-model",
        outcome: "stop", ...USAGE, dedupe_key: "summary-1",
      },
    );
    fs.appendFileSync(f.filePath, '{"partial":', "utf8");
    f.ledger.append(
      { sessionId: "session-a", boundaryId: "branch-a", sourceClass: "scheduled" },
      { event: "compaction", generation: 1, cause: "overflow", context_tokens: 130_000, dedupe_key: "compact-1" },
    );
    const records = f.ledger.readValidated();
    assert.deepEqual(records.map((record) => record.event), ["compaction_usage", "compaction"]);
    fs.appendFileSync(f.filePath, `${JSON.stringify({ content: "forbidden" })}\n`, "utf8");
    assert.throws(() => f.ledger.readValidated(), /unsupported or unsafe fields/);
  } finally { f.cleanup(); }
});

test("ledger refuses broad directory permissions and symlink targets", () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-ledger-mode-"));
  try {
    fs.chmodSync(root, 0o755);
    const broad = new MetadataLedger({ filePath: path.join(root, "ledger.jsonl"), hmacKey: FIXTURE_KEY });
    assert.throws(() => broad.append(
      { sessionId: "session", boundaryId: "branch", sourceClass: "unknown" },
      { event: "context_usage", generation: 1, context_tokens: 1, dedupe_key: "one" },
    ), /permissions/);
    fs.chmodSync(root, 0o700);
    const target = path.join(root, "target.jsonl");
    fs.writeFileSync(target, "", { mode: 0o600 });
    const link = path.join(root, "link.jsonl");
    fs.symlinkSync(target, link);
    const linked = new MetadataLedger({ filePath: link, hmacKey: FIXTURE_KEY });
    assert.throws(() => linked.append(
      { sessionId: "session", boundaryId: "branch", sourceClass: "unknown" },
      { event: "context_usage", generation: 1, context_tokens: 1, dedupe_key: "two" },
    ), /regular file/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("nonce-aware locks preserve live/unknown owners, reclaim verified-dead stale owners, and release only matching nonce", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lock-"));
  fs.chmodSync(root, 0o700);
  const writeOwner = (filePath: string, owner: unknown) => {
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    return lockPath;
  };
  try {
    const liveFile = path.join(root, "live.jsonl");
    const liveLock = writeOwner(liveFile, { version: 1, pid: process.pid, nonce: randomUUID(), created_ms: Date.now() - 60_000 });
    assert.throws(() => acquireMetadataLock(liveFile, { waitMs: 25, staleMs: 1_000 }), /busy/);
    assert.equal(fs.existsSync(liveLock), true, "old but live owner must never be stolen");

    const unknownFile = path.join(root, "unknown.jsonl");
    const unknownLock = writeOwner(unknownFile, { malformed: true });
    assert.throws(() => acquireMetadataLock(unknownFile, { waitMs: 25, staleMs: 1_000 }), /busy/);
    assert.equal(fs.existsSync(unknownLock), true, "unknown owner must never be removed");

    const staleFile = path.join(root, "stale.jsonl");
    const deadNonce = randomUUID();
    const staleLock = writeOwner(staleFile, { version: 1, pid: 2_000_000_000, nonce: deadNonce, created_ms: Date.now() - 60_000 });
    const releaseStale = acquireMetadataLock(staleFile, { waitMs: 250, staleMs: 1_000 });
    const replacement = JSON.parse(fs.readFileSync(path.join(staleLock, "owner.json"), "utf8"));
    assert.notEqual(replacement.nonce, deadNonce);
    assert.equal(replacement.pid, process.pid);
    releaseStale();
    assert.equal(fs.existsSync(staleLock), false);

    const mismatchFile = path.join(root, "mismatch.jsonl");
    const ownNonce = randomUUID();
    const releaseMismatch = acquireMetadataLock(mismatchFile, { waitMs: 25, nonce: ownNonce });
    const mismatchLock = `${mismatchFile}.lock`;
    fs.writeFileSync(path.join(mismatchLock, "owner.json"), `${JSON.stringify({
      version: 1, pid: process.pid, nonce: randomUUID(), created_ms: Date.now(),
    })}\n`, { mode: 0o600 });
    releaseMismatch();
    assert.equal(fs.existsSync(mismatchLock), true, "release must not remove a different nonce owner");

    const fsyncResult = fsyncParentDirectory(path.join(root, "fixture.jsonl"));
    assert.equal(typeof fsyncResult, "boolean", "unsupported directory fsync is tolerated portably");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function recordAt(now: string, event: "context_usage" | "request_usage", key: string): MemoryLedgerRecord {
  const f = fixture(new Date(now));
  try {
    return f.ledger.append(
      { sessionId: "session", boundaryId: "branch", sourceClass: "rpc" },
      event === "context_usage"
        ? { event, generation: 1, context_tokens: 10, dedupe_key: key }
        : { event, generation: 1, provider: "provider", model: "model", outcome: "stop", ...USAGE, dedupe_key: key },
    ).record;
  } finally { f.cleanup(); }
}

test("90-day maintenance aggregates records being aged out, not retained raw records", () => {
  const oldContext = recordAt("2026-05-29T23:59:59.000Z", "context_usage", "old-context");
  const oldRequest = recordAt("2026-05-29T23:59:59.000Z", "request_usage", "old-request");
  const retained = recordAt("2026-05-30T00:00:00.000Z", "context_usage", "retained");
  const result = aggregateAndPruneLedger(
    [oldContext, oldRequest, retained, retained],
    new Date("2026-08-27T23:00:00.000Z"),
    90,
  );
  assert.equal(result.cutoffDay, "2026-05-30");
  assert.equal(result.agedOutCount, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.prunedCount, 3);
  assert.equal(result.aggregateAppendCount, 0, "pure planning does not append aggregate files");
  assert.deepEqual(result.retained, [retained]);
  assert.deepEqual(result.aggregates.map((item) => [item.day, item.event, item.count, item.context_tokens, item.total_tokens]), [
    ["2026-05-29", "context_usage", 1, 10, 0],
    ["2026-05-29", "request_usage", 1, 0, 175],
  ]);
  assert.ok(result.aggregates.every(isLedgerAggregate));
});

test("maintenance preserves aged-out aggregates in an explicit private aggregate file", () => {
  const f = fixture(new Date("2026-05-01T00:00:00.000Z"));
  try {
    f.ledger.append(
      { sessionId: "session", boundaryId: "branch", sourceClass: "rpc" },
      { event: "request_usage", generation: 1, provider: "raw-provider", model: "raw-model", outcome: "length", ...USAGE, dedupe_key: "old" },
    );
    const result = maintainLedgerFile(f.filePath, f.aggregatePath, new Date("2027-01-01T00:00:00.000Z"), 90);
    assert.equal(result.agedOutCount, 1);
    assert.equal(result.aggregateAppendCount, 1);
    assert.equal(fs.readFileSync(f.filePath, "utf8"), "");
    const aggregateRaw = fs.readFileSync(f.aggregatePath, "utf8");
    assert.doesNotMatch(aggregateRaw, /raw-provider|raw-model|session/iu);
    const aggregates = aggregateRaw.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(aggregates.length, 1);
    assert.equal(aggregates[0].total_tokens, 175);
    assert.equal(isLedgerAggregate(aggregates[0]), true);
    const rerun = maintainLedgerFile(f.filePath, f.aggregatePath, new Date("2027-01-01T00:00:00.000Z"), 90);
    assert.equal(rerun.aggregateAppendCount, 0);
    assert.equal(fs.readFileSync(f.aggregatePath, "utf8").trim().split("\n").length, 1);
    if (process.platform !== "win32") assert.equal(fs.statSync(f.aggregatePath).mode & 0o077, 0);
  } finally { f.cleanup(); }
});
