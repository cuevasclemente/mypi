import { createHash, randomUUID } from "node:crypto";

export const SUBAGENT_REPORT_ENTRY_TYPE = "agent-teams-subagent-report";
export const SUBAGENT_REPORT_MESSAGE_TYPE = "subagent-notify";
export const MAX_DURABLE_REPORT_BYTES = 32 * 1024;
export const MAX_RECOVERED_REPORTS_PER_TURN = 8;
export const MAX_RECOVERED_REPORT_BYTES = 48 * 1024;
export const MAX_REPORT_SCAN_ENTRIES = 10_000;

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const REPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface DurableSubagentReport {
  readonly schemaVersion: 1;
  readonly reportId: string;
  readonly agentId: string;
  readonly createdAt: number;
  readonly content: string;
  readonly contentSha256: string;
  readonly storedContentSha256: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function createDurableSubagentReport(
  agentId: string,
  content: string,
  options: { now?: number; reportId?: string; maxBytes?: number } = {},
): DurableSubagentReport {
  if (!AGENT_ID_RE.test(agentId)) throw new Error("Invalid subagent report identity");
  if (typeof content !== "string" || !content.trim()) throw new Error("Subagent report is empty");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid subagent report timestamp");
  const reportId = options.reportId ?? randomUUID();
  if (!REPORT_ID_RE.test(reportId)) throw new Error("Invalid subagent report ID");
  const maxBytes = options.maxBytes ?? MAX_DURABLE_REPORT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_DURABLE_REPORT_BYTES) {
    throw new Error("Invalid subagent report bound");
  }

  const originalBytes = Buffer.byteLength(content, "utf8");
  const truncated = originalBytes > maxBytes;
  const suffix = "\n[durable subagent report truncated]";
  const storedContent = truncated
    ? `${utf8Prefix(content, Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8")))}${suffix}`
    : content;

  return Object.freeze({
    schemaVersion: 1 as const,
    reportId,
    agentId,
    createdAt: now,
    content: storedContent,
    contentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
    storedContentSha256: createHash("sha256").update(storedContent, "utf8").digest("hex"),
    originalBytes,
    truncated,
  });
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function parseReport(value: unknown): DurableSubagentReport | null {
  const record = ownRecord(value);
  if (!record) return null;
  const keys = Object.keys(record).sort();
  if (keys.join("\0") !== [
    "agentId", "content", "contentSha256", "createdAt", "originalBytes", "reportId", "schemaVersion", "storedContentSha256", "truncated",
  ].sort().join("\0")) return null;
  if (record.schemaVersion !== 1
    || typeof record.reportId !== "string" || !REPORT_ID_RE.test(record.reportId)
    || typeof record.agentId !== "string" || !AGENT_ID_RE.test(record.agentId)
    || typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || typeof record.content !== "string" || !record.content.trim()
    || Buffer.byteLength(record.content, "utf8") > MAX_DURABLE_REPORT_BYTES
    || typeof record.contentSha256 !== "string" || !SHA256_RE.test(record.contentSha256)
    || typeof record.storedContentSha256 !== "string" || !SHA256_RE.test(record.storedContentSha256)
    || createHash("sha256").update(record.content, "utf8").digest("hex") !== record.storedContentSha256
    || typeof record.originalBytes !== "number" || !Number.isSafeInteger(record.originalBytes) || record.originalBytes < 1
    || typeof record.truncated !== "boolean") return null;
  if (!record.truncated && (
    record.originalBytes !== Buffer.byteLength(record.content, "utf8")
    || record.contentSha256 !== record.storedContentSha256
  )) return null;
  if (record.truncated && record.originalBytes <= Buffer.byteLength(record.content, "utf8")) return null;
  return Object.freeze(record as unknown as DurableSubagentReport);
}

function deliveredIds(entry: unknown): string[] {
  const record = ownRecord(entry);
  if (!record || record.type !== "custom_message" || record.customType !== SUBAGENT_REPORT_MESSAGE_TYPE) return [];
  const details = ownRecord(record.details);
  if (!details || Object.keys(details).sort().join("\0") !== "durableReportIds" || !Array.isArray(details.durableReportIds)) return [];
  if (details.durableReportIds.length < 1 || details.durableReportIds.length > MAX_RECOVERED_REPORTS_PER_TURN) return [];
  const ids = details.durableReportIds;
  if (!ids.every((id): id is string => typeof id === "string" && REPORT_ID_RE.test(id))) return [];
  if (new Set(ids).size !== ids.length) return [];
  return ids;
}

export function pendingDurableSubagentReports(
  branchEntries: readonly unknown[],
  options: { excludeReportIds?: ReadonlySet<string>; maxReports?: number; maxBytes?: number } = {},
): DurableSubagentReport[] {
  const reports = new Map<string, DurableSubagentReport>();
  const delivered = new Set<string>();
  const boundedEntries = branchEntries.length > MAX_REPORT_SCAN_ENTRIES
    ? branchEntries.slice(branchEntries.length - MAX_REPORT_SCAN_ENTRIES)
    : branchEntries;
  for (const entry of boundedEntries) {
    // A delivery marker is authoritative only for a report already present
    // earlier on this exact branch. A forged/pre-positioned valid-looking ID
    // cannot suppress a report appended later.
    for (const id of deliveredIds(entry)) {
      if (reports.has(id)) delivered.add(id);
    }
    const record = ownRecord(entry);
    if (!record || record.type !== "custom" || record.customType !== SUBAGENT_REPORT_ENTRY_TYPE) continue;
    const report = parseReport(record.data);
    if (report && !reports.has(report.reportId)) reports.set(report.reportId, report);
  }

  const maxReports = options.maxReports ?? MAX_RECOVERED_REPORTS_PER_TURN;
  const maxBytes = options.maxBytes ?? MAX_RECOVERED_REPORT_BYTES;
  const pending: DurableSubagentReport[] = [];
  let usedBytes = 0;
  for (const report of reports.values()) {
    if (delivered.has(report.reportId) || options.excludeReportIds?.has(report.reportId)) continue;
    const reportBytes = Buffer.byteLength(report.content, "utf8");
    if (pending.length >= maxReports || usedBytes + reportBytes > maxBytes) break;
    pending.push(report);
    usedBytes += reportBytes;
  }
  return pending;
}

export function formatDurableSubagentReports(reports: readonly DurableSubagentReport[]): string {
  if (reports.length === 0) throw new Error("No durable subagent reports to format");
  return reports.map((report) => `[from subagent: ${report.agentId}]\n${report.content}`).join("\n\n");
}
