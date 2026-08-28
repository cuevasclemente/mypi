import * as path from "node:path";
import { maintainLedgerFile } from "./ledger.js";

function usage(): never {
  throw new Error("usage: maintain-ledger <absolute-ledger-path> --aggregate <absolute-aggregate-path> [--now <ISO timestamp>] [--days <positive integer>]");
}

const args = process.argv.slice(2);
if (args.length < 3) usage();
const ledgerArgument = args.shift()!;
if (!path.isAbsolute(ledgerArgument)) usage();
let aggregatePath: string | undefined;
let now = new Date();
let days = 90;
while (args.length > 0) {
  const flag = args.shift();
  const value = args.shift();
  if (!value) usage();
  if (flag === "--aggregate" && path.isAbsolute(value)) aggregatePath = value;
  else if (flag === "--now") now = new Date(value);
  else if (flag === "--days" && /^\d+$/u.test(value)) days = Number(value);
  else usage();
}
if (!aggregatePath) usage();

const result = maintainLedgerFile(ledgerArgument, aggregatePath, now, days);
process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  cutoff_day: result.cutoffDay,
  retained_count: result.retained.length,
  aged_out_count: result.agedOutCount,
  duplicate_count: result.duplicateCount,
  pruned_count: result.prunedCount,
  aggregates_written: result.aggregateAppendCount,
}, null, 2)}\n`);
