import assert from "node:assert/strict";
import test from "node:test";
import browserControl from "../plugins/browser-control.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function loadTools() {
  const tools = new Map<string, any>();
  browserControl({
    on() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
  } as any);
  return tools;
}

function state(controlMode: "agent" | "user" = "agent") {
  return { status: "running", controlMode, needsUser: controlMode !== "agent", activeUrl: "https://example.test/", activeTitle: "Example" };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function context() {
  return { cwd: "/must/not/be/serialized", sessionManager: { getSessionId: () => "pi-session" } };
}

function installCapabilityBridge() {
  let calls = 0;
  (globalThis as any).__wayang_browser_agent_capabilities = {
    forPiSession(piSessionId: string) {
      calls += 1;
      assert.equal(piSessionId, "pi-session");
      return { sourceSessionId: `source-${calls}`, token: `opaque-token-${calls}` };
    },
  };
  return () => calls;
}

function assertNoRoutingAuthority(request: CapturedRequest): void {
  const serialized = JSON.stringify(request);
  for (const forbidden of ["projectCwd", "project_cwd", "persistence", "scope", "agentProfileId", "projectId", "/must/not/be/serialized"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
}

test("every browser tool schema removes projectCwd and every request uses the dedicated agent route", async (t) => {
  const tools = loadTools();
  assert.ok(tools.size >= 15);
  for (const tool of tools.values()) {
    assert.equal(JSON.stringify(tool.parameters).includes("projectCwd"), false, tool.name);
  }

  const capabilityCalls = installCapabilityBridge();
  const requests: CapturedRequest[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      method: String(init?.method),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    requests.push(request);
    return response(state());
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    delete (globalThis as any).__wayang_browser_agent_capabilities;
  });

  await tools.get("browser_status").execute("call", {}, undefined, undefined, context());
  assert.equal(capabilityCalls(), 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:8787/api/browser/agent/status");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, {});
  assert.equal(requests[0].headers["X-Wayang-Browser-Agent-Token"], "opaque-token-1");
  assert.equal(requests[0].headers["X-Wayang-Source-Session-Id"], "source-1");
  assertNoRoutingAuthority(requests[0]);
});

test("browser_open captures one capability for start and navigate and never attaches to a replacement", async (t) => {
  const tools = loadTools();
  const capabilityCalls = installCapabilityBridge();
  const requests: CapturedRequest[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: String(init?.method),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return response(state());
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    delete (globalThis as any).__wayang_browser_agent_capabilities;
  });

  const result = await tools.get("browser_open").execute("call", { url: "https://example.test" }, undefined, undefined, context());
  assert.equal(capabilityCalls(), 1);
  assert.deepEqual(requests.map((request) => request.url), [
    "http://127.0.0.1:8787/api/browser/agent/start",
    "http://127.0.0.1:8787/api/browser/agent/navigate",
  ]);
  assert.deepEqual(requests.map((request) => request.body), [{}, { url: "https://example.test" }]);
  assert.deepEqual(requests.map((request) => request.headers["X-Wayang-Browser-Agent-Token"]), ["opaque-token-1", "opaque-token-1"]);
  assert.deepEqual(requests.map((request) => request.headers["X-Wayang-Source-Session-Id"]), ["source-1", "source-1"]);
  requests.forEach(assertNoRoutingAuthority);
  assert.equal(JSON.stringify(result).includes("opaque-token"), false);
  assert.equal(JSON.stringify(result).includes("source-1"), false);
});

test("browser_wait_for_user polls only its exact handoff ID with the same lease", async (t) => {
  const tools = loadTools();
  const capabilityCalls = installCapabilityBridge();
  const requests: CapturedRequest[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured: CapturedRequest = {
      url: String(input),
      method: String(init?.method),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    requests.push(captured);
    if (captured.url.endsWith("/handoff")) {
      return response({ handoff: { handoffId: "exact-handoff-id", status: "pending", reason: "Synthetic login", createdAt: 1, expiresAt: Date.now() + 10_000 }, state: state("user") });
    }
    return response({ handoff: { handoffId: "exact-handoff-id", status: "completed", reason: "Synthetic login", createdAt: 1, expiresAt: Date.now() + 10_000, terminalAt: 2 }, state: state("agent") });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    delete (globalThis as any).__wayang_browser_agent_capabilities;
  });

  const result = await tools.get("browser_wait_for_user").execute("call", { reason: "Synthetic login", timeoutMs: 2_000 }, undefined, undefined, context());
  assert.equal(capabilityCalls(), 1);
  assert.deepEqual(requests.map((request) => request.url), [
    "http://127.0.0.1:8787/api/browser/agent/handoff",
    "http://127.0.0.1:8787/api/browser/agent/handoff-status",
  ]);
  assert.deepEqual(requests[0].body, { reason: "Synthetic login", timeoutMs: 2_000 });
  assert.deepEqual(requests[1].body, { handoffId: "exact-handoff-id" });
  assert.deepEqual(requests.map((request) => request.headers["X-Wayang-Browser-Agent-Token"]), ["opaque-token-1", "opaque-token-1"]);
  assert.equal(result.details.resumed, true);
  assert.equal(JSON.stringify(result).includes("opaque-token"), false);
});

test("browser_resume_status uses exact current/last handoff state instead of control timestamps", async (t) => {
  const tools = loadTools();
  installCapabilityBridge();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({
    handoff: {
      active: null,
      lastTerminal: { handoffId: "done", status: "completed", reason: "Synthetic", createdAt: 1, expiresAt: 2, terminalAt: 2 },
    },
    state: state("agent"),
  })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    delete (globalThis as any).__wayang_browser_agent_capabilities;
  });

  const result = await tools.get("browser_resume_status").execute("call", {}, undefined, undefined, context());
  assert.equal(result.details.resumed, true);
  assert.equal(result.content[0].text.includes("handoff=completed"), true);
});
