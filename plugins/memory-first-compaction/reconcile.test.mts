import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MetadataLedger } from "./ledger.js";
import {
  parseReconciliationReferenceDocument,
  reconcileLedgerUsage,
  type ReconciliationReferenceDocument,
} from "./reconcile.js";

const KEY = "fixture-reconciliation-key-000000000000000000000000";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-reconcile-"));
  fs.chmodSync(root, 0o700);
  const filePath = path.join(root, "ledger.jsonl");
  const ledger = new MetadataLedger({
    filePath,
    hmacKey: KEY,
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  });
  ledger.append(
    { sessionId: "session-a", sourceClass: "interactive", boundaryId: "leaf-a" },
    {
      event: "request_usage",
      generation: 1,
      provider: "provider-a",
      model: "model-a",
      outcome: "stop",
      input_tokens: 1_000,
      output_tokens: 100,
      cache_read_tokens: 4_000,
      cache_write_tokens: 20,
      total_tokens: 5_120,
      dedupe_key: "request-a",
    },
  );
  ledger.append(
    { sessionId: "session-a", sourceClass: "interactive", boundaryId: "leaf-b" },
    {
      event: "compaction_usage",
      generation: 1,
      provider: "provider-a",
      model: "model-a",
      outcome: "stop",
      input_tokens: 500,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 550,
      dedupe_key: "compaction-a",
    },
  );
  ledger.append(
    { sessionId: "session-child", sourceClass: "subagent", boundaryId: "child-leaf" },
    {
      event: "request_usage",
      generation: 1,
      provider: "provider-a",
      model: "model-a",
      outcome: "tool_use",
      input_tokens: 200,
      output_tokens: 20,
      cache_read_tokens: 100,
      cache_write_tokens: 0,
      total_tokens: 320,
      dedupe_key: "request-child",
    },
  );
  return { root, ledger, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function reference(overrides: Partial<ReconciliationReferenceDocument["references"][number]> = {}): ReconciliationReferenceDocument {
  return {
    schema_version: 1,
    references: [{
      source: "transcript",
      source_class: "interactive",
      requests: 2,
      input_tokens: 1_500,
      output_tokens: 150,
      cache_read_tokens: 4_000,
      cache_write_tokens: 20,
      total_tokens: 5_670,
      ...overrides,
    }],
  };
}

test("reconciliation includes assistant and compaction usage and passes exact totals", () => {
  const f = fixture();
  try {
    const report = reconcileLedgerUsage(f.ledger.readValidated(), reference());
    assert.equal(report.pass, true);
    assert.equal(report.max_variance, 0.005);
    assert.equal(report.rows[0]!.metrics.requests.actual, 2);
    assert.equal(report.rows[0]!.metrics.total_tokens.actual, 5_670);
  } finally { f.cleanup(); }
});

test("the 0.5 percent gate distinguishes within-margin and outside-margin totals", () => {
  const f = fixture();
  try {
    const records = f.ledger.readValidated();
    assert.equal(reconcileLedgerUsage(records, reference({ input_tokens: 1_507 })).pass, true);
    const failed = reconcileLedgerUsage(records, reference({ input_tokens: 1_508 }));
    assert.equal(failed.pass, false);
    assert.equal(failed.rows[0]!.metrics.input_tokens.pass, false);
  } finally { f.cleanup(); }
});

test("zero expected totals pass only when actual is also zero and source classes stay separate", () => {
  const f = fixture();
  try {
    const records = f.ledger.readValidated();
    const missingClass = reconcileLedgerUsage(records, reference({
      source: "scheduled",
      source_class: "scheduled",
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
    }));
    assert.equal(missingClass.pass, true);
    const mismatch = reconcileLedgerUsage(records, reference({ input_tokens: 0 }));
    assert.equal(mismatch.pass, false);
    assert.equal(mismatch.rows[0]!.metrics.input_tokens.variance, null);
  } finally { f.cleanup(); }
});

test("reference schema rejects duplicates, unknown fields, content, paths, and invalid counts", () => {
  const valid = reference();
  assert.deepEqual(parseReconciliationReferenceDocument(valid), valid);
  assert.throws(() => parseReconciliationReferenceDocument({ ...valid, content: "forbidden" }), /schema/);
  assert.throws(() => parseReconciliationReferenceDocument({
    schema_version: 1,
    references: [{ ...valid.references[0], path: "/private" }],
  }), /invalid/);
  assert.throws(() => parseReconciliationReferenceDocument({
    schema_version: 1,
    references: [valid.references[0], valid.references[0]],
  }), /duplicate/);
  assert.throws(() => parseReconciliationReferenceDocument({
    schema_version: 1,
    references: [{ ...valid.references[0], requests: -1 }],
  }), /invalid/);
});
