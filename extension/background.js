import { ReplyController, ALARM_NAME } from "./controller.js";
import { pageAgent } from "./page-agent.js";

const controller = new ReplyController(chrome, pageAgent);
const safely = (promise) => promise.catch((error) => console.error("课程回复助手：", error));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return false;
  let result;
  switch (message.type) {
    case "STATE": result = controller.state(); break;
    case "PROBE": result = controller.enqueue(() => controller.probe(message.tabId, message.config || {})); break;
    case "START": result = controller.start(message.tabId, message.config || {}); break;
    case "STOP": result = controller.stop(); break;
    default: return false;
  }
  result.then((data) => sendResponse({ ok: true, data }), (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) safely(controller.tick());
});
chrome.tabs.onRemoved.addListener((tabId) => {
  safely(controller.state().then((state) => {
    if (state.running && state.tabId === tabId) return controller.stop("目标标签页已关闭，任务已停止。");
  }));
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && !change.discarded && !change.frozen) return;
  safely(controller.state().then((state) => {
    if (state.running && state.tabId === tabId &&
        ((change.url && change.url !== state.url) || change.discarded || change.frozen)) {
      return controller.stop("目标页面已跳转或被浏览器休眠，任务已停止。请打开原帖子重新开始。");
    }
  }));
});
chrome.runtime.onStartup.addListener(() => safely(controller.stop("浏览器已重启，请回到课程帖子重新开始。")));
chrome.runtime.onInstalled.addListener(() => safely(controller.stop("扩展已安装或更新，请打开课程帖子后开始。")));
safely(controller.recover());
