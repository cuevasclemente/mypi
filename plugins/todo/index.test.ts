import assert from "node:assert/strict";
import test from "node:test";

import todoExtension, { TODO_LIMITS } from "./index.ts";

function todo(id: number, text: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    text,
    status: "pending",
    priority: "medium",
    dependencies: [],
    createdAt: id,
    updatedAt: id,
    ...overrides,
  };
}

function customSnapshot(id: string, text: string): any {
  return {
    type: "custom",
    id,
    parentId: null,
    customType: "todo-state",
    data: { todos: [todo(1, text)], nextId: 2 },
  };
}

function toolSnapshot(id: string, text: string, details: unknown = undefined): any {
  return {
    type: "message",
    id,
    parentId: null,
    message: {
      role: "toolResult",
      toolName: "todo",
      details: details ?? { action: "list", todos: [todo(1, text)], nextId: 2 },
      content: [{ type: "text", text: "snapshot" }],
      isError: false,
    },
  };
}

class TodoHarness {
  branch: any[] = [];
  allEntries: any[] = [];
  appended: Array<{ customType: string; data: any }> = [];
  handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  tool: any;
  commands = new Map<string, any>();
  sentUserMessages: unknown[] = [];

  readonly ui = {
    theme: { fg: (_color: string, value: string) => value },
    setWidget() {},
    setStatus() {},
    notify() {},
    custom: async () => undefined,
  };

  readonly ctx: any = {
    hasUI: false,
    ui: this.ui,
    sessionManager: {
      getBranch: () => this.branch,
      getEntries: () => this.allEntries,
    },
  };

  readonly pi: any = {
    on: (name: string, handler: (event: any, ctx: any) => unknown) => {
      const handlers = this.handlers.get(name) ?? [];
      handlers.push(handler);
      this.handlers.set(name, handlers);
    },
    registerTool: (tool: any) => {
      this.tool = tool;
    },
    registerCommand: (name: string, command: any) => this.commands.set(name, command),
    appendEntry: (customType: string, data: any) => {
      this.appended.push({ customType, data });
      const entry = {
        type: "custom",
        id: `appended-${this.appended.length}`,
        parentId: null,
        customType,
        data,
      };
      this.branch.push(entry);
      if (this.allEntries !== this.branch) this.allEntries.push(entry);
    },
    sendUserMessage: (message: unknown) => this.sentUserMessages.push(message),
  };

  constructor() {
    todoExtension(this.pi);
  }

  setBranch(branch: any[], allEntries: any[] = branch): void {
    this.branch = branch;
    this.allEntries = allEntries;
  }

  async emit(name: string, event: any = {}): Promise<unknown[]> {
    const values = [];
    for (const handler of this.handlers.get(name) ?? []) values.push(await handler(event, this.ctx));
    return values;
  }

  async execute(params: any): Promise<any> {
    return this.tool.execute("call", params, new AbortController().signal, undefined, this.ctx);
  }

  async list(): Promise<any> {
    return this.execute({ action: "list" });
  }
}

test("two extension instances never share in-memory todos", async () => {
  const first = new TodoHarness();
  const second = new TodoHarness();
  await first.emit("session_start");
  await second.emit("session_start");

  await first.execute({ action: "add", text: "first-session-only" });

  assert.equal((await first.list()).details.todos[0].text, "first-session-only");
  assert.deepEqual((await second.list()).details.todos, []);
});

test("session_tree restores only the selected branch", async () => {
  const harness = new TodoHarness();
  const abandoned = customSnapshot("abandoned", "abandoned-task");
  const current = customSnapshot("current", "current-task");
  harness.setBranch([abandoned], [abandoned, current]);
  await harness.emit("session_start");
  assert.equal((await harness.list()).details.todos[0].text, "abandoned-task");

  harness.setBranch([current], [abandoned, current]);
  await harness.emit("session_tree", { oldLeafId: "abandoned", newLeafId: "current" });

  assert.deepEqual((await harness.list()).details.todos.map((item: any) => item.text), ["current-task"]);
});

test("newest valid current-branch custom or tool snapshot wins", async () => {
  const harness = new TodoHarness();
  const invalidNewest = toolSnapshot("bad", "ignored", {
    action: "list",
    todos: [{ ...todo(2, "bad"), dependencies: [1, 1] }],
    nextId: 3,
  });
  harness.setBranch([
    customSnapshot("custom", "custom-old"),
    toolSnapshot("tool", "tool-new"),
    invalidNewest,
  ]);
  await harness.emit("session_start");

  assert.equal((await harness.list()).details.todos[0].text, "tool-new");

  const customNewest = customSnapshot("custom-new", "custom-newest");
  harness.setBranch([toolSnapshot("tool-old", "tool-old"), customNewest]);
  await harness.emit("session_tree");
  assert.equal((await harness.list()).details.todos[0].text, "custom-newest");

  harness.setBranch([
    toolSnapshot("older-nonempty", "must-not-return"),
    { type: "custom", id: "newest-empty", customType: "todo-state", data: { todos: [], nextId: 1 } },
  ]);
  await harness.emit("session_tree");
  assert.deepEqual((await harness.list()).details.todos, []);
});

test("hook preseeds are isolated to the current branch and only apply after its snapshot", async () => {
  const harness = new TodoHarness();
  const snapshot = customSnapshot("snapshot", "kept");
  const oldPreseed = {
    type: "custom",
    id: "old-preseed",
    customType: "todo-preseed",
    data: { hook: "old-hook", todos: [{ text: "must-not-resurrect" }] },
  };
  const currentPreseed = {
    type: "custom",
    id: "current-preseed",
    customType: "todo-preseed",
    data: { hook: "current-hook", todos: [{ text: "current-preseed" }] },
  };
  const abandonedPreseed = {
    type: "custom",
    id: "abandoned-preseed",
    customType: "todo-preseed",
    data: { hook: "abandoned-hook", todos: [{ text: "abandoned-preseed" }] },
  };
  harness.setBranch([oldPreseed, snapshot], [oldPreseed, snapshot, currentPreseed, abandonedPreseed]);
  await harness.emit("session_start");

  // Simulate a hook whose session_start handler runs after the TODO handler.
  harness.branch.push(currentPreseed);
  await harness.emit("before_agent_start", { systemPrompt: "base" });

  const listed = await harness.list();
  assert.deepEqual(
    listed.details.todos.map((item: any) => item.text).sort(),
    ["current-preseed", "kept"],
  );
  assert.equal(listed.details.todos.find((item: any) => item.text === "current-preseed").assignee, "current-hook");
});

test("legacy custom and tool snapshots derive nextId and turn_end writes canonical optionals", async () => {
  const variants = [
    {
      type: "custom",
      id: "legacy-custom",
      parentId: null,
      customType: "todo-state",
      data: {
        todos: [todo(4, "legacy custom", { assignee: "", notes: null, rank: null })],
      },
    },
    toolSnapshot("legacy-tool", "ignored", {
      action: "list",
      todos: [todo(7, "legacy tool", { assignee: null, notes: "", rank: null })],
    }),
  ];

  for (const [index, entry] of variants.entries()) {
    const harness = new TodoHarness();
    harness.setBranch([entry]);
    await harness.emit("session_start");

    const listed = await harness.list();
    assert.equal(listed.details.nextId, index === 0 ? 5 : 8);
    assert.equal(Object.hasOwn(listed.details.todos[0], "assignee"), false);
    assert.equal(Object.hasOwn(listed.details.todos[0], "notes"), false);
    assert.equal(Object.hasOwn(listed.details.todos[0], "rank"), false);

    await harness.emit("turn_end", { turnIndex: 1 });
    const canonical = harness.appended.at(-1)!.data;
    assert.equal(canonical.nextId, index === 0 ? 5 : 8);
    assert.equal(Object.hasOwn(canonical.todos[0], "assignee"), false);
    assert.equal(Object.hasOwn(canonical.todos[0], "notes"), false);
    assert.equal(Object.hasOwn(canonical.todos[0], "rank"), false);
  }
});

test("session_tree clears stale todos when the selected branch has no snapshot", async () => {
  const harness = new TodoHarness();
  harness.setBranch([customSnapshot("stateful", "must-disappear")]);
  await harness.emit("session_start");
  assert.equal((await harness.list()).details.todos.length, 1);

  harness.setBranch([
    {
      type: "message",
      id: "snapshot-free-leaf",
      parentId: null,
      message: { role: "user", content: "new branch", timestamp: 1 },
    },
  ]);
  await harness.emit("session_tree", { oldLeafId: "stateful", newLeafId: "snapshot-free-leaf" });

  const listed = await harness.list();
  assert.deepEqual(listed.details.todos, []);
  assert.equal(listed.details.nextId, 1);
});

test("invalid protocol input throws and an invalid batch is atomic", async () => {
  const harness = new TodoHarness();
  await harness.emit("session_start");
  await assert.rejects(harness.execute({ action: "add" }), /'text'/);
  await assert.rejects(
    harness.execute({ action: "add", text: "x".repeat(TODO_LIMITS.maxTextBytes + 1) }),
    /exceeds/,
  );
  await assert.rejects(
    harness.execute({
      action: "add",
      text: "deps",
      dependencies: Array.from({ length: TODO_LIMITS.maxDependencies + 1 }, (_, index) => index + 1),
    }),
    /dependencies.*exceeds/,
  );
  await assert.rejects(
    harness.execute({
      action: "batch",
      items: [
        { action: "add", text: "would-have-been-added" },
        { action: "toggle", id: 999 },
      ],
    }),
    /not found/,
  );
  assert.deepEqual((await harness.list()).details.todos, []);
});

test("count, aggregate state, and tool output remain bounded", async () => {
  const harness = new TodoHarness();
  const full = Array.from({ length: TODO_LIMITS.maxTodos }, (_, index) => todo(index + 1, `todo-${index + 1}`));
  harness.setBranch([
    {
      type: "custom",
      id: "full",
      customType: "todo-state",
      data: { todos: full, nextId: TODO_LIMITS.maxTodos + 1 },
    },
  ]);
  await harness.emit("session_start");
  await assert.rejects(harness.execute({ action: "add", text: "one-too-many" }), /cannot exceed/);

  const listed = await harness.list();
  assert.equal(listed.details.todos.length, TODO_LIMITS.maxTodos);
  assert.ok(Buffer.byteLength(JSON.stringify(listed.details), "utf8") < 48 * 1024);
  assert.ok(Buffer.byteLength(listed.content[0].text, "utf8") < 48 * 1024);

  const outputHarness = new TodoHarness();
  await outputHarness.emit("session_start");
  const noisyItems = Array.from({ length: TODO_LIMITS.maxBatchItems / 2 }, (_, index) => [
    { action: "add", text: `${index}-` + "x".repeat(TODO_LIMITS.maxTextBytes - String(index).length - 1) },
    { action: "delete", id: index + 1 },
  ]).flat();
  const noisyResult = await outputHarness.execute({ action: "batch", items: noisyItems });
  assert.match(noisyResult.content[0].text, /output truncated/);
  assert.ok(Buffer.byteLength(noisyResult.content[0].text, "utf8") < 48 * 1024);

  const oversizedField = customSnapshot("oversized-field", "x");
  oversizedField.data.todos[0].notes = "n".repeat(TODO_LIMITS.maxNotesBytes + 1);
  harness.setBranch([customSnapshot("fallback", "valid-fallback"), oversizedField]);
  await harness.emit("session_tree");
  assert.equal((await harness.list()).details.todos[0].text, "valid-fallback");

  const oversizedAggregate = {
    type: "custom",
    id: "oversized-aggregate",
    customType: "todo-state",
    data: {
      todos: Array.from({ length: 6 }, (_, index) =>
        todo(index + 1, `large-${index}`, { notes: "n".repeat(TODO_LIMITS.maxNotesBytes) }),
      ),
      nextId: 7,
    },
  };
  harness.setBranch([customSnapshot("aggregate-fallback", "aggregate-fallback"), oversizedAggregate]);
  await harness.emit("session_tree");
  assert.equal((await harness.list()).details.todos[0].text, "aggregate-fallback");

  const invalidRank = customSnapshot("invalid-rank", "invalid-rank");
  invalidRank.data.todos[0].rank = TODO_LIMITS.maxTodos;
  harness.setBranch([customSnapshot("rank-fallback", "rank-fallback"), invalidRank]);
  await harness.emit("session_tree");
  assert.equal((await harness.list()).details.todos[0].text, "rank-fallback");
});

test("explicit reorder is returned, rendered, persisted, and restored while rankless state keeps default sorting", async () => {
  const rankless = new TodoHarness();
  rankless.setBranch([
    {
      type: "custom",
      id: "rankless",
      customType: "todo-state",
      data: {
        todos: [
          todo(1, "pending low", { priority: "low" }),
          todo(2, "in progress", { status: "in_progress", priority: "low" }),
          todo(3, "pending critical", { priority: "critical" }),
        ],
        nextId: 4,
      },
    },
  ]);
  await rankless.emit("session_start");
  assert.deepEqual((await rankless.list()).details.todos.map((item: any) => item.id), [2, 3, 1]);

  const harness = new TodoHarness();
  harness.setBranch([
    {
      type: "custom",
      id: "before-reorder",
      customType: "todo-state",
      data: {
        todos: [
          todo(1, "normally first", { status: "in_progress", priority: "critical" }),
          todo(2, "explicitly first", { status: "done", priority: "low" }),
        ],
        nextId: 3,
      },
    },
  ]);
  await harness.emit("session_start");

  const reordered = await harness.execute({ action: "reorder", order: [2, 1] });
  assert.deepEqual(reordered.details.todos.map((item: any) => item.id), [2, 1]);
  assert.deepEqual(reordered.details.todos.map((item: any) => item.rank), [0, 1]);

  const theme = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  } as any;
  const rendered = harness.tool.renderResult(reordered, { expanded: true }, theme).render(200).join("\n");
  assert.ok(rendered.indexOf("#2") < rendered.indexOf("#1"));

  await harness.emit("turn_end", { turnIndex: 1 });
  const persisted = harness.appended.at(-1)!.data;
  assert.deepEqual(persisted.todos.map((item: any) => [item.id, item.rank]), [
    [2, 0],
    [1, 1],
  ]);

  const restored = new TodoHarness();
  restored.setBranch([
    { type: "custom", id: "persisted-reorder", customType: "todo-state", data: persisted },
  ]);
  await restored.emit("session_start");
  const restoredList = await restored.list();
  assert.deepEqual(restoredList.details.todos.map((item: any) => item.id), [2, 1]);
  const restoredRendered = restored.tool
    .renderResult(restoredList, { expanded: true }, theme)
    .render(200)
    .join("\n");
  assert.ok(restoredRendered.indexOf("#2") < restoredRendered.indexOf("#1"));
});

test("todos-full persists manager mutations as soon as the manager closes", async () => {
  const harness = new TodoHarness();
  harness.setBranch([customSnapshot("manager-state", "toggle in manager")]);
  await harness.emit("session_start");
  harness.ctx.hasUI = true;

  (harness.ui as any).custom = async (factory: any) => {
    const theme = {
      fg: (_color: string, value: string) => value,
      bold: (value: string) => value,
    };
    const component = factory({ requestRender() {} }, theme, {}, () => undefined);
    component.handleInput(" ");
    component.handleInput("\u001b");
  };

  await harness.commands.get("todos-full").handler("", harness.ctx);

  assert.equal(harness.appended.length, 1);
  assert.equal(harness.appended[0].customType, "todo-state");
  assert.equal(harness.appended[0].data.todos[0].status, "done");
});

test("restored, returned, and persisted snapshots are immutable defensive copies", async () => {
  const harness = new TodoHarness();
  const source = customSnapshot("source", "source-text");
  source.data.todos[0].dependencies = [7];
  harness.setBranch([source]);
  await harness.emit("session_start");

  source.data.todos[0].text = "mutated-source";
  source.data.todos[0].dependencies.push(8);
  const first = await harness.list();
  assert.equal(first.details.todos[0].text, "source-text");
  assert.deepEqual(first.details.todos[0].dependencies, [7]);

  first.details.todos[0].text = "mutated-result";
  first.details.todos[0].dependencies.push(9);
  const second = await harness.list();
  assert.equal(second.details.todos[0].text, "source-text");
  assert.deepEqual(second.details.todos[0].dependencies, [7]);

  await harness.emit("turn_end", { turnIndex: 1 });
  const persisted = harness.appended.at(-1)!.data;
  persisted.todos[0].text = "mutated-persisted";
  persisted.todos[0].dependencies.push(10);
  const third = await harness.list();
  assert.equal(third.details.todos[0].text, "source-text");
  assert.deepEqual(third.details.todos[0].dependencies, [7]);
});
