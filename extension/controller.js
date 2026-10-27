import { DEFAULT_INTERVAL_SECONDS, parseInterval } from "./settings.js";

// Keep the alarm name stable so updates can clear alarms from earlier versions.
export const ALARM_NAME = "course-reply-70s";
export const INTERVAL_MS = DEFAULT_INTERVAL_SECONDS * 1000;
export const DEFAULT_TEXT = "这是一条课程讨论的示例回复";
export const DEFAULT_STATE = { running: false, clicks: 0, intervalSeconds: DEFAULT_INTERVAL_SECONDS, nextRunAt: null, logs: [], message: "打开课程帖子，检测后开始。" };

export class ReplyController {
  constructor(api, agent, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.api = api;
    this.agent = agent;
    this.now = now;
    this.sleep = sleep;
    this.queue = Promise.resolve();
    this.generation = 0;
  }
  enqueue(job) {
    const result = this.queue.then(job);
    this.queue = result.catch(() => {});
    return result;
  }
  async state() { return { ...DEFAULT_STATE, ...(await this.api.storage.local.get("task")).task }; }
  async save(state) {
    await this.api.storage.local.set({ task: state });
    await this.api.action.setBadgeText({ text: state.running ? "ON" : "" });
    await this.api.action.setBadgeBackgroundColor({ color: "#0aa3de" });
    return state;
  }
  log(state, message) {
    state.message = message;
    state.logs = [{ time: this.now(), message }, ...(state.logs || [])].slice(0, 20);
    return state;
  }
  async page(tabId, frameId, action, config) {
    const results = await this.api.scripting.executeScript({
      target: { tabId, frameIds: [frameId] }, world: "MAIN", func: this.agent, args: [action, config]
    });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.error || "无法读取页面，请刷新课程页面后重新检测。");
    return result;
  }
  async tab(tabId, url) {
    const tab = await this.api.tabs.get(tabId);
    if (!/^https?:\/\//.test(tab.url || "")) throw new Error("请在 http/https 课程网页中使用扩展。");
    if (url && tab.url !== url) throw new Error("目标帖子地址已变化，任务已停止。请回到帖子重新开始。");
    if (tab.discarded || tab.frozen) throw new Error("目标标签页已被浏览器休眠或冻结。请打开该页后重新开始，并将课程网站加入始终保持活动名单。");
    if (tab.status === "loading") throw new Error("页面正在加载，请加载完成后重新开始。");
    return tab;
  }
  async probe(tabId, config) {
    const tab = await this.tab(tabId);
    const results = await this.api.scripting.executeScript({
      target: { tabId, allFrames: true }, world: "MAIN", func: this.agent, args: ["probe", config]
    });
    // A parent may discover the same same-origin iframe; prefer the main frame.
    const successes = results.filter((r) => r.result?.ok);
    const match = successes.find((r) => r.frameId === 0) || (successes.length === 1 ? successes[0] : null);
    if (!match) throw new Error(successes.length > 1 ? "多个 iframe 中存在回复表单，请用 CSS 选择器限定目标。" : results.find((r) => r.frameId === 0)?.result?.error || "未找到可用的回复表单。");
    return { ...match.result, frameId: match.frameId, url: tab.url, title: tab.title || "课程帖子", tabId };
  }
  start(tabId, config) {
    const generation = this.generation;
    return this.enqueue(async () => {
      if ((await this.state()).running) throw new Error("已有任务正在运行，请先停止。");
      const text = String(config.text ?? DEFAULT_TEXT).trim();
      const maxReplies = Number(config.maxReplies || 0);
      const intervalSeconds = parseInterval(config.intervalSeconds);
      if (!text || text.length > 2000) throw new Error("回复内容应为 1 至 2000 个字符。");
      if (!Number.isInteger(maxReplies) || maxReplies < 0 || maxReplies > 10000) throw new Error("次数上限应为 0 至 10000 的整数。");
      const match = await this.probe(tabId, config);
      if (match.draft) throw new Error("输入框已有草稿，请先清空，以免覆盖。");
      if (generation !== this.generation) throw new Error("启动已取消。");
      const state = this.log({
        ...DEFAULT_STATE, running: true, tabId, url: match.url, title: match.title,
        frameId: match.frameId, binding: match.binding, text, maxReplies, intervalSeconds,
        editorSelector: config.editorSelector || "", buttonSelector: config.buttonSelector || "",
        startedAt: this.now(), nextRunAt: this.now()
      }, "已启动，正在发布第一条。");
      await this.save(state);
      if (generation !== this.generation) return state;
      // The first reply runs directly in this worker. An alarm scheduled for
      // "now" could still be delayed by the browser's minimum alarm interval.
      await this.runOnce(generation);
      return this.state();
    });
  }
  stop(reason = "已停止。") {
    this.generation++; // Cancel a pending prepare step before it can click.
    return this.enqueue(async () => this.pause(await this.state(), reason));
  }
  async pause(state, reason) {
    await this.api.alarms.clear(ALARM_NAME);
    state.running = false;
    state.inFlight = false;
    state.nextRunAt = null;
    return this.save(this.log(state, reason));
  }
  tick() {
    const generation = this.generation;
    return this.enqueue(() => this.runOnce(generation));
  }
  async runOnce(generation) {
      const state = await this.state();
      if (!state.running || generation !== this.generation) return;
      try {
        await this.tab(state.tabId, state.url);
        if (state.nextRunAt > this.now()) {
          await this.api.alarms.create(ALARM_NAME, { when: state.nextRunAt });
          return;
        }
        // Persist the next allowed attempt BEFORE any side effects. If the worker
        // exits unexpectedly, we pause on recovery rather than re-clicking.
        state.inFlight = true;
        state.nextRunAt = null;
        await this.save(state);
        const config = { binding: state.binding, text: state.text };
        const prepared = await this.page(state.tabId, state.frameId, "prepare", config);
        if (prepared.writer) await this.save(this.log(state, `已通过 ${prepared.writer} 写入 ${prepared.textLength} 字，正在同步并发布。`));
        if (prepared.settleMs) await this.sleep(Math.min(2000, prepared.settleMs));
        if (generation !== this.generation) return;
        await this.tab(state.tabId, state.url);
        if (generation !== this.generation) return;
        await this.page(state.tabId, state.frameId, "submit", config);
        state.clicks++;
        state.lastClickAt = this.now();
        await this.save(this.log(state, `已点击发布 ${state.clicks} 次，正在检查输入框。`));
        // Wait in the extension worker, not in a throttled background page timer.
        let cleared = false;
        for (let attempt = 0; attempt < 4 && generation === this.generation; attempt++) {
          await this.sleep(2000);
          await this.tab(state.tabId, state.url);
          const result = await this.page(state.tabId, state.frameId, "verify", config);
          if (result.cleared) { cleared = true; break; }
        }
        state.inFlight = false;
        if (generation !== this.generation) { await this.save(state); return; }
        if (!cleared) return this.pause(state, "已点击发布，但 8 秒内未检测到输入框清空。请核对页面结果后再开始，避免重复提交。");
        if (state.maxReplies && state.clicks >= state.maxReplies) return this.pause(state, `已达到 ${state.maxReplies} 次点击上限，任务已停止。请在页面核对发布结果。`);
        // No catch-up bursts after sleep or delayed alarms.
        state.nextRunAt = state.lastClickAt + state.intervalSeconds * 1000;
        await this.save(this.log(state, `已点击发布 ${state.clicks} 次；输入框已清空，等待下一次。`));
        await this.api.alarms.create(ALARM_NAME, { when: state.nextRunAt });
      } catch (error) {
        state.inFlight = false;
        await this.pause(state, `已暂停：${error.message}`);
      }
  }
  recover() {
    return this.enqueue(async () => {
      const state = await this.state();
      if (!state.running) return;
      try {
        if (state.inFlight) return this.pause(state, "上一次提交中断，发布结果不确定。请核对页面后重新开始。");
        await this.tab(state.tabId, state.url);
        if (!await this.api.alarms.get(ALARM_NAME)) await this.api.alarms.create(ALARM_NAME, { when: Math.max(state.nextRunAt || 0, this.now() + 1000) });
      } catch (error) { await this.pause(state, error.message); }
    });
  }
}
