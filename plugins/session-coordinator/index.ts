/**
 * Session Coordinator Extension
 *
 * Lets independent pi sessions coordinate through a project-local filesystem room.
 * A live session writes a heartbeat lease under .pi/coordination/sessions/ and
 * agents can use the session_coordination tool to see peers, post notes, and
 * claim paths/tasks before working on them.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";

// ── Types ────────────────────────────────────────────────────────────────────

type LeaseStatus = "active" | "inactive";
type ResourceKind = "path" | "glob" | "task" | "other";
type CoordAction = "status" | "announce" | "post" | "claim" | "release" | "history";

interface RoomState {
	roomDir?: string;
	projectRoot?: string;
	lease?: SessionLease;
	leaseFile?: string;
	startedAt: string;
	heartbeat?: ReturnType<typeof setInterval>;
	lastMessageNoticeAt?: string;
}

interface SessionLease {
	version: 1;
	token: string;
	pid: number;
	host: string;
	cwd: string;
	piSessionId?: string;
	piSessionFile?: string;
	surface: string;
	label?: string;
	status: LeaseStatus;
	summary: string;
	heartbeatAt: string;
	createdAt: string;
	updatedAt: string;
}

interface RoomMessage {
	version: 1;
	id: string;
	type: "message";
	sessionToken: string;
	sessionLabel?: string;
	text: string;
	createdAt: string;
}

interface ClaimRecord {
	version: 1;
	id: string;
	type: "claim" | "release";
	sessionToken: string;
	sessionLabel?: string;
	resource?: string;
	resourceKey?: string;
	kind?: ResourceKind;
	intent?: string;
	claimId?: string;
	createdAt: string;
	expiresAt?: string;
}

interface ActiveClaim extends ClaimRecord {
	type: "claim";
	resource: string;
	resourceKey: string;
	kind: ResourceKind;
	intent: string;
}

interface ToolParams {
	action: CoordAction;
	message?: string;
	summary?: string;
	resource?: string;
	kind?: ResourceKind;
	intent?: string;
	claimId?: string;
	limit?: number;
	ttlSeconds?: number;
}

interface CoordinationSnapshot {
	roomDir: string;
	projectRoot: string;
	self?: SessionLease;
	activePeers: SessionLease[];
	staleOrInactive: SessionLease[];
	messages: RoomMessage[];
	claims: ActiveClaim[];
}

// ── Constants/state ──────────────────────────────────────────────────────────

const EXTENSION_NAME = "session-coordinator";
const COORD_DIR = path.join(".pi", "coordination");
const CONFIG_FILE = path.join(".pi", "session-coordinator.json");
const HEARTBEAT_MS = 15_000;
const STALE_AFTER_MS = 90_000;
const DEFAULT_HISTORY_LIMIT = 20;
const PROMPT_MESSAGE_LIMIT = 5;
const PROMPT_CLAIM_LIMIT = 8;

const state: RoomState = {
	startedAt: nowIso(),
};

// ── Generic helpers ──────────────────────────────────────────────────────────

function nowIso(): string {
	return new Date().toISOString();
}

function randomId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function safeReadJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function safeReadDir(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file: string, data: unknown): void {
	ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	fs.renameSync(tmp, file);
}

function appendJsonLine(file: string, record: unknown): void {
	ensureDir(path.dirname(file));
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
}

function readJsonLines<T>(file: string, limit = 500): T[] {
	try {
		const raw = fs.readFileSync(file, "utf-8");
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		const slice = lines.slice(Math.max(0, lines.length - limit));
		const out: T[] = [];
		for (const line of slice) {
			try {
				out.push(JSON.parse(line) as T);
			} catch {
				// Ignore partial/corrupt lines rather than breaking the room.
			}
		}
		return out;
	} catch {
		return [];
	}
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function walkUp(start: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(start);
	while (true) {
		dirs.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function findGitRoot(cwd: string): string | undefined {
	for (const dir of walkUp(cwd)) {
		if (isDirectory(path.join(dir, ".git")) || isFile(path.join(dir, ".git"))) return dir;
	}
	return undefined;
}

function coordinationProjectRoot(roomDir: string): string {
	return path.dirname(path.dirname(roomDir));
}

function formatRel(projectRoot: string | undefined, value: string): string {
	if (!projectRoot) return value;
	const rel = path.relative(projectRoot, value);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : value;
}

function sessionLabel(lease: SessionLease | undefined): string {
	if (!lease) return "unknown";
	return lease.label || lease.piSessionId || `${lease.host}:${lease.pid}`;
}

function shortToken(token: string): string {
	return token.split("-").slice(0, 2).join("-") || token.slice(0, 12);
}

function coerceLimit(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(200, Math.floor(value))) : fallback;
}

function truncate(value: string, max = 180): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function literalUnion<T extends string>(values: readonly T[], options?: Record<string, unknown>) {
	return Type.Union(values.map((value) => Type.Literal(value)), options);
}

// ── Room discovery/lifecycle ─────────────────────────────────────────────────

function findExistingRoom(cwd: string): string | undefined {
	for (const dir of walkUp(cwd)) {
		const room = path.join(dir, COORD_DIR);
		if (isDirectory(room)) return room;

		const config = path.join(dir, CONFIG_FILE);
		if (isFile(config)) return room;
	}
	return undefined;
}

function ensureRoom(roomDir: string): void {
	ensureDir(path.join(roomDir, "sessions"));
	const roomFile = path.join(roomDir, "room.json");
	if (!isFile(roomFile)) {
		writeJsonAtomic(roomFile, {
			version: 1,
			id: randomId("room"),
			createdAt: nowIso(),
		});
	}
}

function detectSurface(ctx: ExtensionContext): string {
	if (process.env.WAYANG_SESSION_ID || process.env.WAYANG_PROJECT_ID) return "wayang";
	if (process.env.PI_RPC || process.env.PI_MODE === "rpc") return "rpc";
	return ctx.hasUI ? "tui" : "unknown";
}

function readSessionId(ctx: ExtensionContext): string | undefined {
	const sm = ctx.sessionManager as any;
	return sm?.getHeader?.()?.id ?? sm?.sessionId;
}

function readSessionFile(ctx: ExtensionContext): string | undefined {
	const sm = ctx.sessionManager as any;
	return sm?.getSessionFile?.() ?? sm?.sessionFile;
}

function buildLease(ctx: ExtensionContext, existing?: SessionLease): SessionLease {
	const at = nowIso();
	const token = existing?.token ?? randomId(`${os.hostname()}-${process.pid}`);
	return {
		version: 1,
		token,
		pid: process.pid,
		host: os.hostname(),
		cwd: ctx.cwd,
		piSessionId: readSessionId(ctx),
		piSessionFile: readSessionFile(ctx),
		surface: detectSurface(ctx),
		label: existing?.label,
		status: "active",
		summary: existing?.summary ?? "active; no summary announced yet",
		heartbeatAt: at,
		createdAt: existing?.createdAt ?? at,
		updatedAt: at,
	};
}

function writeLease(status: LeaseStatus = "active"): void {
	if (!state.lease || !state.leaseFile) return;
	state.lease = {
		...state.lease,
		status,
		heartbeatAt: nowIso(),
		updatedAt: nowIso(),
	};
	writeJsonAtomic(state.leaseFile, state.lease);
}

function joinRoom(pi: ExtensionAPI, ctx: ExtensionContext, roomDir: string): void {
	ensureRoom(roomDir);
	state.roomDir = roomDir;
	state.projectRoot = coordinationProjectRoot(roomDir);
	state.startedAt = nowIso();
	state.lease = buildLease(ctx, state.lease);
	state.leaseFile = path.join(roomDir, "sessions", `${state.lease.token}.json`);
	writeLease("active");
	startHeartbeat(ctx);
	updateUi(ctx);

	if (ctx.hasUI) {
		ctx.ui.notify(`Joined coordination room: ${formatRel(ctx.cwd, roomDir)}`, "info");
	}
	pi.appendEntry("session-coordinator-state", {
		event: "join",
		roomDir,
		token: state.lease.token,
		joinedAt: state.startedAt,
	});
}

function leaveRoom(pi?: ExtensionAPI): void {
	stopHeartbeat();
	writeLease("inactive");
	if (pi && state.roomDir && state.lease) {
		pi.appendEntry("session-coordinator-state", {
			event: "leave",
			roomDir: state.roomDir,
			token: state.lease.token,
			leftAt: nowIso(),
		});
	}
}

function startHeartbeat(ctx: ExtensionContext): void {
	stopHeartbeat();
	state.heartbeat = setInterval(() => {
		writeLease("active");
		updateUi(ctx);
	}, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
	if (state.heartbeat) clearInterval(state.heartbeat);
	state.heartbeat = undefined;
}

function isLeaseActive(lease: SessionLease): boolean {
	if (lease.status !== "active") return false;
	const heartbeat = Date.parse(lease.heartbeatAt);
	if (!Number.isFinite(heartbeat)) return false;
	return Date.now() - heartbeat <= STALE_AFTER_MS;
}

function requireActiveRoom(): string | undefined {
	return state.roomDir && state.lease ? state.roomDir : undefined;
}

// ── Snapshot/logs/claims ─────────────────────────────────────────────────────

function readLeases(roomDir: string): SessionLease[] {
	const dir = path.join(roomDir, "sessions");
	return safeReadDir(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => safeReadJson<SessionLease>(path.join(dir, name)))
		.filter((lease): lease is SessionLease => Boolean(lease?.token));
}

function readMessages(roomDir: string, limit = DEFAULT_HISTORY_LIMIT): RoomMessage[] {
	return readJsonLines<RoomMessage>(path.join(roomDir, "messages.jsonl"), Math.max(limit, DEFAULT_HISTORY_LIMIT)).filter(
		(record): record is RoomMessage => record?.type === "message" && typeof record.text === "string",
	).slice(-limit);
}

function normalizeResourceKey(kind: ResourceKind, resource: string, ctx?: ExtensionContext): string {
	const trimmed = resource.trim();
	if (kind !== "path") return trimmed;
	const base = ctx?.cwd ?? state.projectRoot ?? process.cwd();
	return path.resolve(base, trimmed);
}

function readActiveClaims(roomDir: string): ActiveClaim[] {
	const records = readJsonLines<ClaimRecord>(path.join(roomDir, "claims.jsonl"), 1_000);
	const claims = new Map<string, ActiveClaim>();
	for (const record of records) {
		if (!record || !record.id || !record.type) continue;
		if (record.type === "claim") {
			if (!record.resource || !record.resourceKey || !record.kind) continue;
			if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) continue;
			claims.set(record.id, {
				...record,
				type: "claim",
				resource: record.resource,
				resourceKey: record.resourceKey,
				kind: record.kind,
				intent: record.intent ?? "working",
			});
		} else if (record.type === "release") {
			if (record.claimId) claims.delete(record.claimId);
			if (record.resourceKey) {
				for (const [id, claim] of claims) {
					if (claim.resourceKey === record.resourceKey && claim.sessionToken === record.sessionToken) claims.delete(id);
				}
			}
		}
	}
	return [...claims.values()];
}

function buildSnapshot(limit = DEFAULT_HISTORY_LIMIT): CoordinationSnapshot | undefined {
	const roomDir = requireActiveRoom();
	if (!roomDir) return undefined;
	const leases = readLeases(roomDir);
	const active = leases.filter(isLeaseActive);
	const activeTokens = new Set(active.map((lease) => lease.token));
	return {
		roomDir,
		projectRoot: state.projectRoot ?? coordinationProjectRoot(roomDir),
		self: state.lease,
		activePeers: active.filter((lease) => lease.token !== state.lease?.token),
		staleOrInactive: leases.filter((lease) => lease.token !== state.lease?.token && !isLeaseActive(lease)),
		messages: readMessages(roomDir, limit),
		claims: readActiveClaims(roomDir).filter((claim) => activeTokens.has(claim.sessionToken)),
	};
}

function resourcesOverlap(a: ActiveClaim, b: ActiveClaim): boolean {
	if (a.kind !== "path" || b.kind !== "path") return a.resourceKey === b.resourceKey && a.kind === b.kind;
	const aKey = path.resolve(a.resourceKey);
	const bKey = path.resolve(b.resourceKey);
	if (aKey === bKey) return true;
	const aToB = path.relative(aKey, bKey);
	const bToA = path.relative(bKey, aKey);
	return Boolean(aToB && !aToB.startsWith("..") && !path.isAbsolute(aToB)) || Boolean(bToA && !bToA.startsWith("..") && !path.isAbsolute(bToA));
}

function findConflicts(candidate: ActiveClaim, claims: ActiveClaim[]): ActiveClaim[] {
	return claims.filter((claim) => claim.sessionToken !== candidate.sessionToken && resourcesOverlap(candidate, claim));
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatSnapshot(snapshot: CoordinationSnapshot, limit = DEFAULT_HISTORY_LIMIT): string {
	const lines: string[] = [];
	lines.push(`Coordination room: ${snapshot.roomDir}`);
	lines.push(`This session: ${state.lease ? `${sessionLabel(state.lease)} (${shortToken(state.lease.token)})` : "unknown"}`);
	if (snapshot.activePeers.length > 0) {
		lines.push(
			"Worktree guidance: when multiple sessions need to edit code concurrently, strongly prefer separate git worktrees/branches per session instead of sharing one checkout. Use coordination claims as an advisory layer on top of worktree isolation.",
		);
	}
	lines.push("");
	lines.push(`Active peers (${snapshot.activePeers.length}):`);
	if (snapshot.activePeers.length === 0) lines.push("- none");
	for (const peer of snapshot.activePeers) {
		lines.push(`- ${sessionLabel(peer)} [${peer.surface}] cwd=${formatRel(snapshot.projectRoot, peer.cwd)} summary=${peer.summary}`);
	}
	lines.push("");
	lines.push(`Active claims (${snapshot.claims.length}):`);
	if (snapshot.claims.length === 0) lines.push("- none");
	for (const claim of snapshot.claims.slice(0, limit)) {
		const owner = claim.sessionToken === state.lease?.token ? "you" : claim.sessionLabel || shortToken(claim.sessionToken);
		const resource = claim.kind === "path" ? formatRel(snapshot.projectRoot, claim.resourceKey) : claim.resource;
		lines.push(`- ${claim.id}: ${owner} claims ${claim.kind}:${resource} — ${claim.intent}`);
	}
	lines.push("");
	lines.push(`Recent messages (${snapshot.messages.length}):`);
	if (snapshot.messages.length === 0) lines.push("- none");
	for (const message of snapshot.messages.slice(-limit)) {
		const owner = message.sessionToken === state.lease?.token ? "you" : message.sessionLabel || shortToken(message.sessionToken);
		lines.push(`- [${message.createdAt}] ${owner}: ${message.text}`);
	}
	return lines.join("\n");
}

function buildPromptBlock(snapshot: CoordinationSnapshot): string | undefined {
	const peers = snapshot.activePeers.slice(0, 8);
	const otherClaims = snapshot.claims.filter((claim) => claim.sessionToken !== state.lease?.token).slice(0, PROMPT_CLAIM_LIMIT);
	const unreadMessages = snapshot.messages
		.filter((message) => message.sessionToken !== state.lease?.token && message.createdAt > state.startedAt)
		.slice(-PROMPT_MESSAGE_LIMIT);

	if (peers.length === 0 && otherClaims.length === 0 && unreadMessages.length === 0) return undefined;

	const lines: string[] = ["", "## Cross-session coordination", `You are in coordination room ${snapshot.roomDir}.`];
	lines.push(
		"Strong preference: if more than one pi session may edit this repository, coordinate with the user/peers to use separate git worktrees and branches for each session rather than sharing one checkout. Claims help communicate intent, but worktrees are the primary way to avoid file/index conflicts.",
	);
	if (peers.length > 0) {
		lines.push("Other active pi sessions:");
		for (const peer of peers) {
			lines.push(`- ${sessionLabel(peer)} (${peer.surface}, cwd=${formatRel(snapshot.projectRoot, peer.cwd)}): ${truncate(peer.summary, 140)}`);
		}
	}
	if (otherClaims.length > 0) {
		lines.push("Active claims by other sessions:");
		for (const claim of otherClaims) {
			const resource = claim.kind === "path" ? formatRel(snapshot.projectRoot, claim.resourceKey) : claim.resource;
			lines.push(`- ${claim.sessionLabel || shortToken(claim.sessionToken)} claims ${claim.kind}:${resource} — ${truncate(claim.intent, 120)}`);
		}
	}
	if (unreadMessages.length > 0) {
		lines.push("Recent coordination messages from other sessions:");
		for (const message of unreadMessages) {
			lines.push(`- [${message.createdAt}] ${message.sessionLabel || shortToken(message.sessionToken)}: ${truncate(message.text, 160)}`);
		}
	}
	lines.push(
		"Guideline: use the session_coordination tool before broad edits, claim files/tasks you intend to modify, post updates when your work may overlap or help another session, and prefer git worktrees for concurrent implementation work.",
	);
	return lines.join("\n");
}

function unreadCount(snapshot: CoordinationSnapshot): number {
	return snapshot.messages.filter((message) => message.sessionToken !== state.lease?.token && message.createdAt > state.startedAt).length;
}

function updateUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI || !state.roomDir) return;
	const snapshot = buildSnapshot(8);
	if (!snapshot) return;
	const unread = unreadCount(snapshot);
	const text = [`🤝 ${snapshot.activePeers.length} peer${snapshot.activePeers.length === 1 ? "" : "s"}`];
	if (unread > 0) text.push(`${unread} unread`);
	if (snapshot.claims.length > 0) text.push(`${snapshot.claims.length} claim${snapshot.claims.length === 1 ? "" : "s"}`);
	ctx.ui.setStatus(EXTENSION_NAME, ctx.ui.theme.fg("muted", text.join(ctx.ui.theme.fg("dim", " · "))));

	ctx.ui.setWidget(EXTENSION_NAME, (_tui, theme) => renderWidget(snapshot, theme));
}

function clearUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(EXTENSION_NAME, undefined);
	ctx.ui.setWidget(EXTENSION_NAME, undefined);
}

function renderWidget(snapshot: CoordinationSnapshot, theme: Theme): Text | undefined {
	if (snapshot.activePeers.length === 0 && snapshot.claims.length === 0 && unreadCount(snapshot) === 0) return undefined;
	const lines: string[] = [];
	const header = theme.fg("accent", "🤝 Coordination");
	const parts = [`${snapshot.activePeers.length} peer${snapshot.activePeers.length === 1 ? "" : "s"}`];
	const unread = unreadCount(snapshot);
	if (unread > 0) parts.push(theme.fg("warning", `${unread} unread`));
	if (snapshot.claims.length > 0) parts.push(`${snapshot.claims.length} claim${snapshot.claims.length === 1 ? "" : "s"}`);
	lines.push(`${header} ${theme.fg("muted", parts.join(" · "))}`);
	for (const peer of snapshot.activePeers.slice(0, 3)) {
		lines.push(`  ${theme.fg("text", sessionLabel(peer))}: ${theme.fg("muted", truncate(peer.summary, 100))}`);
	}
	const otherClaims = snapshot.claims.filter((claim) => claim.sessionToken !== state.lease?.token).slice(0, 3);
	for (const claim of otherClaims) {
		const resource = claim.kind === "path" ? formatRel(snapshot.projectRoot, claim.resourceKey) : claim.resource;
		lines.push(`  ${theme.fg("warning", "claim")} ${claim.sessionLabel || shortToken(claim.sessionToken)} → ${resource}`);
	}
	return new Text(lines.join("\n"), 0, 0);
}

// ── Actions ──────────────────────────────────────────────────────────────────

function inactiveResult() {
	return {
		content: [
			{
				type: "text" as const,
				text: "Session coordination is not active in this directory. Run /coord enable to create .pi/coordination/ and join a room, or start pi under a directory that already has .pi/coordination/.",
			},
		],
		details: { active: false },
	};
}

function actionStatus(params: ToolParams) {
	const snapshot = buildSnapshot(coerceLimit(params.limit, DEFAULT_HISTORY_LIMIT));
	if (!snapshot) return inactiveResult();
	return {
		content: [{ type: "text" as const, text: formatSnapshot(snapshot, coerceLimit(params.limit, DEFAULT_HISTORY_LIMIT)) }],
		details: { active: true, snapshot },
	};
}

function actionAnnounce(params: ToolParams, ctx: ExtensionContext) {
	const roomDir = requireActiveRoom();
	if (!roomDir || !state.lease) return inactiveResult();
	const summary = (params.summary ?? params.message ?? "").trim();
	if (!summary) {
		return { content: [{ type: "text" as const, text: "Provide summary or message for announce." }], details: { error: "missing_summary" } };
	}
	state.lease = { ...state.lease, cwd: ctx.cwd, summary, updatedAt: nowIso() };
	writeLease("active");
	updateUi(ctx);
	return {
		content: [{ type: "text" as const, text: `Announced current work: ${summary}` }],
		details: { active: true, lease: state.lease },
	};
}

function actionPost(params: ToolParams, ctx: ExtensionContext) {
	const roomDir = requireActiveRoom();
	if (!roomDir || !state.lease) return inactiveResult();
	const text = (params.message ?? "").trim();
	if (!text) return { content: [{ type: "text" as const, text: "Provide message for post." }], details: { error: "missing_message" } };
	const record: RoomMessage = {
		version: 1,
		id: randomId("msg"),
		type: "message",
		sessionToken: state.lease.token,
		sessionLabel: sessionLabel(state.lease),
		text,
		createdAt: nowIso(),
	};
	appendJsonLine(path.join(roomDir, "messages.jsonl"), record);
	writeLease("active");
	updateUi(ctx);
	return { content: [{ type: "text" as const, text: `Posted coordination message: ${text}` }], details: { active: true, message: record } };
}

function actionClaim(params: ToolParams, ctx: ExtensionContext) {
	const roomDir = requireActiveRoom();
	if (!roomDir || !state.lease) return inactiveResult();
	const resource = (params.resource ?? "").trim();
	if (!resource) return { content: [{ type: "text" as const, text: "Provide resource for claim." }], details: { error: "missing_resource" } };
	const kind = params.kind ?? "path";
	const resourceKey = normalizeResourceKey(kind, resource, ctx);
	const ttl = typeof params.ttlSeconds === "number" && params.ttlSeconds > 0 ? params.ttlSeconds : undefined;
	const claim: ActiveClaim = {
		version: 1,
		id: randomId("claim"),
		type: "claim",
		sessionToken: state.lease.token,
		sessionLabel: sessionLabel(state.lease),
		resource,
		resourceKey,
		kind,
		intent: (params.intent ?? params.message ?? "working here").trim(),
		createdAt: nowIso(),
		expiresAt: ttl ? new Date(Date.now() + ttl * 1000).toISOString() : undefined,
	};
	const existingClaims = readActiveClaims(roomDir);
	const conflicts = findConflicts(claim, existingClaims);
	appendJsonLine(path.join(roomDir, "claims.jsonl"), claim);
	writeLease("active");
	updateUi(ctx);
	const displayResource = kind === "path" ? formatRel(state.projectRoot, resourceKey) : resource;
	const lines = [`Claimed ${kind}:${displayResource} — ${claim.intent}`, `Claim id: ${claim.id}`];
	if (conflicts.length > 0) {
		lines.push("", "Potential overlap with other active claims:");
		for (const conflict of conflicts) {
			const conflictResource = conflict.kind === "path" ? formatRel(state.projectRoot, conflict.resourceKey) : conflict.resource;
			lines.push(`- ${conflict.sessionLabel || shortToken(conflict.sessionToken)} claims ${conflict.kind}:${conflictResource} — ${conflict.intent}`);
		}
		if (ctx.hasUI) ctx.ui.notify(`Coordination warning: ${conflicts.length} overlapping claim(s)`, "warning");
	}
	return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { active: true, claim, conflicts } };
}

function actionRelease(params: ToolParams, ctx: ExtensionContext) {
	const roomDir = requireActiveRoom();
	if (!roomDir || !state.lease) return inactiveResult();
	const claimId = params.claimId?.trim();
	const resource = params.resource?.trim();
	if (!claimId && !resource) {
		return { content: [{ type: "text" as const, text: "Provide claimId or resource for release." }], details: { error: "missing_release_target" } };
	}
	const kind = params.kind ?? "path";
	const record: ClaimRecord = {
		version: 1,
		id: randomId("release"),
		type: "release",
		sessionToken: state.lease.token,
		sessionLabel: sessionLabel(state.lease),
		claimId,
		resource,
		resourceKey: resource ? normalizeResourceKey(kind, resource, ctx) : undefined,
		kind,
		createdAt: nowIso(),
	};
	appendJsonLine(path.join(roomDir, "claims.jsonl"), record);
	writeLease("active");
	updateUi(ctx);
	return { content: [{ type: "text" as const, text: `Released coordination claim ${claimId ?? resource}.` }], details: { active: true, release: record } };
}

function actionHistory(params: ToolParams) {
	const snapshot = buildSnapshot(coerceLimit(params.limit, DEFAULT_HISTORY_LIMIT));
	if (!snapshot) return inactiveResult();
	const limit = coerceLimit(params.limit, DEFAULT_HISTORY_LIMIT);
	return {
		content: [{ type: "text" as const, text: formatSnapshot(snapshot, limit) }],
		details: { active: true, messages: snapshot.messages.slice(-limit), claims: snapshot.claims.slice(-limit) },
	};
}

function executeAction(params: ToolParams, ctx: ExtensionContext) {
	switch (params.action) {
		case "status":
			return actionStatus(params);
		case "announce":
			return actionAnnounce(params, ctx);
		case "post":
			return actionPost(params, ctx);
		case "claim":
			return actionClaim(params, ctx);
		case "release":
			return actionRelease(params, ctx);
		case "history":
			return actionHistory(params);
	}
}

// ── Extension entrypoint ─────────────────────────────────────────────────────

export default function sessionCoordinator(pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_coordination",
		label: "Session Coordination",
		description: "Coordinate with other active independent pi sessions in this project: see peers, announce work, post notes, and claim/release paths or tasks.",
		promptSnippet: "Coordinate with other active pi sessions in this project",
		promptGuidelines: [
			"Use session_coordination status before broad edits, refactors, or work that might overlap with another active pi session.",
			"When multiple independent pi sessions may edit the same git repository, strongly prefer putting each session in its own git worktree/branch before implementation work; ask the user or coordinate with peers if a worktree is needed.",
			"Use session_coordination announce to summarize your current scope, claim to reserve paths/tasks you intend to modify, post to share blockers or complementary findings, and release when a claim is no longer needed.",
			"session_coordination claims are advisory: do not assume they are OS locks; coordinate politely when a claim overlaps another active session. Worktrees provide stronger isolation than claims.",
		],
		parameters: Type.Object({
			action: literalUnion(["status", "announce", "post", "claim", "release", "history"] as const, {
				description: "Coordination action to perform.",
			}),
			message: Type.Optional(Type.String({ description: "Message text for post, or fallback text for announce/claim intent." })),
			summary: Type.Optional(Type.String({ description: "Short working summary for announce." })),
			resource: Type.Optional(Type.String({ description: "Resource to claim or release. For kind=path, relative paths resolve from the current cwd." })),
			kind: Type.Optional(literalUnion(["path", "glob", "task", "other"] as const, { description: "Kind of resource being claimed." })),
			intent: Type.Optional(Type.String({ description: "Why this resource is claimed / what work is planned." })),
			claimId: Type.Optional(Type.String({ description: "Claim id to release." })),
			limit: Type.Optional(Type.Number({ description: "Maximum recent messages/claims to show." })),
			ttlSeconds: Type.Optional(Type.Number({ description: "Optional claim expiration in seconds." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeAction(params as ToolParams, ctx);
		},
		renderResult(result, _options, theme) {
			const text = result.content?.map((part: any) => part.text).filter(Boolean).join("\n") ?? "";
			return new Text(theme.fg("accent", "🤝 session_coordination") + "\n" + theme.fg("text", text), 0, 0);
		},
	});

	pi.registerMessageRenderer(EXTENSION_NAME, (message, _opts, theme) => {
		const content = (message as any).content as string;
		return new Text(theme.fg("accent", "🤝 Coordination") + " " + theme.fg("muted", content), 0, 0);
	});

	pi.registerCommand("coord", {
		description: "Manage cross-session coordination room (/coord enable|disable|status|note|announce)",
		handler: async (args, ctx) => {
			const [commandRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const command = commandRaw || "status";
			const text = rest.join(" ");

			if (command === "enable") {
				const projectRoot = text ? path.resolve(ctx.cwd, text) : findGitRoot(ctx.cwd) ?? ctx.cwd;
				const roomDir = path.join(projectRoot, COORD_DIR);
				joinRoom(pi, ctx, roomDir);
				return;
			}

			if (command === "disable") {
				leaveRoom(pi);
				clearUi(ctx);
				if (ctx.hasUI) ctx.ui.notify("Left coordination room (presence marked inactive).", "info");
				return;
			}

			if (command === "note" || command === "post") {
				const result = actionPost({ action: "post", message: text }, ctx);
				if (ctx.hasUI) ctx.ui.notify((result.content[0] as any).text, "info");
				return;
			}

			if (command === "announce") {
				const result = actionAnnounce({ action: "announce", summary: text }, ctx);
				if (ctx.hasUI) ctx.ui.notify((result.content[0] as any).text, "info");
				return;
			}

			const snapshot = buildSnapshot(DEFAULT_HISTORY_LIMIT);
			if (!snapshot) {
				if (ctx.hasUI) ctx.ui.notify("Coordination inactive. Run /coord enable to create .pi/coordination/ and join.", "warning");
				return;
			}
			if (ctx.hasUI) {
				await ctx.ui.custom((_tui, theme, _kb, done) => {
					const timer = setTimeout(() => done(), 10_000);
					const body = formatSnapshot(snapshot, DEFAULT_HISTORY_LIMIT);
					return {
						render: () => new Text(theme.fg("accent", theme.bold("Session coordination")) + "\n\n" + body + "\n\n" + theme.fg("muted", "Closes automatically."), 0, 0),
						onKey: () => {
							clearTimeout(timer);
							done();
						},
						cleanup: () => clearTimeout(timer),
					};
				});
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const roomDir = findExistingRoom(ctx.cwd);
		if (!roomDir) return;
		joinRoom(pi, ctx, roomDir);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const snapshot = buildSnapshot(DEFAULT_HISTORY_LIMIT);
		if (!snapshot) return undefined;
		writeLease("active");
		updateUi(ctx);
		const block = buildPromptBlock(snapshot);
		if (!block) return undefined;
		return { systemPrompt: `${event.systemPrompt}${block}` };
	});

	pi.on("turn_end", async (_event, ctx) => {
		writeLease("active");
		updateUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		leaveRoom(pi);
	});
}
