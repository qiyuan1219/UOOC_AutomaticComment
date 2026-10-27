// This function is serialized by chrome.scripting: keep every helper inside it.
export function pageAgent(action, config = {}) {
  const clean = (value) => String(value ?? "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
  const label = (node) => clean(node.value || node.innerText || node.textContent || node.getAttribute("aria-label"));
  const visible = (node) => {
    const view = node.ownerDocument.defaultView;
    const style = view.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const editable = (node) => !node.disabled && !node.readOnly &&
    (node.tagName === "TEXTAREA" || node.isContentEditable ||
      (node.tagName === "BODY" && node.ownerDocument.designMode.toLowerCase() === "on"));
  const textOf = (node) => clean(node.tagName === "TEXTAREA" ? node.value : node.innerText || node.textContent);
  const blocked = (node) => node.disabled || node.getAttribute("aria-disabled") === "true" ||
    node.closest('[inert], [aria-busy="true"]') || /(?:^|\s)(?:disabled|is-disabled|loading|is-loading)(?:\s|$)/.test(node.className);
  const pathOf = (node) => {
    const doc = node.ownerDocument;
    if (node.id) {
      const id = `#${doc.defaultView.CSS.escape(node.id)}`;
      if (doc.querySelectorAll(id).length === 1) return id;
    }
    const parts = [];
    for (let el = node; el; el = el.parentElement) {
      let index = 1;
      for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (prev.tagName === el.tagName) index++;
      }
      parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${index})`);
    }
    return parts.join(" > ");
  };
  const documents = [];
  let inaccessibleFrames = 0;
  function walk(doc, frames = []) {
    documents.push({ doc, frames });
    for (const frame of doc.querySelectorAll("iframe, frame")) {
      if (!visible(frame)) continue;
      try {
        if (frame.contentDocument?.documentElement) walk(frame.contentDocument, [...frames, pathOf(frame)]);
        else inaccessibleFrames++;
      } catch { inaccessibleFrames++; }
    }
  }
  const resolve = (frames, selector, expectedUrl) => {
    let doc = document;
    for (const framePath of frames) {
      const frame = doc.querySelector(framePath);
      if (!frame || !visible(frame) || !frame.contentDocument) throw new Error("编辑器所在的 iframe 已变化，请重新检测。");
      doc = frame.contentDocument;
    }
    if (doc.URL !== expectedUrl) throw new Error("编辑器或按钮所在页面已变化，请重新检测。");
    const nodes = doc.querySelectorAll(selector);
    if (nodes.length !== 1 || !visible(nodes[0])) throw new Error("输入框或发布按钮已变化，请重新检测。");
    return nodes[0];
  };
  function locate() {
    const b = config.binding;
    if (!b) throw new Error("请先检测页面。");
    const editor = resolve(b.editor.frames, b.editor.selector, b.editor.url);
    const button = resolve(b.button.frames, b.button.selector, b.button.url);
    if (!editable(editor) || editor.tagName !== b.editor.tag) throw new Error("输入框当前不可编辑。");
    if (label(button) !== b.button.label) throw new Error("发布按钮文字已变化，已停止。");
    return { editor, button };
  }
  function notify(editor) {
    const view = editor.ownerDocument.defaultView;
    editor.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText", data: config.text }));
    editor.dispatchEvent(new view.Event("change", { bubbles: true }));
    editor.dispatchEvent(new view.Event("blur", { bubbles: false }));
  }
  function contextsFor(editor) {
    const contexts = new Set([window]);
    let view = editor.ownerDocument.defaultView;
    while (view && !contexts.has(view)) {
      contexts.add(view);
      try {
        if (view.parent === view || !view.parent.document) break;
        view = view.parent;
      } catch { break; }
    }
    // The injection itself can run in the editor frame, so still visit its parent.
    try {
      view = window.parent;
      while (view && !contexts.has(view)) {
        void view.document;
        contexts.add(view);
        if (view.parent === view) break;
        view = view.parent;
      }
    } catch { /* Cross-origin boundary. */ }
    return contexts;
  }
  function ueditorFor(editor) {
    const candidates = new Set();
    for (const context of contextsFor(editor)) {
      try {
        for (const instance of Object.values(context.UE?.instants || context.baidu?.editor?.instants || {})) candidates.add(instance);
        candidates.add(context.editor); // UEditor's own iframe bootstrap exposes this.
        for (const ui of Object.values(context.$EDITORUI || {})) candidates.add(ui?.editor);
      } catch { /* Unavailable parent window. */ }
    }
    return [...candidates].find((instance) => instance?.body === editor && typeof instance.setContent === "function");
  }
  function modelFor(editor) {
    let node = editor;
    while (node) {
      if (node.matches?.('[ng-model], [data-ng-model], [x-ng-model]')) {
        const angular = node.ownerDocument.defaultView.angular;
        if (angular?.element) {
          const wrapped = angular.element(node);
          const controller = wrapped.controller("ngModel");
          if (controller?.$setViewValue) return { node, controller, scope: wrapped.scope?.() || controller.$$scope };
        }
      }
      if (node.parentElement) node = node.parentElement;
      else {
        try { node = node.ownerDocument.defaultView.frameElement; }
        catch { node = null; }
      }
    }
    return null;
  }
  function modelText(value, doc) {
    if (typeof value !== "string") return "";
    const template = doc.createElement("template");
    template.innerHTML = value;
    return clean(template.content.textContent);
  }
  function syncModel(editor) {
    const model = modelFor(editor);
    if (!model) return false;
    const { node, controller, scope } = model;
    if (controller.$viewValue && typeof controller.$viewValue !== "string") throw new Error("编辑器的数据格式特殊，尚未同步。请提供编辑器外层 HTML。");
    const update = () => {
      const value = editor.tagName === "TEXTAREA" ? editor.value : editor.innerHTML;
      controller.$setViewValue(value, "input");
      controller.$commitViewValue?.();
    };
    if (scope?.$apply && !scope.$root?.$$phase) scope.$apply(update);
    else update();
    if (!controller.$pending && modelText(controller.$modelValue, node.ownerDocument) !== clean(config.text)) {
      throw new Error("编辑器显示了文字，但网站表单数据尚未同步或校验未通过，未点击发布。");
    }
    return true;
  }
  function checkContent(editor) {
    const ue = ueditorFor(editor);
    if (ue?.getContentTxt && clean(ue.getContentTxt()) !== clean(config.text)) {
      throw new Error("UEditor 实际读取的内容与草稿不一致，未点击发布。");
    }
    if (ue?.getContentLength && ue.getContentLength(true) < clean(config.text).length) {
      throw new Error("UEditor 的实际字数未同步，未点击发布。");
    }
    const model = modelFor(editor);
    if (model && (model.controller.$pending || modelText(model.controller.$modelValue, model.node.ownerDocument) !== clean(config.text))) {
      throw new Error("网站表单数据尚未同步或正在校验，未点击发布。");
    }
  }
  function write(editor) {
    const doc = editor.ownerDocument;
    const view = doc.defaultView;
    const htmlNode = doc.createElement("p");
    htmlNode.textContent = config.text;
    const html = htmlNode.outerHTML;
    const ue = ueditorFor(editor);
    if (ue) {
      // Do not silently fall back to DOM editing when the real editor API fails.
      // Suppress selection changes so writing does not steal focus in the background.
      ue.setContent(html, false, true);
      ue.fireEvent?.("contentchange");
      ue.fireEvent?.("wordcount");
      ue.fireEvent?.("blur", { type: "blur", target: editor });
      ue.sync?.();
      notify(editor);
      syncModel(editor);
      return { writer: "UEditor", settleMs: 1000 };
    }
    // Prefer editor APIs, which also synchronize their hidden form fields.
    for (const context of contextsFor(editor)) {
      try {
        const tiny = context.tinymce || context.tinyMCE;
        for (const instance of tiny?.editors || []) {
          if (instance.getBody?.() === editor) {
            instance.setContent(html); instance.save?.(); notify(editor); return;
          }
        }
        for (const instance of Object.values(context.CKEDITOR?.instances || {})) {
          if (instance.editable?.()?.$ === editor) {
            instance.setData(html); instance.updateElement?.(); notify(editor); return;
          }
        }
        for (const instance of context.KindEditor?.instances || []) {
          if (instance.edit?.doc?.body === editor) {
            instance.html(html); instance.sync?.(); notify(editor); return;
          }
        }
      } catch { /* Cross-origin parent or an unavailable editor API. */ }
    }
    const quill = view.Quill?.find?.(editor);
    if (quill?.setText) quill.setText(config.text, "user");
    else if (editor.tagName === "TEXTAREA") {
      Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, "value").set.call(editor, config.text);
    } else {
      // DOM editing does not focus the tab, move the mouse, or type into other apps.
      editor.replaceChildren(htmlNode);
    }
    notify(editor);
    const hasModel = syncModel(editor);
    return { writer: hasModel ? "AngularJS" : "DOM", settleMs: hasModel ? 1000 : 0 };
  }
  try {
    if (action === "probe") {
      walk(document);
      const editors = [];
      const buttons = [];
      for (const item of documents) {
        const { doc, frames } = item;
        const editorQuery = config.editorSelector || 'textarea, [contenteditable="true"], [contenteditable=""], body[contenteditable], body.cke_editable, body.mce-content-body';
        let nodes = [...doc.querySelectorAll(editorQuery)];
        if (!config.editorSelector && doc.designMode.toLowerCase() === "on" && doc.body) nodes.push(doc.body);
        for (let node of new Set(nodes)) {
          if (/^(IFRAME|FRAME)$/.test(node.tagName)) node = node.contentDocument?.body;
          if (!node || !visible(node) || !editable(node)) continue;
          if (editors.some((e) => e.node === node || e.node.contains(node))) continue;
          const entry = documents.find((d) => d.doc === node.ownerDocument);
          if (!entry) continue;
          editors.push({ node, frames: entry.frames, selector: pathOf(node), url: node.ownerDocument.URL, tag: node.tagName });
        }
        // AngularJS can bind ng-click to a plain div, including this course's
        // <div class="release" ng-click="handleRelease()">发布回复</div>.
        for (const node of doc.querySelectorAll(config.buttonSelector || 'button, [role="button"], input[type="submit"], input[type="button"], a, .el-button, .ivu-btn, .ant-btn, [ng-click], [data-ng-click], [x-ng-click]')) {
          if (visible(node) && (config.buttonSelector || label(node).replace(/\s/g, "") === "发布回复")) {
            // Nested role=button/span wrappers can otherwise be counted twice.
            if (!buttons.some((b) => b.node === node || b.node.contains(node) || node.contains(b.node))) {
              buttons.push({ node, frames, selector: pathOf(node), url: doc.URL, label: label(node) });
            }
          }
        }
      }
      if (buttons.length !== 1 || editors.length !== 1) {
        return { ok: false, error: `找到 ${editors.length} 个输入框、${buttons.length} 个“发布回复”按钮。需要各有一个；可在高级设置中填写 CSS 选择器。${inaccessibleFrames ? " 检测到无法读取的跨域 iframe，可能需要单独打开其页面。" : ""}` };
      }
      const { node: editorNode, ...editor } = editors[0];
      const { node: buttonNode, ...button } = buttons[0];
      return { ok: true, binding: { editor, button }, draft: textOf(editorNode), buttonDisabled: Boolean(blocked(buttonNode)), editorType: editor.tag === "TEXTAREA" ? "文本框" : editor.frames.length ? "iframe 富文本编辑器" : "富文本编辑器" };
    }
    const { editor, button } = locate();
    if (action === "prepare") {
      if (textOf(editor)) throw new Error("输入框中已有内容。请检查上一条回复是否发出，并清空草稿后重新开始。");
      const result = write(editor);
      if (textOf(editor) !== clean(config.text)) throw new Error("写入后内容校验失败，未点击发布。请检查编辑器兼容性。");
      checkContent(editor);
      return { ok: true, ...result, textLength: textOf(editor).length };
    }
    if (action === "submit") {
      if (textOf(editor) !== clean(config.text)) throw new Error("输入框内容已变化，未点击发布。");
      checkContent(editor);
      if (blocked(button)) throw new Error("发布按钮被禁用或正在提交，已暂停。");
      button.click();
      return { ok: true, clicked: true };
    }
    if (action === "verify") return { ok: true, cleared: textOf(editor) === "" };
    throw new Error("未知页面操作。");
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
