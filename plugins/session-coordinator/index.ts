/**
 * Filesystem-backed, advisory coordination for independent Pi sessions.
 * Activation is agent-callable and every extension factory owns its own lease/timer.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
	DEFAULT_HISTORY_LIMIT,
	MAX_HISTORY_LIMIT,
	SessionCoordinatorCore,
	boundedSnapshotDetails,
	boundedToolResult,
	executeActivationAction,
	findCanonicalGitProjectRoot,
	type ActiveClaim,
	type ActivationState,
	type CoordinationSnapshot,
	type LeaseMetadata,
	type ResourceKind,
	type SessionLease,
} from "./core.js";

const EXTENSION_NAME = "session-coordinator";
const PROMPT_MESSAGE_LIMIT = 5;
const PROMPT_CLAIM_LIMIT = 8;
const MAX_CONFLICT_RESULTS = 20;

type CoordAction = "enable" | "ensure" | "status" | "announce" | "post" | "claim" | "release" | "history";

interface ToolParams {
	action: CoordAction;
	projectRoot?: string;
	message?: string;
	summary?: string;
	resource?: string;
	kind?: ResourceKind;
	intent?: string;
	claimId?: string;
	limit?: number;
	ttlSeconds?: number;
}

function coerceLimit(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(value))) : fallback;
}

function truncate(value: string, max = 180): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatRel(projectRoot: string, value: string): string {
	const rel = path.relative(projectRoot, value);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : value;
}

function sessionLabel(lease: SessionLease): string {
	return lease.label || lease.token.slice(0, 14);
}

function displayResource(projectRoot: string, claim: ActiveClaim): string {
	return claim.kind === "path" ? formatRel(projectRoot, claim.resourceKey) : claim.resource;
}

function metadataFor(pi: ExtensionAPI, ctx: ExtensionContext): LeaseMetadata {
	let canonicalCwd = path.resolve(ctx.cwd);
	try {
		canonicalCwd = fs.realpathSync.native(canonicalCwd);
	} catch {
		// Activation will reject a missing cwd; discovery simply finds no room.
	}
	let piSessionId: string | undefined;
	let piSessionFile: string | undefined;
	try {
		piSessionId = ctx.sessionManager.getSessionId();
		piSessionFile = ctx.sessionManager.getSessionFile();
	} catch {
		// Ephemeral or replacement-session contexts may not expose persisted metadata.
	}
	return {
		cwd: canonicalCwd,
		surface: process.env.WAYANG_SESSION_ID || process.env.WAYANG_PROJECT_ID
			? "wayang"
			: process.env.PI_RPC || process.env.PI_MODE === "rpc"
				? "rpc"
				: ctx.hasUI
					? "tui"
					: "unknown",
		label: pi.getSessionName(),
		piSessionId,
		piSessionFile,
	};
}

function activationText(state: ActivationState): string {
	return `Session coordination ${state.outcome}: ${state.roomDir}`;
}

function inactiveResult() {
	return boundedToolResult(
		"Session coordination is inactive. Call session_coordination with action=ensure, or action=enable and an explicit canonical projectRoot.",
		{ active: false },
	);
}

function buildSnapshotToolResult(snapshot: CoordinationSnapshot, limit = DEFAULT_HISTORY_LIMIT) {
	return boundedToolResult(formatSnapshot(snapshot, limit), boundedSnapshotDetails(snapshot, limit));
}

function formatSnapshot(snapshot: CoordinationSnapshot, limit = DEFAULT_HISTORY_LIMIT): string {
	const lines = [
		`Coordination room: ${snapshot.roomDir}`,
		`This session: ${sessionLabel(snapshot.self)} (${snapshot.self.token.slice(0, 14)})`,
		"",
		`Active peers (${snapshot.activePeers.length}):`,
	];
	if (snapshot.activePeers.length === 0) lines.push("- none");
	for (const peer of snapshot.activePeers) {
		lines.push(`- ${sessionLabel(peer)} [${peer.surface}] cwd=${formatRel(snapshot.projectRoot, peer.cwd)} summary=${peer.summary}`);
	}
	lines.push("", `Active claims (${snapshot.claims.length}):`);
	if (snapshot.claims.length === 0) lines.push("- none");
	for (const claim of snapshot.claims.slice(0, limit)) {
		const owner = claim.sessionToken === snapshot.self.token ? "you" : claim.sessionLabel || claim.sessionToken.slice(0, 14);
		lines.push(`- ${claim.id}: ${owner} claims ${claim.kind}:${displayResource(snapshot.projectRoot, claim)} — ${claim.intent}`);
	}
	lines.push("", `Recent messages (${snapshot.messages.length}):`);
	if (snapshot.messages.length === 0) lines.push("- none");
	for (const message of snapshot.messages.slice(-limit)) {
		const owner = message.sessionToken === snapshot.self.token ? "you" : message.sessionLabel || message.sessionToken.slice(0, 14);
		lines.push(`- [${message.createdAt}] ${owner}: ${message.text}`);
	}
	return lines.join("\n");
}

function unreadCount(core: SessionCoordinatorCore, snapshot: CoordinationSnapshot): number {
	return snapshot.messages.filter((message) => message.sessionToken !== snapshot.self.token && message.createdAt > core.getStartedAt()).length;
}

function buildPromptBlock(core: SessionCoordinatorCore, snapshot: CoordinationSnapshot): string | undefined {
	const peers = snapshot.activePeers.slice(0, 8);
	const claims = snapshot.claims.filter((claim) => claim.sessionToken !== snapshot.self.token).slice(0, PROMPT_CLAIM_LIMIT);
	const messages = snapshot.messages
		.filter((message) => message.sessionToken !== snapshot.self.token && message.createdAt > core.getStartedAt())
		.slice(-PROMPT_MESSAGE_LIMIT);
	if (peers.length === 0 && claims.length === 0 && messages.length === 0) return undefined;

	const lines = ["", "## Cross-session coordination", `You are in coordination room ${snapshot.roomDir}.`];
	if (peers.length) {
		lines.push("Other active Pi sessions:");
		for (const peer of peers) lines.push(`- ${sessionLabel(peer)} (${peer.surface}, cwd=${formatRel(snapshot.projectRoot, peer.cwd)}): ${truncate(peer.summary, 140)}`);
	}
	if (claims.length) {
		lines.push("Active claims by other sessions:");
		for (const claim of claims) lines.push(`- ${claim.sessionLabel || claim.sessionToken.slice(0, 14)} claims ${claim.kind}:${displayResource(snapshot.projectRoot, claim)} — ${truncate(claim.intent, 120)}`);
	}
	if (messages.length) {
		lines.push("Recent coordination messages from other sessions:");
		for (const message of messages) lines.push(`- [${message.createdAt}] ${message.sessionLabel || message.sessionToken.slice(0, 14)}: ${truncate(message.text, 160)}`);
	}
	lines.push("Guideline: coordination is advisory. Check peers before broad edits, claim intended work, share useful blockers, avoid secrets, and use separate Git worktrees/branches for concurrent implementation.");
	return lines.join("\n");
}

function renderWidget(core: SessionCoordinatorCore, snapshot: CoordinationSnapshot, theme: Theme): Text | undefined {
	const unread = unreadCount(core, snapshot);
	if (!snapshot.activePeers.length && !snapshot.claims.length && !unread) return undefined;
	const parts = [`${snapshot.activePeers.length} peer${snapshot.activePeers.length === 1 ? "" : "s"}`];
	if (unread) parts.push(`${unread} unread`);
	if (snapshot.claims.length) parts.push(`${snapshot.claims.length} claim${snapshot.claims.length === 1 ? "" : "s"}`);
	const lines = [`${theme.fg("accent", "🤝 Coordination")} ${theme.fg("muted", parts.join(" · "))}`];
	for (const peer of snapshot.activePeers.slice(0, 3)) lines.push(`  ${theme.fg("text", sessionLabel(peer))}: ${theme.fg("muted", truncate(peer.summary, 100))}`);
	for (const claim of snapshot.claims.filter((item) => item.sessionToken !== snapshot.self.token).slice(0, 3)) {
		lines.push(`  ${theme.fg("warning", "claim")} ${claim.sessionLabel || claim.sessionToken.slice(0, 14)} → ${displayResource(snapshot.projectRoot, claim)}`);
	}
	return new Text(lines.join("\n"), 0, 0);
}

function updateUi(core: SessionCoordinatorCore, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const snapshot = core.snapshot(8);
	if (!snapshot) return;
	const unread = unreadCount(core, snapshot);
	const parts = [`🤝 ${snapshot.activePeers.length} peer${snapshot.activePeers.length === 1 ? "" : "s"}`];
	if (unread) parts.push(`${unread} unread`);
	if (snapshot.claims.length) parts.push(`${snapshot.claims.length} claim${snapshot.claims.length === 1 ? "" : "s"}`);
	ctx.ui.setStatus(EXTENSION_NAME, ctx.ui.theme.fg("muted", parts.join(" · ")));
	ctx.ui.setWidget(EXTENSION_NAME, (_tui, theme) => renderWidget(core, snapshot, theme));
}

function clearUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(EXTENSION_NAME, undefined);
	ctx.ui.setWidget(EXTENSION_NAME, undefined);
}

export default function sessionCoordinator(pi: ExtensionAPI) {
	// Deliberately factory-local: a Wayang/Pi runtime owns exactly one lease and timer.
	const core = new SessionCoordinatorCore();
	// A deliberate /coord disable lasts for this extension runtime. Without this
	// guard, before_agent_start would immediately auto-join the room again.
	let autoDiscoveryEnabled = true;

	function executeAction(params: ToolParams, ctx: ExtensionContext) {
		const metadata = metadataFor(pi, ctx);
		if (params.action === "enable" || params.action === "ensure") {
			const activation = executeActivationAction(core, params.action, { projectRoot: params.projectRoot }, metadata);
			autoDiscoveryEnabled = true;
			updateUi(core, ctx);
			return boundedToolResult(activationText(activation), activation);
		}

		const limit = coerceLimit(params.limit, DEFAULT_HISTORY_LIMIT);
		if (params.action === "status" || params.action === "history") {
			const snapshot = core.snapshot(limit);
			if (!snapshot) return inactiveResult();
			return buildSnapshotToolResult(snapshot, limit);
		}
		if (!core.isActive()) return inactiveResult();

		if (params.action === "announce") {
			const summary = params.summary ?? params.message ?? "";
			const lease = core.announce(summary, metadata);
			updateUi(core, ctx);
			return boundedToolResult(`Announced current work: ${lease.summary}`, { active: true, summary: lease.summary });
		}
		if (params.action === "post") {
			const message = core.post(params.message ?? "");
			updateUi(core, ctx);
			return boundedToolResult(`Posted coordination message: ${message.text}`, { active: true, message });
		}
		if (params.action === "claim") {
			const kind = params.kind ?? "path";
			const { claim, conflicts: allConflicts } = core.claim(params.resource ?? "", kind, params.intent ?? params.message ?? "working here", metadata.cwd, params.ttlSeconds);
			const conflicts = allConflicts.slice(0, MAX_CONFLICT_RESULTS);
			const lines = [`Claimed ${kind}:${displayResource(core.snapshot(1)!.projectRoot, claim)} — ${claim.intent}`, `Claim id: ${claim.id}`];
			if (conflicts.length) {
				lines.push("", "Potential overlap with other active claims:");
				for (const conflict of conflicts) lines.push(`- ${conflict.sessionLabel || conflict.sessionToken.slice(0, 14)} claims ${conflict.kind}:${displayResource(core.snapshot(1)!.projectRoot, conflict)} — ${conflict.intent}`);
				if (allConflicts.length > conflicts.length) lines.push(`- … ${allConflicts.length - conflicts.length} additional overlap(s) omitted`);
				if (ctx.hasUI) ctx.ui.notify(`Coordination warning: ${allConflicts.length} overlapping claim(s)`, "warning");
			}
			updateUi(core, ctx);
			return boundedToolResult(lines.join("\n"), { active: true, claim, conflicts, conflictsTruncated: allConflicts.length > conflicts.length });
		}
		const release = core.release(params.claimId?.trim(), params.resource?.trim(), params.kind ?? "path", metadata.cwd);
		updateUi(core, ctx);
		return boundedToolResult(`Released coordination claim ${release.claimId ?? release.resource}.`, { active: true, release });
	}

	pi.registerTool({
		name: "session_coordination",
		label: "Session Coordination",
		description: "Activate or use advisory filesystem coordination with other independent Pi/Wayang sessions. enable requires an explicit canonical projectRoot; ensure is idempotent and discovers or creates the appropriate project room. History is capped at 50 messages/claims and tool content/details stay below 48 KiB.",
		promptSnippet: "Activate and coordinate with other Pi/Wayang sessions in this project",
		promptGuidelines: [
			"Use session_coordination ensure when coordination may be needed but is not yet active; repeated calls preserve this session's lease and heartbeat.",
			"Use session_coordination enable only with an explicit absolute canonical projectRoot supplied or confirmed by the user.",
			"Use session_coordination status before broad edits, and use announce, claim, post, and release for advisory coordination; never put secrets or transcript content in coordination records.",
			"When sessions concurrently edit one Git repository, use separate worktrees/branches; session_coordination claims are advisory rather than locks.",
		],
		parameters: Type.Object({
			action: StringEnum(["enable", "ensure", "status", "announce", "post", "claim", "release", "history"] as const, { description: "Coordination action." }),
			projectRoot: Type.Optional(Type.String({ description: "Explicit absolute canonical project root; required for enable." })),
			message: Type.Optional(Type.String({ description: "Bounded room message, or fallback announce/claim text. Never include secrets or transcript content." })),
			summary: Type.Optional(Type.String({ description: "Short current-work summary for announce." })),
			resource: Type.Optional(Type.String({ description: "Resource to claim or release; relative paths resolve from cwd." })),
			kind: Type.Optional(StringEnum(["path", "glob", "task", "other"] as const)),
			intent: Type.Optional(Type.String({ description: "Short claim intent." })),
			claimId: Type.Optional(Type.String({ description: "Claim id to release." })),
			limit: Type.Optional(Type.Number({ description: "History result count, clamped to 1–50 messages and claims." })),
			ttlSeconds: Type.Optional(Type.Number({ description: "Optional claim expiration in seconds." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeAction(params as ToolParams, ctx);
		},
		renderResult(result, _options, theme) {
			const text = result.content?.map((part: any) => part.text).filter(Boolean).join("\n") ?? "";
			return new Text(`${theme.fg("accent", "🤝 session_coordination")}\n${theme.fg("text", text)}`, 0, 0);
		},
	});

	pi.registerMessageRenderer(EXTENSION_NAME, (message, _opts, theme) => {
		return new Text(`${theme.fg("accent", "🤝 Coordination")} ${theme.fg("muted", String((message as any).content ?? ""))}`, 0, 0);
	});

	pi.registerCommand("coord", {
		description: "Coordination convenience command (/coord enable|ensure|disable|status|note|announce)",
		handler: async (args, ctx) => {
			const [commandRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const command = commandRaw || "status";
			const text = rest.join(" ");
			try {
				if (command === "enable" || command === "ensure") {
					const metadata = metadataFor(pi, ctx);
					const fallbackRoot = findCanonicalGitProjectRoot(metadata.cwd) ?? metadata.cwd;
					const activation = command === "enable"
						? core.enable(text ? path.resolve(ctx.cwd, text) : fallbackRoot, metadata)
						: core.ensure(metadata);
					autoDiscoveryEnabled = true;
					updateUi(core, ctx);
					if (ctx.hasUI) ctx.ui.notify(activationText(activation), "info");
					return;
				}
				if (command === "disable") {
					autoDiscoveryEnabled = false;
					core.leave();
					clearUi(ctx);
					if (ctx.hasUI) ctx.ui.notify("Left coordination room; automatic discovery is disabled until /coord ensure or /coord enable.", "info");
					return;
				}
				if (command === "note" || command === "post") {
					const result = executeAction({ action: "post", message: text }, ctx);
					if (ctx.hasUI) ctx.ui.notify(result.content[0].text, "info");
					return;
				}
				if (command === "announce") {
					const result = executeAction({ action: "announce", summary: text }, ctx);
					if (ctx.hasUI) ctx.ui.notify(result.content[0].text, "info");
					return;
				}
				const snapshot = core.snapshot(DEFAULT_HISTORY_LIMIT);
				if (!snapshot) {
					if (ctx.hasUI) ctx.ui.notify("Coordination inactive. Run /coord ensure.", "warning");
					return;
				}
				if (ctx.hasUI) ctx.ui.notify(formatSnapshot(snapshot), "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	const discover = (ctx: ExtensionContext) => {
		if (!autoDiscoveryEnabled || core.isActive()) return;
		try {
			const activation = core.discoverAndJoin(metadataFor(pi, ctx));
			if (activation) updateUi(core, ctx);
		} catch {
			// Non-creating discovery is best-effort; explicit activation reports errors.
		}
	};

	const refreshLease = (ctx: ExtensionContext): boolean => {
		if (!core.isActive()) return false;
		try {
			core.touch(metadataFor(pi, ctx));
			return true;
		} catch {
			// Event hooks must not destabilize an agent run if the room disappears.
			// Drop local active state so an explicit ensure can recreate it.
			core.leave();
			clearUi(ctx);
			return false;
		}
	};

	pi.on("session_start", async (_event, ctx) => discover(ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		// Re-run discovery every turn so an already-running Wayang session can join
		// after another session creates the room.
		discover(ctx);
		if (!refreshLease(ctx)) return undefined;
		const snapshot = core.snapshot(DEFAULT_HISTORY_LIMIT);
		if (!snapshot) return undefined;
		updateUi(core, ctx);
		const block = buildPromptBlock(core, snapshot);
		return block ? { systemPrompt: `${event.systemPrompt}${block}` } : undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (refreshLease(ctx)) updateUi(core, ctx);
	});

	pi.on("session_shutdown", async () => core.leave());
}
