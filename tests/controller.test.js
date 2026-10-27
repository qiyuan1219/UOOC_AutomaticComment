import test from "node:test";
import assert from "node:assert/strict";
import { ReplyController, ALARM_NAME, INTERVAL_MS } from "../extension/controller.js";

function fixture() {
  let now = 1_000_000;
  let task;
  let alarm;
  let fail;
  let clearEditor = true;
  const actions = [];
  const target = { id: 7, url: "https://course.example/thread/12", title: "示例课程", status: "complete" };
  const api = {
    storage: { local: {
      get: async () => ({ task: task && structuredClone(task) }),
      set: async (value) => { task = structuredClone(value.task); }
    } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { get: async () => ({ ...target }) },
    alarms: {
      create: async (name, data) => { assert.equal(name, ALARM_NAME); alarm = data; },
      clear: async () => { alarm = undefined; }, get: async () => alarm
    },
    scripting: { executeScript: async ({ args: [action] }) => {
      actions.push(action);
      if (fail === action) return [{ frameId: 0, result: { ok: false, error: "simulated failure" } }];
      if (action === "probe") return [{ frameId: 0, result: { ok: true, binding: {}, draft: "" } }];
      return [{ frameId: 0, result: { ok: true, cleared: clearEditor } }];
    } }
  };
  const controller = new ReplyController(api, () => {}, { now: () => now, sleep: async (ms) => { now += ms; } });
  return {
    api, controller, actions, target,
    set now(value) { now = value; }, get now() { return now; },
    get alarm() { return alarm; }, get task() { return task; },
    set fail(value) { fail = value; }, set clearEditor(value) { clearEditor = value; }
  };
}
const start = (f, config = {}) => f.controller.start(7, { text: "示例讨论回复内容", ...config });

test("probe is read-only and creates no alarm", async () => {
  const f = fixture();
  await f.controller.probe(7, {});
  assert.deepEqual(f.actions, ["probe"]);
  assert.equal(f.alarm, undefined);
});
test("start clicks immediately; subsequent replies wait 70 seconds", async () => {
  const f = fixture();
  const startedAt = f.now;
  await start(f);
  assert.deepEqual(f.actions, ["probe", "prepare", "submit", "verify"]);
  assert.equal(f.task.clicks, 1);
  assert.equal(f.task.lastClickAt, startedAt, "first click does not wait for an alarm");
  assert.equal(f.alarm.when, startedAt + INTERVAL_MS);
  await f.controller.tick();
  assert.equal(f.task.clicks, 1);
  f.now = f.task.nextRunAt;
  await f.controller.tick();
  assert.equal(f.task.clicks, 2);
  assert.equal(f.alarm.when, f.task.lastClickAt + INTERVAL_MS);
});
test("a delayed alarm sends once without catching up", async () => {
  const f = fixture(); await start(f); f.now += INTERVAL_MS * 10;
  await f.controller.tick();
  assert.equal(f.actions.filter((a) => a === "submit").length, 2);
  await f.controller.tick();
  assert.equal(f.task.clicks, 2);
});
test("double start and overlapping alarms do not create duplicate clicks", async () => {
  const f = fixture(); await start(f);
  await assert.rejects(start(f), /已有任务/);
  f.now += INTERVAL_MS;
  await Promise.all([f.controller.tick(), f.controller.tick()]);
  assert.equal(f.actions.filter((a) => a === "submit").length, 2);
});
test("stop cancels before the next alarm", async () => {
  const f = fixture(); await start(f); await f.controller.stop();
  f.now += INTERVAL_MS; await f.controller.tick();
  assert.deepEqual(f.actions, ["probe", "prepare", "submit", "verify"]);
  assert.equal(f.alarm, undefined);
  assert.equal(f.task.running, false);
});
test("stop received during the immediate first preparation prevents the click", async () => {
  const f = fixture();
  let release, arrived;
  const reachedPrepare = new Promise((resolve) => { arrived = resolve; });
  const continuePrepare = new Promise((resolve) => { release = resolve; });
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async (args) => {
    if (args.args[0] === "prepare") { arrived(); await continuePrepare; }
    return execute(args);
  };
  const starting = start(f); await reachedPrepare;
  const stop = f.controller.stop(); release(); await Promise.all([starting, stop]);
  assert.equal(f.actions.includes("submit"), false);
  assert.equal(f.task.running, false);
});
test("page navigation stops before filling or publishing", async () => {
  const f = fixture(); await start(f);
  f.target.url = "https://course.example/thread/other";
  f.now += INTERVAL_MS; await f.controller.tick();
  assert.deepEqual(f.actions, ["probe", "prepare", "submit", "verify"]);
  assert.equal(f.task.running, false);
  assert.match(f.task.message, /地址已变化/);
});
test("failed preparation never clicks and pauses the task", async () => {
  const f = fixture(); f.fail = "prepare"; await start(f);
  await f.controller.tick();
  assert.equal(f.actions.includes("submit"), false);
  assert.equal(f.task.running, false);
});
test("uncertain result pauses without retrying", async () => {
  const f = fixture(); f.clearEditor = false; await start(f);
  await f.controller.tick();
  assert.equal(f.task.clicks, 1);
  assert.equal(f.task.running, false);
  assert.match(f.task.message, /8 秒/);
  assert.equal(f.actions.filter((a) => a === "submit").length, 1);
});
test("a limit of one sends immediately and stops without creating an alarm", async () => {
  const f = fixture(); await start(f, { maxReplies: 1 });
  await f.controller.tick();
  assert.equal(f.task.clicks, 1);
  assert.equal(f.task.running, false);
  assert.equal(f.alarm, undefined);
});
test("fresh worker restores a missing alarm from persisted state", async () => {
  const f = fixture(); await start(f); await f.api.alarms.clear(ALARM_NAME);
  const restored = new ReplyController(f.api, () => {}, { now: () => f.now });
  await restored.recover();
  assert.equal(f.alarm.when, f.task.nextRunAt);
  assert.deepEqual(f.actions, ["probe", "prepare", "submit", "verify"]);
});
test("fresh worker pauses an interrupted submission instead of repeating it", async () => {
  const f = fixture(); await start(f);
  await f.api.storage.local.set({ task: { ...f.task, inFlight: true } });
  const restored = new ReplyController(f.api, () => {}, { now: () => f.now });
  await restored.recover();
  assert.equal(f.task.running, false);
  assert.match(f.task.message, /发布结果不确定/);
});

test("custom interval persists and controls subsequent replies after a worker restart", async () => {
  const f = fixture();
  await start(f, { intervalSeconds: 125 });
  assert.equal(f.task.intervalSeconds, 125);
  assert.equal(f.alarm.when, f.task.lastClickAt + 125_000);
  await f.api.alarms.clear(ALARM_NAME);
  const restored = new ReplyController(f.api, () => {}, { now: () => f.now, sleep: async () => {} });
  await restored.recover();
  f.now = f.task.nextRunAt - 1;
  await restored.tick();
  assert.equal(f.task.clicks, 1);
  f.now++;
  await restored.tick();
  assert.equal(f.task.clicks, 2);
  assert.equal(f.alarm.when, f.task.lastClickAt + 125_000);
});

test("invalid intervals are rejected before probing or sending the immediate first reply", async () => {
  for (const intervalSeconds of [0, 29, 30.5, 86401, "", "abc", null]) {
    const f = fixture();
    await assert.rejects(start(f, { intervalSeconds }), /回复间隔/);
    assert.deepEqual(f.actions, []);
    assert.equal(f.alarm, undefined);
  }
});

test("minimum and maximum intervals are accepted", async () => {
  for (const intervalSeconds of [30, 86400]) {
    const f = fixture();
    await start(f, { intervalSeconds });
    assert.equal(f.task.clicks, 1);
    assert.equal(f.alarm.when, f.task.lastClickAt + intervalSeconds * 1000);
  }
});

test("legacy running tasks without an interval keep the 70-second default", async () => {
  const f = fixture(); await start(f);
  const { intervalSeconds, ...legacy } = f.task;
  await f.api.storage.local.set({ task: legacy });
  f.now = legacy.nextRunAt;
  await f.controller.tick();
  assert.equal(f.task.intervalSeconds, 70);
  assert.equal(f.alarm.when, f.task.lastClickAt + INTERVAL_MS);
});
