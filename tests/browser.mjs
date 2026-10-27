import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, cp, mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { pageAgent } from "../extension/page-agent.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = await readFile(path.join(root, "demo/index.html"), "utf8");
const syncFixture = await readFile(path.join(root, "tests/ueditor-fixture.html"), "utf8");
const angularSource = await readFile(path.join(root, "node_modules/angular/angular.js"), "utf8");
// Use the user's exact button markup. The local click listener stands in for
// the site's AngularJS handler; the test never evaluates ng-click expressions.
const releaseDemo = demo
  .replace('<button id="publish-reply">发布回复</button>', '<div class="release" ng-click="handleRelease()">发布回复</div>')
  .replace("document.getElementById('publish-reply').addEventListener", "document.querySelector('.release[ng-click]').addEventListener");
const server = createServer((req, res) => {
  if (req.url === "/angular.js") {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.end(angularSource);
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url.startsWith("/sync/") ? syncFixture : req.url === "/release/" ? releaseDemo : demo);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const temp = await mkdtemp(path.join(tmpdir(), "course-reply-test-"));
const extensionPath = path.join(temp, "extension");
await cp(path.join(root, "extension"), extensionPath, { recursive: true });
// Pre-grant ONLY the local fixture host in the disposable test copy. Production
// requests the current course site's optional permission through the start button.
const manifestPath = path.join(extensionPath, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*"];
await writeFile(manifestPath, JSON.stringify(manifest));
const resultsDir = path.join(root, "test-results");
await mkdir(resultsDir, { recursive: true });
const imagesDir = path.join(root, "docs/images");
await mkdir(imagesDir, { recursive: true });
let context;
try {
  context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    headless: true, channel: "chromium",
    ...(process.env.COURSE_REPLY_TEST_BROWSER ? { executablePath: process.env.COURSE_REPLY_TEST_BROWSER } : {}),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const errors = [];
  worker.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const control = await context.newPage();
  await control.goto(popupUrl);
  await control.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  const page = await context.newPage();
  await page.goto(`${origin}/demo/`);
  const invoke = async (action, config = {}) => page.evaluate(
    ({ source, action, config }) => (0, eval)(`(${source})`)(action, config),
    { source: pageAgent.toString(), action, config }
  );
  const TEXT = "【回复内容已匿名处理】";
  let check = await invoke("probe");
  assert.equal(check.ok, true, check.error);
  assert.equal(await page.locator("#reply-editor").innerText(), "");
  assert.equal(await page.locator("#total").innerText(), "0");
  let config = { binding: check.binding, text: TEXT };
  assert.equal((await invoke("prepare", config)).ok, true);
  assert.equal(await page.locator("#reply-editor").innerText(), TEXT);
  assert.equal(await page.locator("#total").innerText(), "0");
  assert.equal((await invoke("submit", config)).ok, true);
  assert.equal(await page.locator("#replies article").count(), 1);
  assert.equal((await invoke("verify", config)).cleared, true);
  console.log("PASS rich editor: detection is read-only; fill, submit, clear signal");

  await page.setContent('<textarea id="text"></textarea><button id="post">发布回复</button>');
  await page.evaluate(() => {
    window.inputSeen = "";
    document.querySelector("textarea").addEventListener("input", (e) => { window.inputSeen = e.target.value; });
  });
  check = await invoke("probe"); config = { binding: check.binding, text: TEXT };
  assert.equal((await invoke("prepare", config)).ok, true);
  assert.equal(await page.evaluate(() => window.inputSeen), TEXT);
  assert.equal((await invoke("prepare", config)).ok, false);
  await page.locator("#text").fill("用户修改的内容");
  assert.equal((await invoke("submit", config)).ok, false);
  console.log("PASS textarea input events, existing draft protection, user edit protection");

  await page.setContent('<textarea></textarea><textarea></textarea><button>发布回复</button><button>发布回复</button>');
  assert.equal((await invoke("probe")).ok, false);
  await page.setContent('<textarea id="other"></textarea><textarea id="target"></textarea><button id="post">发布回复</button>');
  check = await invoke("probe", { editorSelector: "#target", buttonSelector: "#post" });
  assert.equal(check.ok, true, check.error);
  config = { binding: check.binding, text: TEXT };
  assert.equal((await invoke("prepare", config)).ok, true);
  assert.equal(await page.locator("#other").inputValue(), "");
  await page.locator("#post").evaluate((el) => { el.disabled = true; });
  assert.equal((await invoke("submit", config)).ok, false);
  console.log("PASS ambiguous forms, CSS overrides, disabled button protection");

  await page.setContent('<textarea></textarea><div>发布回复</div><div class="release" ng-click="handleRelease()">发布回复</div>');
  check = await invoke("probe");
  assert.equal(check.ok, true, check.error);
  assert.equal(check.binding.button.selector, "html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(2)");
  assert.equal((await invoke("probe", { buttonSelector: '.release[ng-click]' })).ok, true);
  await page.setContent('<textarea></textarea><div ng-click="handleRelease()" role="button"><span data-ng-click="handleRelease()">发布回复</span></div>');
  assert.equal((await invoke("probe")).ok, true, "nested AngularJS clickable wrappers count once");
  console.log("PASS AngularJS div detection, CSS override, unrelated text and nested wrapper handling");

  await page.setContent('<iframe id="editor-frame" style="width:600px;height:180px" srcdoc="<html><body contenteditable=true></body></html>"></iframe><button id="publish">发布回复</button>');
  await page.frameLocator("#editor-frame").locator("body").waitFor();
  check = await invoke("probe"); assert.equal(check.ok, true, check.error);
  config = { binding: check.binding, text: TEXT };
  assert.equal((await invoke("prepare", config)).ok, true);
  assert.equal(await page.frameLocator("#editor-frame").locator("body").innerText(), TEXT);
  assert.equal(check.editorType, "iframe 富文本编辑器");
  console.log("PASS same-origin iframe editor with publish button in parent");

  await page.frameLocator("#editor-frame").locator("body").evaluate((el) => { el.replaceChildren(); });
  await page.evaluate(() => {
    const body = document.querySelector("iframe").contentDocument.body;
    window.editorApiUsed = false;
    window.UE = { instants: { sample: {
      body, setContent(html) { body.innerHTML = html; window.editorApiUsed = true; }, sync() {}
    } } };
  });
  const markup = '<img src=x onerror="window.bad=true"> & 匿名示例';
  assert.equal((await invoke("prepare", { binding: check.binding, text: markup })).ok, true);
  assert.equal(await page.evaluate(() => window.editorApiUsed), true);
  assert.equal(await page.frameLocator("#editor-frame").locator("img").count(), 0);
  console.log("PASS editor API synchronization and text escaping");
  await page.evaluate(() => { delete window.UE; });

  for (const suffix of ["", "?iframeRegistry=1"]) {
    await page.goto(`${origin}/sync/${suffix}`);
    await page.waitForFunction(() => window.fixtureState?.ready);
    // Reproduce the exact symptom: visible draft > 5 characters, site's model empty.
    await page.frameLocator("#ueditor-frame").locator("body").evaluate((el, text) => { el.textContent = text; }, TEXT);
    await page.locator(".release").click();
    assert.equal(await page.locator("#site-error").innerText(), "输入的文字要在5个以上");
    assert.equal(await page.evaluate(() => window.fixtureState.posted.length), 0);
    await page.frameLocator("#ueditor-frame").locator("body").evaluate((el) => el.replaceChildren());
    check = await invoke("probe");
    assert.equal(check.ok, true, check.error);
    config = { binding: check.binding, text: TEXT };
    const prepared = await invoke("prepare", config);
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.writer, "UEditor");
    assert.ok((await page.locator("#model-field").inputValue()).includes(TEXT));
    assert.equal((await invoke("submit", config)).ok, true);
    assert.deepEqual(await page.evaluate(() => window.fixtureState.posted), [TEXT]);
    assert.equal((await invoke("verify", config)).cleared, true);
    assert.ok(await page.evaluate(() => window.fixtureState.events.includes("wordcount")));
    console.log(`PASS reproduces minimum-length error, synchronizes UEditor and real AngularJS model, then submits (${suffix || "UE registry"})`);
  }
  await page.goto(`${origin}/sync/`);
  await page.waitForFunction(() => window.fixtureState?.ready);
  check = await invoke("probe");
  await page.evaluate(() => { window.UE.instants.ueditorInstant8.setContent = () => { throw new Error("UE API failure"); }; });
  const failedEditor = await invoke("prepare", { binding: check.binding, text: TEXT });
  assert.equal(failedEditor.ok, false);
  assert.match(failedEditor.error, /UE API failure/);
  assert.equal((await page.frameLocator("#ueditor-frame").locator("body").innerText()).trim(), "");
  assert.equal(await page.evaluate(() => window.fixtureState.posted.length), 0);
  console.log("PASS editor API errors stop without falling back to unsynchronized DOM writes");

  // Exercise the actual MV3 worker, popup and a custom interval, with the target
  // tab left in the background and no open popup during the wait.
  await page.goto(`${origin}/release/`);
  await page.evaluate(() => {
    window.replyClickTimes = [];
    document.querySelector('.release[ng-click]').addEventListener('click', () => window.replyClickTimes.push(Date.now()));
  });
  await page.bringToFront();
  const initialPopupCreated = context.waitForEvent("page");
  await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), popupUrl);
  let popup = await initialPopupCreated;
  await popup.waitForLoadState();
  await popup.waitForFunction(() => document.getElementById("target").textContent.includes("本地模拟"));
  await popup.locator("#text").fill(TEXT);
  await popup.locator("#intervalSeconds").fill("30");
  await popup.locator("#maxReplies").fill("2");
  const removedCopy = ["首条立即发送 · 后续每隔 70 秒", "开启后立即发送第一条，之后每隔 70 秒发送。0 表示持续运行；测试时可将上限设为 1", "可切换标签页或最小化浏览器。保留课程标签页及登录状态，电脑保持唤醒；系统调度可能使间隔延后。点击计数不代表服务器确认发布成功。"];
  const popupText = await popup.locator("body").innerText();
  assert.ok(removedCopy.every((copy) => !popupText.includes(copy)));
  await popup.locator("body").screenshot({ path: path.join(imagesDir, "popup-ready.png") });
  // A direct popup URL has itself as the active tab; the real action popup
  // uses the underlying page. Select the fixture only in this test harness.
  const fixtureTabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${origin}/release/`);
  await popup.evaluate(async ({ tabId, text }) => {
    const reply = await chrome.runtime.sendMessage({ type: "PROBE", tabId, config: {} });
    if (!reply.ok) throw new Error(reply.error);
    await chrome.storage.local.set({ preferences: { text, intervalSeconds: 30, maxReplies: 2 } });
  }, { tabId: fixtureTabId, text: TEXT });
  // Start through the production message handler (not a replaced timer).
  const requestedAt = Date.now();
  const started = await popup.evaluate(async ({ tabId, text }) => chrome.runtime.sendMessage({
    type: "START", tabId, config: { text, intervalSeconds: 30, maxReplies: 2 }
  }), { tabId: fixtureTabId, text: TEXT });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.data.running, true, started.data.message);
  assert.equal(started.data.clicks, 1);
  assert.equal(started.data.intervalSeconds, 30);
  assert.equal(await page.locator("#replies article").count(), 1);
  const firstClickAt = await page.evaluate(() => window.replyClickTimes[0]);
  assert.ok(firstClickAt - requestedAt < 10_000, "first reply is sent immediately without waiting for an alarm");
  console.log("PASS first reply posts immediately after start");
  const due = started.data.nextRunAt;
  await popup.reload();
  await popup.locator("#status.on").waitFor();
  assert.equal(await popup.locator("#text").inputValue(), TEXT);
  assert.equal(await popup.locator("#intervalSeconds").inputValue(), "30");
  assert.equal(await popup.locator("#intervalSeconds").isDisabled(), true);
  const initialProgress = await popup.locator("#wait-progress").evaluate((el) => el.value);
  await popup.waitForFunction((initial) => document.getElementById("wait-progress").value > initial + 12, initialProgress);
  await popup.locator("body").screenshot({ path: path.join(imagesDir, "popup-running.png") });
  await popup.locator("body").screenshot({ path: path.join(resultsDir, "popup.png") });
  await popup.close();
  await control.close();
  const foreground = await context.newPage(); await foreground.goto("about:blank"); await foreground.bringToFront();
  console.log(`RUN actual custom 30-second alarm, popup closed, another tab in foreground; due ${new Date(due).toISOString()}`);
  await page.waitForFunction(() => document.querySelectorAll("#replies article").length === 2, null, { timeout: 90_000 });
  const observed = Date.now();
  assert.ok(observed >= due - 100, "did not post early");
  assert.deepEqual(await page.locator("#replies p").allTextContents(), [TEXT, TEXT]);
  const repeatSpacingMs = await page.evaluate(() => window.replyClickTimes[1] - window.replyClickTimes[0]);
  assert.ok(repeatSpacingMs >= 30_000 && repeatSpacingMs < 60_000, "second click follows the custom 30-second interval rather than the old 70-second default");
  await page.screenshot({ path: path.join(resultsDir, "demo-posted.png"), fullPage: true });
  await page.screenshot({ path: path.join(imagesDir, "demo-result.png"), fullPage: true });
  worker = context.serviceWorkers()[0];
  let final;
  for (let i = 0; i < 12; i++) {
    final = await worker.evaluate(async () => (await chrome.storage.local.get("task")).task);
    if (!final.running) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(final.clicks, 2);
  assert.equal(final.running, false, final.message);
  assert.match(final.message, /上限/);
  assert.equal(await worker.evaluate(() => chrome.alarms.get("course-reply-70s")), undefined);
  console.log("PASS immediate first reply, custom 30-second background repeat, progress, click limit and no leftover alarm");

  // Open an inactive extension page, so its active-tab query sees the fixture,
  // just like a real toolbar popup. Exercise the actual start/permission handler.
  await page.bringToFront();
  const popupCreated = context.waitForEvent("page");
  await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), popupUrl);
  popup = await popupCreated;
  await popup.waitForLoadState();
  await popup.waitForFunction(() => document.getElementById("target").textContent.includes("本地模拟"));
  await popup.locator("#probe").click();
  await popup.waitForFunction(() => document.getElementById("message").textContent.includes("本次检测未输入或发布"));
  await popup.locator("#maxReplies").fill("0");
  assert.equal(await popup.locator("#intervalSeconds").inputValue(), "30");
  await popup.locator("#intervalSeconds").fill("125");
  await popup.locator("#start").click();
  await popup.locator("#status.on").waitFor();
  await popup.waitForFunction(() => document.getElementById("countdown").textContent.includes("秒后发布"));
  await popup.close();
  const reopened = context.waitForEvent("page");
  await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), popupUrl);
  popup = await reopened;
  await popup.waitForLoadState();
  await popup.locator("#status.on").waitFor();
  assert.equal(await popup.locator("#intervalSeconds").inputValue(), "125");
  assert.ok(await popup.locator("#wait-progress").evaluate((el) => el.value > 0));
  await popup.locator("#stop").click();
  await popup.waitForFunction(() => document.getElementById("status").textContent === "已停止");
  assert.equal(await worker.evaluate(() => chrome.alarms.get("course-reply-70s")), undefined);
  assert.equal(await popup.locator("#wait-progress").evaluate((el) => el.value), 0);
  assert.deepEqual(errors, []);
  console.log("PASS popup detect, current-site permission, start and stop buttons");
  const installation = await context.newPage();
  await installation.setViewportSize({ width: 1120, height: 650 });
  await installation.goto("chrome://extensions/");
  await installation.locator("extensions-manager").waitFor();
  await installation.locator("extensions-item").waitFor();
  const developerMode = installation.locator("extensions-toolbar #devMode");
  if (!await developerMode.evaluate((el) => el.checked)) await developerMode.click();
  await installation.locator("#loadUnpacked").waitFor();
  await installation.screenshot({ path: path.join(imagesDir, "installation.png"), animations: "disabled" });
  await writeFile(path.join(resultsDir, "browser-report.json"), JSON.stringify({
    passed: true, extensionVersion: manifest.version,
    buttonMarkup: '<div class="release" ng-click="handleRelease()">发布回复</div>',
    firstClickDelayMs: firstClickAt - requestedAt, repeatSpacingMs,
    scheduledAt: due, observedAt: observed, clicks: final.clicks,
    message: final.message, note: "Disposable extension copy pre-granted only the local test host. No real course site was accessed."
  }, null, 2));
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  // Only delete the absolute, verified task-specific directory we just created.
  const resolvedTemp = path.resolve(temp);
  if (path.dirname(resolvedTemp) === path.resolve(tmpdir()) && path.basename(resolvedTemp).startsWith("course-reply-test-")) {
    await rm(resolvedTemp, { recursive: true, force: true });
  }
}
