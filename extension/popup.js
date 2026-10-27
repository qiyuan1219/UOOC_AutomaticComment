import { countdownState, parseInterval } from "./settings.js";

const $ = (id) => document.getElementById(id);
let currentTab;
let state = {};
let busy = false;
const configIds = ["text", "intervalSeconds", "maxReplies", "editorSelector", "buttonSelector"];
const getConfig = () => Object.fromEntries(configIds.map((id) => [id, $(id).value]));
const showError = (error) => { $("error").textContent = error?.message || String(error); $("error").hidden = false; };
async function request(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || "扩展后台无响应，请重新加载扩展。");
  return response.data;
}
function timeLabel(time) { return new Date(time).toLocaleTimeString("zh-CN", { hour12: false }); }
function countdown() {
  const view = countdownState(state);
  $("countdown").textContent = view.text;
  const progress = $("wait-progress");
  if (view.indeterminate) progress.removeAttribute("value");
  else progress.value = view.percent;
  progress.setAttribute("aria-valuetext", view.text);
}
function render(next) {
  state = next;
  $("status").textContent = state.running ? "运行中" : "已停止";
  $("status").classList.toggle("on", !!state.running);
  $("clicks").textContent = state.clicks || 0;
  $("message").textContent = state.message;
  $("target").textContent = state.running ? state.title : currentTab?.title || "请打开课程帖子";
  $("target").title = state.running ? state.url : currentTab?.url || "";
  $("stop").hidden = !state.running;
  $("start").disabled = busy || !!state.running || !currentTab;
  $("probe").disabled = busy || !!state.running || !currentTab;
  configIds.forEach((id) => { $(id).disabled = busy || !!state.running; });
  $("logs").replaceChildren(...(state.logs || []).map((entry) => {
    const li = document.createElement("li");
    li.textContent = `${timeLabel(entry.time)} ${entry.message}`;
    return li;
  }));
  countdown();
}
async function work(callback) {
  busy = true;
  $("error").hidden = true;
  render(state);
  try { await callback(); } catch (error) { showError(error); }
  finally { busy = false; render(state); }
}
$("probe").addEventListener("click", () => work(async () => {
  const result = await request("PROBE", { tabId: currentTab.id, config: getConfig() });
  state = { ...state, message: `检测到${result.editorType}和“${result.binding.button.label}”按钮。${result.draft ? "输入框已有草稿，请先清空。" : "可以开始；本次检测未输入或发布。"}` };
}));
$("start").addEventListener("click", () => {
  // Call request directly within the click gesture; only this site's permission.
  let grant;
  try {
    parseInterval($("intervalSeconds").value);
    const url = new URL(currentTab?.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error("请先打开课程帖子网页。");
    grant = chrome.permissions.request({ origins: [`${url.origin}/*`] });
  } catch (error) { showError(error); return; }
  work(async () => {
    if (!await grant) throw new Error("需要授权访问当前课程网站，才能在后台填写回复。");
    const config = getConfig();
    await chrome.storage.local.set({ preferences: config });
    state = await request("START", { tabId: currentTab.id, config });
  });
});
$("stop").addEventListener("click", () => work(async () => { state = await request("STOP"); }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.task) render(changes.task.newValue || {});
});
async function init() {
  try {
    [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { preferences } = await chrome.storage.local.get("preferences");
    if (preferences) configIds.forEach((id) => { if (preferences[id] !== undefined) $(id).value = preferences[id]; });
    const next = await request("STATE");
    if (next.running) configIds.forEach((id) => { if (next[id] !== undefined) $(id).value = next[id]; });
    render(next);
  } catch (error) { showError(error); }
}
init();
// Only the visible popup uses a short timer, for display. Scheduling is in alarms.
setInterval(countdown, 250);

