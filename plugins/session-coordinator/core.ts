import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type LeaseStatus = "active" | "inactive";
export type ResourceKind = "path" | "glob" | "task" | "other";

export interface LeaseMetadata {
	cwd: string;
	surface: string;
	label?: string;
	piSessionId?: string;
	piSessionFile?: string;
}

export interface SessionLease {
	version: 1;
	token: string;
	pid: number;
	host: string;
	cwd: string;
	surface: string;
	label?: string;
	piSessionId?: string;
	piSessionFile?: string;
	status: LeaseStatus;
	summary: string;
	heartbeatAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface RoomMessage {
	version: 1;
	id: string;
	type: "message";
	sessionToken: string;
	sessionLabel?: string;
	text: string;
	createdAt: string;
}

export interface ClaimRecord {
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

export interface ActiveClaim extends ClaimRecord {
	type: "claim";
	resource: string;
	resourceKey: string;
	kind: ResourceKind;
	intent: string;
}

export interface CoordinationSnapshot {
	roomDir: string;
	projectRoot: string;
	self: SessionLease;
	activePeers: SessionLease[];
	staleOrInactive: SessionLease[];
	messages: RoomMessage[];
	claims: ActiveClaim[];
}

export function coordinationWidgetVisible(snapshot: CoordinationSnapshot, startedAt: string): boolean {
	return snapshot.activePeers.length > 0
		|| snapshot.claims.length > 0
		|| snapshot.messages.some((message) => message.sessionToken !== snapshot.self.token && message.createdAt > startedAt);
}

interface RoomMetadata {
	version: 1;
	id: string;
	createdAt: string;
}

interface ExistingRoom {
	roomDir: string;
	metadata: RoomMetadata;
}

export type ActivationAction = "enable" | "ensure";

export interface ActivationState {
	active: true;
	created: boolean;
	joined: boolean;
	outcome: "active" | "created" | "joined";
	roomDir: string;
	projectRoot: string;
	leaseId: string;
}

export interface Scheduler {
	setInterval(handler: () => void, milliseconds: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface CoordinatorOptions {
	heartbeatMs?: number;
	staleAfterMs?: number;
	scheduler?: Scheduler;
	now?: () => Date;
	/** Deterministic test seam for interleaving first-room marker publication. */
	beforeRoomMarkerPublish?: () => void;
}

export const COORD_DIR = path.join(".pi", "coordination");
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 50;
/** Deliberately below both decimal 50 KB and Pi's 50 KiB ceiling. */
export const MAX_TOOL_RESULT_BYTES = 48 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_STALE_AFTER_MS = 90_000;
const MAX_LOG_RECORDS = 1_000;
const MAX_JSON_FILE_BYTES = 64 * 1024;
const NO_FOLLOW = (fs.constants as Partial<Record<string, number>>).O_NOFOLLOW ?? 0;

export class CoordinationPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoordinationPathError";
	}
}

function randomId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function safeReadJson<T>(file: string): T | undefined {
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_FILE_BYTES) return undefined;
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
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

function isDirectory(value: string): boolean {
	try {
		return fs.statSync(value).isDirectory();
	} catch {
		return false;
	}
}

function isFile(value: string): boolean {
	try {
		return fs.statSync(value).isFile();
	} catch {
		return false;
	}
}

function isSymlink(value: string): boolean {
	try {
		return fs.lstatSync(value).isSymbolicLink();
	} catch {
		return false;
	}
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function assertRegularDestination(file: string): void {
	try {
		const stat = fs.lstatSync(file);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new CoordinationPathError(`Refusing non-regular coordination file: ${file}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function writeJsonAtomic(file: string, data: unknown, allowCreateParent = false): void {
	const parent = path.dirname(file);
	if (allowCreateParent) ensureDir(parent);
	else if (!isDirectory(parent)) throw new CoordinationPathError(`Coordination room path is missing: ${parent}`);
	assertRegularDestination(file);
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// Best-effort cleanup only.
		}
		throw error;
	}
}

function appendJsonLine(file: string, record: unknown): void {
	const parent = path.dirname(file);
	if (!isDirectory(parent)) throw new CoordinationPathError(`Coordination room path is missing: ${parent}`);
	assertRegularDestination(file);
	const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
	let handle: number | undefined;
	try {
		handle = fs.openSync(
			file,
			fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | NO_FOLLOW,
			0o600,
		);
		if (!fs.fstatSync(handle).isFile()) throw new CoordinationPathError(`Refusing non-regular coordination log: ${file}`);
		fs.writeSync(handle, line, 0, line.length);
	} catch (error) {
		if (error instanceof CoordinationPathError) throw error;
		throw new CoordinationPathError(`Unable to append coordination log ${file}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (handle !== undefined) fs.closeSync(handle);
	}
}

function readJsonLines<T>(file: string, limit = 500): T[] {
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) return [];
		const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim());
		const out: T[] = [];
		for (const line of lines.slice(Math.max(0, lines.length - limit))) {
			try {
				out.push(JSON.parse(line) as T);
			} catch {
				// A partial append does not make the advisory room unusable.
			}
		}
		return out;
	} catch {
		return [];
	}
}

function utf8Prefix(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const parts: string[] = [];
	let used = 0;
	for (const character of value) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (used + bytes > maxBytes) break;
		parts.push(character);
		used += bytes;
	}
	return parts.join("");
}

export function capToolText(text: string): string {
	if (Buffer.byteLength(text, "utf8") < MAX_TOOL_RESULT_BYTES) return text;
	const marker = "\n[Coordination output truncated to the 48 KiB tool-result limit.]";
	return `${utf8Prefix(text, MAX_TOOL_RESULT_BYTES - Buffer.byteLength(marker, "utf8") - 1)}${marker}`;
}

export function capToolDetails<T>(details: T): T | { active: boolean; truncated: true; omitted: string } {
	try {
		if (Buffer.byteLength(JSON.stringify(details), "utf8") < MAX_TOOL_RESULT_BYTES) return details;
	} catch {
		// Fall through to a small deterministic replacement.
	}
	const active = Boolean(details && typeof details === "object" && (details as { active?: unknown }).active);
	return { active, truncated: true, omitted: "Details exceeded the 48 KiB tool-result limit." };
}

export function boundedToolResult<T>(text: string, details: T) {
	return {
		content: [{ type: "text" as const, text: capToolText(text) }],
		details: capToolDetails(details),
	};
}

export function boundedSnapshotDetails(snapshot: CoordinationSnapshot, limit = DEFAULT_HISTORY_LIMIT) {
	const boundedLimit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_HISTORY_LIMIT)));
	const details: {
		active: true;
		roomDir: string;
		projectRoot: string;
		leaseId: string;
		peers: Array<{ leaseId: string; label?: string; surface: string; cwd: string; summary: string }>;
		messages: CoordinationSnapshot["messages"];
		claims: CoordinationSnapshot["claims"];
		truncated?: true;
	} = {
		active: true,
		roomDir: snapshot.roomDir,
		projectRoot: snapshot.projectRoot,
		leaseId: snapshot.self.token,
		peers: snapshot.activePeers.slice(0, boundedLimit).map((peer) => ({
			leaseId: peer.token,
			label: peer.label,
			surface: peer.surface,
			cwd: peer.cwd,
			summary: peer.summary,
		})),
		messages: snapshot.messages.slice(-boundedLimit),
		claims: snapshot.claims.slice(-boundedLimit),
	};
	const originalPeerCount = snapshot.activePeers.length;
	const originalMessageCount = snapshot.messages.length;
	const originalClaimCount = snapshot.claims.length;
	const lists: Array<Array<unknown>> = [details.peers, details.messages, details.claims];
	while (Buffer.byteLength(JSON.stringify(details), "utf8") >= MAX_TOOL_RESULT_BYTES - 512) {
		const largest = lists
			.filter((list) => list.length)
			.sort((a, b) => Buffer.byteLength(JSON.stringify(b), "utf8") - Buffer.byteLength(JSON.stringify(a), "utf8"))[0];
		if (!largest) break;
		largest.shift();
		details.truncated = true;
	}
	if (
		details.peers.length < originalPeerCount
		|| details.messages.length < originalMessageCount
		|| details.claims.length < originalClaimCount
	) details.truncated = true;
	return details;
}

function walkUp(start: string): string[] {
	const result: string[] = [];
	let current = path.resolve(start);
	while (true) {
		result.push(current);
		const parent = path.dirname(current);
		if (parent === current) return result;
		current = parent;
	}
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readSmallText(file: string): string | undefined {
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return undefined;
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		return undefined;
	}
}

export function canonicalExistingDirectory(input: string, field = "projectRoot"): string {
	if (!input || input.includes("\0")) throw new CoordinationPathError(`${field} must be a non-empty absolute path.`);
	if (!path.isAbsolute(input)) throw new CoordinationPathError(`${field} must be absolute.`);
	if (path.resolve(input) !== input) throw new CoordinationPathError(`${field} must already be normalized and canonical.`);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(input);
	} catch {
		throw new CoordinationPathError(`${field} must exist.`);
	}
	if (!stat.isDirectory()) throw new CoordinationPathError(`${field} must be a directory.`);
	if (stat.isSymbolicLink()) throw new CoordinationPathError(`${field} must not be a symbolic link.`);
	const real = fs.realpathSync.native(input);
	if (real !== input) throw new CoordinationPathError(`${field} must not contain symbolic-link aliases.`);
	return real;
}

function readValidRoomMetadata(roomFile: string): RoomMetadata | undefined {
	if (!isFile(roomFile) || isSymlink(roomFile)) return undefined;
	const metadata = safeReadJson<Partial<RoomMetadata>>(roomFile);
	if (metadata?.version !== 1 || typeof metadata.id !== "string" || !metadata.id.trim()) return undefined;
	if (typeof metadata.createdAt !== "string" || !Number.isFinite(Date.parse(metadata.createdAt))) return undefined;
	return { version: 1, id: metadata.id, createdAt: metadata.createdAt };
}

function validateExistingRoom(roomDir: string): ExistingRoom | undefined {
	try {
		const canonical = canonicalExistingDirectory(roomDir, "coordination room");
		const root = path.dirname(path.dirname(canonical));
		if (canonical !== path.join(root, COORD_DIR)) return undefined;
		const sessionsDir = canonicalExistingDirectory(path.join(canonical, "sessions"), "coordination sessions directory");
		if (sessionsDir !== path.join(canonical, "sessions")) return undefined;
		const metadata = readValidRoomMetadata(path.join(canonical, "room.json"));
		return metadata ? { roomDir: canonical, metadata } : undefined;
	} catch {
		return undefined;
	}
}

function validateCreationPath(projectRoot: string): void {
	for (const candidate of [path.join(projectRoot, ".pi"), path.join(projectRoot, COORD_DIR), path.join(projectRoot, COORD_DIR, "sessions")]) {
		if (!fs.existsSync(candidate)) continue;
		if (isSymlink(candidate)) throw new CoordinationPathError(`Refusing symbolic-link coordination path: ${candidate}`);
		const canonical = canonicalExistingDirectory(candidate, "coordination path");
		if (!isWithin(projectRoot, canonical)) throw new CoordinationPathError("Coordination path escapes the project root.");
	}
}

function publishRoomMetadataExclusive(
	roomFile: string,
	metadata: RoomMetadata,
	beforePublish?: () => void,
): { metadata: RoomMetadata; created: boolean } {
	const existing = readValidRoomMetadata(roomFile);
	if (existing) return { metadata: existing, created: false };
	assertRegularDestination(roomFile);
	const tmp = `${roomFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let handle: number | undefined;
	try {
		handle = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NO_FOLLOW, 0o600);
		fs.writeFileSync(handle, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
		fs.fsyncSync(handle);
		fs.closeSync(handle);
		handle = undefined;
		beforePublish?.();
		try {
			// link(2), unlike rename(2), installs the complete marker only if the
			// destination is absent. Concurrent creators therefore cannot overwrite
			// one another's room identity.
			fs.linkSync(tmp, roomFile);
			return { metadata, created: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const winner = readValidRoomMetadata(roomFile);
			if (!winner) throw new CoordinationPathError("Concurrent room creator published an invalid room marker.");
			return { metadata: winner, created: false };
		}
	} finally {
		if (handle !== undefined) fs.closeSync(handle);
		try {
			fs.unlinkSync(tmp);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// A leftover private temp file is harmless and preferable to masking the
				// activation result after the marker was published.
			}
		}
	}
}

function ensureRoom(projectRoot: string, now: Date, beforePublish?: () => void): { roomDir: string; roomId: string; created: boolean } {
	validateCreationPath(projectRoot);
	const roomDir = path.join(projectRoot, COORD_DIR);
	ensureDir(path.join(roomDir, "sessions"));
	const canonicalRoom = canonicalExistingDirectory(roomDir, "coordination room");
	if (canonicalRoom !== roomDir || !isWithin(projectRoot, canonicalRoom)) {
		throw new CoordinationPathError("Coordination room is not canonical within the project root.");
	}
	const sessionsDir = path.join(roomDir, "sessions");
	if (canonicalExistingDirectory(sessionsDir, "coordination sessions directory") !== sessionsDir) {
		throw new CoordinationPathError("Coordination sessions directory is not canonical within the room.");
	}
	const published = publishRoomMetadataExclusive(
		path.join(roomDir, "room.json"),
		{ version: 1, id: randomId("room"), createdAt: now.toISOString() },
		beforePublish,
	);
	return { roomDir, roomId: published.metadata.id, created: published.created };
}

/** Resolve a repository's main/common worktree root without executing Git. */
export function findCanonicalGitProjectRoot(cwd: string): string | undefined {
	let canonicalCwd: string;
	try {
		canonicalCwd = fs.realpathSync.native(path.resolve(cwd));
	} catch {
		return undefined;
	}
	for (const candidate of walkUp(canonicalCwd)) {
		const marker = path.join(candidate, ".git");
		if (isSymlink(marker)) continue;
		if (isDirectory(marker)) return candidate;
		if (!isFile(marker)) continue;
		const markerText = readSmallText(marker);
		const match = markerText?.match(/^gitdir:\s*(.+)$/);
		if (!match || match[1].includes("\0")) return candidate;
		const gitDirInput = path.resolve(candidate, match[1]);
		try {
			const gitDirReal = fs.realpathSync.native(gitDirInput);
			if (gitDirReal !== gitDirInput) return candidate;
			const gitDir = canonicalExistingDirectory(gitDirInput, "git directory");
			const commonText = readSmallText(path.join(gitDir, "commondir"));
			if (!commonText || commonText.includes("\0")) return candidate;
			const commonInput = path.resolve(gitDir, commonText);
			const commonReal = fs.realpathSync.native(commonInput);
			if (commonReal !== commonInput) return candidate;
			const commonDir = canonicalExistingDirectory(commonInput, "common git directory");
			const commonRoot = canonicalExistingDirectory(path.dirname(commonDir), "common git project root");

			// A linked worktree's private git directory must be a direct child of
			// <common>/.git/worktrees and must point back to this exact .git marker.
			// Without both checks, a crafted gitdir/commondir pair could redirect
			// coordination writes into an unrelated checkout.
			if (commonDir !== path.join(commonRoot, ".git")) return candidate;
			if (path.dirname(gitDir) !== path.join(commonDir, "worktrees")) return candidate;
			const backlink = readSmallText(path.join(gitDir, "gitdir"));
			if (!backlink || backlink.includes("\0") || path.resolve(gitDir, backlink) !== marker) return candidate;
			return commonRoot;
		} catch {
			return candidate;
		}
	}
	return undefined;
}

export function findExistingRoom(cwd: string): string | undefined {
	let canonicalCwd: string;
	try {
		canonicalCwd = fs.realpathSync.native(path.resolve(cwd));
	} catch {
		return undefined;
	}

	// Prefer the common Git root before the lexical parent walk. Linked worktrees
	// are often siblings of the main checkout, and a legacy room inside one
	// worktree must not shadow the repository-wide room once it exists.
	const gitRoot = findCanonicalGitProjectRoot(canonicalCwd);
	if (gitRoot) {
		const commonRoom = validateExistingRoom(path.join(gitRoot, COORD_DIR));
		if (commonRoom) return commonRoom.roomDir;
	}
	for (const dir of walkUp(canonicalCwd)) {
		const room = validateExistingRoom(path.join(dir, COORD_DIR));
		if (room) return room.roomDir;
	}
	return undefined;
}

function labelFor(lease: SessionLease): string {
	return lease.label || lease.token.slice(0, 14);
}

function findCanonicalGitWorktreeRoot(cwd: string): string | undefined {
	let canonicalCwd: string;
	try {
		canonicalCwd = fs.realpathSync.native(path.resolve(cwd));
	} catch {
		return undefined;
	}
	for (const candidate of walkUp(canonicalCwd)) {
		const marker = path.join(candidate, ".git");
		if (!isSymlink(marker) && (isDirectory(marker) || isFile(marker))) return candidate;
	}
	return undefined;
}

function normalizeResourceKey(kind: ResourceKind, resource: string, cwd: string): string {
	if (kind !== "path") return resource.trim();
	const absolute = path.resolve(cwd, resource.trim());
	const worktreeRoot = findCanonicalGitWorktreeRoot(cwd);
	const commonRoot = findCanonicalGitProjectRoot(cwd);
	if (!worktreeRoot || !commonRoot || !isWithin(worktreeRoot, absolute)) return absolute;
	// Equivalent repository paths in sibling worktrees share one logical key,
	// allowing advisory overlap warnings even though their physical files differ.
	return path.join(commonRoot, path.relative(worktreeRoot, absolute));
}

function bounded(value: string, max: number, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} must not be empty.`);
	if (trimmed.length > max) throw new Error(`${field} must be at most ${max} characters.`);
	return trimmed;
}

function boundedOptional(value: string | undefined, maxBytes: number): string | undefined {
	if (typeof value !== "string" || value.includes("\0")) return undefined;
	const trimmed = value.trim();
	if (!trimmed || Buffer.byteLength(trimmed, "utf8") > maxBytes) return undefined;
	return trimmed;
}

function safeReadRegularFile(file: string): Buffer | undefined {
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new CoordinationPathError(`Refusing non-regular coordination file: ${file}`);
		if (stat.size > MAX_JSON_FILE_BYTES) throw new CoordinationPathError(`Coordination lease is too large: ${file}`);
		return fs.readFileSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function restoreRegularFile(file: string, previous: Buffer | undefined): void {
	assertRegularDestination(file);
	if (!previous) {
		fs.unlinkSync(file);
		return;
	}
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.rollback`;
	try {
		fs.writeFileSync(tmp, previous, { flag: "wx", mode: 0o600 });
		fs.renameSync(tmp, file);
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// Best-effort cleanup only.
			}
		}
	}
}

function sanitizeLeaseMetadata(metadata: LeaseMetadata): LeaseMetadata {
	const cwd = boundedOptional(metadata.cwd, 4096);
	if (!cwd || !path.isAbsolute(cwd) || path.resolve(cwd) !== cwd) throw new CoordinationPathError("Lease cwd must be an absolute normalized path.");
	const sessionFile = boundedOptional(metadata.piSessionFile, 4096);
	return {
		cwd,
		surface: boundedOptional(metadata.surface, 64) ?? "unknown",
		label: boundedOptional(metadata.label, 512),
		piSessionId: boundedOptional(metadata.piSessionId, 256),
		piSessionFile: sessionFile && path.isAbsolute(sessionFile) && path.resolve(sessionFile) === sessionFile ? sessionFile : undefined,
	};
}

export class SessionCoordinatorCore {
	private readonly heartbeatMs: number;
	private readonly staleAfterMs: number;
	private readonly scheduler: Scheduler;
	private readonly clock: () => Date;
	private readonly beforeRoomMarkerPublish?: () => void;
	private readonly leaseId = randomId("lease");
	private heartbeat?: unknown;
	private roomDir?: string;
	private roomId?: string;
	private projectRoot?: string;
	private lease?: SessionLease;
	private startedAt: string;

	constructor(options: CoordinatorOptions = {}) {
		this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
		this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		this.scheduler = options.scheduler ?? {
			setInterval: (handler, milliseconds) => setInterval(handler, milliseconds),
			clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
		};
		this.clock = options.now ?? (() => new Date());
		this.beforeRoomMarkerPublish = options.beforeRoomMarkerPublish;
		this.startedAt = this.nowIso();
	}

	isActive(): boolean {
		return Boolean(this.roomDir && this.lease?.status === "active");
	}

	getStartedAt(): string {
		return this.startedAt;
	}

	getLease(): SessionLease | undefined {
		return this.lease ? { ...this.lease } : undefined;
	}

	enable(explicitProjectRoot: string, metadata: LeaseMetadata): ActivationState {
		const requestedRoot = canonicalExistingDirectory(explicitProjectRoot, "projectRoot");
		// A Git worktree is a view of the common repository, not an independent
		// coordination project. Always place repository rooms at the main/common
		// root so main and linked worktrees converge on one filesystem room.
		const projectRoot = findCanonicalGitProjectRoot(requestedRoot) ?? requestedRoot;
		return this.activate(projectRoot, metadata, true);
	}

	ensure(metadata: LeaseMetadata): ActivationState {
		if (this.isActive() && this.projectRoot) return this.activate(this.projectRoot, metadata, true);
		const canonicalCwd = canonicalExistingDirectory(fs.realpathSync.native(path.resolve(metadata.cwd)), "cwd");
		const gitRoot = findCanonicalGitProjectRoot(canonicalCwd);
		if (gitRoot) return this.activate(gitRoot, metadata, true);
		const existingRoom = findExistingRoom(canonicalCwd);
		if (existingRoom) return this.activate(path.dirname(path.dirname(existingRoom)), metadata, false);
		return this.activate(canonicalCwd, metadata, true);
	}

	/** Join only if a room already exists. Never creates the room opt-in itself. */
	discoverAndJoin(metadata: LeaseMetadata): ActivationState | undefined {
		if (this.isActive()) return this.activation(false, false);
		const roomDir = findExistingRoom(metadata.cwd);
		if (!roomDir) return undefined;
		return this.activate(path.dirname(path.dirname(roomDir)), metadata, false);
	}

	leave(): void {
		this.stopHeartbeat();
		const roomDir = this.roomDir;
		if (this.lease && roomDir) {
			const at = this.nowIso();
			const inactiveLease = { ...this.lease, status: "inactive" as const, heartbeatAt: at, updatedAt: at };
			try {
				this.requireCurrentRoom();
				writeJsonAtomic(path.join(roomDir, "sessions", `${this.leaseId}.json`), inactiveLease);
			} catch {
				// Shutdown/disable cleanup must still release the in-process timer and
				// state if the room was deleted, replaced, or became unwritable. Peers
				// will age the last active lease out through normal stale detection.
			}
			this.lease = inactiveLease;
		}
		this.roomDir = undefined;
		this.roomId = undefined;
		this.projectRoot = undefined;
	}

	touch(metadata?: LeaseMetadata): void {
		if (!this.lease || !this.roomDir) return;
		this.requireCurrentRoom();
		const safeMetadata = metadata ? sanitizeLeaseMetadata(metadata) : undefined;
		const at = this.nowIso();
		const nextLease: SessionLease = {
			...this.lease,
			cwd: safeMetadata?.cwd ?? this.lease.cwd,
			surface: safeMetadata?.surface ?? this.lease.surface,
			label: safeMetadata?.label ?? this.lease.label,
			piSessionId: safeMetadata?.piSessionId ?? this.lease.piSessionId,
			piSessionFile: safeMetadata?.piSessionFile ?? this.lease.piSessionFile,
			status: "active",
			heartbeatAt: at,
			updatedAt: at,
		};
		writeJsonAtomic(this.leaseFile(), nextLease);
		this.lease = nextLease;
	}

	announce(summary: string, metadata: LeaseMetadata): SessionLease {
		this.requireWritableRoom();
		this.lease = { ...this.lease!, summary: bounded(summary, 240, "summary") };
		this.touch(metadata);
		return { ...this.lease! };
	}

	post(message: string): RoomMessage {
		const roomDir = this.requireWritableRoom();
		const record: RoomMessage = {
			version: 1,
			id: randomId("msg"),
			type: "message",
			sessionToken: this.lease!.token,
			sessionLabel: labelFor(this.lease!),
			text: bounded(message, 500, "message"),
			createdAt: this.nowIso(),
		};
		appendJsonLine(path.join(roomDir, "messages.jsonl"), record);
		this.touch();
		return record;
	}

	claim(resourceInput: string, kind: ResourceKind, intentInput: string, cwd: string, ttlSeconds?: number): { claim: ActiveClaim; conflicts: ActiveClaim[] } {
		const roomDir = this.requireWritableRoom();
		const resource = bounded(resourceInput, 500, "resource");
		const intent = bounded(intentInput, 240, "intent");
		const claim: ActiveClaim = {
			version: 1,
			id: randomId("claim"),
			type: "claim",
			sessionToken: this.lease!.token,
			sessionLabel: labelFor(this.lease!),
			resource,
			resourceKey: normalizeResourceKey(kind, resource, cwd),
			kind,
			intent,
			createdAt: this.nowIso(),
			expiresAt: ttlSeconds && ttlSeconds > 0 ? new Date(this.clock().getTime() + Math.min(ttlSeconds, 31_536_000) * 1000).toISOString() : undefined,
		};
		const conflicts = this.readActiveClaims(roomDir).filter((other) => other.sessionToken !== claim.sessionToken && resourcesOverlap(claim, other));
		appendJsonLine(path.join(roomDir, "claims.jsonl"), claim);
		this.touch();
		return { claim, conflicts };
	}

	release(claimId: string | undefined, resourceInput: string | undefined, kind: ResourceKind, cwd: string): ClaimRecord {
		const roomDir = this.requireWritableRoom();
		if (!claimId && !resourceInput) throw new Error("claimId or resource is required.");
		const resource = resourceInput ? bounded(resourceInput, 500, "resource") : undefined;
		const record: ClaimRecord = {
			version: 1,
			id: randomId("release"),
			type: "release",
			sessionToken: this.lease!.token,
			sessionLabel: labelFor(this.lease!),
			claimId: claimId ? bounded(claimId, 100, "claimId") : undefined,
			resource,
			resourceKey: resource ? normalizeResourceKey(kind, resource, cwd) : undefined,
			kind,
			createdAt: this.nowIso(),
		};
		appendJsonLine(path.join(roomDir, "claims.jsonl"), record);
		this.touch();
		return record;
	}

	snapshot(limit = DEFAULT_HISTORY_LIMIT): CoordinationSnapshot | undefined {
		if (!this.roomDir || !this.projectRoot || !this.lease) return undefined;
		const boundedLimit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_HISTORY_LIMIT)));
		const leases = safeReadDir(path.join(this.roomDir, "sessions"))
			.filter((name) => name.endsWith(".json"))
			.map((name) => safeReadJson<SessionLease>(path.join(this.roomDir!, "sessions", name)))
			.filter((lease): lease is SessionLease => Boolean(lease?.token));
		const active = leases.filter((lease) => this.isLeaseActive(lease));
		const activeTokens = new Set(active.map((lease) => lease.token));
		return {
			roomDir: this.roomDir,
			projectRoot: this.projectRoot,
			self: { ...this.lease },
			activePeers: active.filter((lease) => lease.token !== this.lease!.token),
			staleOrInactive: leases.filter((lease) => lease.token !== this.lease!.token && !this.isLeaseActive(lease)),
			messages: readJsonLines<RoomMessage>(path.join(this.roomDir, "messages.jsonl"), boundedLimit).filter((item) => item?.type === "message"),
			claims: this.readActiveClaims(this.roomDir).filter((claim) => activeTokens.has(claim.sessionToken)).slice(-boundedLimit),
		};
	}

	private activate(projectRoot: string, metadata: LeaseMetadata, allowCreate: boolean): ActivationState {
		const requestedRoom = path.join(projectRoot, COORD_DIR);
		const existing = allowCreate ? undefined : validateExistingRoom(requestedRoom);
		if (!allowCreate && !existing) throw new CoordinationPathError("Coordination room does not exist or is invalid.");
		const room = allowCreate
			? ensureRoom(projectRoot, this.clock(), this.beforeRoomMarkerPublish)
			: { roomDir: existing!.roomDir, roomId: existing!.metadata.id, created: false };
		if (this.isActive() && this.roomDir === room.roomDir && this.roomId === room.roomId) {
			this.touch(metadata);
			return this.activation(false, false);
		}

		const safeMetadata = sanitizeLeaseMetadata(metadata);
		const at = this.nowIso();
		const nextLease: SessionLease = {
			version: 1,
			token: this.leaseId,
			pid: process.pid,
			host: os.hostname(),
			cwd: safeMetadata.cwd,
			surface: safeMetadata.surface,
			label: safeMetadata.label,
			piSessionId: safeMetadata.piSessionId,
			piSessionFile: safeMetadata.piSessionFile,
			status: "active",
			summary: this.lease?.summary ?? "active; no summary announced yet",
			heartbeatAt: at,
			createdAt: this.lease?.createdAt ?? at,
			updatedAt: at,
		};
		const destinationFile = path.join(room.roomDir, "sessions", `${this.leaseId}.json`);
		const priorDestination = safeReadRegularFile(destinationFile);

		// Stage and atomically publish the destination lease before touching any
		// current state. A destination write failure therefore leaves the old lease
		// and its existing heartbeat timer completely intact.
		writeJsonAtomic(destinationFile, nextLease);

		const oldRoomDir = this.roomDir;
		const oldRoomId = this.roomId;
		const oldLease = this.lease;
		const switchingPhysicalRoom = Boolean(this.isActive() && oldRoomDir && oldRoomId && oldRoomDir !== room.roomDir);
		if (switchingPhysicalRoom && oldRoomDir && oldRoomId && oldLease) {
			const inactiveAt = this.nowIso();
			const inactiveLease = { ...oldLease, status: "inactive" as const, heartbeatAt: inactiveAt, updatedAt: inactiveAt };
			try {
				this.requireRoomIdentity(oldRoomDir, oldRoomId);
				writeJsonAtomic(path.join(oldRoomDir, "sessions", `${this.leaseId}.json`), inactiveLease);
			} catch (error) {
				try {
					restoreRegularFile(destinationFile, priorDestination);
				} catch {
					// The old lease/timer remains authoritative even if best-effort removal
					// of the newly published destination lease is externally obstructed.
				}
				throw error;
			}
		}

		this.roomDir = room.roomDir;
		this.roomId = room.roomId;
		this.projectRoot = projectRoot;
		this.startedAt = at;
		this.lease = nextLease;
		this.startHeartbeat();
		return this.activation(room.created, true);
	}

	private activation(created: boolean, joined: boolean): ActivationState {
		if (!this.roomDir || !this.projectRoot) throw new Error("Coordinator is inactive.");
		return {
			active: true,
			created,
			joined,
			outcome: created ? "created" : joined ? "joined" : "active",
			roomDir: this.roomDir,
			projectRoot: this.projectRoot,
			leaseId: this.leaseId,
		};
	}

	private leaseFile(): string {
		return path.join(this.roomDir!, "sessions", `${this.leaseId}.json`);
	}

	private requireWritableRoom(): string {
		if (!this.roomDir || !this.lease || this.lease.status !== "active") throw new Error("Session coordination is not active.");
		this.requireCurrentRoom();
		return this.roomDir;
	}

	private requireCurrentRoom(): void {
		if (!this.roomDir || !this.roomId) throw new Error("Session coordination is not active.");
		this.requireRoomIdentity(this.roomDir, this.roomId);
	}

	private requireRoomIdentity(roomDir: string, roomId: string): void {
		const existing = validateExistingRoom(roomDir);
		if (!existing) throw new CoordinationPathError("Coordination room is missing or invalid.");
		if (existing.metadata.id !== roomId) throw new CoordinationPathError("Coordination room was replaced; explicit ensure or enable is required.");
	}

	private nowIso(): string {
		return (this.clock?.() ?? new Date()).toISOString();
	}

	private startHeartbeat(): void {
		if (this.heartbeat !== undefined) return;
		this.heartbeat = this.scheduler.setInterval(() => {
			try {
				this.touch();
			} catch {
				// A transient or externally removed room must not crash the Pi host.
				// Explicit actions still surface write failures to their caller.
			}
		}, this.heartbeatMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeat === undefined) return;
		this.scheduler.clearInterval(this.heartbeat);
		this.heartbeat = undefined;
	}

	private isLeaseActive(lease: SessionLease): boolean {
		if (lease.status !== "active") return false;
		const heartbeat = Date.parse(lease.heartbeatAt);
		return Number.isFinite(heartbeat) && this.clock().getTime() - heartbeat <= this.staleAfterMs;
	}

	private readActiveClaims(roomDir: string): ActiveClaim[] {
		const records = readJsonLines<ClaimRecord>(path.join(roomDir, "claims.jsonl"), MAX_LOG_RECORDS);
		const claims = new Map<string, ActiveClaim>();
		for (const record of records) {
			if (!record?.id || !record.type) continue;
			if (record.type === "release") {
				if (record.claimId) {
					const claim = claims.get(record.claimId);
					if (claim?.sessionToken === record.sessionToken) claims.delete(record.claimId);
				}
				if (record.resourceKey) {
					for (const [id, claim] of claims) {
						if (claim.resourceKey === record.resourceKey && claim.sessionToken === record.sessionToken) claims.delete(id);
					}
				}
				continue;
			}
			if (!record.resource || !record.resourceKey || !record.kind) continue;
			if (record.expiresAt && Date.parse(record.expiresAt) <= this.clock().getTime()) continue;
			claims.set(record.id, { ...record, type: "claim", resource: record.resource, resourceKey: record.resourceKey, kind: record.kind, intent: record.intent ?? "working" });
		}
		return [...claims.values()];
	}
}

export function executeActivationAction(
	core: SessionCoordinatorCore,
	action: ActivationAction,
	params: { projectRoot?: string },
	metadata: LeaseMetadata,
): ActivationState {
	if (action === "enable") {
		if (!params.projectRoot) throw new CoordinationPathError("projectRoot is required for enable.");
		return core.enable(params.projectRoot, metadata);
	}
	return core.ensure(metadata);
}

export function resourcesOverlap(a: ActiveClaim, b: ActiveClaim): boolean {
	if (a.kind !== "path" || b.kind !== "path") return a.kind === b.kind && a.resourceKey === b.resourceKey;
	const aKey = path.resolve(a.resourceKey);
	const bKey = path.resolve(b.resourceKey);
	if (aKey === bKey) return true;
	const aToB = path.relative(aKey, bKey);
	const bToA = path.relative(bKey, aKey);
	return Boolean(aToB && !aToB.startsWith("..") && !path.isAbsolute(aToB)) || Boolean(bToA && !bToA.startsWith("..") && !path.isAbsolute(bToA));
}
