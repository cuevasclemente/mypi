import assert from "node:assert/strict";
import test from "node:test";
import agentTeamsExtension from "./index.js";
import { TEAM_GOALS_ENTRY_TYPE, type Goal } from "./goals.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

type EventHandler = (event: any, ctx: any) => Promise<any> | any;

const goal = (id: string, description: string): Goal => ({
  id,
  description,
  completed: false,
  createdAt: 1,
});

const snapshot = (goals: Goal[]) => ({
  type: "custom",
  customType: TEAM_GOALS_ENTRY_TYPE,
  data: { goals },
});

function extensionHarness() {
  const handlers = new Map<string, EventHandler[]>();
  const tools = new Map<string, RegisteredTool>();
  const appended: Array<{ customType: string; data: any }> = [];
  const pi = {
    appendEntry(customType: string, data: any) {
      appended.push({ customType, data });
    },
    getActiveTools: () => [],
    on(event: string, handler: EventHandler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerTool(definition: RegisteredTool) {
      tools.set(definition.name, definition);
    },
    setActiveTools() {},
  };

  agentTeamsExtension(pi as any);
  return { appended, handlers, tools };
}

test("session_tree listener restores goals from the navigated branch", async () => {
  const { handlers, tools } = extensionHarness();
  const treeHandlers = handlers.get("session_tree") ?? [];
  assert.equal(treeHandlers.length, 1);

  let branch = [snapshot([goal("goal-1", "left")])];
  const ctx = { sessionManager: { getBranch: () => branch } };
  await treeHandlers[0]({}, ctx);

  const list = tools.get("goals_list");
  assert.ok(list);
  let result = await list.execute("call-1", { all: true });
  assert.deepEqual(result.details.goals.map((item: Goal) => item.description), ["left"]);

  branch = [snapshot([goal("goal-9", "right")])];
  await treeHandlers[0]({}, ctx);
  result = await list.execute("call-2", { all: true });
  assert.deepEqual(result.details.goals.map((item: Goal) => item.description), ["right"]);
});

test("goal tools append and return immutable copies while filling ID gaps safely", async () => {
  const { appended, handlers, tools } = extensionHarness();
  const treeHandler = (handlers.get("session_tree") ?? [])[0];
  assert.ok(treeHandler);

  const branch = [snapshot([
    goal("goal-1", "one"),
    goal("goal-3", "three"),
  ])];
  await treeHandler({}, { sessionManager: { getBranch: () => branch } });

  const add = tools.get("goals_add");
  assert.ok(add);
  const first = await add.execute("call-1", { description: "two" });
  const second = await add.execute("call-2", { description: "four" });

  assert.equal(first.details.goal.id, "goal-2");
  assert.equal(second.details.goal.id, "goal-4");
  assert.ok(Object.isFrozen(first.details.goal));
  assert.equal(appended.length, 2);
  assert.ok(Object.isFrozen(appended[0].data));
  assert.ok(Object.isFrozen(appended[0].data.goals));
  assert.ok(Object.isFrozen(appended[0].data.goals[0]));
  assert.notEqual(appended[0].data.goals[0], branch[0].data.goals[0]);
  assert.notEqual(first.details.goal, appended[0].data.goals[2]);
  assert.throws(() => { first.details.goal.description = "mutated"; }, TypeError);
  assert.throws(() => { appended[0].data.goals[0].description = "mutated"; }, TypeError);

  const ids = appended[1].data.goals.map((item: Goal) => item.id);
  assert.deepEqual(ids, ["goal-1", "goal-3", "goal-2", "goal-4"]);
  assert.equal(new Set(ids).size, ids.length);
});
