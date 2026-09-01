import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { installDurableSubagentReportLifecycle } from "../plugins/agent-teams/durable-report-lifecycle.ts";
import {
  createDurableSubagentReport,
  formatDurableSubagentReports,
  MAX_DURABLE_REPORT_BYTES,
  MAX_REPORT_SCAN_ENTRIES,
  pendingDurableSubagentReports,
  SUBAGENT_REPORT_ENTRY_TYPE,
  SUBAGENT_REPORT_MESSAGE_TYPE,
} from "../plugins/agent-teams/durable-reports.ts";

const INDEX_SOURCE = readFileSync(new URL("../plugins/agent-teams/index.ts", import.meta.url), "utf8");
const LIFECYCLE_SOURCE = readFileSync(new URL("../plugins/agent-teams/durable-report-lifecycle.ts", import.meta.url), "utf8");
const REPORT_ID_A = "00000000-0000-4000-8000-000000000001";
const REPORT_ID_B = "00000000-0000-4000-8000-000000000002";

function custom(report: ReturnType<typeof createDurableSubagentReport>) {
  return { type: "custom", customType: SUBAGENT_REPORT_ENTRY_TYPE, data: report };
}

function delivered(...ids: string[]) {
  return { type: "custom_message", customType: SUBAGENT_REPORT_MESSAGE_TYPE, details: { durableReportIds: ids } };
}

test("durable reports bind identity/content metadata and truncate on a UTF-8 boundary", () => {
  const content = `prefix-${"界".repeat(MAX_DURABLE_REPORT_BYTES)}`;
  const report = createDurableSubagentReport("catalog-worker", content, {
    now: 1234,
    reportId: REPORT_ID_A,
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.createdAt, 1234);
  assert.equal(report.truncated, true);
  assert.ok(Buffer.byteLength(report.content, "utf8") <= MAX_DURABLE_REPORT_BYTES);
  assert.match(report.content, /\[durable subagent report truncated\]$/);
  assert.equal(report.originalBytes, Buffer.byteLength(content, "utf8"));
  assert.equal(report.contentSha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(report.storedContentSha256, createHash("sha256").update(report.content).digest("hex"));
  assert.equal(Object.isFrozen(report), true);
});

test("pending reports survive as custom entries and delivered custom messages consume them once", () => {
  const a = createDurableSubagentReport("a", "report-a", { now: 1, reportId: REPORT_ID_A });
  const b = createDurableSubagentReport("b", "report-b", { now: 2, reportId: REPORT_ID_B });
  assert.deepEqual(pendingDurableSubagentReports([custom(a), custom(b)]).map((value) => value.reportId), [REPORT_ID_A, REPORT_ID_B]);
  assert.deepEqual(pendingDurableSubagentReports([custom(a), delivered(REPORT_ID_A), custom(b)]).map((value) => value.reportId), [REPORT_ID_B]);
  assert.deepEqual(pendingDurableSubagentReports([custom(a), custom(b)], { excludeReportIds: new Set([REPORT_ID_B]) }).map((value) => value.reportId), [REPORT_ID_A]);
});

test("recovery is bounded by count and aggregate bytes without skipping oldest pending reports", () => {
  const a = createDurableSubagentReport("a", "a".repeat(400), { now: 1, reportId: REPORT_ID_A });
  const b = createDurableSubagentReport("b", "b".repeat(400), { now: 2, reportId: REPORT_ID_B });
  assert.deepEqual(pendingDurableSubagentReports([custom(a), custom(b)], { maxReports: 1 }).map((value) => value.reportId), [REPORT_ID_A]);
  assert.deepEqual(pendingDurableSubagentReports([custom(a), custom(b)], { maxBytes: 450 }).map((value) => value.reportId), [REPORT_ID_A]);
});

test("malformed, tampered, overlong, duplicate, off-branch, and counterfeit delivery records fail closed", () => {
  const report = createDurableSubagentReport("a", "report-a", { now: 1, reportId: REPORT_ID_A });
  const malformed = { ...report, unknown: true };
  const tampered = { ...report, content: "report-b" };
  const overlong = { ...report, content: "x".repeat(MAX_DURABLE_REPORT_BYTES + 1), originalBytes: MAX_DURABLE_REPORT_BYTES + 1 };
  assert.deepEqual(pendingDurableSubagentReports([
    { type: "custom", customType: SUBAGENT_REPORT_ENTRY_TYPE, data: malformed },
    { type: "custom", customType: SUBAGENT_REPORT_ENTRY_TYPE, data: tampered },
    { type: "custom", customType: SUBAGENT_REPORT_ENTRY_TYPE, data: overlong },
  ]), []);
  assert.equal(pendingDurableSubagentReports([custom(report), custom(report)]).length, 1);
  assert.equal(pendingDurableSubagentReports([custom(report), { type: "custom_message", customType: SUBAGENT_REPORT_MESSAGE_TYPE, details: { durableReportIds: ["not-an-id"] } }]).length, 1);
  assert.equal(pendingDurableSubagentReports([delivered(REPORT_ID_A), custom(report)]).length, 1, "a pre-positioned valid marker cannot suppress a later report");
  assert.equal(pendingDurableSubagentReports([custom(report), delivered(REPORT_ID_A)]).length, 0, "a later exact marker consumes the report");

  const branchA = [custom(report)];
  const branchB: unknown[] = [];
  assert.equal(pendingDurableSubagentReports(branchA).length, 1);
  assert.equal(pendingDurableSubagentReports(branchB).length, 0);
});

test("recovery scan has a hard transcript-entry bound", () => {
  const report = createDurableSubagentReport("a", "report-a", { now: 1, reportId: REPORT_ID_A });
  const padding = Array.from({ length: MAX_REPORT_SCAN_ENTRIES }, () => ({ type: "message" }));
  assert.deepEqual(pendingDurableSubagentReports([custom(report), ...padding]), []);
  assert.equal(pendingDurableSubagentReports([...padding.slice(1), custom(report)]).length, 1);
});

test("invalid routing identities and unbounded fallback inputs are rejected before persistence", () => {
  for (const id of ["", "has space", "é", "-leading", "x".repeat(129)]) {
    assert.throws(() => createDurableSubagentReport(id, "content", { reportId: REPORT_ID_A }), /identity/);
  }
  assert.throws(() => createDurableSubagentReport("valid", "", { reportId: REPORT_ID_A }), /empty/);
});

test("lifecycle harness appends, recovers, persists a marker, suppresses once after reload, and stops before tree navigation", async () => {
  const branch: any[] = [];
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  let notify: ((agentId: string, content: string) => void) | undefined;
  let stops = 0;
  const pi: any = {
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
      return `entry-${branch.length}`;
    },
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  const manager: any = {
    setNotifyHandler(handler: (agentId: string, content: string) => void) { notify = handler; },
    async stopAll() { stops++; return 1; },
  };
  const context = { sessionManager: { getBranch: () => branch } };

  installDurableSubagentReportLifecycle(pi, manager);
  notify?.("worker", "durable result");
  assert.equal(branch.length, 1);
  const before = handlers.get("before_agent_start")![0]!;
  const delivery = await before({}, context);
  assert.equal(delivery.message.customType, SUBAGENT_REPORT_MESSAGE_TYPE);
  assert.match(delivery.message.content, /\[from subagent: worker\]\ndurable result/);
  branch.push({ type: "custom_message", ...delivery.message });

  const reloadedHandlers = new Map<string, Array<(...args: any[]) => any>>();
  const reloadedPi = { ...pi, on(name: string, handler: (...args: any[]) => any) { reloadedHandlers.set(name, [...(reloadedHandlers.get(name) ?? []), handler]); } } as any;
  installDurableSubagentReportLifecycle(reloadedPi, manager);
  assert.equal(await reloadedHandlers.get("before_agent_start")![0]!({}, context), undefined);
  await reloadedHandlers.get("session_before_tree")![0]!({}, context);
  assert.equal(stops, 1);

  notify?.("has space", "must not fall back unbounded");
  assert.equal(branch.length, 2, "invalid routing IDs append no report or fallback message");
});

test("extension integration persists before recovery, uses no nextTurn queue, and tears children down before tree navigation", () => {
  const notifyStart = LIFECYCLE_SOURCE.indexOf("subagentManager.setNotifyHandler");
  const notifyEnd = LIFECYCLE_SOURCE.indexOf('pi.on("before_agent_start"', notifyStart);
  assert.ok(notifyStart >= 0 && notifyEnd > notifyStart);
  const notifyBlock = LIFECYCLE_SOURCE.slice(notifyStart, notifyEnd);
  assert.match(notifyBlock, /pi\.appendEntry\(SUBAGENT_REPORT_ENTRY_TYPE, report\)/);
  assert.doesNotMatch(notifyBlock, /sendMessage|nextTurn/);
  assert.match(LIFECYCLE_SOURCE, /pi\.on\("session_before_tree"[\s\S]*?subagentManager\.stopAll\(\)/);
  assert.match(INDEX_SOURCE, /installDurableSubagentReportLifecycle\(pi, subagentManager\)/);
  assert.match(INDEX_SOURCE, /const SubagentId = Type\.String\([\s\S]*?maxLength: 128[\s\S]*?pattern:/);
});

test("formatted reports retain exact agent attribution", () => {
  const a = createDurableSubagentReport("catalog", "done", { now: 1, reportId: REPORT_ID_A });
  const b = createDurableSubagentReport("approval", "blocked", { now: 2, reportId: REPORT_ID_B });
  assert.equal(formatDurableSubagentReports([a, b]), "[from subagent: catalog]\ndone\n\n[from subagent: approval]\nblocked");
  assert.throws(() => formatDurableSubagentReports([]), /No durable/);
});
