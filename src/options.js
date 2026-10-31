// The snippet list: pick, edit, add, delete, search, folders, formatting, import and export. Edits save as you type.

const api = globalThis.browser ?? globalThis.chrome;
const T = globalThis.TFTemplate;
const H = globalThis.TFHtml;
const $ = (id) => document.getElementById(id);

let snippets = [];
let uses = {};
let settings = {};
let current = null;

async function start() {
  const data = await api.storage.local.get(["snippets", "uses", "settings", "syncState"]);
  snippets = data.snippets ?? [];
  uses = data.uses ?? {};
  settings = data.settings ?? {};
  $("enabled").checked = settings.enabled !== false;
  $("syncOn").checked = settings.sync !== false;
  $("blocked").value = (settings.blockedSites ?? []).join(", ");
  showSync(data.syncState);
  try {
    const cmd = (await api.commands.getAll()).find((c) => c.name === "open-search");
    $("searchKey").textContent = cmd?.shortcut || "a key you set in the browser's extension shortcuts";
  } catch { /* the default stays */ }
  drawList();
  const first = sorted()[0];
  if (first) pick(first.id);
}

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.uses) { uses = changes.uses.newValue ?? {}; drawList(); }
  if (changes.syncState) showSync(changes.syncState.newValue);
  // Snippets that came in from another computer
  if (changes.snippets && !saving) {
    snippets = changes.snippets.newValue ?? [];
    drawList();
    if (!snippets.some((s) => s.id === current)) pick(sorted()[0]?.id ?? null);
  }
});

function showSync(state) {
  const el = $("syncState");
  el.classList.toggle("bad", !!state && !state.ok && !state.off);
  if (!state || state.off) { el.textContent = settings.sync === false ? "Sync is off. Snippets stay on this computer." : ""; return; }
  if (state.tooBig) { el.textContent = `Too much to sync (${Math.round(state.size / 1000)} KB of ${Math.round(state.limit / 1000)} KB). Use Export and Import to move snippets.`; return; }
  if (state.error) { el.textContent = `Sync stopped: ${state.error}`; return; }
  el.textContent = `Synced through your browser account · ${Math.round((state.size ?? 0) / 1000)} KB of ${Math.round((state.limit ?? 90000) / 1000)} KB`;
}

// Folders in A to Z order with snippets that have no folder first, A to Z by shortcut inside each
function sorted() {
  return [...snippets].sort((a, b) => (a.folder ?? "").localeCompare(b.folder ?? "") || (a.shortcut ?? "").localeCompare(b.shortcut ?? ""));
}

function plainOf(s) {
  return s.rich ? H.toText(s.html ?? "") : s.text ?? "";
}

function drawList() {
  const q = $("search").value.trim().toLowerCase();
  const list = $("list");
  list.textContent = "";
  const shown = sorted().filter((s) => !q || [s.shortcut, s.label, s.folder, plainOf(s)].some((v) => (v ?? "").toLowerCase().includes(q)));
  let folder = null;
  for (const s of shown) {
    if ((s.folder ?? "") !== folder) {
      folder = s.folder ?? "";
      if (folder) {
        const head = document.createElement("div");
        head.className = "folder";
        head.textContent = folder;
        list.append(head);
      }
    }
    const item = document.createElement("div");
    item.className = "item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(s.id === current));
    item.tabIndex = 0;
    if (s.off) item.classList.add("off");
    const key = document.createElement("span");
    key.className = "key";
    key.textContent = s.shortcut || "(no shortcut)";
    const what = document.createElement("span");
    what.className = "what";
    const n = uses[s.id]?.n ?? 0;
    what.textContent = `${s.label || plainOf(s).split("\n")[0].slice(0, 60)}${n ? ` · used ${n}` : ""}`;
    item.append(key, what);
    item.addEventListener("click", () => pick(s.id));
    item.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(s.id); });
    list.append(item);
  }
  if (!shown.length) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = q ? "Nothing matches." : "No snippets yet.";
    list.append(note);
  }
  const folders = $("folders");
  folders.textContent = "";
  for (const f of [...new Set(snippets.map((s) => s.folder).filter(Boolean))].sort()) {
    const o = document.createElement("option");
    o.value = f;
    folders.append(o);
  }
}

function pick(id) {
  current = id;
  const s = snippets.find((x) => x.id === id);
  $("editor").hidden = !s;
  $("empty").hidden = !!s;
  if (!s) { drawList(); return; }
  $("shortcut").value = s.shortcut ?? "";
  $("label").value = s.label ?? "";
  $("folder").value = s.folder ?? "";
  $("off").checked = !!s.off;
  $("rich").checked = !!s.rich;
  $("text").value = s.text ?? "";
  $("richText").innerHTML = s.rich ? H.sanitize(s.html ?? "") : "";
  showMode();
  $("saved").textContent = "";
  hideAsk();
  resetDelete();
  showClash();
  showPreview();
  drawList();
}

function showMode() {
  const rich = $("rich").checked;
  $("text").hidden = rich;
  $("richText").hidden = !rich;
  $("formatBar").hidden = !rich;
}

function showPreview() {
  const s = snippets.find((x) => x.id === current);
  if (!s) return;
  const rich = !!s.rich;
  const resolve = (shortcut) => {
    const o = snippets.find((x) => x.shortcut === shortcut.trim() && x.id !== s.id);
    if (!o) return null;
    if (rich) return o.rich ? o.html ?? "" : H.fromText(o.text ?? "");
    return plainOf(o);
  };
  const tree = T.parse(rich ? s.html ?? "" : s.text ?? "", resolve);
  const fields = T.fields(tree);
  // Fields show their default, or their name in brackets when they have none and no formula needs a number from them
  const values = {};
  const uses = proUsedIn(tree, fields);
  for (const f of fields) values[f.name] = f.kind === "formtoggle" ? f.default : f.default || (uses.includes("formulas") || uses.includes("if blocks") ? "" : `[${f.name}]`);
  const ctx = { now: new Date(), clipboard: "[clipboard]", site: (node) => `[page ${node.plain[0] ?? "text"}]` };
  const parts = T.render(tree, values, ctx, rich).replace(T.CARET, "").split(T.ACTION);
  const out = parts.map((p, i) => (i ? `[${ctx.actions[i - 1]?.type === "wait" ? "pause" : ctx.actions[i - 1]?.key}]` : "") + p).join("");
  if (rich) $("preview").innerHTML = H.sanitize(out);
  else $("preview").textContent = out;
  const note = $("proNote");
  note.hidden = !uses.length;
  // Typefill Pro, when it's part of this build, says whether it's unlocked (pro-options.js)
  const page = globalThis.TypefillProPage;
  const on = !!page?.isOn();
  note.classList.toggle("locked", !on);
  note.textContent = uses.length ? `Uses Typefill Pro: ${uses.join(", ")}.${on ? "" : page ? " It won't go in until Pro is unlocked below." : " This copy of Typefill doesn't include Pro."}` : "";
}

function proUsedIn(tree, fields) {
  return T.proParts(tree, new Set(fields.map((f) => f.name.toLowerCase())));
}

// Two snippets where one shortcut ends the other: the shorter one would always win while typing
function showClash() {
  const me = $("shortcut").value.trim();
  const other = me && snippets.find((s) => s.id !== current && s.shortcut && !s.off && (s.shortcut === me || me.endsWith(s.shortcut) || s.shortcut.endsWith(me)));
  const el = $("clash");
  el.hidden = !other;
  if (other) el.textContent = other.shortcut === me
    ? `${other.shortcut} is already used by another snippet.`
    : `${other.shortcut} and ${me} overlap, so typing the longer one sets off the shorter one first.`;
}

let saveTimer = 0;
let saving = false;
function edited() {
  const s = snippets.find((x) => x.id === current);
  if (!s) return;
  s.shortcut = $("shortcut").value.trim();
  s.label = $("label").value.trim();
  s.folder = $("folder").value.trim();
  s.off = $("off").checked;
  if (s.rich) s.html = H.sanitize($("richText").innerHTML);
  else s.text = $("text").value;
  s.edited = Date.now();
  showClash();
  showPreview();
  drawList();
  clearTimeout(saveTimer);
  $("saved").textContent = "Saving";
  saveTimer = setTimeout(save, 300);
}

async function save(extra = {}) {
  saving = true;
  try {
    await api.storage.local.set({ snippets, ...extra });
  } finally {
    saving = false;
  }
  $("saved").textContent = "Saved";
}

for (const id of ["shortcut", "label", "folder", "text"]) $(id).addEventListener("input", edited);
$("richText").addEventListener("input", edited);
$("off").addEventListener("change", edited);
$("search").addEventListener("input", drawList);

// Formatting on keeps the words and lets you style them. Off turns it back into plain text.
$("rich").addEventListener("change", () => {
  const s = snippets.find((x) => x.id === current);
  if (!s) return;
  if ($("rich").checked) {
    s.rich = true;
    s.html = H.fromText($("text").value);
    $("richText").innerHTML = s.html;
  } else {
    s.rich = false;
    s.text = H.toText(H.sanitize($("richText").innerHTML));
    delete s.html;
    $("text").value = s.text;
  }
  showMode();
  edited();
});

// Toolbar buttons keep the caret where it was in the text
let lastRange = null;
document.addEventListener("selectionchange", () => {
  const sel = document.getSelection();
  if (sel.rangeCount && $("richText").contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange();
});
function focusRich() {
  const el = $("richText");
  el.focus();
  if (lastRange && el.contains(lastRange.startContainer)) {
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(lastRange);
  }
}

for (const b of document.querySelectorAll(".tools button, .format-bar button")) b.addEventListener("mousedown", (e) => e.preventDefault());

function insertToken(token) {
  if ($("rich").checked) {
    focusRich();
    document.execCommand("insertText", false, token);
  } else {
    const ta = $("text");
    ta.focus();
    ta.setRangeText(token, ta.selectionStart, ta.selectionEnd, "end");
    edited();
  }
}

for (const bar of document.querySelectorAll(".tools")) bar.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-insert]");
  if (btn) insertToken(btn.dataset.insert);
});

$("formatBar").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cmd]");
  if (!btn) return;
  const cmd = btn.dataset.cmd;
  if (cmd === "link") { ask("Link address, like https://example.com", (url) => { if (/^(https?:|mailto:)/i.test(url)) { focusRich(); document.execCommand("createLink", false, url); } }); return; }
  if (cmd === "image") { ask("Picture address, starting https://", (url) => { if (/^https:/i.test(url)) { focusRich(); document.execCommand("insertImage", false, url); } }); return; }
  focusRich();
  document.execCommand(cmd);
});

$("importBtn").addEventListener("click", () => {
  const others = snippets.filter((s) => s.id !== current && s.shortcut).map((s) => s.shortcut);
  ask(others.length ? `Shortcut of the snippet to put in, like ${others[0]}` : "Shortcut of the snippet to put in", (shortcut) => insertToken(`{import: ${shortcut}}`));
});

// A small row under the text for a link, a picture or a shortcut, in place of a pop-up
let askDone = null;
function ask(placeholder, then) {
  $("ask").hidden = false;
  $("askInput").value = "";
  $("askInput").placeholder = placeholder;
  $("askInput").focus();
  askDone = then;
}
function hideAsk() { $("ask").hidden = true; askDone = null; }
$("askOk").addEventListener("click", () => { const v = $("askInput").value.trim(); const then = askDone; hideAsk(); if (v && then) then(v); });
$("askCancel").addEventListener("click", hideAsk);
$("askInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("askOk").click(); }
  if (e.key === "Escape") hideAsk();
});

$("add").addEventListener("click", async () => {
  const now = Date.now();
  const s = { id: newId(), shortcut: "", label: "", folder: snippets.find((x) => x.id === current)?.folder ?? "", text: "", created: now, edited: now };
  snippets.unshift(s);
  await save();
  $("search").value = "";
  pick(s.id);
  $("shortcut").focus();
});

function newId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Delete asks for a second click instead of a pop-up. The delete is remembered so sync takes it to other computers.
let armed = false;
function resetDelete() { armed = false; $("delete").textContent = "Delete"; }
$("delete").addEventListener("click", async () => {
  if (!armed) { armed = true; $("delete").textContent = "Click again to delete"; return; }
  const order = sorted();
  const i = order.findIndex((x) => x.id === current);
  snippets = snippets.filter((x) => x.id !== current);
  const { deleted = {} } = await api.storage.local.get("deleted");
  deleted[current] = Date.now();
  await save({ deleted });
  const next = order.filter((x) => x.id !== current)[Math.min(i, order.length - 2)];
  pick(next?.id ?? null);
});
$("delete").addEventListener("blur", resetDelete);

$("enabled").addEventListener("change", saveSettings);
$("syncOn").addEventListener("change", saveSettings);
$("blocked").addEventListener("change", saveSettings);
async function saveSettings() {
  const blockedSites = $("blocked").value.split(/[,\s]+/).map((h) => h.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
  settings = { ...settings, enabled: $("enabled").checked, sync: $("syncOn").checked, blockedSites };
  await api.storage.local.set({ settings });
  if (!settings.sync) showSync({ off: true });
}

$("export").addEventListener("click", () => {
  const out = {
    app: "typefill", version: 1,
    snippets: sorted().map(({ shortcut, label, folder, text, rich, html, off }) => ({ shortcut, label, ...(folder ? { folder } : {}), ...(rich ? { rich, html } : { text }), ...(off ? { off } : {}) })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "typefill-snippets.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (!file) return;
  const raw = await file.text();
  let incoming = [];
  try { incoming = /\.csv$/i.test(file.name) ? readCsv(raw) : readJson(JSON.parse(raw)); } catch { incoming = []; }
  if (!incoming.length) { flash("That file has no snippets Typefill can read."); return; }
  // A snippet with the same shortcut is updated, anything new is added
  const now = Date.now();
  let added = 0, updated = 0;
  for (const s of incoming) {
    const same = s.shortcut && snippets.find((x) => x.shortcut === s.shortcut);
    if (same) { Object.assign(same, s, { edited: now }); if (!s.rich) { delete same.rich; delete same.html; } updated++; }
    else { snippets.push({ id: newId(), created: now, edited: now, ...s }); added++; }
  }
  await save();
  drawList();
  if (!current) pick(sorted()[0]?.id ?? null);
  flash(`Imported ${added} new and updated ${updated}.`);
});

// Typefill's own export, a Text Blaze export (folders, each with snippets), or any list with a shortcut and text
function readJson(data) {
  const out = [];
  const one = (s, folder) => {
    const shortcut = String(s.shortcut ?? s.abbreviation ?? s.trigger ?? "").trim();
    const label = String(s.label ?? s.name ?? s.title ?? "");
    const f = String(s.folder ?? folder ?? "");
    if (s.rich && s.html) { out.push({ shortcut, label, folder: f, rich: true, html: H.sanitize(String(s.html)) }); return; }
    const text = String(s.text ?? s.content ?? s.body ?? s.snippet ?? "");
    if (text) out.push({ shortcut, label, folder: f, text });
  };
  if (Array.isArray(data?.folders)) for (const f of data.folders) for (const s of f.snippets ?? []) one(s, f.name);
  const list = Array.isArray(data) ? data : Array.isArray(data?.snippets) ? data.snippets : [];
  for (const s of list) one(s);
  return out;
}

// Columns named shortcut and snippet (or text), and a name if there is one. The first row holds the names.
function readCsv(raw) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === '"' && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && raw[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const sc = col("shortcut", "abbreviation", "trigger"), tx = col("snippet", "text", "content"), nm = col("name", "label", "title"), fd = col("folder");
  if (sc < 0 || tx < 0) return [];
  return rows.filter((r) => r[tx]).map((r) => ({ shortcut: (r[sc] ?? "").trim(), label: nm >= 0 ? r[nm] ?? "" : "", folder: fd >= 0 ? r[fd] ?? "" : "", text: r[tx] }));
}

function flash(msg) {
  $("saved").textContent = msg;
  if ($("editor").hidden) $("emptyNote").textContent = msg;
}

// What Typefill Pro (pro-options.js) calls back
globalThis.__typefillOptions = { showPreview };

start();
