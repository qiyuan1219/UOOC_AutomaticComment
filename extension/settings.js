export const DEFAULT_INTERVAL_SECONDS = 70;
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86_400;

export function parseInterval(value = DEFAULT_INTERVAL_SECONDS) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    throw new Error(`回复间隔应为 ${MIN_INTERVAL_SECONDS} 至 ${MAX_INTERVAL_SECONDS} 秒的整数。`);
  }
  return seconds;
}

export function countdownState(task, now = Date.now()) {
  if (!task.running) return { text: "已停止", percent: 0, indeterminate: false };
  if (task.inFlight || !task.nextRunAt) return { text: "正在发布…", percent: 0, indeterminate: true };
  const duration = (task.intervalSeconds || DEFAULT_INTERVAL_SECONDS) * 1000;
  const remaining = Math.max(0, task.nextRunAt - now);
  return {
    text: remaining ? `${Math.ceil(remaining / 1000)} 秒后发布` : "等待执行…",
    percent: Math.max(0, Math.min(100, (1 - remaining / duration) * 100)),
    indeterminate: false
  };
}
