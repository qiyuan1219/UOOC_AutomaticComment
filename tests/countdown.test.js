import test from "node:test";
import assert from "node:assert/strict";
import { countdownState } from "../extension/settings.js";

test("countdown and progress restore from the stored deadline", () => {
  const task = { running: true, intervalSeconds: 120, nextRunAt: 200_000 };
  const half = countdownState(task, 140_000);
  assert.equal(half.text, "60 秒后发布");
  assert.equal(half.percent, 50);
  assert.equal(countdownState(task, 170_000).percent, 75);
});

test("overdue alarms wait at 100 percent and never show negative countdowns", () => {
  const view = countdownState({ running: true, intervalSeconds: 30, nextRunAt: 10_000 }, 11_000);
  assert.equal(view.text, "等待执行…");
  assert.equal(view.percent, 100);
});

test("submitting uses indeterminate progress and stopping resets it", () => {
  assert.equal(countdownState({ running: true, inFlight: true, nextRunAt: null }).indeterminate, true);
  assert.equal(countdownState({ running: false, nextRunAt: 999_999 }).percent, 0);
  assert.equal(countdownState({ running: false }).text, "已停止");
});
