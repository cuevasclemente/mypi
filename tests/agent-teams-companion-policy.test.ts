import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  activeToolNamesFromApi,
  authorizeChildPathToolCall,
  authorizeSubagentLaunch,
  authorizeSubagentLaunchWithFreshProjection,
  loadCompanionPolicyProjection,
  sanitizedChildProcessEnvironment,
} from "../plugins/agent-teams/companion-policy.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-companion-policy-"));
  const standard = path.join(root, "standard");
  const protectedRoot = path.join(root, "protected");
  const unknown = path.join(root, "unknown");
  fs.mkdirSync(path.join(standard, "child"), { recursive: true });
  fs.mkdirSync(protectedRoot);
  fs.mkdirSync(unknown);
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const storePath = path.join(dataDir, "store.json");
  const projectionPath = path.join(dataDir, "project-access-policy.json");
  fs.writeFileSync(storePath, "{}\n", { mode: 0o600 });

  const writeProjection = (overrides: Record<string, unknown> = {}) => {
    const store = fs.statSync(storePath);
    const projection = {
      schema_version: 1,
      generation: 1,
      complete: true,
      source_store: {
        size: store.size,
        mtime_ms: store.mtimeMs,
        ctime_ms: store.ctimeMs,
        ino: Number(store.ino) || 0,
      },
      projects: [
        {
          cwd: standard,
          privacy_mode: "standard",
          allowed_agent_profile_ids: null,
          dream: true,
          scheduled: true,
          subagents: true,
          global_index: true,
        },
        {
          cwd: protectedRoot,
          privacy_mode: "protected",
          allowed_agent_profile_ids: ["synthetic-finance"],
          dream: false,
          scheduled: false,
          subagents: false,
          global_index: false,
        },
      ],
      sessions: [],
      ...overrides,
    };
    fs.writeFileSync(projectionPath, `${JSON.stringify(projection)}\n`, { mode: 0o600 });
    fs.chmodSync(projectionPath, 0o600);
  };
  writeProjection();
  return { root, standard, protectedRoot, unknown, storePath, projectionPath, writeProjection };
}

test("active parent tool names survive old string and new descriptor API shapes", () => {
  const expected = ["bash", "edit", "read", "write"];
  assert.deepEqual(activeToolNamesFromApi(["read", "bash", "edit", "write"]), expected);
  assert.deepEqual(activeToolNamesFromApi(expected.map((name) => ({ name }))), expected);
  assert.deepEqual(activeToolNamesFromApi(undefined), []);
});

test("companion policy allows standard parent/target and only narrows child tools", () => {
  const f = fixture();
  try {
    const unavailableProtected = path.join(f.root, "offline-protected-project");
    f.writeProjection({
      projects: [
        {
          cwd: f.standard,
          privacy_mode: "standard",
          allowed_agent_profile_ids: null,
          dream: true,
          scheduled: true,
          subagents: true,
          global_index: true,
        },
        {
          cwd: unavailableProtected,
          privacy_mode: "protected",
          allowed_agent_profile_ids: ["synthetic-finance"],
          dream: false,
          scheduled: false,
          subagents: false,
          global_index: false,
        },
      ],
    });
    const projection = loadCompanionPolicyProjection(f.projectionPath);
    assert.equal(projection.projects[1]?.cwd, path.resolve(unavailableProtected));

    const decision = authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: path.join(f.standard, "child"),
      parentTools: ["read", "write", "sudo_exec"],
      requestedTools: ["read", "bash", "sudo_exec"],
      projectionPath: f.projectionPath,
    });
    assert.deepEqual(decision.effectiveTools, ["read"]);
    assert.equal(decision.allowPrivilegedExec, false);
    assert.equal(decision.protectedProjectsPresent, true);
    assert.throws(() => authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: unavailableProtected,
      parentTools: ["read"],
      projectionPath: f.projectionPath,
    }), /target cwd is unavailable/);

    const safeBuiltins = authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "sudo_exec", "custom_tool"],
      requestedTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "sudo_exec", "custom_tool"],
      projectionPath: f.projectionPath,
    });
    assert.deepEqual(safeBuiltins.effectiveTools, ["edit", "find", "grep", "ls", "read", "write"]);
    assert.equal(safeBuiltins.allowPrivilegedExec, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("standard-project allowlists require the exact mapped source agent profile", () => {
  const f = fixture();
  const parentSessionFile = path.join(f.root, "parent-session.jsonl");
  fs.writeFileSync(parentSessionFile, "synthetic parent session placeholder\n");
  const financeProfile = "synthetic-finance-profile";
  const wrenProfile = "synthetic-wren-profile";
  const standardProject = (allowlist: string[]) => ({
    cwd: f.standard,
    privacy_mode: "standard",
    allowed_agent_profile_ids: allowlist,
    dream: true,
    scheduled: true,
    subagents: true,
    global_index: true,
  });
  const session = (profile: string) => ({
    session_id: "wayang-parent-session",
    path: parentSessionFile,
    cwd: f.standard,
    dream: true,
    agent_profile_id: profile,
  });
  try {
    f.writeProjection({ projects: [standardProject([financeProfile])], sessions: [session(financeProfile)] });
    const allowed = authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read"],
      requestedTools: ["read"],
      parentSessionFile,
      projectionPath: f.projectionPath,
    });
    assert.equal(allowed.sourceAgentProfileId, financeProfile);
    assert.deepEqual(allowed.effectiveTools, ["read"]);

    f.writeProjection({ projects: [standardProject([financeProfile])], sessions: [session(wrenProfile)] });
    assert.throws(() => authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read"],
      parentSessionFile,
      projectionPath: f.projectionPath,
    }), /not allowed/);

    f.writeProjection({ projects: [standardProject([wrenProfile])], sessions: [session(financeProfile)] });
    assert.throws(() => authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read"],
      parentSessionFile,
      projectionPath: f.projectionPath,
    }), /not allowed/);

    f.writeProjection({ projects: [standardProject([financeProfile])], sessions: [] });
    assert.throws(() => authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read"],
      parentSessionFile,
      projectionPath: f.projectionPath,
    }), /profile is unknown/);

    f.writeProjection({ projects: [standardProject([financeProfile])], sessions: [session(financeProfile)] });
    assert.throws(() => authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read"],
      parentSessionId: "wayang-parent-session",
      projectionPath: f.projectionPath,
    }), /profile is unknown/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("child paths enforce every Standard allowlist and protect PIN path/env", () => {
  const f = fixture();
  const financeRoot = path.join(f.root, "finance-standard");
  const wrenRoot = path.join(f.root, "wren-standard");
  const configRoot = path.join(f.root, "config");
  fs.mkdirSync(financeRoot);
  fs.mkdirSync(wrenRoot);
  fs.mkdirSync(path.join(configRoot, "pi"), { recursive: true });
  fs.writeFileSync(path.join(financeRoot, "allowed.txt"), "FINANCE_ALLOWED\n");
  fs.writeFileSync(path.join(wrenRoot, "denied.txt"), "WREN_ONLY\n");
  const pinPath = path.join(configRoot, "pi", "command-guard-identity-pin");
  const transcriptPath = path.join(f.root, "pi-sessions", "standard-only", "session.jsonl");
  fs.writeFileSync(pinPath, "00000000\n", { mode: 0o600 });
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, "STANDARD_ONLY_TRANSCRIPT_CANARY\n");
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;
  const financeProfile = "synthetic-finance-profile";
  const wrenProfile = "synthetic-wren-profile";
  const standard = (cwd: string, allowlist: string[] | null) => ({
    cwd,
    privacy_mode: "standard",
    allowed_agent_profile_ids: allowlist,
    dream: true,
    scheduled: true,
    subagents: true,
    global_index: true,
  });
  try {
    f.writeProjection({
      projects: [
        standard(f.standard, null),
        standard(financeRoot, [financeProfile]),
        standard(wrenRoot, [wrenProfile]),
      ],
      sessions: [{
        session_id: "standard-only-session",
        path: transcriptPath,
        cwd: f.standard,
        dream: true,
        agent_profile_id: financeProfile,
      }],
    });
    const standardOnlyCeiling = authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "sudo_exec", "custom_tool"],
      requestedTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "sudo_exec", "custom_tool"],
      projectionPath: f.projectionPath,
    });
    assert.equal(standardOnlyCeiling.protectedProjectsPresent, false);
    assert.deepEqual(standardOnlyCeiling.effectiveTools, ["edit", "find", "grep", "ls", "read", "write"]);
    assert.equal(standardOnlyCeiling.allowPrivilegedExec, false);
    assert.doesNotThrow(() => authorizeChildPathToolCall({
      cwd: f.standard,
      toolName: "read",
      input: { path: path.join(financeRoot, "allowed.txt") },
      projectionPath: f.projectionPath,
      sourceAgentProfileId: financeProfile,
    }));
    assert.throws(() => authorizeChildPathToolCall({
      cwd: f.standard,
      toolName: "read",
      input: { path: path.join(wrenRoot, "denied.txt") },
      projectionPath: f.projectionPath,
      sourceAgentProfileId: financeProfile,
    }), /Standard project agent allowlist/);
    assert.throws(() => authorizeChildPathToolCall({
      cwd: f.standard,
      toolName: "find",
      input: { path: f.root },
      projectionPath: f.projectionPath,
      sourceAgentProfileId: financeProfile,
    }), /Standard project agent allowlist/);
    assert.throws(() => authorizeChildPathToolCall({
      cwd: f.standard,
      toolName: "read",
      input: { path: transcriptPath },
      projectionPath: f.projectionPath,
      sourceAgentProfileId: financeProfile,
    }), /transcript\/attachment\/Wayang control storage/);
    for (const [toolName, target] of [["read", pinPath], ["find", configRoot]] as const) {
      assert.throws(() => authorizeChildPathToolCall({
        cwd: f.standard,
        toolName,
        input: { path: target },
        projectionPath: f.projectionPath,
        sourceAgentProfileId: financeProfile,
      }), /command-guard identity PIN/);
    }

    const authorization = authorizeSubagentLaunch({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read"],
      projectionPath: f.projectionPath,
    });
    const parentEnvironment: NodeJS.ProcessEnv = { SAFE_CHILD_ENV: "preserved" };
    for (const key of [
      "PI_COMMAND_GUARD_IDENTITY_PIN",
      "COMMAND_GUARD_IDENTITY_PIN",
      "PI_COMMAND_GUARD_IDENTITY_PIN_FILE",
    ]) {
      Object.defineProperty(parentEnvironment, key, {
        enumerable: true,
        get() { throw new Error(`PIN value was read: ${key}`); },
      });
    }
    const childEnvironment = sanitizedChildProcessEnvironment(authorization, parentEnvironment);
    assert.equal(childEnvironment.SAFE_CHILD_ENV, "preserved");
    assert.equal(Object.keys(childEnvironment).some((key) => /IDENTITY_PIN|COMMAND_GUARD.*PIN/i.test(key)), false);
  } finally {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("child path tools deny projected transcripts, control/attachment roots, ancestor scans, and live tightening", () => {
  const f = fixture();
  const transcriptDir = path.join(f.root, "pi-sessions", "project");
  const lateDir = path.join(f.root, "late-transcripts");
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.mkdirSync(lateDir);
  const transcript = path.join(transcriptDir, "protected.jsonl");
  const lateTranscript = path.join(lateDir, "late.jsonl");
  fs.writeFileSync(transcript, "TRANSCRIPT_CANARY\n");
  fs.writeFileSync(lateTranscript, "LATE_TRANSCRIPT_CANARY\n");
  const dataDir = path.dirname(f.projectionPath);
  const search = path.join(dataDir, "search.db");
  const attachment = path.join(dataDir, "attachments", "other-session", "cross.txt");
  fs.writeFileSync(search, "SEARCH_CANARY\n");
  fs.mkdirSync(path.dirname(attachment), { recursive: true });
  fs.writeFileSync(attachment, "ATTACHMENT_CANARY\n");
  const session = {
    session_id: "projected-session",
    path: transcript,
    cwd: f.standard,
    dream: true,
    agent_profile_id: null,
  };
  try {
    f.writeProjection({ sessions: [session] });
    const allow = authorizeChildPathToolCall({
      cwd: f.standard,
      toolName: "read",
      input: { path: path.join(f.standard, "child") },
      projectionPath: f.projectionPath,
    });
    assert.equal(allow.canonicalPath, fs.realpathSync(path.join(f.standard, "child")));

    for (const denied of [transcript, f.storePath, search, f.projectionPath, attachment]) {
      assert.throws(() => authorizeChildPathToolCall({
        cwd: f.standard,
        toolName: "read",
        input: { path: denied },
        projectionPath: f.projectionPath,
      }), /transcript\/attachment\/Wayang control storage/);
    }
    for (const [toolName, target] of [["grep", transcriptDir], ["find", f.root]] as const) {
      assert.throws(() => authorizeChildPathToolCall({
        cwd: f.standard,
        toolName,
        input: { path: target },
        projectionPath: f.projectionPath,
      }), /denied/);
    }

    assert.doesNotThrow(() => authorizeChildPathToolCall({
      cwd: f.standard,
      toolName: "read",
      input: { path: lateTranscript },
      projectionPath: f.projectionPath,
    }));
    f.writeProjection({ sessions: [session, { ...session, session_id: "late-session", path: lateTranscript }] });
    assert.throws(() => authorizeChildPathToolCall({
      cwd: f.standard,
      toolName: "read",
      input: { path: lateTranscript },
      projectionPath: f.projectionPath,
    }), /transcript\/attachment\/Wayang control storage/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("companion policy denies protected and unknown parent/target projects", () => {
  const f = fixture();
  try {
    const base = { parentTools: ["read"], projectionPath: f.projectionPath };
    assert.throws(
      () => authorizeSubagentLaunch({ ...base, parentCwd: f.protectedRoot, targetCwd: f.standard }),
      /parent project policy/,
    );
    assert.throws(
      () => authorizeSubagentLaunch({ ...base, parentCwd: f.standard, targetCwd: f.protectedRoot }),
      /target project policy/,
    );
    assert.throws(
      () => authorizeSubagentLaunch({ ...base, parentCwd: f.unknown, targetCwd: f.standard }),
      /parent project is unknown/,
    );
    assert.throws(
      () => authorizeSubagentLaunch({ ...base, parentCwd: f.standard, targetCwd: f.unknown }),
      /target project is unknown/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("availability check retries only transient projection fingerprint staleness", async () => {
  const f = fixture();
  try {
    fs.appendFileSync(f.storePath, " ");
    const refresh = setTimeout(() => f.writeProjection(), 30);
    const decision = await authorizeSubagentLaunchWithFreshProjection({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read"],
      requestedTools: [],
      projectionPath: f.projectionPath,
    }, { timeoutMs: 250, intervalMs: 10 });
    clearTimeout(refresh);
    assert.equal(decision.parentProjectCwd, fs.realpathSync(f.standard));

    fs.appendFileSync(f.storePath, " ");
    await assert.rejects(authorizeSubagentLaunchWithFreshProjection({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read"],
      projectionPath: f.projectionPath,
    }, { timeoutMs: 10, intervalMs: 2 }), /stale/);

    f.writeProjection({ projects: [] });
    const startedAt = Date.now();
    await assert.rejects(authorizeSubagentLaunchWithFreshProjection({
      parentCwd: f.standard,
      targetCwd: f.standard,
      parentTools: ["read"],
      projectionPath: f.projectionPath,
    }, { timeoutMs: 250, intervalMs: 10 }), /parent project is unknown/);
    assert.ok(Date.now() - startedAt < 200, "non-stale policy denial must not be retried");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("companion policy denies missing, public, malformed, stale, and contradictory projections", () => {
  const f = fixture();
  try {
    fs.chmodSync(f.projectionPath, 0o644);
    if (process.platform !== "win32") {
      assert.throws(() => loadCompanionPolicyProjection(f.projectionPath), /not private/);
    }
    fs.chmodSync(f.projectionPath, 0o600);
    fs.appendFileSync(f.storePath, " ");
    assert.throws(() => loadCompanionPolicyProjection(f.projectionPath), /stale/);
    fs.writeFileSync(f.projectionPath, "not json", { mode: 0o600 });
    assert.throws(() => loadCompanionPolicyProjection(f.projectionPath), /malformed/);
    f.writeProjection({
      projects: [{
        cwd: f.protectedRoot,
        privacy_mode: "protected",
        allowed_agent_profile_ids: ["synthetic-finance"],
        dream: true,
        scheduled: false,
        subagents: false,
        global_index: false,
      }],
    });
    assert.throws(() => loadCompanionPolicyProjection(f.projectionPath), /contradictory/);
    fs.rmSync(f.projectionPath);
    assert.throws(() => loadCompanionPolicyProjection(f.projectionPath), /unavailable/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
