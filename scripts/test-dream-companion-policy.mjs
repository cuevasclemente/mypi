#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dreamerSource = process.env.DREAMER_SOURCE || path.join(repo, "plugins/dreamer.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mypi-dream-companion-"));
const syntheticHome = path.join(root, "home");
const sessionsRoot = path.join(syntheticHome, ".pi", "agent", "sessions");
const projectRoot = path.join(root, "project");
const dataRoot = path.join(root, "wayang");
fs.mkdirSync(sessionsRoot, { recursive: true });
fs.mkdirSync(projectRoot);
fs.mkdirSync(dataRoot);

const standard = path.join(sessionsRoot, "standard.jsonl");
const protectedFile = path.join(sessionsRoot, "protected.jsonl");
const unknown = path.join(sessionsRoot, "unknown.jsonl");
const transcript = (id, cwd, canary) => [
  JSON.stringify({ type: "session", version: 3, id, cwd }),
  JSON.stringify({ type: "message", message: { role: "user", content: canary } }),
].join("\n") + "\n";
fs.writeFileSync(standard, transcript("standard", projectRoot, "STANDARD_AUTHORIZED_CANARY"));
fs.writeFileSync(protectedFile, transcript("protected", projectRoot, "PROTECTED_DENIED_CANARY"));
fs.writeFileSync(unknown, transcript("unknown", projectRoot, "UNKNOWN_DENIED_CANARY"));
fs.symlinkSync(sessionsRoot, path.join(projectRoot, "sessions-link"));
fs.symlinkSync(syntheticHome, path.join(projectRoot, "home-link"));

const storePath = path.join(dataRoot, "store.json");
const projectionPath = path.join(dataRoot, "project-access-policy.json");
fs.writeFileSync(storePath, "{}\n", { mode: 0o600 });
const writeProjection = () => {
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
    projects: [],
    sessions: [
      { session_id: "standard", path: fs.realpathSync.native(standard), cwd: projectRoot, dream: true },
      { session_id: "protected", path: fs.realpathSync.native(protectedFile), cwd: projectRoot, dream: false },
    ],
  };
  fs.writeFileSync(projectionPath, `${JSON.stringify(projection)}\n`, { mode: 0o600 });
  fs.chmodSync(projectionPath, 0o600);
};
writeProjection();

const bundle = path.join(root, "dreamer.cjs");
execFileSync("npx", [
  "--no-install", "esbuild", dreamerSource,
  "--bundle", "--platform=node", "--format=cjs",
  "--external:@earendil-works/*", "--external:typebox", `--outfile=${bundle}`,
], { cwd: repo, stdio: "pipe" });

process.env.HOME = syntheticHome;
process.env.PI_DREAM_SESSIONS_DIR = sessionsRoot;
process.env.PI_DREAM_STATE_FILE = path.join(root, "dreamer-state.json");
process.env.PI_DREAM_AUTHORIZATION_RUNNER = path.join(
  path.resolve(process.env.WAYANG_DIR || path.join(repo, "..", "wayang")),
  "scripts/dream-authorized-sessions.mjs",
);
process.env.WAYANG_PROJECT_POLICY_PROJECTION = projectionPath;
fs.writeFileSync(process.env.PI_DREAM_STATE_FILE, JSON.stringify({
  lastRun: new Date(0).toISOString(),
  processedSessions: {},
  skillsIndex: {},
}));

const require = createRequire(import.meta.url);
const Module = require("node:module");
const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "@earendil-works/pi-tui") {
    return { Text: class Text { constructor(text) { this.text = text; } } };
  }
  if (request === "typebox") {
    const identity = (value) => value;
    return { Type: { Object: identity, String: identity, Number: identity, Optional: identity } };
  }
  return realLoad.apply(this, arguments);
};

try {
  const dreamer = require(bundle);
  assert.deepEqual(dreamer.listAuthorizedSessionPaths(), [fs.realpathSync.native(standard)]);
  const discovered = dreamer.discoverSessions();
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].firstUserMessage, "STANDARD_AUTHORIZED_CANARY");
  assert.throws(() => dreamer.readAuthorizedSessionBytes(protectedFile), /denied read/);
  assert.throws(() => dreamer.readAuthorizedSessionBytes(unknown), /denied read/);

  const handlers = {};
  const messages = [];
  const tools = [];
  const commands = [];
  let activeTools = [
    "dream_session_read", "read", "edit", "write", "grep", "find", "ls",
    "bash", "sudo_exec", "custom_unknown_tool",
  ];
  const install = dreamer.default || dreamer;
  install({
    registerTool(definition) { tools.push(definition); },
    registerCommand(name, definition) { commands.push([name, definition]); },
    registerMessageRenderer() {},
    on(name, handler) { handlers[name] = handler; },
    sendMessage(message) { messages.push(message); },
    getActiveTools() { return activeTools; },
    setActiveTools(names) { activeTools = [...names]; },
  });
  assert.ok(tools.some((tool) => tool.name === "dream_session_read"));
  const result = await handlers.input({ text: "dream" }, {});
  assert.equal(result.action, "transform");
  assert.deepEqual(activeTools.sort(), ["dream_session_read", "edit", "read", "write"]);

  const ctx = { cwd: projectRoot };
  const direct = (toolName, target) => handlers.tool_call(
    { toolName, input: target === undefined ? {} : { path: target } },
    ctx,
  );
  assert.match((await direct("grep", path.dirname(sessionsRoot))).reason, /ancestor traversal/);
  assert.match((await direct("find", syntheticHome)).reason, /ancestor traversal/);
  assert.match((await direct("ls", path.parse(sessionsRoot).root)).reason, /ancestor traversal/);
  assert.match((await direct("read", syntheticHome)).reason, /ancestor traversal/);
  assert.match((await direct("grep", path.join(projectRoot, "sessions-link"))).reason, /ancestor traversal|direct access/);
  assert.match((await direct("write", path.join(projectRoot, "sessions-link", "new.txt"))).reason, /direct access|ancestor traversal/);
  assert.equal(await direct("find", projectRoot), undefined, "unrelated project path should remain allowed");

  fs.appendFileSync(storePath, " ");
  assert.throws(() => dreamer.listAuthorizedSessionPaths(), /denied list/);
  assert.match((await direct("find", projectRoot)).reason, /denied list/);
  await handlers.agent_end({}, {});

  const deniedHandlers = {};
  const deniedMessages = [];
  install({
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
    on(name, handler) { deniedHandlers[name] = handler; },
    sendMessage(message) { deniedMessages.push(message); },
    getActiveTools() { return ["dream_session_read", "read"]; },
    setActiveTools() {},
  });
  const deniedResult = await deniedHandlers.input({ text: "dream" }, {});
  assert.deepEqual(deniedResult, { action: "handled" });
  assert.match(deniedMessages.at(-1).content, /denied before agent launch/);

  console.log("dream companion policy ancestor-intersection tests passed");
} finally {
  Module._load = realLoad;
  fs.rmSync(root, { recursive: true, force: true });
}
