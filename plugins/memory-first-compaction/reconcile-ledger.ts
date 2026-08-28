import * as fs from "node:fs";
import * as path from "node:path";

import { readValidatedLedgerFile } from "./ledger.js";
import {
  DEFAULT_MAX_VARIANCE,
  parseReconciliationReferenceDocument,
  reconcileLedgerUsage,
} from "./reconcile.js";

function usage(): never {
  throw new Error("usage: reconcile-ledger <absolute-ledger-path> <absolute-reference-json> [--max-variance <0..1>]");
}

function readReference(filePath: string): unknown {
  if (!path.isAbsolute(filePath)) throw new Error("reference path must be absolute");
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("reference must be a regular file");
  if (stat.size > 256 * 1024) throw new Error("reference file exceeds 256 KiB");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

try {
  const args = process.argv.slice(2);
  if (args.length < 2) usage();
  const ledgerPath = args.shift()!;
  const referencePath = args.shift()!;
  if (!path.isAbsolute(ledgerPath) || !path.isAbsolute(referencePath)) usage();
  let maxVariance = DEFAULT_MAX_VARIANCE;
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (flag !== "--max-variance" || value === undefined) usage();
    maxVariance = Number(value);
  }
  const records = readValidatedLedgerFile(ledgerPath);
  const reference = parseReconciliationReferenceDocument(readReference(referencePath));
  const report = reconcileLedgerUsage(records, reference, maxVariance);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pass ? 0 : 2;
} catch (error) {
  const message = error instanceof Error ? error.message : "reconciliation failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
