#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const agentTeamsSourceDir = process.env.AGENT_TEAMS_SOURCE_DIR
  || path.join(repo, "plugins/agent-teams");
const wayangCwd = path.resolve(process.env.WAYANG_DIR || path.join(repo, "..", "wayang"));
assert.ok(fs.statSync(wayangCwd).isDirectory(), "Wayang standard parent fixture must exist");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-agent-tools-runner-"));
const dataDir = path.join(root, "wayang-data");
const binDir = path.join(root, "bin");
const captures = path.join(root, "captures");
const standardRoot = path.join(root, "standard");
const neutralRoot = path.join(root, "neutral-standard");
const separatedRoot = path.join(root, "separated-standard-projects");
const financeDataRoot = path.join(separatedRoot, "finance");
const wrenDataRoot = path.join(separatedRoot, "wren");
const protectedRoot = path.join(root, "protected");
const syntheticHome = path.join(root, "home");
const syntheticPinPath = path.join(syntheticHome, ".config", "pi", "command-guard-identity-pin");
const parentSessionFile = path.join(root, "pi-sessions", "parent-session.jsonl");
const financeProfile = "synthetic-finance-profile";
const wrenProfile = "synthetic-wren-profile";
fs.mkdirSync(dataDir);
fs.mkdirSync(binDir);
fs.mkdirSync(captures);
fs.mkdirSync(standardRoot);
fs.mkdirSync(neutralRoot);
fs.mkdirSync(financeDataRoot, { recursive: true });
fs.mkdirSync(wrenDataRoot);
fs.mkdirSync(protectedRoot);
fs.mkdirSync(path.dirname(syntheticPinPath), { recursive: true });
fs.mkdirSync(path.dirname(parentSessionFile));
fs.writeFileSync(parentSessionFile, "synthetic parent session placeholder\n");
fs.writeFileSync(path.join(standardRoot, "allowed.txt"), "allowed synthetic data\n");
fs.writeFileSync(path.join(financeDataRoot, "allowed.txt"), "finance-only synthetic data\n");
fs.writeFileSync(path.join(wrenDataRoot, "denied.txt"), "wren-only synthetic data\n");
fs.writeFileSync(path.join(protectedRoot, "denied.txt"), "protected synthetic data\n");
fs.writeFileSync(syntheticPinPath, "00000000\n", { mode: 0o600 });
fs.symlinkSync(path.join(protectedRoot, "denied.txt"), path.join(standardRoot, "protected-file-link"));
fs.symlinkSync(protectedRoot, path.join(standardRoot, "protected-dir-link"));

const storePath = path.join(dataDir, "store.json");
const projectionPath = path.join(dataDir, "project-access-policy.json");
fs.writeFileSync(storePath, "{}\n", { mode: 0o600 });
const writeProjection = (
  tightenTarget = false,
  sourceProfile = financeProfile,
  includeSession = true,
  includeProtected = true,
) => {
  const store = fs.statSync(storePath);
  const standardPolicy = (cwd, allowlist = null) => ({
    cwd,
    privacy_mode: "standard",
    allowed_agent_profile_ids: allowlist,
    dream: true,
    scheduled: true,
    subagents: true,
    global_index: true,
  });
  const protectedPolicy = (cwd) => ({
    cwd,
    privacy_mode: "protected",
    allowed_agent_profile_ids: ["synthetic-allowed-profile"],
    dream: false,
    scheduled: false,
    subagents: false,
    global_index: false,
  });
  fs.writeFileSync(projectionPath, `${JSON.stringify({
    schema_version: 1,
    generation: tightenTarget ? 2 : 1,
    complete: true,
    source_store: {
      size: store.size,
      mtime_ms: store.mtimeMs,
      ctime_ms: store.ctimeMs,
      ino: Number(store.ino) || 0,
    },
    projects: [
      standardPolicy(wayangCwd, [financeProfile]),
      standardPolicy(standardRoot, [tightenTarget ? wrenProfile : financeProfile]),
      standardPolicy(neutralRoot, null),
      standardPolicy(financeDataRoot, [financeProfile]),
      standardPolicy(wrenDataRoot, [wrenProfile]),
      ...(includeProtected ? [protectedPolicy(protectedRoot)] : []),
    ],
    sessions: includeSession ? [{
      session_id: "wayang-parent-session",
      path: parentSessionFile,
      cwd: wayangCwd,
      dream: true,
      agent_profile_id: sourceProfile,
    }] : [],
  })}\n`, { mode: 0o600 });
  fs.chmodSync(projectionPath, 0o600);
};
writeProjection(false, financeProfile, true, false);

const fakePi = path.join(binDir, "pi");
fs.writeFileSync(fakePi, `#!/bin/sh
set -eu
capture="$FAKE_PI_CAPTURE_DIR/argv-$$"
printf '%s\\n' "$@" >"$capture"
if [ "\${PI_COMMAND_GUARD_IDENTITY_PIN+x}" = x ] || \
   [ "\${COMMAND_GUARD_IDENTITY_PIN+x}" = x ] || \
   [ "\${PI_COMMAND_GUARD_IDENTITY_PIN_FILE+x}" = x ]; then
  : >"$capture.pin-leak"
fi
case " $* " in
  *" --mode rpc "*)
    trap 'exit 0' TERM INT
    sleep 20 & wait $!
    ;;
  *)
    printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"synthetic child ok"}],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"total":0}},"stopReason":"stop"}}'
    ;;
esac
`);
fs.chmodSync(fakePi, 0o755);

const entry = path.join(root, "entry.ts");
fs.writeFileSync(entry, [
  `export { runSingleAgent } from ${JSON.stringify(path.join(agentTeamsSourceDir, "subagent-runner.ts"))};`,
  `export { SubagentManager } from ${JSON.stringify(path.join(agentTeamsSourceDir, "subagent-manager.ts"))};`,
  `export { activeToolNamesFromApi } from ${JSON.stringify(path.join(agentTeamsSourceDir, "companion-policy.ts"))};`,
  `export { default as childPolicyGuard } from ${JSON.stringify(path.join(agentTeamsSourceDir, "child-policy-guard.ts"))};`,
  `export { default as agentTeamsExtension } from ${JSON.stringify(path.join(agentTeamsSourceDir, "index.ts"))};`,
].join("\n"));
const bundle = path.join(root, "agent-team-runner.cjs");
execFileSync("npx", [
  "--no-install", "esbuild", entry,
  "--bundle", "--platform=node", "--format=cjs",
  "--external:@earendil-works/*", "--external:typebox", `--outfile=${bundle}`,
], { cwd: repo, stdio: "pipe" });

process.env.HOME = syntheticHome;
process.env.PI_COMMAND_GUARD_IDENTITY_PIN = "synthetic-pin-value-never-read";
process.env.COMMAND_GUARD_IDENTITY_PIN = "synthetic-related-pin-never-read";
process.env.PI_COMMAND_GUARD_IDENTITY_PIN_FILE = syntheticPinPath;
process.env.PATH = `${binDir}:${process.env.PATH}`;
process.env.FAKE_PI_CAPTURE_DIR = captures;
process.env.WAYANG_PROJECT_POLICY_PROJECTION = projectionPath;
process.env.MYPI_AGENT_TEAMS_CHILD_GUARD = path.join(agentTeamsSourceDir, "child-policy-guard.ts");

const require = createRequire(import.meta.url);
const Module = require("node:module");
const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "@earendil-works/pi-coding-agent") {
    return { withFileMutationQueue: async (_file, operation) => operation() };
  }
  if (request === "@earendil-works/pi-tui") {
    return { Text: class Text { constructor(text) { this.text = text; } } };
  }
  if (request === "typebox") {
    const schema = (...args) => ({ args });
    return { Type: { Object: schema, String: schema, Number: schema, Boolean: schema, Optional: schema, Array: schema, Union: schema, Literal: schema } };
  }
  return realLoad.apply(this, arguments);
};

const requested = ["read", "bash", "edit", "write"];
const expected = ["edit", "read", "write"];
const assertToolArg = (argv, label) => {
  assert.ok(!argv.includes("--no-tools"), `${label} unexpectedly disabled every safe tool`);
  const index = argv.indexOf("--tools");
  assert.ok(index >= 0 && argv[index + 1], `${label} did not pass --tools`);
  assert.deepEqual(argv[index + 1].split(",").sort(), expected, `${label} did not enforce the safe requested ceiling`);
  assert.ok(!argv[index + 1].split(",").includes("bash"), `${label} retained bash in a Wayang companion child`);
  assert.ok(argv.includes("--no-extensions"), `${label} did not disable general extension discovery`);
  const extensionIndexes = argv.flatMap((value, index) => value === "--extension" ? [index] : []);
  assert.equal(extensionIndexes.length, 1, `${label} loaded more than one explicit extension`);
  assert.equal(argv[extensionIndexes[0] + 1], fs.realpathSync.native(process.env.MYPI_AGENT_TEAMS_CHILD_GUARD), `${label} did not load only the reviewed guard`);
};

try {
  const api = require(bundle);
  const parentTools = api.activeToolNamesFromApi(requested); // Pi 0.74 string-name API shape.
  assert.deepEqual(parentTools, ["bash", "edit", "read", "write"]);

  const frontendHandlers = {};
  let frontendActiveTools = [...requested, "subagent_spawn", "subagent_dispatch"];
  api.agentTeamsExtension({
    on(name, handler) { (frontendHandlers[name] ||= []).push(handler); },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    appendEntry() {},
    sendMessage() {},
    getActiveTools() { return frontendActiveTools; },
    getAllTools() { return frontendActiveTools.map((name) => ({ name })); },
    setActiveTools(names) { frontendActiveTools = [...names]; },
  });
  const frontendCtx = {
    cwd: wayangCwd,
    sessionManager: {
      getSessionId: () => "wayang-parent-session",
      getSessionFile: () => parentSessionFile,
      getEntries: () => [],
    },
  };
  const frontendPreflight = async (input) => {
    const event = { toolName: "subagent_spawn", input };
    for (const handler of frontendHandlers.tool_call || []) {
      const result = await handler(event, frontendCtx);
      if (result?.block) return result;
    }
    return undefined;
  };
  assert.equal(await frontendPreflight({ cwd: wayangCwd, tools: "read,bash,edit,write" }), undefined);
  writeProjection(false, wrenProfile, true, false);
  assert.match((await frontendPreflight({ cwd: wayangCwd, tools: "read" })).reason, /not allowed/);
  writeProjection(false, financeProfile, false, false);
  assert.match((await frontendPreflight({ cwd: wayangCwd, tools: "read" })).reason, /profile is unknown/);
  writeProjection(false, financeProfile, true, false);

  const result = await api.runSingleAgent(
    wayangCwd,
    { name: "synthetic-dispatch", systemPrompt: "Synthetic regression child.", tools: requested },
    "Return synthetic success.",
    wayangCwd,
    undefined,
    undefined,
    undefined,
    (results) => ({ mode: "single", results }),
    undefined,
    [],
    {
      parentCwd: wayangCwd,
      parentTools,
      parentSessionId: "wayang-parent-session",
      parentSessionFile,
    },
  );
  assert.equal(result.exitCode, 0, result.stderr);

  const manager = new api.SubagentManager();
  await manager.spawn({
    id: "synthetic-spawn",
    agentName: "synthetic-spawn",
    systemPrompt: "Synthetic regression child.",
    tools: requested.join(","),
    cwd: wayangCwd,
    policyParentCwd: wayangCwd,
    policyParentTools: parentTools,
    policyParentSessionId: "wayang-parent-session",
    policyParentSessionFile: parentSessionFile,
  });

  const deadline = Date.now() + 2_000;
  while (fs.readdirSync(captures).length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const captureEntries = fs.readdirSync(captures).sort();
  assert.deepEqual(captureEntries.filter((file) => file.endsWith(".pin-leak")), [], "child process inherited command-guard PIN env");
  const files = captureEntries.filter((file) => file.startsWith("argv-"));
  assert.equal(files.length, 2, "both dispatch and long-lived spawn must reach the fake Pi executable");
  const invocations = files.map((file) => fs.readFileSync(path.join(captures, file), "utf8").trim().split("\n"));
  const jsonInvocation = invocations.find((argv) => argv.includes("json"));
  const rpcInvocation = invocations.find((argv) => argv.includes("rpc"));
  assert.ok(jsonInvocation, "one-shot dispatch invocation missing");
  assert.ok(rpcInvocation, "long-lived spawn invocation missing");
  assertToolArg(jsonInvocation, "one-shot dispatch");
  assertToolArg(rpcInvocation, "long-lived spawn");
  await manager.stopAll();

  writeProjection(false, wrenProfile, true, false);
  const deniedDispatch = await api.runSingleAgent(
    wayangCwd,
    { name: "wren-denied-dispatch", systemPrompt: "Synthetic denied child.", tools: ["read"] },
    "This must not launch.", wayangCwd, undefined, undefined, undefined,
    (results) => ({ mode: "single", results }), undefined, [],
    { parentCwd: wayangCwd, parentTools, parentSessionFile },
  );
  assert.equal(deniedDispatch.exitCode, 1);
  assert.match(deniedDispatch.stderr, /not allowed/);
  await assert.rejects(() => manager.spawn({
    id: "wren-denied-spawn",
    agentName: "wren-denied-spawn",
    systemPrompt: "Synthetic denied child.",
    tools: "read",
    cwd: wayangCwd,
    policyParentCwd: wayangCwd,
    policyParentTools: parentTools,
    policyParentSessionFile: parentSessionFile,
  }), /not allowed/);
  assert.equal(fs.readdirSync(captures).filter((file) => file.startsWith("argv-")).length, 2, "denied Wren manager/runner path launched a child");
  writeProjection(false, financeProfile, true, false);

  // Execute the actual reviewed guard factory against live synthetic policy.
  process.env.MYPI_COMPANION_PARENT_PROJECT_CWD = neutralRoot;
  process.env.MYPI_COMPANION_TARGET_PROJECT_CWD = neutralRoot;
  process.env.MYPI_COMPANION_POLICY_PROJECTION = projectionPath;
  process.env.MYPI_COMPANION_SOURCE_AGENT_PROFILE_ID = financeProfile;
  const handlers = {};
  api.childPolicyGuard({ on(name, handler) { handlers[name] = handler; } });
  const guard = handlers.tool_call;
  assert.equal(typeof guard, "function", "child policy guard did not register tool_call");
  const ctx = { cwd: neutralRoot };
  const call = (toolName, target) => guard({ toolName, input: target === undefined ? {} : { path: target } }, ctx);

  assert.equal(await call("read", path.join(standardRoot, "allowed.txt")), undefined, "Finance source should retain its Standard target access");
  assert.equal(await call("read", path.join(financeDataRoot, "allowed.txt")), undefined, "Finance source should access Finance-allowlisted project");
  assert.match((await call("read", path.join(wrenDataRoot, "denied.txt"))).reason, /Standard project agent allowlist/);
  assert.match((await call("find", separatedRoot)).reason, /Standard project agent allowlist/);
  process.env.MYPI_COMPANION_SOURCE_AGENT_PROFILE_ID = wrenProfile;
  assert.match((await call("read", path.join(financeDataRoot, "allowed.txt"))).reason, /Standard project agent allowlist/);
  process.env.MYPI_COMPANION_SOURCE_AGENT_PROFILE_ID = financeProfile;
  assert.match((await call("read", syntheticPinPath)).reason, /command-guard identity PIN/);
  assert.match((await call("find", syntheticHome)).reason, /command-guard identity PIN/);
  assert.match((await call("read", parentSessionFile)).reason, /transcript\/attachment\/Wayang control/);
  assert.match((await call("bash", undefined)).reason, /only reviewed built-in path tools/);
  assert.match((await call("custom_unknown_tool", undefined)).reason, /only reviewed built-in path tools/);

  writeProjection();
  assert.match((await call("read", path.join(protectedRoot, "denied.txt"))).reason, /protected project/);
  assert.match((await call("read", path.join(standardRoot, "protected-file-link"))).reason, /protected project/);
  assert.match((await call("write", path.join(standardRoot, "protected-dir-link", "new.txt"))).reason, /protected project/);
  assert.match((await call("read", storePath)).reason, /transcript\/attachment\/Wayang control/);

  fs.appendFileSync(storePath, " ");
  assert.match((await call("read", path.join(standardRoot, "allowed.txt"))).reason, /stale/);
  fs.writeFileSync(storePath, "{}\n", { mode: 0o600 });
  writeProjection();
  fs.writeFileSync(projectionPath, "malformed", { mode: 0o600 });
  assert.match((await call("read", path.join(standardRoot, "allowed.txt"))).reason, /malformed/);
  writeProjection();

  writeProjection(true);
  process.env.MYPI_COMPANION_PARENT_PROJECT_CWD = standardRoot;
  process.env.MYPI_COMPANION_TARGET_PROJECT_CWD = standardRoot;
  assert.match((await call("read", path.join(standardRoot, "allowed.txt"))).reason, /not allowed by the (?:parent|target) project/);

  console.log("agent teams real spawn/runner options and child guard regression passed");
} finally {
  Module._load = realLoad;
  fs.rmSync(root, { recursive: true, force: true });
}
