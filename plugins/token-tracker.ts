/**
 * Token Tracker Extension
 *
 * Aggregates token usage by model, provider, and date from all pi sessions.
 * Real-time: captures usage from each assistant message as it arrives.
 * Backfill: /tokens scan reads historical JSONL sessions.
 *
 * Storage: ~/.pi/tokens/usage.json
 * Commands: /tokens [today|week|month|all|scan|clear|help]
 *
 * Usage JSON structure:
 * {
 *   "daily": {
 *     "2026-05-22": {
 *       "openai-codex": {
 *         "gpt-5.5": {
 *           "input": 15925,
 *           "output": 544,
 *           "cacheRead": 9728,
 *           "cacheWrite": 0,
 *           "totalTokens": 26197,
 *           "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
 *           "requests": 2
 *         }
 *       }
 *     }
 *   },
 *   "_meta": {
 *     "firstSeen": "2026-05-22T00:00:00Z",
 *     "lastUpdated": "2026-05-28T12:00:00Z",
 *     "scannedFiles": {
 *       "/path/to/session.jsonl": { "mtime": 1716768000000, "date": "2026-05-27" }
 *     }
 *   }
 * }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Constants ───────────────────────────────────────────────────────────────

const TOKENS_DIR = path.join(os.homedir(), ".pi/tokens");
const USAGE_FILE = path.join(TOKENS_DIR, "usage.json");
const SESSIONS_DIR = path.join(os.homedir(), ".pi/agent/sessions");

// ── Types ───────────────────────────────────────────────────────────────────

interface TokenCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

interface ModelUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: TokenCost;
	requests: number;
}

interface ProviderUsage {
	[modelId: string]: ModelUsage;
}

interface DailyUsage {
	[provider: string]: ProviderUsage;
}

interface ScannedFile {
	mtime: number;
	date: string;
}

interface UsageData {
	daily: Record<string, DailyUsage>;
	_meta: {
		firstSeen: string | null;
		lastUpdated: string | null;
		scannedFiles: Record<string, ScannedFile>;
	};
}

// ── Data Management ─────────────────────────────────────────────────────────

function ensureDir(): void {
	if (!fs.existsSync(TOKENS_DIR)) {
		fs.mkdirSync(TOKENS_DIR, { recursive: true });
	}
}

function loadUsage(): UsageData {
	ensureDir();
	try {
		if (fs.existsSync(USAGE_FILE)) {
			const raw = fs.readFileSync(USAGE_FILE, "utf-8");
			const parsed = JSON.parse(raw);
			return {
				daily: parsed.daily ?? {},
				_meta: {
					firstSeen: parsed._meta?.firstSeen ?? null,
					lastUpdated: parsed._meta?.lastUpdated ?? null,
					scannedFiles: parsed._meta?.scannedFiles ?? {},
				},
			};
		}
	} catch (err) {
		console.error("[token-tracker] Failed to load usage:", err);
	}
	return { daily: {}, _meta: { firstSeen: null, lastUpdated: null, scannedFiles: {} } };
}

function saveUsage(data: UsageData): void {
	ensureDir();
	try {
		data._meta.lastUpdated = new Date().toISOString();
		if (!data._meta.firstSeen) {
			data._meta.firstSeen = data._meta.lastUpdated;
		}
		fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
	} catch (err) {
		console.error("[token-tracker] Failed to save usage:", err);
	}
}

function todayKey(): string {
	return new Date().toISOString().slice(0, 10);
}

function ensureProvider(day: DailyUsage, provider: string): ProviderUsage {
	if (!day[provider]) day[provider] = {};
	return day[provider];
}

function ensureModel(providerData: ProviderUsage, model: string): ModelUsage {
	if (!providerData[model]) {
		providerData[model] = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			requests: 0,
		};
	}
	return providerData[model];
}

// ── Message Extraction ──────────────────────────────────────────────────────

function extractUsageFromMessage(
	message: Record<string, unknown>,
): { provider: string; modelId: string; usage: ModelUsage } | null {
	const provider = typeof message.provider === "string" ? message.provider : null;
	const model = typeof message.model === "string" ? message.model : null;
	const usageRaw = (message as Record<string, unknown>).usage as
		| { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } }
		| undefined;

	if (!provider || !model || !usageRaw) return null;

	const usage: ModelUsage = {
		input: usageRaw.input ?? 0,
		output: usageRaw.output ?? 0,
		cacheRead: usageRaw.cacheRead ?? 0,
		cacheWrite: usageRaw.cacheWrite ?? 0,
		totalTokens: usageRaw.totalTokens ?? 0,
		cost: {
			input: usageRaw.cost?.input ?? 0,
			output: usageRaw.cost?.output ?? 0,
			cacheRead: usageRaw.cost?.cacheRead ?? 0,
			cacheWrite: usageRaw.cost?.cacheWrite ?? 0,
			total: usageRaw.cost?.total ?? 0,
		},
		requests: 1,
	};

	return { provider, modelId: model, usage };
}

// ── Session Scanning (Backfill) ─────────────────────────────────────────────

function scanSessions(): { processed: number; newEntries: number; errors: number } {
	const data = loadUsage();
	let processed = 0;
	let newEntries = 0;
	let errors = 0;

	if (!fs.existsSync(SESSIONS_DIR)) {
		return { processed: 0, newEntries: 0, errors: 0 };
	}

	const projectDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory());

	for (const dirEnt of projectDirs) {
		const dirPath = path.join(SESSIONS_DIR, dirEnt.name);
		let files: string[];
		try {
			files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			const filePath = path.join(dirPath, file);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(filePath);
			} catch {
				continue;
			}

			// Check if already scanned with same mtime
			const scanned = data._meta.scannedFiles[filePath];
			if (scanned && scanned.mtime === stat.mtimeMs) {
				continue;
			}
			processed++;

			// Read the file and extract usage
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const lines = content.trim().split("\n");

				let sessionDate: string | null = null;

				// First line is session metadata
				if (lines.length > 0) {
					const header = JSON.parse(lines[0]);
					if (header.type === "session" && header.timestamp) {
						sessionDate = header.timestamp.slice(0, 10);
					}
				}

				// If we couldn't get the date from the header, use file mtime
				if (!sessionDate) {
					sessionDate = new Date(stat.mtimeMs).toISOString().slice(0, 10);
				}

				// Process message lines
				for (let i = 1; i < lines.length; i++) {
					try {
						const line = JSON.parse(lines[i]);
						if (line.type !== "message") continue;
						const msg = line.message;
						if (!msg || msg.role !== "assistant") continue;

						const extracted = extractUsageFromMessage(msg);
						if (!extracted) continue;

						// Add to in-memory data directly
						if (!data.daily[sessionDate]) data.daily[sessionDate] = {};
						const dayData = data.daily[sessionDate];
						const prov = ensureProvider(dayData, extracted.provider);
						const modelData = ensureModel(prov, extracted.modelId);

						modelData.input += extracted.usage.input;
						modelData.output += extracted.usage.output;
						modelData.cacheRead += extracted.usage.cacheRead;
						modelData.cacheWrite += extracted.usage.cacheWrite;
						modelData.totalTokens += extracted.usage.totalTokens;
						modelData.cost.input += extracted.usage.cost.input;
						modelData.cost.output += extracted.usage.cost.output;
						modelData.cost.cacheRead += extracted.usage.cost.cacheRead;
						modelData.cost.cacheWrite += extracted.usage.cost.cacheWrite;
						modelData.cost.total += extracted.usage.cost.total;
						modelData.requests += extracted.usage.requests;

						newEntries++;
					} catch {
						// Skip malformed lines
					}
				}

				// Mark as scanned
				data._meta.scannedFiles[filePath] = {
					mtime: stat.mtimeMs,
					date: sessionDate,
				};
			} catch (err) {
				errors++;
				console.error(`[token-tracker] Failed to scan ${filePath}:`, err);
			}
		}
	}

	saveUsage(data);

	return { processed, newEntries, errors };
}

// ── Reporting Helpers ───────────────────────────────────────────────────────

interface ReportLine {
	provider: string;
	modelId: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	requests: number;
}

interface Report {
	lines: ReportLine[];
	totals: ReportLine;
	dateRange: string;
	dailyData: Record<string, DailyUsage>;
}

function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(Math.round(n));
}

function fmtCost(n: number): string {
	if (n === 0) return "$0.00";
	if (n < 0.01) return "<$0.01";
	return `$${n.toFixed(2)}`;
}

function collectReport(dates: string[]): Report {
	const data = loadUsage();
	const lines: ReportLine[] = [];
	const dailyData: Record<string, DailyUsage> = {};

	const totals: ReportLine = {
		provider: "TOTAL",
		modelId: "",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		requests: 0,
	};

	const modelMap = new Map<string, ReportLine>();

	for (const date of dates) {
		const day = data.daily[date];
		if (!day) continue;
		dailyData[date] = day;

		for (const [provider, provData] of Object.entries(day)) {
			for (const [modelId, usage] of Object.entries(provData)) {
				const key = `${provider}/${modelId}`;
				const existing = modelMap.get(key);
				if (existing) {
					existing.input += usage.input;
					existing.output += usage.output;
					existing.cacheRead += usage.cacheRead;
					existing.cacheWrite += usage.cacheWrite;
					existing.totalTokens += usage.totalTokens;
					existing.cost += usage.cost.total;
					existing.requests += usage.requests;
				} else {
					modelMap.set(key, {
						provider,
						modelId,
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
						totalTokens: usage.totalTokens,
						cost: usage.cost.total,
						requests: usage.requests,
					});
				}

				totals.input += usage.input;
				totals.output += usage.output;
				totals.cacheRead += usage.cacheRead;
				totals.cacheWrite += usage.cacheWrite;
				totals.totalTokens += usage.totalTokens;
				totals.cost += usage.cost.total;
				totals.requests += usage.requests;
			}
		}
	}

	// Sort: by total cost descending, then by total tokens descending
	const sorted = [...modelMap.values()].sort((a, b) => {
		const costDiff = b.cost - a.cost;
		if (Math.abs(costDiff) > 0.001) return costDiff;
		return b.totalTokens - a.totalTokens;
	});

	const dateStr =
		dates.length === 1
			? dates[0]
			: `${dates[0]} to ${dates[dates.length - 1]}`;

	return { lines: sorted, totals, dateRange: dateStr, dailyData };
}

function daysInWeek(): string[] {
	const now = new Date();
	const day = now.getDay();
	const monday = new Date(now);
	monday.setDate(now.getDate() - ((day + 6) % 7));
	const days: string[] = [];
	for (let i = 0; i < 7; i++) {
		const d = new Date(monday);
		d.setDate(monday.getDate() + i);
		days.push(d.toISOString().slice(0, 10));
	}
	return days;
}

function daysInMonth(): string[] {
	const now = new Date();
	const year = now.getFullYear();
	const month = now.getMonth();
	const days: string[] = [];
	const date = new Date(year, month, 1);
	while (date.getMonth() === month) {
		days.push(date.toISOString().slice(0, 10));
		date.setDate(date.getDate() + 1);
	}
	return days;
}

function allDays(): string[] {
	const data = loadUsage();
	return Object.keys(data.daily).sort();
}

function daysSince(since: string): string[] {
	const start = new Date(since + "T00:00:00Z");
	if (isNaN(start.getTime())) return [];
	const now = new Date();
	const days: string[] = [];
	const d = new Date(start);
	while (d <= now) {
		days.push(d.toISOString().slice(0, 10));
		d.setDate(d.getDate() + 1);
	}
	return days;
}

// ── Report Renderers ────────────────────────────────────────────────────────

function renderTextReport(report: Report): string {
	const lines: string[] = [];

	lines.push(`╔══════════════════════════════════════════════════════════════════════════════╗`);
	lines.push(`║  Token Usage Report — ${report.dateRange.padEnd(43)}║`);
	lines.push(`╠══════════════════════════════════════════════════════════════════════════════╣`);

	if (report.lines.length === 0) {
		lines.push(`║  No usage data for this period.                                               ║`);
	} else {
		// Header
		lines.push(
			`║ Provider/Model               Input       Output     CacheRd    CacheWr      Total   Cost    Reqs ║`,
		);
		lines.push(
			`║ ──────────────────────────── ────────── ────────── ────────── ────────── ───────── ─────── ──── ║`,
		);

		for (const entry of report.lines) {
			const name = `${entry.provider}/${entry.modelId}`.slice(0, 28).padEnd(28);
			const inp = fmtNum(entry.input).padStart(10);
			const out = fmtNum(entry.output).padStart(10);
			const cr = fmtNum(entry.cacheRead).padStart(10);
			const cw = fmtNum(entry.cacheWrite).padStart(10);
			const total = fmtNum(entry.totalTokens).padStart(9);
			const cost = fmtCost(entry.cost).padStart(7);
			const reqs = String(entry.requests).padStart(4);
			lines.push(`║ ${name} ${inp} ${out} ${cr} ${cw} ${total} ${cost} ${reqs} ║`);
		}

		// Totals separator
		lines.push(
			`║ ──────────────────────────── ────────── ────────── ────────── ────────── ───────── ─────── ──── ║`,
		);
		const totInp = fmtNum(report.totals.input).padStart(10);
		const totOut = fmtNum(report.totals.output).padStart(10);
		const totCr = fmtNum(report.totals.cacheRead).padStart(10);
		const totCw = fmtNum(report.totals.cacheWrite).padStart(10);
		const totTotal = fmtNum(report.totals.totalTokens).padStart(9);
		const totCost = fmtCost(report.totals.cost).padStart(7);
		const totReqs = String(report.totals.requests).padStart(4);
		lines.push(`║ TOTAL                         ${totInp} ${totOut} ${totCr} ${totCw} ${totTotal} ${totCost} ${totReqs} ║`);
	}

	lines.push(`╚══════════════════════════════════════════════════════════════════════════════╝`);
	return lines.join("\n");
}

function renderTuiReport(
	report: Report,
	width: number,
	header: string,
	subtitle: string,
	footer: string,
	theme: { fg: (style: string, text: string) => string; bold: (text: string) => string },
): string[] {
	const out: string[] = [];
	out.push(theme.fg("accent", theme.bold(header)));
	out.push(theme.fg("dim", `  ${subtitle}`));
	out.push("");

	if (report.lines.length === 0) {
		out.push(theme.fg("muted", "  No token usage data for this period."));
	} else {
		const nameW = 30;
		const numW = 10;

		const hdr =
			"Provider/Model".padEnd(nameW) +
			"Input".padStart(numW) +
			"Output".padStart(numW) +
			"CacheRd".padStart(numW) +
			"CacheWr".padStart(numW) +
			"Total".padStart(numW) +
			"Cost".padStart(8) +
			"Reqs".padStart(5);
		out.push(theme.fg("dim", `  ${hdr}`));
		out.push(theme.fg("dim", `  ${"─".repeat(hdr.length)}`));

		for (const entry of report.lines) {
			const name = `${entry.provider}/${entry.modelId}`;
			const truncatedName = name.length > nameW - 2 ? name.slice(0, nameW - 3) + "…" : name;
			out.push(
				`  ${theme.fg("text", truncatedName.padEnd(nameW))}` +
					`${theme.fg("text", fmtNum(entry.input).padStart(numW))}` +
					`${theme.fg("text", fmtNum(entry.output).padStart(numW))}` +
					`${theme.fg("muted", fmtNum(entry.cacheRead).padStart(numW))}` +
					`${theme.fg("muted", fmtNum(entry.cacheWrite).padStart(numW))}` +
					`${theme.fg("accent", fmtNum(entry.totalTokens).padStart(numW))}` +
					`${theme.fg(entry.cost > 0 ? "warning" : "muted", fmtCost(entry.cost).padStart(8))}` +
					`${theme.fg("muted", String(entry.requests).padStart(5))}`,
			);
		}

		out.push(theme.fg("dim", `  ${"─".repeat(hdr.length)}`));
		out.push(
			`  ${theme.fg("accent", theme.bold("TOTAL".padEnd(nameW)))}` +
				`${theme.fg("accent", theme.bold(fmtNum(report.totals.input).padStart(numW)))}` +
				`${theme.fg("accent", theme.bold(fmtNum(report.totals.output).padStart(numW)))}` +
				`${theme.fg("accent", theme.bold(fmtNum(report.totals.cacheRead).padStart(numW)))}` +
				`${theme.fg("accent", theme.bold(fmtNum(report.totals.cacheWrite).padStart(numW)))}` +
				`${theme.fg("accent", theme.bold(fmtNum(report.totals.totalTokens).padStart(numW)))}` +
				`${theme.fg("accent", theme.bold(fmtCost(report.totals.cost).padStart(8)))}` +
				`${theme.fg("accent", theme.bold(String(report.totals.requests).padStart(5)))}`,
		);

		if (Object.keys(report.dailyData).length > 1) {
			out.push("");
			out.push(theme.fg("dim", "  Daily breakdown:"));
			for (const date of Object.keys(report.dailyData).sort()) {
				let dayTotal = 0;
				for (const prov of Object.values(report.dailyData[date])) {
					for (const usage of Object.values(prov)) {
						dayTotal += usage.totalTokens;
					}
				}
				out.push(`    ${theme.fg("muted", date)}  ${theme.fg("text", fmtNum(dayTotal).padStart(10))} tokens`);
			}
		}
	}

	out.push("");
	out.push(theme.fg("dim", `  ${footer}`));
	return out;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Real-time tracking: capture usage from each assistant message ────
	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;

		const msg = event.message as unknown as Record<string, unknown>;
		const extracted = extractUsageFromMessage(msg);
		if (!extracted) return;

		const date = todayKey();

		// Write directly to avoid load/save race conditions with concurrent sessions.
		// Single JSON file writes are atomic enough for this use case.
		const data = loadUsage();
		if (!data.daily[date]) data.daily[date] = {};
		const dayData = data.daily[date];
		const prov = ensureProvider(dayData, extracted.provider);
		const modelData = ensureModel(prov, extracted.modelId);

		modelData.input += extracted.usage.input;
		modelData.output += extracted.usage.output;
		modelData.cacheRead += extracted.usage.cacheRead;
		modelData.cacheWrite += extracted.usage.cacheWrite;
		modelData.totalTokens += extracted.usage.totalTokens;
		modelData.cost.input += extracted.usage.cost.input;
		modelData.cost.output += extracted.usage.cost.output;
		modelData.cost.cacheRead += extracted.usage.cost.cacheRead;
		modelData.cost.cacheWrite += extracted.usage.cost.cacheWrite;
		modelData.cost.total += extracted.usage.cost.total;
		modelData.requests += extracted.usage.requests;

		saveUsage(data);
	});

	// ── /tokens command — dispatch to subcommands ───────────────────────
	pi.registerCommand("tokens", {
		description: "Show or manage token usage tracking",
		handler: async (args, ctx) => {
			const sub = (args?.[0] ?? "today").toLowerCase();

			if (!ctx.hasUI) {
				// Print mode: render text report
				let report: Report;
				switch (sub) {
					case "scan":
						const scanResult = scanSessions();
						console.log(`Scanned ${scanResult.processed} session files.`);
						console.log(`Added ${scanResult.newEntries} new usage entries.`);
						if (scanResult.errors > 0) console.log(`${scanResult.errors} errors.`);
						return;
					case "all":
						report = collectReport(allDays());
						break;
					case "week":
						report = collectReport(daysInWeek());
						break;
					case "month":
						report = collectReport(daysInMonth());
						break;
					case "clear": {
						const data = loadUsage();
						data.daily = {};
						data._meta.scannedFiles = {};
						saveUsage(data);
						console.log("Token usage data cleared.");
						return;
					}
					case "help":
						console.log("/tokens [today|week|month|all|scan|clear|help]");
						console.log("  today  — Show today's token usage (default)");
						console.log("  week   — Show this week (Mon-Sun)");
						console.log("  month  — Show this month");
						console.log("  all    — Show all-time usage");
						console.log("  scan   — Backfill from historical session files");
						console.log("  clear  — Reset all usage tracking data");
						return;
					default:
						// Try to parse as "since YYYY-MM-DD"
						if (/^\d{4}-\d{2}-\d{2}$/.test(sub)) {
							const since = daysSince(sub);
							if (since.length === 0) {
								console.log(`Invalid date: ${sub}`);
								return;
							}
							report = collectReport(since);
						} else {
							report = collectReport([todayKey()]);
						}
				}

				console.log(renderTextReport(report));
				return;
			}

			// TUI mode: render in a custom panel
			switch (sub) {
				case "scan":
					ctx.ui.notify("Scanning historical sessions...", "info");
					// Run scan asynchronously since it can be slow
					setTimeout(() => {
						const result = scanSessions();
						ctx.ui.notify(
							`Token scan complete: ${result.processed} files, ${result.newEntries} entries, ${result.errors} errors`,
							result.errors > 0 ? "warning" : "info",
						);
					}, 10);
					ctx.ui.notify(
						"Scan running in background. Use /tokens all to see results when done.",
						"info",
					);
					return;

				case "clear": {
					const data = loadUsage();
					data.daily = {};
					data._meta.scannedFiles = {};
					saveUsage(data);
					ctx.ui.notify("Token usage data cleared.", "info");
					return;
				}

				case "help":
					ctx.ui.notify(
						"/tokens [today|week|month|all|scan|clear|since YYYY-MM-DD]",
						"info",
					);
					return;
			}

			let report: Report;
			let title: string;
			let subtitle: string;

			switch (sub) {
				case "all":
					report = collectReport(allDays());
					title = "📊 Token Usage — All Time";
					subtitle = `Since ${report.dailyData ? Object.keys(report.dailyData).sort()[0] ?? "—" : "—"} · ${report.lines.length} model(s)`;
					break;
				case "week":
					report = collectReport(daysInWeek());
					title = "📊 Token Usage — This Week";
					subtitle = `${report.dateRange} · ${report.lines.length} model(s)`;
					break;
				case "month":
					report = collectReport(daysInMonth());
					title = "📊 Token Usage — This Month";
					subtitle = `${report.dateRange} · ${report.lines.length} model(s)`;
					break;
				default:
					if (/^\d{4}-\d{2}-\d{2}$/.test(sub)) {
						const since = daysSince(sub);
						if (since.length === 0) {
							ctx.ui.notify(`Invalid date: ${sub}`, "error");
							return;
						}
						report = collectReport(since);
						title = "📊 Token Usage";
						subtitle = `Since ${sub} · ${report.lines.length} model(s)`;
					} else {
						report = collectReport([todayKey()]);
						title = "📊 Token Usage — Today";
						subtitle = `${report.dateRange} · ${report.lines.length} model(s)`;
					}
			}

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => done(), 15000);

				const footer = "Auto-closes in 15s · Press any key to close · /tokens [week|month|all|scan]";

				return {
					render: (width: number) => {
						return renderTuiReport(report, width, title, subtitle, footer, theme);
					},
					handleInput: () => {
						if (timeout) {
							clearTimeout(timeout);
							timeout = null;
						}
						done();
						return true;
					},
					invalidate: () => {},
				};
			});
		},
	});

	// ── Session start — log that tracker is active ──────────────────────
	pi.on("session_start", async (_event, ctx) => {
		const data = loadUsage();
		const totalDays = Object.keys(data.daily).length;
		if (ctx.hasUI && totalDays > 0) {
			// Count today's tokens
			const today = todayKey();
			const todayData = data.daily[today];
			let todayTokens = 0;
			if (todayData) {
				for (const prov of Object.values(todayData)) {
					for (const usage of Object.values(prov)) {
						todayTokens += usage.totalTokens;
					}
				}
			}

			if (todayTokens > 0) {
				ctx.ui.notify(
					`Token tracker: ${fmtNum(todayTokens)} tokens used today across ${totalDays} tracked day(s). /tokens for report`,
					"info",
				);
			}
		}
	});
}