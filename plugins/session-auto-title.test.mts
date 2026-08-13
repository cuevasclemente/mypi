import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PI_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE,
  createSessionAutoTitleExtension,
  extractTitleProjection,
  normalizeTitle,
  type ExtensionTitleProvider,
} from "./session-auto-title.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(provider: ExtensionTitleProvider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-title-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const manager = SessionManager.create(cwd, path.join(root, "sessions"));
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const notifications: string[] = [];
  const pi: any = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
    appendEntry(type: string, data: unknown) { manager.appendCustomEntry(type, data); },
    getSessionName() { return manager.getSessionName(); },
    setSessionName(name: string) { manager.appendSessionInfo(name); },
  } satisfies Partial<ExtensionAPI>;
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: manager,
    modelRegistry: {},
    ui: { notify(message: string) { notifications.push(message); } },
    isIdle: () => true,
    isProjectTrusted: () => true,
    hasPendingMessages: () => false,
  };
  createSessionAutoTitleExtension({ provider })(pi as ExtensionAPI);
  async function emit(name: string, event: any): Promise<void> {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx as ExtensionContext);
  }
  function appendExchange(index: number): void {
    manager.appendMessage({ role: "user", content: `prompt ${index}`, timestamp: Date.now() } as any);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `answer ${index}` }],
      provider: "synthetic",
      model: "synthetic",
      stopReason: "stop",
      timestamp: Date.now(),
    } as any);
  }
  return {
    root,
    manager,
    ctx: ctx as ExtensionContext,
    notifications,
    emit,
    appendExchange,
    cleanup() {
      delete (globalThis as any)[Symbol.for("wayang.owned-session-managers.v1")];
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("identity-neutral TUI extension marks exact interactive turns and titles after exchange three", async () => {
  const inputs: string[] = [];
  const h = harness({
    async prepare() {
      return { dispatch: async (input) => { inputs.push(input); return "TUI session title"; } };
    },
  });
  const previous = process.env.PI_AUTO_SESSION_TITLE;
  process.env.PI_AUTO_SESSION_TITLE = "on";
  try {
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    for (let index = 1; index <= 3; index++) {
      await h.emit("input", { type: "input", source: "interactive", text: `prompt ${index}` });
      h.appendExchange(index);
      await h.emit("agent_settled", { type: "agent_settled" });
      if (index < 3) assert.equal(h.manager.getSessionName(), undefined);
    }
    await waitFor(() => h.manager.getSessionName() === "TUI session title");
    const entries = h.manager.getEntries() as any[];
    assert.equal(entries.filter((entry) => entry.customType === PI_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE).length, 3);
    assert.match(inputs[0]!, /prompt 1/);
    assert.doesNotMatch(inputs[0]!, /system|tool/i);
    const info = entries.filter((entry) => entry.type === "session_info").at(-1);
    assert.equal(info?.origin, "automatic");
    assert.match(h.notifications[0]!, /TUI session title/);
  } finally {
    if (previous === undefined) delete process.env.PI_AUTO_SESSION_TITLE;
    else process.env.PI_AUTO_SESSION_TITLE = previous;
    h.cleanup();
  }
});

test("RPC input and Wayang-owned managers never persist markers or call the provider", async () => {
  let calls = 0;
  const h = harness({ async prepare() { calls++; return { dispatch: async () => "No" }; } });
  const previous = process.env.PI_AUTO_SESSION_TITLE;
  process.env.PI_AUTO_SESSION_TITLE = "on";
  try {
    const owners = new WeakSet<object>();
    owners.add(h.manager);
    (globalThis as any)[Symbol.for("wayang.owned-session-managers.v1")] = owners;
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.emit("input", { type: "input", source: "rpc", text: "rpc prompt" });
    h.appendExchange(1);
    await h.emit("agent_settled", { type: "agent_settled" });
    assert.equal(extractTitleProjection(h.manager.getEntries()), null);
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_AUTO_SESSION_TITLE;
    else process.env.PI_AUTO_SESSION_TITLE = previous;
    h.cleanup();
  }
});

test("provider failure retries only after the next completed marked exchange", async () => {
  let calls = 0;
  const h = harness({
    async prepare() {
      return {
        dispatch: async () => {
          calls++;
          if (calls === 1) throw new Error("synthetic failure");
          return "Fourth exchange retry";
        },
      };
    },
  });
  const previous = process.env.PI_AUTO_SESSION_TITLE;
  process.env.PI_AUTO_SESSION_TITLE = "on";
  try {
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    for (let index = 1; index <= 3; index++) {
      await h.emit("input", { type: "input", source: "interactive", text: `prompt ${index}` });
      h.appendExchange(index);
      await h.emit("agent_settled", { type: "agent_settled" });
    }
    await waitFor(() => calls === 1);
    await h.emit("agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    await h.emit("input", { type: "input", source: "interactive", text: "prompt 4" });
    h.appendExchange(4);
    await h.emit("agent_settled", { type: "agent_settled" });
    await waitFor(() => h.manager.getSessionName() === "Fourth exchange retry");
    assert.equal(calls, 2);
  } finally {
    if (previous === undefined) delete process.env.PI_AUTO_SESSION_TITLE;
    else process.env.PI_AUTO_SESSION_TITLE = previous;
    h.cleanup();
  }
});

test("human naming during the provider request wins the shared CAS", async () => {
  const response = deferred<string>();
  const dispatched = deferred<void>();
  const h = harness({
    async prepare() {
      return { dispatch: () => { dispatched.resolve(); return response.promise; } };
    },
  });
  const previous = process.env.PI_AUTO_SESSION_TITLE;
  process.env.PI_AUTO_SESSION_TITLE = "on";
  try {
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    for (let index = 1; index <= 3; index++) {
      await h.emit("input", { type: "input", source: "interactive", text: `prompt ${index}` });
      h.appendExchange(index);
      await h.emit("agent_settled", { type: "agent_settled" });
    }
    await dispatched.promise;
    SessionManager.open(h.manager.getSessionFile()!, undefined, h.ctx.cwd).appendSessionInfo("Human title", { origin: "human" });
    response.resolve("Automatic title");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(SessionManager.open(h.manager.getSessionFile()!, undefined, h.ctx.cwd).getSessionName(), "Human title");
  } finally {
    if (previous === undefined) delete process.env.PI_AUTO_SESSION_TITLE;
    else process.env.PI_AUTO_SESSION_TITLE = previous;
    h.cleanup();
  }
});

test("title normalization rejects wrappers, controls, and oversized output", () => {
  assert.equal(normalizeTitle('"Plain useful title"'), "Plain useful title");
  for (const value of ["Title: bad", "# bad", "Here is the title", "two\nlines", `bad\u202e`, "x".repeat(81)]) {
    assert.equal(normalizeTitle(value), null);
  }
});
