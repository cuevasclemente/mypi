import {
  SOURCE_CLASSES,
  type MemoryLedgerRecord,
  type MemorySourceClass,
  type UsageComponents,
} from "./ledger.js";

export const RECONCILIATION_SOURCES = ["transcript", "provider", "scheduled", "subagent"] as const;
export const DEFAULT_MAX_VARIANCE = 0.005;
export type ReconciliationSource = typeof RECONCILIATION_SOURCES[number];

export interface UsageTotals extends UsageComponents {
  requests: number;
}

export interface ReconciliationReference extends UsageTotals {
  source: ReconciliationSource;
  source_class: MemorySourceClass;
}

export interface ReconciliationReferenceDocument {
  schema_version: 1;
  references: ReconciliationReference[];
}

export interface MetricComparison {
  expected: number;
  actual: number;
  delta: number;
  variance: number | null;
  pass: boolean;
}

export interface ReconciliationRow {
  source: ReconciliationSource;
  source_class: MemorySourceClass;
  metrics: Record<keyof UsageTotals, MetricComparison>;
  pass: boolean;
}

export interface ReconciliationReport {
  schema_version: 1;
  max_variance: number;
  pass: boolean;
  rows: ReconciliationRow[];
}

const USAGE_KEYS = [
  "requests",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
] as const satisfies readonly (keyof UsageTotals)[];

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isReconciliationReference(value: unknown): value is ReconciliationReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return exactKeys(reference, ["source", "source_class", ...USAGE_KEYS])
    && typeof reference.source === "string"
    && (RECONCILIATION_SOURCES as readonly string[]).includes(reference.source)
    && typeof reference.source_class === "string"
    && (SOURCE_CLASSES as readonly string[]).includes(reference.source_class)
    && USAGE_KEYS.every((key) => count(reference[key]));
}

export function parseReconciliationReferenceDocument(value: unknown): ReconciliationReferenceDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reference document must be an object");
  const document = value as Record<string, unknown>;
  if (!exactKeys(document, ["schema_version", "references"]) || document.schema_version !== 1) {
    throw new Error("unsupported reconciliation reference schema");
  }
  if (!Array.isArray(document.references) || document.references.length === 0 || document.references.length > 64) {
    throw new Error("reconciliation references must contain 1 to 64 rows");
  }
  if (!document.references.every(isReconciliationReference)) throw new Error("invalid reconciliation reference row");
  const identities = new Set<string>();
  for (const reference of document.references) {
    const identity = `${reference.source}\0${reference.source_class}`;
    if (identities.has(identity)) throw new Error("duplicate reconciliation reference row");
    identities.add(identity);
  }
  return { schema_version: 1, references: [...document.references] };
}

function zeroTotals(): UsageTotals {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
  };
}

export function ledgerUsageTotals(records: readonly MemoryLedgerRecord[]): Map<MemorySourceClass, UsageTotals> {
  const totals = new Map<MemorySourceClass, UsageTotals>();
  for (const record of records) {
    if (record.event !== "request_usage" && record.event !== "compaction_usage") continue;
    const current = totals.get(record.source_class) ?? zeroTotals();
    current.requests++;
    current.input_tokens += record.input_tokens;
    current.output_tokens += record.output_tokens;
    current.cache_read_tokens += record.cache_read_tokens;
    current.cache_write_tokens += record.cache_write_tokens;
    current.total_tokens += record.total_tokens;
    totals.set(record.source_class, current);
  }
  return totals;
}

function compareMetric(expected: number, actual: number, maxVariance: number): MetricComparison {
  const delta = actual - expected;
  if (expected === 0) {
    return { expected, actual, delta, variance: actual === 0 ? 0 : null, pass: actual === 0 };
  }
  const variance = Math.abs(delta) / expected;
  return { expected, actual, delta, variance, pass: variance <= maxVariance };
}

export function reconcileLedgerUsage(
  records: readonly MemoryLedgerRecord[],
  referenceDocument: ReconciliationReferenceDocument,
  maxVariance = DEFAULT_MAX_VARIANCE,
): ReconciliationReport {
  if (!Number.isFinite(maxVariance) || maxVariance < 0 || maxVariance > 1) {
    throw new Error("maxVariance must be between 0 and 1");
  }
  const references = parseReconciliationReferenceDocument(referenceDocument).references;
  const actualByClass = ledgerUsageTotals(records);
  const rows = references.map((reference): ReconciliationRow => {
    const actual = actualByClass.get(reference.source_class) ?? zeroTotals();
    const metrics = Object.fromEntries(USAGE_KEYS.map((key) => [
      key,
      compareMetric(reference[key], actual[key], maxVariance),
    ])) as Record<keyof UsageTotals, MetricComparison>;
    return {
      source: reference.source,
      source_class: reference.source_class,
      metrics,
      pass: USAGE_KEYS.every((key) => metrics[key].pass),
    };
  });
  return {
    schema_version: 1,
    max_variance: maxVariance,
    pass: rows.every((row) => row.pass),
    rows,
  };
}
