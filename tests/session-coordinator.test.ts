import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
	COORD_DIR,
	CoordinationPathError,
	MAX_HISTORY_LIMIT,
	MAX_TOOL_RESULT_BYTES,
	SessionCoordinatorCore,
	boundedSnapshotDetails,
	boundedToolResult,
	canonicalExistingDirectory,
	coordinationWidgetVisible,
	executeActivationAction,
	findCanonicalGitProjectRoot,
	findExistingRoom,
	type LeaseMetadata,
	type Scheduler,
} from "../plugins/session-coordinator/core.js";

const temporaryRoots = new Set<string>();

afterEach(() => {
	for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
	temporaryRoots.clear();
});

function temporaryDirectory(name: string): string {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `session-coordinator-${name}-`)));
	temporaryRoots.add(root);
	return root;
}

function metadata(cwd: string, label = "synthetic session"): LeaseMetadata {
	return { cwd: fs.realpathSync.native(cwd), surface: "wayang", label };
}

function createMainRepository(name = "repo"): string {
	const root = path.join(temporaryDirectory(name), "main");
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	return fs.realpathSync.native(root);
}

function createLinkedWorktree(mainRoot: string, name = "task"): string {
	const gitDir = path.join(mainRoot, ".git", "worktrees", name);
	const linkedRoot = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-${name}`);
	fs.mkdirSync(gitDir, { recursive: true });
	fs.mkdirSync(linkedRoot, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n", "utf8");
	fs.writeFileSync(path.join(gitDir, "gitdir"), `${path.join(linkedRoot, ".git")}\n`, "utf8");
	fs.writeFileSync(path.join(linkedRoot, ".git"), `gitdir: ${gitDir}\n`, "utf8");
	return fs.realpathSync.native(linkedRoot);
}

function readLease(roomDir: string, leaseId: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(roomDir, "sessions", `${leaseId}.json`), "utf8")) as Record<string, unknown>;
}

function readRoomId(roomDir: string): string {
	return (JSON.parse(fs.readFileSync(path.join(roomDir, "room.json"), "utf8")) as { id: string }).id;
}

class FakeScheduler implements Scheduler {
	readonly handlers = new Map<number, () => void>();
	private nextId = 1;

	setInterval(handler: () => void, _milliseconds: number): number {
		const id = this.nextId++;
		this.handlers.set(id, handler);
		return id;
	}

	clearInterval(handle: unknown): void {
		this.handlers.delete(handle as number);
	}

	tick(): void {
		for (const handler of [...this.handlers.values()]) handler();
	}
}

test("ensure creates the canonical non-Git cwd room and returns structured activation state", () => {
	const root = temporaryDirectory("plain-ensure");
	const scheduler = new FakeScheduler();
	const core = new SessionCoordinatorCore({ scheduler });

	const state = executeActivationAction(core, "ensure", {}, metadata(root));

	assert.equal(state.active, true);
	assert.equal(state.created, true);
	assert.equal(state.joined, true);
	assert.equal(state.outcome, "created");
	assert.equal(state.projectRoot, root);
	assert.equal(state.roomDir, path.join(root, COORD_DIR));
	assert.match(state.leaseId, /^lease-/);
	assert.equal(scheduler.handlers.size, 1);
	assert.equal(readLease(state.roomDir, state.leaseId).status, "active");
	core.leave();
});

test("concurrent first-room creators atomically share the published winner", () => {
	const root = temporaryDirectory("concurrent-create");
	const winner = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	let winnerState: ReturnType<SessionCoordinatorCore["ensure"]> | undefined;
	const interleaved = new SessionCoordinatorCore({
		scheduler: new FakeScheduler(),
		beforeRoomMarkerPublish: () => {
			winnerState = winner.ensure(metadata(root, "winner"));
		},
	});

	const interleavedState = interleaved.ensure(metadata(root, "interleaved creator"));

	assert.equal(winnerState?.created, true);
	assert.equal(interleavedState.created, false);
	assert.equal(interleavedState.outcome, "joined");
	assert.equal(interleavedState.roomDir, winnerState?.roomDir);
	assert.equal(winner.snapshot()?.activePeers.length, 1);
	assert.equal(readRoomId(interleavedState.roomDir), readRoomId(winnerState!.roomDir));
	interleaved.leave();
	winner.leave();
});

test("enable requires an explicit absolute canonical existing directory", () => {
	const root = temporaryDirectory("explicit-enable");
	const core = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });

	assert.throws(
		() => executeActivationAction(core, "enable", {}, metadata(root)),
		(error: unknown) => error instanceof CoordinationPathError && /projectRoot is required/.test(error.message),
	);
	assert.throws(() => core.enable("relative/project", metadata(root)), CoordinationPathError);
	assert.throws(() => core.enable(path.join(root, "missing"), metadata(root)), CoordinationPathError);

	const alias = path.join(root, "alias");
	fs.symlinkSync(root, alias, "dir");
	assert.throws(() => canonicalExistingDirectory(alias), CoordinationPathError);
});

test("ensure is idempotent and preserves one lease and one heartbeat", () => {
	const root = temporaryDirectory("idempotent");
	const scheduler = new FakeScheduler();
	const core = new SessionCoordinatorCore({ scheduler });

	const first = core.ensure(metadata(root, "first label"));
	const second = core.ensure(metadata(root, "updated label"));

	assert.equal(second.outcome, "active");
	assert.equal(second.created, false);
	assert.equal(second.joined, false);
	assert.equal(second.leaseId, first.leaseId);
	assert.equal(scheduler.handlers.size, 1);
	assert.equal(readLease(first.roomDir, first.leaseId).label, "updated label");
	core.leave();
});

test("late non-creating discovery joins a room created after another session started", () => {
	const root = temporaryDirectory("late-discovery");
	const leader = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const follower = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });

	assert.equal(follower.discoverAndJoin(metadata(root, "follower")), undefined);
	const leaderState = leader.ensure(metadata(root, "leader"));
	const followerState = follower.discoverAndJoin(metadata(root, "follower"));

	assert.equal(followerState?.outcome, "joined");
	assert.equal(followerState?.roomDir, leaderState.roomDir);
	assert.equal(leader.snapshot()?.activePeers.length, 1);
	leader.leave();
	follower.leave();
});

test("synthetic main and linked worktrees resolve and coordinate through one Git common-root room", () => {
	const mainRoot = createMainRepository("worktrees");
	const linkedRoot = createLinkedWorktree(mainRoot);
	const mainScheduler = new FakeScheduler();
	const linkedScheduler = new FakeScheduler();
	const main = new SessionCoordinatorCore({ scheduler: mainScheduler });
	const linked = new SessionCoordinatorCore({ scheduler: linkedScheduler });

	assert.equal(findCanonicalGitProjectRoot(mainRoot), mainRoot);
	assert.equal(findCanonicalGitProjectRoot(linkedRoot), mainRoot);
	const mainState = main.ensure(metadata(mainRoot, "main"));
	const linkedState = linked.ensure(metadata(linkedRoot, "linked"));

	assert.equal(mainState.projectRoot, mainRoot);
	assert.equal(linkedState.projectRoot, mainRoot);
	assert.equal(linkedState.roomDir, mainState.roomDir);
	assert.notEqual(linkedState.leaseId, mainState.leaseId);
	assert.deepEqual(main.snapshot()?.activePeers.map((peer) => peer.label), ["linked"]);
	const mainClaim = main.claim("src/shared.ts", "path", "main edit", mainRoot).claim;
	const linkedClaim = linked.claim("src/shared.ts", "path", "linked edit", linkedRoot);
	assert.equal(linkedClaim.conflicts.length, 1, "equivalent paths in sibling worktrees overlap logically");
	assert.equal(linkedClaim.conflicts[0]?.id, mainClaim.id);
	assert.equal(linkedClaim.claim.resourceKey, mainClaim.resourceKey);
	assert.equal(mainScheduler.handlers.size, 1);
	assert.equal(linkedScheduler.handlers.size, 1);
	main.leave();
	linked.leave();
});

test("crafted gitdir and commondir metadata cannot relocate coordination writes", () => {
	const victimRoot = createMainRepository("git-pointer-victim");
	const attackerRoot = temporaryDirectory("git-pointer-attacker");
	const forgedGitDir = path.join(victimRoot, ".git", "worktrees", "forged");
	fs.mkdirSync(forgedGitDir, { recursive: true });
	fs.writeFileSync(path.join(forgedGitDir, "commondir"), "../..\n", "utf8");
	fs.writeFileSync(path.join(forgedGitDir, "gitdir"), `${path.join(attackerRoot, "different.git")}\n`, "utf8");
	fs.writeFileSync(path.join(attackerRoot, ".git"), `gitdir: ${forgedGitDir}\n`, "utf8");

	assert.equal(findCanonicalGitProjectRoot(attackerRoot), attackerRoot, "a mismatched backlink must fail closed to the local checkout");
	const attacker = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const attackerState = attacker.enable(attackerRoot, metadata(attackerRoot));
	assert.equal(attackerState.projectRoot, attackerRoot);
	assert.equal(fs.existsSync(path.join(victimRoot, COORD_DIR)), false);
	attacker.leave();

	const secondAttacker = temporaryDirectory("git-pointer-containment");
	const privateGitDir = path.join(temporaryDirectory("git-pointer-private"), "private-git-dir");
	fs.mkdirSync(privateGitDir, { recursive: true });
	fs.writeFileSync(path.join(privateGitDir, "commondir"), `${path.join(victimRoot, ".git")}\n`, "utf8");
	fs.writeFileSync(path.join(privateGitDir, "gitdir"), `${path.join(secondAttacker, ".git")}\n`, "utf8");
	fs.writeFileSync(path.join(secondAttacker, ".git"), `gitdir: ${privateGitDir}\n`, "utf8");
	assert.equal(findCanonicalGitProjectRoot(secondAttacker), secondAttacker, "gitDir must live directly under commonDir/worktrees");
});

test("explicit enable from a linked worktree also maps to the Git common root", () => {
	const mainRoot = createMainRepository("linked-enable");
	const linkedRoot = createLinkedWorktree(mainRoot);
	const core = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });

	const state = core.enable(linkedRoot, metadata(linkedRoot));

	assert.equal(state.projectRoot, mainRoot);
	assert.equal(state.roomDir, path.join(mainRoot, COORD_DIR));
	core.leave();
});

test("the common-root room takes precedence over a legacy linked-worktree room", () => {
	const mainRoot = createMainRepository("room-precedence");
	const linkedRoot = createLinkedWorktree(mainRoot);
	const legacyRoom = path.join(linkedRoot, COORD_DIR);
	fs.mkdirSync(path.join(legacyRoom, "sessions"), { recursive: true });
	fs.writeFileSync(path.join(legacyRoom, "room.json"), `${JSON.stringify({ version: 1, id: "room-legacy", createdAt: "2026-08-10T00:00:00.000Z" })}\n`, "utf8");
	const common = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const commonState = common.enable(mainRoot, metadata(mainRoot));

	assert.equal(findExistingRoom(linkedRoot), commonState.roomDir);
	const follower = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	assert.equal(follower.discoverAndJoin(metadata(linkedRoot))?.roomDir, commonState.roomDir);
	common.leave();
	follower.leave();
});

test("coordination widget visibility is false for an empty room and true when a peer joins", () => {
	const root = temporaryDirectory("empty-widget");
	const core = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const peer = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	core.ensure(metadata(root, "self"));

	assert.equal(coordinationWidgetVisible(core.snapshot()!, core.getStartedAt()), false);

	peer.ensure(metadata(root, "peer"));
	assert.equal(coordinationWidgetVisible(core.snapshot()!, core.getStartedAt()), true);
	core.leave();
	peer.leave();
});

test("independent coordinator instances own independent leases and timers", () => {
	const root = temporaryDirectory("per-factory-state");
	const firstScheduler = new FakeScheduler();
	const secondScheduler = new FakeScheduler();
	const first = new SessionCoordinatorCore({ scheduler: firstScheduler });
	const second = new SessionCoordinatorCore({ scheduler: secondScheduler });

	const firstState = first.ensure(metadata(root, "first"));
	const secondState = second.ensure(metadata(root, "second"));

	assert.notEqual(firstState.leaseId, secondState.leaseId);
	assert.equal(firstScheduler.handlers.size, 1);
	assert.equal(secondScheduler.handlers.size, 1);
	first.leave();
	assert.equal(firstScheduler.handlers.size, 0);
	assert.equal(secondScheduler.handlers.size, 1);
	assert.equal(second.snapshot()?.self.status, "active");
	second.leave();
});

test("switching rooms in one runtime inactivates the old lease without leaking a timer", () => {
	const firstRoot = temporaryDirectory("switch-first");
	const secondRoot = temporaryDirectory("switch-second");
	const scheduler = new FakeScheduler();
	const core = new SessionCoordinatorCore({ scheduler });

	const first = core.enable(firstRoot, metadata(firstRoot));
	const second = core.enable(secondRoot, metadata(secondRoot));

	assert.equal(scheduler.handlers.size, 1);
	assert.equal(readLease(first.roomDir, first.leaseId).status, "inactive");
	assert.equal(readLease(second.roomDir, second.leaseId).status, "active");
	core.leave();
	assert.equal(scheduler.handlers.size, 0);
	assert.equal(readLease(second.roomDir, second.leaseId).status, "inactive");
});

test("destination lease write failure rolls back a room switch without touching the old lease or timer", () => {
	const currentRoot = temporaryDirectory("switch-write-current");
	const destinationRoot = temporaryDirectory("switch-write-destination");
	const destinationOwner = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const destination = destinationOwner.enable(destinationRoot, metadata(destinationRoot));
	destinationOwner.leave();
	const scheduler = new FakeScheduler();
	const core = new SessionCoordinatorCore({ scheduler });
	const current = core.enable(currentRoot, metadata(currentRoot));
	fs.mkdirSync(path.join(destination.roomDir, "sessions", `${current.leaseId}.json`));

	assert.throws(() => core.enable(destinationRoot, metadata(destinationRoot)), CoordinationPathError);
	assert.equal(core.isActive(), true);
	assert.equal(core.getLease()?.token, current.leaseId);
	assert.equal(scheduler.handlers.size, 1);
	assert.equal(readLease(current.roomDir, current.leaseId).status, "active");
	assert.doesNotThrow(() => scheduler.tick());
	assert.equal(readLease(current.roomDir, current.leaseId).status, "active");
	core.leave();
});

test("a rejected room switch preserves the current lease and heartbeat", () => {
	const currentRoot = temporaryDirectory("safe-switch-current");
	const rejectedRoot = temporaryDirectory("safe-switch-rejected");
	const outside = temporaryDirectory("safe-switch-outside");
	fs.symlinkSync(outside, path.join(rejectedRoot, ".pi"), "dir");
	const scheduler = new FakeScheduler();
	const core = new SessionCoordinatorCore({ scheduler });
	const current = core.enable(currentRoot, metadata(currentRoot));

	assert.throws(() => core.enable(rejectedRoot, metadata(rejectedRoot)), CoordinationPathError);
	assert.equal(core.isActive(), true);
	assert.equal(scheduler.handlers.size, 1);
	assert.equal(core.getLease()?.token, current.leaseId);
	assert.equal(readLease(current.roomDir, current.leaseId).status, "active");
	core.leave();
});

test("shutdown and heartbeat cleanup remain safe if the room is removed externally", () => {
	const root = temporaryDirectory("removed-room");
	const scheduler = new FakeScheduler();
	const core = new SessionCoordinatorCore({ scheduler });
	const state = core.ensure(metadata(root));
	fs.rmSync(state.roomDir, { recursive: true, force: true });

	assert.doesNotThrow(() => scheduler.tick());
	assert.doesNotThrow(() => core.leave());
	assert.equal(core.isActive(), false);
	assert.equal(scheduler.handlers.size, 0);
});

test("deleted room stays absent after heartbeat, touch, and leave", () => {
	const root = temporaryDirectory("removed-room-no-recreate");
	const scheduler = new FakeScheduler();
	const core = new SessionCoordinatorCore({ scheduler });
	const state = core.ensure(metadata(root));
	fs.rmSync(state.roomDir, { recursive: true, force: true });

	assert.doesNotThrow(() => scheduler.tick());
	assert.equal(fs.existsSync(state.roomDir), false, "heartbeat must not recreate the room");
	assert.throws(() => core.touch(metadata(root)), CoordinationPathError);
	assert.equal(fs.existsSync(state.roomDir), false, "touch must not recreate the room");
	assert.throws(() => core.post("must not recreate the room"), CoordinationPathError);
	assert.equal(fs.existsSync(state.roomDir), false, "log append must not recreate the room");
	assert.doesNotThrow(() => core.leave());
	assert.equal(fs.existsSync(state.roomDir), false, "leave must not recreate the room");
});

test("append logs reject symlink sentinels and non-regular files", () => {
	const root = temporaryDirectory("append-log-types");
	const core = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const state = core.ensure(metadata(root));
	const messageSentinel = path.join(root, "message-sentinel.txt");
	const claimSentinel = path.join(root, "claim-sentinel.txt");
	fs.writeFileSync(messageSentinel, "message sentinel\n", "utf8");
	fs.writeFileSync(claimSentinel, "claim sentinel\n", "utf8");
	const messagesLog = path.join(state.roomDir, "messages.jsonl");
	const claimsLog = path.join(state.roomDir, "claims.jsonl");
	fs.symlinkSync(messageSentinel, messagesLog, "file");
	fs.symlinkSync(claimSentinel, claimsLog, "file");

	assert.throws(() => core.post("must not follow the message symlink"), CoordinationPathError);
	assert.throws(() => core.claim("src", "path", "must not follow the claim symlink", root), CoordinationPathError);
	assert.equal(fs.readFileSync(messageSentinel, "utf8"), "message sentinel\n");
	assert.equal(fs.readFileSync(claimSentinel, "utf8"), "claim sentinel\n");

	fs.unlinkSync(messagesLog);
	fs.mkdirSync(messagesLog);
	assert.throws(() => core.post("must reject a directory log"), CoordinationPathError);
	core.leave();
});

test("discovery does not repair a missing room marker or sessions directory", () => {
	const markerRoot = temporaryDirectory("missing-marker");
	const markerOwner = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const markerRoom = markerOwner.ensure(metadata(markerRoot)).roomDir;
	markerOwner.leave();
	fs.rmSync(path.join(markerRoom, "room.json"));
	const markerDiscoverer = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });

	assert.equal(findExistingRoom(markerRoot), undefined);
	assert.equal(markerDiscoverer.discoverAndJoin(metadata(markerRoot)), undefined);
	assert.equal(fs.existsSync(path.join(markerRoom, "room.json")), false);
	fs.writeFileSync(path.join(markerRoom, "room.json"), "{}\n", "utf8");
	assert.equal(findExistingRoom(markerRoot), undefined, "a malformed marker is not a room opt-in");
	assert.equal(markerDiscoverer.discoverAndJoin(metadata(markerRoot)), undefined);
	assert.equal(fs.readFileSync(path.join(markerRoom, "room.json"), "utf8"), "{}\n", "discovery must not repair a malformed marker");

	const sessionsRoot = temporaryDirectory("missing-sessions");
	const sessionsOwner = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const sessionsRoom = sessionsOwner.ensure(metadata(sessionsRoot)).roomDir;
	sessionsOwner.leave();
	fs.rmSync(path.join(sessionsRoom, "sessions"), { recursive: true, force: true });
	const sessionsDiscoverer = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });

	assert.equal(findExistingRoom(sessionsRoot), undefined);
	assert.equal(sessionsDiscoverer.discoverAndJoin(metadata(sessionsRoot)), undefined);
	assert.equal(fs.existsSync(path.join(sessionsRoom, "sessions")), false);
});

test("a writer activated against an old room ID refuses writes into its replacement", () => {
	const root = temporaryDirectory("replaced-room");
	const oldScheduler = new FakeScheduler();
	const oldWriter = new SessionCoordinatorCore({ scheduler: oldScheduler });
	const oldState = oldWriter.ensure(metadata(root, "old writer"));
	const oldRoomId = readRoomId(oldState.roomDir);
	fs.rmSync(oldState.roomDir, { recursive: true, force: true });

	const replacement = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const replacementState = replacement.ensure(metadata(root, "replacement"));
	assert.notEqual(readRoomId(replacementState.roomDir), oldRoomId);
	assert.doesNotThrow(() => oldScheduler.tick());
	assert.equal(fs.existsSync(path.join(replacementState.roomDir, "sessions", `${oldState.leaseId}.json`)), false);
	assert.throws(() => oldWriter.touch(metadata(root, "old writer")), /room was replaced/);
	assert.throws(() => oldWriter.post("must not enter replacement"), /room was replaced/);
	assert.equal(fs.existsSync(path.join(replacementState.roomDir, "sessions", `${oldState.leaseId}.json`)), false);
	assert.equal(fs.existsSync(path.join(replacementState.roomDir, "messages.jsonl")), false);

	oldWriter.leave();
	assert.equal(fs.existsSync(path.join(replacementState.roomDir, "sessions", `${oldState.leaseId}.json`)), false);
	replacement.leave();
});

test("explicit ensure and enable can recreate missing room structure", () => {
	const ensureRoot = temporaryDirectory("ensure-recreate");
	const ensureCore = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const firstEnsure = ensureCore.ensure(metadata(ensureRoot));
	const firstEnsureRoomId = readRoomId(firstEnsure.roomDir);
	fs.rmSync(firstEnsure.roomDir, { recursive: true, force: true });

	const recreatedByEnsure = ensureCore.ensure(metadata(ensureRoot));
	assert.equal(recreatedByEnsure.outcome, "created");
	assert.notEqual(readRoomId(recreatedByEnsure.roomDir), firstEnsureRoomId);
	assert.equal(readLease(recreatedByEnsure.roomDir, recreatedByEnsure.leaseId).status, "active");
	ensureCore.leave();

	const enableRoot = temporaryDirectory("enable-recreate");
	const enableCore = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const firstEnable = enableCore.enable(enableRoot, metadata(enableRoot));
	const firstEnableRoomId = readRoomId(firstEnable.roomDir);
	fs.rmSync(path.join(firstEnable.roomDir, "room.json"));
	fs.rmSync(path.join(firstEnable.roomDir, "sessions"), { recursive: true, force: true });

	const recreatedByEnable = enableCore.enable(enableRoot, metadata(enableRoot));
	assert.equal(recreatedByEnable.outcome, "created");
	assert.notEqual(readRoomId(recreatedByEnable.roomDir), firstEnableRoomId);
	assert.equal(readLease(recreatedByEnable.roomDir, recreatedByEnable.leaseId).status, "active");
	enableCore.leave();
});

test("stale peer leases and their claims are excluded while active peer data remains visible", () => {
	const root = temporaryDirectory("stale-filtering");
	let nowMs = Date.parse("2026-08-10T12:00:00.000Z");
	const now = () => new Date(nowMs);
	const leader = new SessionCoordinatorCore({ scheduler: new FakeScheduler(), now, staleAfterMs: 90_000 });
	const peer = new SessionCoordinatorCore({ scheduler: new FakeScheduler(), now, staleAfterMs: 90_000 });
	leader.ensure(metadata(root, "leader"));
	peer.ensure(metadata(root, "peer"));
	peer.announce("editing API", metadata(root, "peer"));
	peer.post("starting API work");
	peer.claim("src/api", "path", "editing routes", root);

	assert.equal(leader.snapshot()?.activePeers.length, 1);
	assert.equal(leader.snapshot()?.claims.length, 1);
	assert.equal(leader.snapshot()?.messages.length, 1);

	nowMs += 90_001;
	leader.touch(metadata(root, "leader"));
	const snapshot = leader.snapshot();
	assert.equal(snapshot?.activePeers.length, 0);
	assert.equal(snapshot?.staleOrInactive.length, 1);
	assert.equal(snapshot?.claims.length, 0);
	assert.equal(snapshot?.messages.length, 1, "append-only history remains visible");
	leader.leave();
	peer.leave();
});

test("lease metadata restores bounded Pi session identifiers when safely available", () => {
	const root = temporaryDirectory("session-metadata");
	const core = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const sessionFile = path.join(root, "session.jsonl");
	const state = core.ensure({
		...metadata(root),
		piSessionId: "session-abc123",
		piSessionFile: sessionFile,
	});
	const lease = readLease(state.roomDir, state.leaseId);
	assert.equal(lease.piSessionId, "session-abc123");
	assert.equal(lease.piSessionFile, sessionFile);
	core.leave();

	const invalidRoot = temporaryDirectory("invalid-session-metadata");
	const invalid = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const invalidState = invalid.ensure({
		...metadata(invalidRoot),
		piSessionId: "x".repeat(257),
		piSessionFile: "relative/session.jsonl",
	});
	const invalidLease = readLease(invalidState.roomDir, invalidState.leaseId);
	assert.equal("piSessionId" in invalidLease, false);
	assert.equal("piSessionFile" in invalidLease, false);
	invalid.leave();
});

test("maximum Unicode history payloads keep messages, claims, content, and details bounded", () => {
	const root = temporaryDirectory("maximum-payload");
	const core = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	core.ensure(metadata(root));
	const maximumMessage = "😀".repeat(250);
	const maximumResource = "界".repeat(500);
	const maximumIntent = "é".repeat(240);
	for (let index = 0; index < MAX_HISTORY_LIMIT + 10; index++) {
		core.post(`${index}:${maximumMessage}`.slice(0, 500));
		core.claim(`${index}:${maximumResource}`.slice(0, 500), "task", maximumIntent, root);
	}

	const snapshot = core.snapshot(10_000)!;
	assert.equal(snapshot.messages.length, MAX_HISTORY_LIMIT);
	assert.equal(snapshot.claims.length, MAX_HISTORY_LIMIT);
	const result = boundedToolResult(JSON.stringify(snapshot), boundedSnapshotDetails(snapshot, 10_000));
	assert.ok(Buffer.byteLength(result.content[0].text, "utf8") < MAX_TOOL_RESULT_BYTES);
	assert.ok(Buffer.byteLength(JSON.stringify(result.details), "utf8") < MAX_TOOL_RESULT_BYTES);
	const details = result.details as { messages?: unknown[]; claims?: unknown[] };
	assert.ok((details.messages?.length ?? 0) <= MAX_HISTORY_LIMIT);
	assert.ok((details.claims?.length ?? 0) <= MAX_HISTORY_LIMIT);
	core.leave();
});

test("one session cannot release another session's claim by id", () => {
	const root = temporaryDirectory("claim-ownership");
	const owner = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	const other = new SessionCoordinatorCore({ scheduler: new FakeScheduler() });
	owner.ensure(metadata(root, "owner"));
	other.ensure(metadata(root, "other"));
	const { claim } = owner.claim("src/shared", "path", "owner work", root);

	other.release(claim.id, undefined, "path", root);

	assert.deepEqual(owner.snapshot()?.claims.map((item) => item.id), [claim.id]);
	owner.leave();
	other.leave();
});
