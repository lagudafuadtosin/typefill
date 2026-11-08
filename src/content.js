// Watches typing on every page. When the text before the caret ends with a snippet's shortcut, the shortcut is
// replaced with the snippet. Snippets with form fields ask for their values first in a small box on the page.
// The search box (Ctrl+Shift+Space) puts a snippet in without typing its shortcut.

(() => {
  "use strict";
  if (globalThis.__typefill) return;
  globalThis.__typefill = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const T = globalThis.TFTemplate;
  const H = globalThis.TFHtml;

  let all = [];
  let snippets = [];
  let longest = 0;
  let enabled = true;
  // Typefill Pro, when it's part of this build (pro-content.js), plugs in here. The free build has none.
  const pro = () => globalThis.TypefillPro;
  // On Typefill's own snippet page only the "Try it here" box expands shortcuts, never the boxes snippets are written in
  const ownPage = location.href.startsWith(api.runtime.getURL(""));
  const allowed = (el) => !ownPage || !!el?.closest?.("[data-typefill-try]");

  async function load() {
    const { snippets: list = [], settings = {} } = await api.storage.local.get(["snippets", "settings"]);
    all = list.filter((s) => s && !s.deleted);
    snippets = all.filter((s) => s.shortcut && !s.off).sort((a, b) => b.shortcut.length - a.shortcut.length);
    longest = snippets.reduce((n, s) => Math.max(n, s.shortcut.length), 0);
    enabled = settings.enabled !== false && !(settings.blockedSites ?? []).some((h) => hostMatches(h));
  }
  load();
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.snippets || changes.settings)) load();
  });

  function hostMatches(pattern) {
    const host = topHost();
    const p = String(pattern).trim().toLowerCase().replace(/^\*\./, "");
    return !!p && (host === p || host.endsWith("." + p));
  }

  function topHost() {
    try { return window.top.location.hostname.toLowerCase(); } catch { return location.hostname.toLowerCase(); }
  }

  // The longest shortcut the text ends with
  function match(before) {
    if (!before) return null;
    for (const s of snippets) if (before.endsWith(s.shortcut)) return s;
    return null;
  }

  // Google Docs draws text on a canvas and takes key presses through a hidden frame, so the page text can't be read
  // there. Its typing is followed key by key instead.
  const inDocsFrame = (() => {
    try { return !!window.frameElement?.classList.contains("docs-texteventtarget-iframe"); } catch { return false; }
  })();

  let busy = false;

  // While a snippet goes in, letters typed meanwhile are held back and put in straight after it, so a fast typist
  // never has a letter land inside the shortcut being replaced
  let holding = false;
  let held = "";
  window.addEventListener("keydown", (e) => {
    if (!holding || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    held += e.key;
  }, true);

  if (inDocsFrame) watchDocs();
  else {
    document.addEventListener("input", onInput, true);
    // Editors like CKEditor and ProseMirror put typed letters in themselves and the page gets no input event,
    // so each typed letter is also checked once the editor has dealt with it
    document.addEventListener("keydown", (e) => {
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) setTimeout(() => onInput({}), 0);
    }, true);
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "search" && enabled && !busy && document.hasFocus()) {
      const target = currentTarget();
      if (target) void openSearch(target);
    }
  });

  function onInput(e) {
    if (!enabled || busy || !snippets.length) return;
    if (e.inputType && e.inputType !== "insertText" && e.inputType !== "insertCompositionText") return;
    const el = deepActive();
    if (!el || !allowed(el)) return;
    if (isTextField(el)) {
      if (el.selectionStart !== el.selectionEnd || el.selectionStart == null) return;
      const before = el.value.slice(Math.max(0, el.selectionStart - longest), el.selectionStart);
      const s = match(before);
      if (s) void expand({ kind: "field", el, start: el.selectionStart - s.shortcut.length, end: el.selectionStart }, s, s.shortcut);
      return;
    }
    const host = editableHost(el);
    if (!host) return;
    const sel = selectionFor(host);
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const s = match(textBeforeCaret(sel, host));
    if (s) void expand({ kind: "editable", el: host }, s, s.shortcut);
  }

  // Where the caret is now, for the search box: a text box, an editable area or Docs
  function currentTarget() {
    if (inDocsFrame) return docsTarget();
    const el = deepActive();
    if (el && !allowed(el)) return null;
    if (el && isTextField(el)) return { kind: "field", el, start: el.selectionStart, end: el.selectionEnd };
    const host = el && editableHost(el);
    return host ? { kind: "editable", el: host } : null;
  }

  // The focused element, looking inside shadow roots
  function deepActive() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function isTextField(el) {
    if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
    if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return false;
    return ["text", "search", "url", "email", "tel", ""].includes(el.type);
  }

  function editableHost(el) {
    if (!(el instanceof HTMLElement) || !el.isContentEditable) return null;
    return el;
  }

  function selectionFor(el) {
    return el.getRootNode().getSelection?.() ?? document.getSelection();
  }

  function textBeforeCaret(sel, host, length = longest) {
    const r = sel.getRangeAt(0);
    const node = r.endContainer;
    if (node.nodeType === Node.TEXT_NODE && r.endOffset >= length) return node.data.slice(r.endOffset - length, r.endOffset);
    const pre = document.createRange();
    pre.selectNodeContents(host);
    pre.setEnd(node, r.endOffset);
    return pre.toString().slice(-length);
  }

  // Text with every space and line break taken out. Editors show breaks as blocks the page text doesn't spell out,
  // and keep or drop spaces at line ends, so only the visible characters are compared.
  const squash = (s) => s.replace(/\s+/g, "").split(T.CARET).join("");

  // Some editors (Outlook) take a paste a moment later, rebuild the text and set the caret themselves. Waits until the
  // end of the snippet sits before the caret and the editor has stopped changing the page. Gives up after a second.
  async function settled(el, text) {
    const tail = squash(text).slice(-12);
    let last = performance.now();
    const watch = new MutationObserver(() => { last = performance.now(); });
    watch.observe(el, { childList: true, subtree: true, characterData: true });
    try {
      const start = performance.now();
      while (performance.now() - start < 1000) {
        await new Promise((r) => setTimeout(r, 20));
        const sel = selectionFor(el);
        const there = !tail || (sel?.rangeCount && squash(textBeforeCaret(sel, el, 80)).endsWith(tail));
        if (there && performance.now() - last >= 60) return;
      }
    } finally {
      watch.disconnect();
    }
  }

  // Steps the caret back from the end of the snippet until the text before it ends the way the snippet's text before
  // {cursor} does. Counting characters alone goes wrong where an editor turns line breaks into blocks or drops a space.
  function caretBack(el, text, back) {
    const sel = selectionFor(el);
    const before = text.slice(0, text.length - back);
    const rest = text.slice(text.length - back);
    const want = squash(before).slice(-16);
    if (!want) {
      for (let i = 0; i < back; i++) sel.modify("move", "backward", "character");
      return;
    }
    const matches = () => squash(textBeforeCaret(sel, el, 80)).endsWith(want);
    for (let i = 0; i <= back + 20; i++) {
      if (i > 0) sel.modify("move", "backward", "character");
      if (i < Math.max(0, back - 4) || !matches()) continue;
      // The first match from the end sits after any line breaks or spaces the rest of the snippet starts with,
      // since those don't change the visible text. Step back over them too.
      const lead = /^\s*/.exec(rest)[0].length;
      for (let j = 0; j < lead; j++) {
        sel.modify("move", "backward", "character");
        if (!matches()) { sel.modify("move", "forward", "character"); break; }
      }
      return;
    }
  }

  // A snippet's template, with {import: /x} filled from the other snippets in the same form, formatted or plain
  function prepare(snippet) {
    const rich = !!(snippet.rich && snippet.html);
    const resolve = (shortcut) => {
      const s = all.find((x) => x.shortcut === shortcut.trim());
      if (!s) return null;
      const sRich = !!(s.rich && s.html);
      if (rich) return sRich ? s.html : H.fromText(s.text ?? "");
      return sRich ? H.toText(s.html) : s.text ?? "";
    };
    return { tree: T.parse(rich ? snippet.html : snippet.text ?? "", resolve), rich };
  }

  // What gets put in: plain text (for boxes that take no formatting), HTML when formatted, and how far back the caret
  // goes. marked and markedHtml keep the caret mark in, for editors where it is found again after the paste.
  function output({ tree, rich }, values, ctx) {
    const rendered = T.render(tree, values, ctx, rich);
    if (!rich) return { ...T.splitCaret(rendered), html: null, marked: rendered, markedHtml: null };
    const plain = H.toText(rendered);
    return { ...T.splitCaret(plain), html: H.sanitize(rendered.replace(T.CARET, "")), marked: plain, markedHtml: H.sanitize(rendered) };
  }

  // typed is the shortcut to take out first, or "" when the snippet came from the search box
  async function expand(target, snippet, typed) {
    busy = true;
    holding = true;
    held = "";
    try {
      const prepared = prepare(snippet);
      const proUsed = T.proParts(prepared.tree);
      if (proUsed.length && !pro()?.isOn()) {
        // The shortcut stays where it is and the box says what's needed
        holding = false;
        await notice(snippet, pro()
          ? `This snippet uses Typefill Pro (${proUsed.join(", ")}). Unlock Pro on the Typefill snippet page to use it.`
          : `This snippet uses Typefill Pro (${proUsed.join(", ")}), which this copy of Typefill doesn't include.`);
        restoreCaret(target, null);
        if (target.kind === "field") target.el.setSelectionRange(target.end, target.end);
        return;
      }
      const ctx = { now: new Date() };
      if (hasCommand(prepared.tree, "clipboard")) ctx.clipboard = await readClipboard();
      const problems = proUsed.length ? await pro().prepare(prepared.tree, ctx) : [];
      const fields = T.fields(prepared.tree, ctx.now, ctx);
      let values = {};
      if (fields.length || problems.length) {
        // The form box takes typing for itself
        holding = false;
        const saved = saveCaret(target);
        values = await askForm(snippet, prepared, fields, ctx, problems);
        restoreCaret(target, saved);
        if (!values) {
          // Cancelled: the shortcut stays, with the caret after it
          if (target.kind === "field") target.el.setSelectionRange(target.end, target.end);
          return;
        }
        holding = true;
        if (target.kind === "editable") {
          // Editors like Lexical (WhatsApp) put back their own idea of the caret a moment after getting focus back.
          // That settles first, then the caret goes back to where the shortcut ends.
          await new Promise((r) => setTimeout(r, 60));
          restoreCaret(target, saved);
        }
      }
      const out = output(prepared, values, ctx);
      if (ctx.actions.length && pro()) await pro().runSteps(target, typed, out, ctx.actions);
      else await put(target, typed, out);
      bumpUse(snippet.id);
    } finally {
      holding = false;
      busy = false;
      const late = held;
      held = "";
      if (late) replay(target, late);
    }
  }

  async function put(target, typed, out) {
    if (target.kind === "field") replaceInField(target, out);
    else if (target.kind === "editable") await replaceInEditable(target, typed, out);
    else await target.replace(typed.length, out);
  }

  // Letters typed while the snippet went in, put in after it
  function replay(target, text) {
    if (target.kind === "field") document.execCommand("insertText", false, text);
    else if (target.kind === "editable") insertText(text);
    else paste(text);
    // The held letters may finish another shortcut
    if (target.kind !== "docs") setTimeout(() => onInput({}), 0);
  }

  function hasCommand(nodes, type) {
    return nodes.some((n) => n.type === type || (n.children && hasCommand(n.children, type)));
  }

  function saveCaret(target) {
    if (target.kind !== "editable") return null;
    const sel = selectionFor(target.el);
    return sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  }

  function restoreCaret(target, range) {
    target.el?.focus({ preventScroll: true });
    if (target.kind === "field") target.el.setSelectionRange(target.start, target.end);
    else if (target.kind === "editable" && range) {
      const sel = selectionFor(target.el);
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (target.refocus) target.refocus();
  }

  function replaceInField({ el, start, end }, { text, back }) {
    el.setSelectionRange(start, end);
    // insertText keeps the page's undo history and the events frameworks listen for
    if (!document.execCommand("insertText", false, text)) {
      el.setRangeText(text, start, end, "end");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    if (back) {
      const pos = el.selectionEnd - back;
      el.setSelectionRange(pos, pos);
    }
  }

  // Editors copy the page's selection into their own when it changes, some straight away (Lexical) and some a moment
  // later (Quill, ProseMirror). Both get their turn before anything else happens.
  async function selectionTold() {
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((r) => setTimeout(r, 30));
  }

  async function replaceInEditable({ el }, typed, out) {
    const { text, back, html } = out;
    const sel = selectionFor(el);
    if (typed) {
      for (let i = 0; i < typed.length; i++) sel.modify("extend", "backward", "character");
      // Only replace when exactly the shortcut is selected, never more
      if (sel.toString().replace(/\u00a0/g, " ") !== typed.replace(/\u00a0/g, " ")) { sel.collapseToEnd(); return; }
      await selectionTold();
      // The shortcut comes out first, so the snippet goes in at a plain caret. Pasting over a backwards selection
      // leaves some editors (ProseMirror) holding part of it, and the next key typed replaces the snippet.
      deleteSelection();
      await selectionTold();
      if (squash(textBeforeCaret(selectionFor(el), el, typed.length + 20)).endsWith(squash(typed))) return;
    }
    // With a caret spot, the snippet goes in with a mark where the caret belongs. Once the editor has settled the mark
    // is found, the caret put on it and the mark taken out. That works however the editor counts spaces and breaks.
    const marked = back > 0;
    const t = marked ? out.marked : text;
    const h = marked ? out.markedHtml : html;
    // Rich editors (Gmail, Notion, Slack) take a paste and handle it themselves. Plain one-line text goes in as typing.
    const done = h
      ? paste(t, h) || document.execCommand("insertHTML", false, h)
      : t.includes("\n") ? paste(t) || document.execCommand("insertText", false, t) : insertText(t);
    if (!done || !marked) return;
    await settled(el, t.replace(T.CARET, ""));
    if (await takeMark(el)) return;
    caretBack(el, text, back);
    document.dispatchEvent(new Event("selectionchange"));
  }

  // Finds the caret mark in the editor, puts the caret there and deletes the mark. False if the mark isn't there.
  async function takeMark(el) {
    const find = () => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const at = n.data.indexOf(T.CARET);
        if (at >= 0) return { node: n, at };
      }
      return null;
    };
    for (let tries = 0; tries < 3; tries++) {
      const hit = find();
      if (!hit) return tries > 0;
      const r = document.createRange();
      r.setStart(hit.node, hit.at);
      r.setEnd(hit.node, hit.at + 1);
      const sel = selectionFor(el);
      sel.removeAllRanges();
      sel.addRange(r);
      await selectionTold();
      // Through the editor, like a key press, so its own copy of the text loses the mark too
      deleteSelection();
      await selectionTold();
    }
    return !find();
  }

  // Editors that do their own typing (CKEditor, Lexical, Slate) take it from a beforeinput event like a key press
  // sends. Anything that doesn't take that gets the browser's own insert or delete.
  function askPage(name, detail) {
    const root = document.documentElement;
    root.removeAttribute("data-typefill-pasted");
    window.dispatchEvent(new CustomEvent(name, { detail }));
    const taken = root.getAttribute("data-typefill-pasted") === "1";
    root.removeAttribute("data-typefill-pasted");
    return taken;
  }

  function insertText(text) {
    return askPage("typefill-insert", text) || document.execCommand("insertText", false, text);
  }

  function deleteSelection() {
    return askPage("typefill-delete", "") || document.execCommand("delete");
  }

  // The page's own world makes the paste, so the page can read it in every browser. True if the page took it.
  function paste(text, html = null) {
    const root = document.documentElement;
    root.removeAttribute("data-typefill-pasted");
    window.dispatchEvent(new CustomEvent("typefill-paste", { detail: JSON.stringify({ text, html }) }));
    const taken = root.getAttribute("data-typefill-pasted") === "1";
    root.removeAttribute("data-typefill-pasted");
    return taken;
  }

  async function readClipboard() {
    try { return await navigator.clipboard.readText(); } catch { /* falls back below */ }
    // The clipboardRead permission lets a paste into a hidden box read it where the async API is refused
    const active = document.activeElement;
    const box = document.createElement("textarea");
    box.style.cssText = "position: fixed; top: -100px; opacity: 0;";
    document.documentElement.append(box);
    box.focus();
    let text = "";
    try { if (document.execCommand("paste")) text = box.value; } catch { /* nothing to read */ }
    box.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    return text;
  }

  function bumpUse(id) {
    api.runtime.sendMessage({ type: "used", id }).catch(() => {});
  }

  // ---- Google Docs ----

  function watchDocs() {
    let typed = "";
    document.addEventListener("keydown", (e) => {
      if (!enabled || busy || !snippets.length) return;
      if (e.ctrlKey || e.metaKey || e.altKey) { typed = ""; return; }
      if (e.key === "Backspace") { typed = typed.slice(0, -1); return; }
      if (e.key.length !== 1) { if (e.key !== "Shift") typed = ""; return; }
      typed = (typed + e.key).slice(-Math.max(longest, 1) * 2);
      const s = match(typed);
      if (!s) return;
      typed = "";
      // Let Docs put the last letter in first
      setTimeout(() => void expand(docsTarget(), s, s.shortcut), 30);
    }, true);
    document.addEventListener("mousedown", () => { typed = ""; }, true);
    window.top.document.addEventListener("mousedown", () => { typed = ""; }, true);
  }

  function docsTarget() {
    const editable = document.activeElement?.isContentEditable ? document.activeElement : document.querySelector("[contenteditable=true]") ?? document.body;
    return {
      kind: "docs",
      refocus: () => editable.focus(),
      replace: async (length, { text, back, html }) => {
        editable.focus();
        for (let i = 0; i < length; i++) docsKey("Backspace", 8);
        paste(text, html);
        if (!back) return;
        // Docs takes the paste in a moment later, and a key sent before that lands ahead of the pasted text
        await new Promise((r) => setTimeout(r, 150));
        for (let i = 0; i < back; i++) docsKey("ArrowLeft", 37);
      },
    };
  }

  // Docs reads keyCode, which a made-up key event can't set from here, so the page's own world sends it
  function docsKey(key, keyCode) {
    window.dispatchEvent(new CustomEvent("typefill-key", { detail: JSON.stringify({ key, keyCode }) }));
  }

  // ---- boxes shown over the page ----

  // A closed shadow root on the top page, so the page's styles and scripts can't reach in. The box is a modal dialog:
  // a page's own modal (LinkedIn's post box) sits above every z-index and makes the rest of the page unclickable, and
  // only a modal opened after it comes out in front and takes the keyboard.
  function overlay(css, html) {
    const doc = (() => { try { return window.top.document; } catch { return document; } })();
    const host = doc.createElement("typefill-box");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>${BASE_CSS}${css}</style><dialog class="layer"><div class="back"></div>${html}</dialog>`;
    doc.documentElement.append(host);
    const layer = shadow.querySelector(".layer");
    // Esc is handled by each box's own key handler
    layer.addEventListener("cancel", (e) => e.preventDefault());
    try { layer.showModal(); } catch { layer.setAttribute("open", ""); }
    return { doc, host, shadow };
  }

  // guard.js, loaded before the page's scripts, hands key presses for the open box to this handler before a page like
  // Gmail can swallow them. Only when the box sits in this frame's own page.
  function keysTo(doc, handler) {
    if (doc === document) globalThis.__typefillKey = handler;
  }

  // problems: things that went wrong getting the snippet ready (a sheet that couldn't be read), shown above the fields
  function askForm(snippet, prepared, fields, ctx, problems = []) {
    return new Promise((resolve) => {
      const { doc, host, shadow } = overlay("", `
        <form class="box" role="dialog" aria-label="Fill in the snippet">
          <div class="head"><strong></strong><span class="hint">Enter to insert, Esc to cancel</span></div>
          <div class="problems"></div>
          <div class="fields"></div>
          <div class="preview" aria-label="Preview"></div>
          <div class="buttons"><button type="button" class="cancel">Cancel</button><button type="submit" class="ok">Insert</button></div>
        </form>`);
      shadow.querySelector("strong").textContent = snippet.label || snippet.shortcut || "Snippet";
      const box = shadow.querySelector(".fields");
      const preview = shadow.querySelector(".preview");
      const values = {};
      const inputs = [];
      for (const f of fields) {
        const row = doc.createElement("label");
        row.className = "row";
        const name = doc.createElement("span");
        name.textContent = f.name;
        let input;
        if (f.kind === "formparagraph") { input = doc.createElement("textarea"); input.rows = 3; input.value = f.default; }
        else if (f.kind === "formmenu") {
          input = doc.createElement("select");
          for (const o of f.options) { const opt = doc.createElement("option"); opt.value = o; opt.textContent = o; input.append(opt); }
          input.value = f.default;
        } else if (f.kind === "formtoggle") { input = doc.createElement("input"); input.type = "checkbox"; input.checked = f.default; row.classList.add("check"); }
        else if (f.kind === "formdate") { input = doc.createElement("input"); input.type = "date"; input.value = f.default; }
        else { input = doc.createElement("input"); input.type = "text"; input.value = f.default; }
        const read = () => { values[f.name] = f.kind === "formtoggle" ? input.checked : input.value; };
        read();
        input.addEventListener("input", () => { read(); show(); });
        input.addEventListener("change", () => { read(); show(); });
        if (f.kind === "formtoggle") row.append(input, name); else row.append(name, input);
        box.append(row);
        inputs.push(input);
      }
      for (const p of problems) {
        const line = doc.createElement("p");
        line.className = "problem";
        line.textContent = p;
        shadow.querySelector(".problems").append(line);
      }
      // Key steps show as [tab] and the like in the preview
      const show = () => {
        const parts = output(prepared, values, ctx).text.split(T.ACTION);
        preview.textContent = parts.map((p, i) => (i ? `[${ctx.actions[i - 1]?.type === "wait" ? "pause" : ctx.actions[i - 1]?.key}]` : "") + p).join("");
      };
      show();

      let finished = false;
      const done = (result) => {
        if (finished) return;
        finished = true;
        globalThis.__typefillKey = null;
        host.remove();
        resolve(result);
      };
      const form = shadow.querySelector("form");
      form.addEventListener("submit", (e) => { e.preventDefault(); done({ ...values }); });
      const onKey = (e) => {
        // Keys typed in the box stay in the box, so the page underneath doesn't act on them
        e.stopPropagation();
        const at = shadow.activeElement;
        if (e.key === "Escape") { e.preventDefault(); done(null); return; }
        if (e.key !== "Enter" || at instanceof HTMLButtonElement) return;
        if (at instanceof HTMLTextAreaElement && !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        done({ ...values });
      };
      form.addEventListener("keydown", onKey);
      keysTo(doc, onKey);
      shadow.querySelector(".cancel").addEventListener("click", () => done(null));
      shadow.querySelector(".back").addEventListener("mousedown", () => done(null));
      (inputs[0] ?? shadow.querySelector(".ok")).focus();
      inputs[0]?.select?.();
    });
  }

  // A message with one button, for a snippet that can't go in (it needs Pro)
  function notice(snippet, message) {
    return new Promise((resolve) => {
      const { doc, host, shadow } = overlay("", `
        <div class="box" role="alertdialog" aria-label="Typefill">
          <div class="head"><strong></strong></div>
          <p class="message"></p>
          <div class="buttons"><button type="button" class="ok">OK</button></div>
        </div>`);
      shadow.querySelector("strong").textContent = snippet.label || snippet.shortcut || "Snippet";
      shadow.querySelector(".message").textContent = message;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        globalThis.__typefillKey = null;
        host.remove();
        resolve();
      };
      const onKey = (e) => {
        e.stopPropagation();
        if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); done(); }
      };
      shadow.querySelector(".box").addEventListener("keydown", onKey);
      keysTo(doc, onKey);
      shadow.querySelector(".ok").addEventListener("click", done);
      shadow.querySelector(".back").addEventListener("mousedown", done);
      shadow.querySelector(".ok").focus();
    });
  }

  // Find a snippet by name, shortcut, folder or words in it, and put it in where the caret was
  async function openSearch(target) {
    const saved = saveCaret(target);
    busy = true;
    const chosen = await new Promise((resolve) => {
      const { doc, host, shadow } = overlay(SEARCH_CSS, `
        <div class="box" role="dialog" aria-label="Find a snippet">
          <input class="q" type="search" placeholder="Find a snippet" aria-label="Find a snippet" autocomplete="off">
          <ul class="results" role="listbox"></ul>
          <div class="hint">Up and down to pick, Enter to insert, Esc to close</div>
        </div>`);
      const q = shadow.querySelector(".q");
      const results = shadow.querySelector(".results");
      let shown = [], at = 0;
      const draw = () => {
        const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const hay = (s) => [s.shortcut, s.label, s.folder, s.rich ? H.toText(s.html ?? "") : s.text].join(" ").toLowerCase();
        shown = all.filter((s) => !s.off && words.every((w) => hay(s).includes(w))).slice(0, 8);
        at = Math.min(at, Math.max(0, shown.length - 1));
        results.textContent = "";
        shown.forEach((s, i) => {
          const li = doc.createElement("li");
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", String(i === at));
          const top = doc.createElement("div");
          const name = doc.createElement("strong");
          name.textContent = s.label || s.shortcut || "Snippet";
          const key = doc.createElement("code");
          key.textContent = s.shortcut ?? "";
          top.append(name, key);
          const what = doc.createElement("div");
          what.className = "what";
          what.textContent = (s.rich ? H.toText(s.html ?? "") : s.text ?? "").replace(/\s+/g, " ").slice(0, 90);
          li.append(top, what);
          li.addEventListener("mousedown", (e) => { e.preventDefault(); done(s); });
          results.append(li);
        });
        if (!shown.length) {
          const li = doc.createElement("li");
          li.className = "none";
          li.textContent = all.length ? "Nothing matches." : "No snippets yet.";
          results.append(li);
        }
      };
      let finished = false;
      const done = (result) => {
        if (finished) return;
        finished = true;
        globalThis.__typefillKey = null;
        host.remove();
        resolve(result);
      };
      q.addEventListener("input", () => { at = 0; draw(); });
      const onKey = (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); done(null); }
        else if (e.key === "ArrowDown") { e.preventDefault(); at = Math.min(at + 1, shown.length - 1); draw(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); at = Math.max(at - 1, 0); draw(); }
        else if (e.key === "Enter") { e.preventDefault(); if (shown[at]) done(shown[at]); }
      };
      shadow.querySelector(".box").addEventListener("keydown", onKey);
      keysTo(doc, onKey);
      shadow.querySelector(".back").addEventListener("mousedown", () => done(null));
      draw();
      q.focus();
    });
    busy = false;
    restoreCaret(target, saved);
    if (chosen) await expand(target, chosen, "");
  }

  const BASE_CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: transparent; overflow: hidden; }
    .layer::backdrop { background: transparent; }
    .back { position: fixed; inset: 0; background: rgba(20, 22, 28, .28); }
    .box { position: fixed; top: 12vh; left: 50%; transform: translateX(-50%); width: min(440px, calc(100vw - 32px));
      max-height: 76vh; overflow: auto; box-sizing: border-box; padding: 18px; border-radius: 12px;
      background: #fff; color: #1d1f24; box-shadow: 0 18px 50px rgba(0,0,0,.25);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 12px; }
    .head strong { font-size: 15px; }
    .hint { color: #6b7080; font-size: 12px; }
    .row { display: grid; gap: 4px; margin-bottom: 10px; font-weight: 500; }
    .row.check { display: flex; align-items: center; gap: 8px; }
    input[type=text], input[type=date], input[type=search], textarea, select { font: inherit; padding: 7px 9px; border: 1px solid #c9ccd6; border-radius: 7px; background: #fff; color: inherit; }
    input:focus, textarea:focus, select:focus, button:focus-visible { outline: 2px solid #3d6cf0; outline-offset: 1px; }
    .preview { white-space: pre-wrap; background: #f4f5f8; border-radius: 8px; padding: 10px; margin: 6px 0 14px; max-height: 180px; overflow: auto; color: #2b2e36; }
    .buttons { display: flex; justify-content: flex-end; gap: 8px; }
    button { font: inherit; padding: 7px 14px; border-radius: 7px; border: 1px solid #c9ccd6; background: #fff; color: inherit; cursor: pointer; }
    .ok { background: #3d6cf0; border-color: #3d6cf0; color: #fff; }
    .message { margin: 0 0 14px; }
    .problem { margin: 0 0 10px; padding: 8px 10px; border-radius: 7px; background: #fff4e5; color: #8a4b08; }
    @media (prefers-color-scheme: dark) {
      .box { background: #23252c; color: #e8e9ee; }
      .hint { color: #a0a4b2; }
      input[type=text], input[type=date], input[type=search], textarea, select, button { background: #2c2f37; border-color: #474b57; }
      .preview { background: #1b1d22; color: #d9dbe2; }
      .ok { background: #5b84f5; border-color: #5b84f5; }
    }`;

  const SEARCH_CSS = `
    .box { padding: 12px; }
    .q { width: 100%; box-sizing: border-box; font-size: 15px; padding: 9px 11px; }
    .results { list-style: none; margin: 8px 0; padding: 0; }
    .results li { padding: 8px 10px; border-radius: 8px; cursor: pointer; }
    .results li[aria-selected="true"] { background: #eaf0ff; }
    .results li > div:first-child { display: flex; justify-content: space-between; gap: 10px; }
    .results code { font: 12px ui-monospace, Consolas, monospace; color: #6b7080; }
    .results .what { color: #6b7080; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .results .none { color: #6b7080; cursor: default; }
    @media (prefers-color-scheme: dark) {
      .results li[aria-selected="true"] { background: #2a3350; }
      .results code, .results .what, .results .none { color: #a0a4b2; }
    }`;
  // What Typefill Pro (pro-content.js) borrows from here
  globalThis.__typefillCore = { put, currentTarget, askPage, docsKey, deepActive, inDocsFrame };
})();
