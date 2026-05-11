/**
 * Dreamer Extension — Pi Dreaming / Skill Extraction
 *
 * A scheduled job that analyzes recent pi sessions and extracts reusable
 * workflows into Agent Skills. Skills are written to 3 redundant locations:
 *   1. ~/.pi/agent/skills/     (installed, auto-discovered by pi)
 *   2. ~/src/mypi/skills/      (backup)
 *   3. ~/src/memoriki/skills/  (backup)
 *
 * Triggered by a cron job at 9am PST daily, or manually via /dream command.
 *
 * Architecture:
 *   - Extension does bookkeeping: session discovery, batching, state tracking
 *   - Agent does creative work: subagent orchestration, pattern discovery,
 *     skill creation, file writing
 *
 * Phases (executed by the agent via subagents):
 *   1. Cheap subagents scan session batches for important workflows
 *   2. Orchestrator synthesizes findings, decides which merit skills
 *   3. Expensive subagent(s) create SKILL.md files for selected patterns
 *   4. Skills written to all 3 locations, state file updated
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Constants ───────────────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(os.homedir(), ".pi/agent/sessions");
const STATE_FILE = path.join(os.homedir(), ".pi/agent/dreamer-state.json");
const SKILL_LOCATIONS = [
	path.join(os.homedir(), ".pi/agent/skills"),
	path.join(os.homedir(), "src/mypi/skills"),
	path.join(os.homedir(), "src/memoriki/skills"),
];

/** Maximum sessions per cheap-subagent batch */
const BATCH_SIZE = 4;

/** Dream trigger keywords — input containing any of these triggers the dream cycle */
const DREAM_TRIGGERS = ["dream", "dream cycle", "/dream"];

// ── Types ───────────────────────────────────────────────────────────────────

interface SessionMeta {
	filePath: string;
	fileName: string;
	mtime: number;
	mtimeStr: string;
	cwd: string;
	project: string;
	firstUserMessage: string;
	messageCount: number;
	toolNames: string[];
}

interface ProcessedSession {
	mtime: number;
	mtimeStr: string;
	skillsGenerated: string[];
}

interface SkillRecord {
	created: string;
	sourceSessions: string[];
	description: string;
}

interface DreamerState {
	lastRun: string | null;
	processedSessions: Record<string, ProcessedSession>;
	skillsIndex: Record<string, SkillRecord>;
}

interface DreamContext {
	triggered: boolean;
	unprocessedSessions: SessionMeta[];
	batches: SessionMeta[][];
	lastRun: string | null;
	totalUnprocessed: number;
	catchUpMode: boolean;
}

// ── State Management ────────────────────────────────────────────────────────

function loadState(): DreamerState {
	try {
		if (fs.existsSync(STATE_FILE)) {
			const raw = fs.readFileSync(STATE_FILE, "utf-8");
			const parsed = JSON.parse(raw);
			return {
				lastRun: typeof parsed.lastRun === "string" ? parsed.lastRun : null,
				processedSessions: parsed.processedSessions ?? {},
				skillsIndex: parsed.skillsIndex ?? {},
			};
		}
	} catch (err) {
		console.error("[dreamer] Failed to load state:", err);
	}
	return { lastRun: null, processedSessions: {}, skillsIndex: {} };
}

function saveState(state: DreamerState): void {
	try {
		const dir = path.dirname(STATE_FILE);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
	} catch (err) {
		console.error("[dreamer] Failed to save state:", err);
	}
}

// ── Session Discovery ───────────────────────────────────────────────────────

/** Extract the project name from a session directory name */
function projectFromDir(dirName: string): string {
	// dirName is like "--home-clemente-src-memoriki--"
	const cleaned = dirName.replace(/^--?/, "").replace(/--?$/, "").replace(/--/g, "/");
	// Handle home directory
	const home = os.homedir();
	if (cleaned.startsWith(home)) return cleaned.slice(home.length + 1) || "~";
	// Handle other patterns
	const parts = cleaned.split("/").filter(Boolean);
	return parts.join("/") || cleaned;
}

/** Read just enough of a session JSONL to extract metadata */
function extractSessionMeta(filePath: string, fileName: string, mtime: number): SessionMeta | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.trim().split("\n");
		if (lines.length === 0) return null;

		const header = JSON.parse(lines[0]);
		if (header.type !== "session") return null;

		const cwd = header.cwd ?? "unknown";
		const project = cwd.replace(os.homedir(), "~");

		let firstUserMessage = "";
		let messageCount = 0;
		const toolNames = new Set<string>();

		for (let i = 1; i < lines.length; i++) {
			try {
				const entry = JSON.parse(lines[i]);
				if (entry.type === "message") {
					messageCount++;
					const msg = entry.message;
					if (msg?.role === "user" && !firstUserMessage) {
						if (Array.isArray(msg.content)) {
							for (const block of msg.content) {
								if (block.type === "text" && block.text) {
									firstUserMessage = block.text.slice(0, 200);
									break;
								}
							}
						} else if (typeof msg.content === "string") {
							firstUserMessage = msg.content.slice(0, 200);
						}
					}
					// Collect tool names from toolResult messages
					if (msg?.role === "toolResult" && msg.toolName) {
						toolNames.add(msg.toolName);
					}
				}
			} catch {
				// Skip malformed lines
			}
		}

		return {
			filePath,
			fileName,
			mtime,
			mtimeStr: new Date(mtime).toISOString(),
			cwd,
			project,
			firstUserMessage,
			messageCount,
			toolNames: [...toolNames].sort(),
		};
	} catch (err) {
		console.error(`[dreamer] Failed to extract meta from ${filePath}:`, err);
		return null;
	}
}

/** Discover all session files and their metadata */
function discoverSessions(): SessionMeta[] {
	const sessions: SessionMeta[] = [];

	if (!fs.existsSync(SESSIONS_DIR)) {
		console.error("[dreamer] Sessions directory not found:", SESSIONS_DIR);
		return sessions;
	}

	const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const dirName of dirs) {
		const dirPath = path.join(SESSIONS_DIR, dirName);
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

			const meta = extractSessionMeta(filePath, file, stat.mtimeMs);
			if (meta) sessions.push(meta);
		}
	}

	// Sort by modification time, newest first
	sessions.sort((a, b) => b.mtime - a.mtime);

	return sessions;
}

/** Find sessions that haven't been processed since the last run */
function findUnprocessed(sessions: SessionMeta[], state: DreamerState): SessionMeta[] {
	if (!state.lastRun) {
		// First run: process sessions from the last 24 hours
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		return sessions.filter((s) => s.mtime >= cutoff);
	}

	const lastRunTime = new Date(state.lastRun).getTime();

	// Find sessions modified after last run
	const newSessions = sessions.filter((s) => {
		const processed = state.processedSessions[s.filePath];
		if (!processed) return s.mtime > lastRunTime;
		// Session was processed but has been modified since
		return s.mtime > Math.max(processed.mtime, lastRunTime);
	});

	return newSessions;
}

/** Group sessions into batches for cheap subagents */
function batchSessions(sessions: SessionMeta[]): SessionMeta[][] {
	if (sessions.length === 0) return [];

	// Group by project first, then batch within projects
	const byProject = new Map<string, SessionMeta[]>();
	for (const s of sessions) {
		const existing = byProject.get(s.project) ?? [];
		existing.push(s);
		byProject.set(s.project, existing);
	}

	const batches: SessionMeta[][] = [];
	for (const [, projectSessions] of byProject) {
		for (let i = 0; i < projectSessions.length; i += BATCH_SIZE) {
			batches.push(projectSessions.slice(i, i + BATCH_SIZE));
		}
	}

	return batches;
}

// ── Dream Context Builder ───────────────────────────────────────────────────

function buildDreamContext(
	batches: SessionMeta[][],
	state: DreamerState,
	totalUnprocessed: number,
): string {
	const now = new Date().toISOString();
	const catchUp = state.lastRun
		? (Date.now() - new Date(state.lastRun).getTime()) > 25 * 60 * 60 * 1000
		: false;

	const lines: string[] = [];

	lines.push("# 🌙 Dream Cycle — Session Analysis & Skill Extraction");
	lines.push("");
	lines.push(`**Timestamp:** ${now}`);
	lines.push(`**Last dream run:** ${state.lastRun ?? "never"}`);
	if (catchUp) lines.push(`**⚠️ Catch-up mode:** last run was >24h ago — processing ${totalUnprocessed} sessions`);
	lines.push(`**Unprocessed sessions:** ${totalUnprocessed} in ${batches.length} batch(es)`);
	lines.push(`**Skills previously generated:** ${Object.keys(state.skillsIndex).length}`);
	lines.push("");

	lines.push("## Current Skills Index");
	lines.push("");
	if (Object.keys(state.skillsIndex).length === 0) {
		lines.push("No skills generated yet.");
	} else {
		for (const [name, record] of Object.entries(state.skillsIndex)) {
			lines.push(`- **${name}** — ${record.description} (created: ${record.created})`);
		}
	}
	lines.push("");

	lines.push("## Session Batches");
	lines.push("");

	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		lines.push(`### Batch ${i + 1} (${batch.length} session(s))`);
		lines.push("");
		for (const s of batch) {
			const toolStr = s.toolNames.length > 0 ? s.toolNames.join(", ") : "none";
			const msgPreview = s.firstUserMessage
				? s.firstUserMessage.slice(0, 120).replace(/\n/g, " ")
				: "(no user message)";
			lines.push(`- **${s.project}** — ${s.messageCount} msgs, tools: ${toolStr}`);
			lines.push(`  _${msgPreview}_`);
			lines.push(`  File: \`${s.filePath}\``);
		}
		lines.push("");
	}

	lines.push("## Instructions");
	lines.push("");

	lines.push("### Phase 1: Session Analysis (Cheap Subagents)");
	lines.push("");
	lines.push("For each batch above, spawn a **cheap subagent** (use `model: \"anthropic/claude-haiku-4-5\"` or `\"openai/gpt-4o-mini\"`).");
	lines.push("Each subagent should read ALL session files in its batch using the `read` tool. For each session, identify:");
	lines.push("");
	lines.push("1. **Primary task** — what was the user trying to accomplish?");
	lines.push("2. **Key workflows** — what sequences of actions were performed?");
	lines.push("3. **Tools and techniques** — what tools were used, any notable patterns?");
	lines.push("4. **Success/failure** — was the task completed? Any blockers?");
	lines.push("5. **Reusable insights** — what knowledge, patterns, or procedures would help future sessions?");
	lines.push("6. **Skill candidate** — could this workflow be captured as a reusable skill? If so, propose a skill name and brief description.");
	lines.push("");
	lines.push("Each subagent should return a structured report with findings for each session, plus a list of proposed skills.");
	lines.push("");

	lines.push("### Phase 2: Synthesis (Orchestrator — YOU)");
	lines.push("");
	lines.push("After all cheap subagents complete, review their outputs and decide:");
	lines.push("");
	lines.push("1. Which proposed skills are genuinely reusable across projects?");
	lines.push("2. Are there patterns that span multiple sessions (cross-session themes)?");
	lines.push("3. Do any proposed skills overlap with existing ones in the Skills Index above?");
	lines.push("4. Rate each candidate: **create**, **merge** (with existing), or **skip**.");
	lines.push("");

	lines.push("### Phase 3: Skill Creation (Expensive Subagent)");
	lines.push("");
	lines.push("For each skill you decide to CREATE, spawn an **expensive subagent** (use `model: \"anthropic/claude-sonnet-4-5\"` or your best available model) to generate the SKILL.md.");
	lines.push("");
	lines.push("**Skill requirements:**");
	lines.push("- Follow the [Agent Skills spec](https://agentskills.io/specification)");
	lines.push("- YAML frontmatter with `name` (kebab-case, max 64 chars, must match directory) and `description` (specific, max 1024 chars)");
	lines.push("- Clear setup section (dependencies, environment requirements)");
	lines.push("- Step-by-step workflow with concrete examples");
	lines.push("- References to tools and techniques from the source sessions");
	lines.push("- When relevant, include scripts or reference files");
	lines.push("");

	lines.push("**Output locations — write each skill to ALL THREE:**");
	lines.push("```");
	lines.push(`1. ~/.pi/agent/skills/<skill-name>/SKILL.md    (pi auto-discovery)`);
	lines.push(`2. ~/src/mypi/skills/<skill-name>/SKILL.md     (backup)`);
	lines.push(`3. ~/src/memoriki/skills/<skill-name>/SKILL.md (backup)`);
	lines.push("```");
	lines.push("Use `mkdir -p` to create directories as needed, then write SKILL.md via the `write` tool.");
	lines.push("");

	lines.push("### Phase 4: State Update");
	lines.push("");
	lines.push("After all skills are written, update the dreamer state file at:");
	lines.push(`\`${STATE_FILE}\``);
	lines.push("");
	lines.push("Use `read` to load the current state, then `edit` or `write` to update:");
	lines.push(`- Set \`lastRun\` to \`"${now}\``);
	lines.push("- Add each processed session to \`processedSessions\` with its mtime and generated skill names");
	lines.push("- Add each new skill to \`skillsIndex\` with its creation timestamp, source sessions, and description");
	lines.push("");

	lines.push("## Important Notes");
	lines.push("");
	lines.push("- **Do NOT read the state file for API keys or secrets** — it only contains session metadata");
	lines.push("- **Batch subagents can run in parallel** — spawn all batch readers at once, then collect results");
	lines.push("- **Skill names must be valid** — kebab-case, lowercase letters/numbers/hyphens only, match directory name");
	lines.push("- **Avoid duplicates** — check the Skills Index before creating a skill that already exists");
	lines.push("- **Be selective** — not every session warrants a skill. Only extract genuinely reusable patterns.");
	lines.push("- **After completing**, report what skills were created and where.");
	lines.push("");

	lines.push("Begin the dream cycle now. 🌙");

	return lines.join("\n");
}

// ── Dream Context Preparation ───────────────────────────────────────────────

function prepareDreamContext(): DreamContext {
	const state = loadState();
	const allSessions = discoverSessions();
	const unprocessed = findUnprocessed(allSessions, state);

	if (unprocessed.length === 0) {
		return {
			triggered: false,
			unprocessedSessions: [],
			batches: [],
			lastRun: state.lastRun,
			totalUnprocessed: 0,
			catchUpMode: false,
		};
	}

	const batches = batchSessions(unprocessed);
	const lastRunTime = state.lastRun ? new Date(state.lastRun).getTime() : 0;
	const catchUpMode = state.lastRun
		? (Date.now() - lastRunTime) > 25 * 60 * 60 * 1000
		: false;

	return {
		triggered: true,
		unprocessedSessions: unprocessed,
		batches,
		lastRun: state.lastRun,
		totalUnprocessed: unprocessed.length,
		catchUpMode,
	};
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let dreamActive = false;

	// ── /dream command — show status and optionally trigger ──────────────
	pi.registerCommand("dream", {
		description: "Run the dream cycle to extract skills from recent pi sessions",
		handler: async (_args, ctx) => {
			const dreamCtx = prepareDreamContext();

			if (!ctx.hasUI) {
				// Print mode: just show status
				if (!dreamCtx.triggered) {
					console.log("No unprocessed sessions. Dream cycle is up to date.");
					console.log(`Last run: ${dreamCtx.lastRun ?? "never"}`);
					return;
				}
				console.log(`Found ${dreamCtx.totalUnprocessed} unprocessed sessions in ${dreamCtx.batches.length} batch(es).`);
				console.log("Run 'dream' as a user prompt to start the dream cycle.");
				return;
			}

			// Interactive mode: show status dialog
			if (!dreamCtx.triggered) {
				ctx.ui.notify(
					`Dream cycle up to date. Last run: ${dreamCtx.lastRun ?? "never"}`,
					"info",
				);
				return;
			}

			const skillsCount = Object.keys(loadState().skillsIndex).length;
			const message = [
				`${dreamCtx.totalUnprocessed} unprocessed sessions in ${dreamCtx.batches.length} batch(es)`,
				`Last run: ${dreamCtx.lastRun ?? "never"}`,
				`Skills generated: ${skillsCount}`,
				dreamCtx.catchUpMode ? "⚠️ Catch-up mode (last run >24h ago)" : "",
				"",
				"Send 'dream' as a prompt to start the cycle.",
			].filter(Boolean).join("\n");

			ctx.ui.notify(message, "info");
		},
	});

	// ── /dream-status command ───────────────────────────────────────────
	pi.registerCommand("dream-status", {
		description: "Show dream cycle status and skill index",
		handler: async (_args, ctx) => {
			const state = loadState();
			const allSessions = discoverSessions();
			const unprocessed = findUnprocessed(allSessions, state);

			if (!ctx.hasUI) {
				console.log(`Last dream run: ${state.lastRun ?? "never"}`);
				console.log(`Total sessions: ${allSessions.length}`);
				console.log(`Unprocessed: ${unprocessed.length}`);
				console.log(`Skills generated: ${Object.keys(state.skillsIndex).length}`);
				if (Object.keys(state.skillsIndex).length > 0) {
					console.log("\nSkills:");
					for (const [name, record] of Object.entries(state.skillsIndex)) {
						console.log(`  - ${name}: ${record.description}`);
					}
				}
				return;
			}

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => done(), 12000);

				const state = loadState();
				const allSessions = discoverSessions();
				const unprocessed = findUnprocessed(allSessions, state);

				return {
					render: (width: number) => {
						const out: string[] = [];
						out.push(theme.fg("accent", theme.bold("🌙 Dream Cycle Status")));
						out.push(theme.fg("dim", "─".repeat(Math.min(width, 70))));
						out.push("");
						out.push(`  Last run:     ${theme.fg("text", state.lastRun ?? "never")}`);
						out.push(`  Total sessions: ${theme.fg("text", String(allSessions.length))}`);
						out.push(`  Unprocessed:  ${theme.fg(unprocessed.length > 0 ? "warning" : "text", String(unprocessed.length))}`);
						out.push(`  Skills:       ${theme.fg("text", String(Object.keys(state.skillsIndex).length))}`);
						out.push("");

						if (Object.keys(state.skillsIndex).length > 0) {
							out.push(theme.fg("accent", "  Skills Index:"));
							for (const [name, record] of Object.entries(state.skillsIndex)) {
								out.push(`    ${theme.fg("text", name)} — ${theme.fg("muted", record.description)}`);
							}
						}

						if (unprocessed.length > 0) {
							out.push("");
							out.push(theme.fg("accent", "  Recent Unprocessed:"));
							for (const s of unprocessed.slice(0, 5)) {
								const preview = s.firstUserMessage
									? s.firstUserMessage.slice(0, 60).replace(/\n/g, " ")
									: "(empty)";
								out.push(`    ${theme.fg("dim", s.project)} — ${theme.fg("muted", preview)}`);
							}
							if (unprocessed.length > 5) {
								out.push(`    ... and ${unprocessed.length - 5} more`);
							}
						}

						out.push("");
						out.push(theme.fg("dim", "  Auto-closes in 12s · /dream to run · Press any key to close"));
						return out;
					},
					handleInput: () => {
						if (timeout) { clearTimeout(timeout); timeout = null; }
						done();
						return true;
					},
					invalidate: () => {},
				};
			});
		},
	});

	// ── Input handler — detect and transform dream triggers ─────────────
	pi.on("input", async (event, _ctx) => {
		const text = event.text.toLowerCase().trim();
		const triggered = DREAM_TRIGGERS.some((t) => text === t || text.startsWith(t + " "));

		if (!triggered) return { action: "continue" };

		const dreamCtx = prepareDreamContext();

		if (!dreamCtx.triggered) {
			// No unprocessed sessions — send a message and skip agent
			const state = loadState();
			pi.sendMessage({
				customType: "dreamer",
				content: `Dream cycle is up to date. No unprocessed sessions.\nLast run: ${state.lastRun ?? "never"}\nSkills: ${Object.keys(state.skillsIndex).length}`,
				display: true,
			});
			dreamActive = false;
			return { action: "handled" };
		}

		dreamActive = true;
		const dreamPrompt = buildDreamContext(
			dreamCtx.batches,
			loadState(),
			dreamCtx.totalUnprocessed,
		);

		return {
			action: "transform",
			text: dreamPrompt,
		};
	});

	// ── Session start — initialize state ────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		dreamActive = false;

		// Ensure log directory exists
		const logDir = path.join(os.homedir(), ".pi/logs");
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
		}
	});

	// ── Agent end — track when dream cycle completes ────────────────────
	pi.on("agent_end", async (_event, _ctx) => {
		if (!dreamActive) return;

		// The agent should have updated the state file during Phase 4.
		// We don't need to do anything here — the state is managed via the
		// state file which the agent reads/writes directly.
		dreamActive = false;
	});

	// ── Custom message renderer ─────────────────────────────────────────
	pi.registerMessageRenderer("dreamer", (message, _opts, theme) => {
		const header = theme.fg("accent", theme.bold("🌙 Dreamer"));
		const body = theme.fg("muted", (message as any).content as string);
		return new Text(`${header}\n${body}`, 0, 0);
	});

	// ── Session shutdown ────────────────────────────────────────────────
	pi.on("session_shutdown", async () => {
		dreamActive = false;
	});
}
