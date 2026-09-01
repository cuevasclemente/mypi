const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..");
const source = path.join(repo, "plugins", "wayang-apps.ts");
const bundle = path.join(os.tmpdir(), `wayang-apps-source-auth-${process.pid}.cjs`);

execFileSync("npx", [
  "--no-install",
  "esbuild",
  source,
  "--bundle",
  "--platform=node",
  "--external:@earendil-works/*",
  "--external:typebox",
  `--outfile=${bundle}`,
], { cwd: repo, stdio: "pipe" });

const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "typebox") {
    const schema = () => ({});
    return { Type: { Any: schema, Boolean: schema, Object: schema, Optional: (value) => value, String: schema } };
  }
  return realLoad.apply(this, arguments);
};
const extensionModule = require(bundle);
Module._load = realLoad;
const install = extensionModule.default || extensionModule;

test.after(() => {
  fs.rmSync(bundle, { force: true });
});

test("Wayang Apps plugin sends the exact Pi session capability and fails closed without it", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousBridge = globalThis.__wayang_apps_agent_capabilities;
  const previousUrl = process.env.WAYANG_URL;
  const previousLegacy = process.env.WAYANG_APPS_AGENT_TOKEN;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousBridge === undefined) delete globalThis.__wayang_apps_agent_capabilities;
    else globalThis.__wayang_apps_agent_capabilities = previousBridge;
    if (previousUrl === undefined) delete process.env.WAYANG_URL;
    else process.env.WAYANG_URL = previousUrl;
    if (previousLegacy === undefined) delete process.env.WAYANG_APPS_AGENT_TOKEN;
    else process.env.WAYANG_APPS_AGENT_TOKEN = previousLegacy;
  });

  const tools = new Map();
  install({ registerTool(tool) { tools.set(tool.name, tool); } });
  const listApps = tools.get("list_apps");
  assert.ok(listApps);

  process.env.WAYANG_URL = "http://127.0.0.1:18787";
  process.env.WAYANG_APPS_AGENT_TOKEN = "legacy-process-token-must-not-be-used";
  let requestedPiSession;
  let captured;
  globalThis.__wayang_apps_agent_capabilities = {
    forPiSession(piSessionId) {
      requestedPiSession = piSessionId;
      return { sourceSessionId: "synthetic-wayang-source", token: "synthetic-scoped-token" };
    },
  };
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  const ctx = {
    cwd: "/tmp/synthetic-project",
    sessionManager: { getSessionId() { return "synthetic-pi-session"; } },
  };
  const success = await listApps.execute("tool-call", {}, undefined, undefined, ctx);
  assert.match(success.content[0].text, /Found 0 app/);
  assert.equal(requestedPiSession, "synthetic-pi-session");
  assert.match(captured.url, /project_cwd=%2Ftmp%2Fsynthetic-project/);
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get("x-wayang-apps-actor"), "agent");
  assert.equal(headers.get("x-wayang-apps-agent-token"), "synthetic-scoped-token");
  assert.equal(headers.get("x-wayang-source-session-id"), "synthetic-wayang-source");
  assert.notEqual(headers.get("x-wayang-apps-agent-token"), process.env.WAYANG_APPS_AGENT_TOKEN);
  assert.equal(headers.has("origin"), false);

  delete globalThis.__wayang_apps_agent_capabilities;
  let fetchedWithoutCapability = false;
  globalThis.fetch = async () => {
    fetchedWithoutCapability = true;
    throw new Error("fetch must not run without a source-session capability");
  };
  const denied = await listApps.execute("tool-call", {}, undefined, undefined, ctx);
  assert.match(denied.content[0].text, /did not provide session-attributed Apps authorization/);
  assert.equal(fetchedWithoutCapability, false);
});
