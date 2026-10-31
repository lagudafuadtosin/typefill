// Starter snippets on first install, use counts, the search box key, and sync between computers through the browser's
// own account sync (Chrome or Firefox). Nothing goes to any server of ours.
// Typefill Pro adds its own background script next to this one (pro-background.js) in the Pro build.

const api = globalThis.browser ?? globalThis.chrome;

const STARTERS = [
  { shortcut: "/date", label: "Today's date", text: "{time: D MMMM YYYY}" },
  { shortcut: "/thanks", label: "Thank you reply", text: "Hi {formtext: name=Name},\n\nThanks for getting in touch. {cursor}\n\nBest wishes" },
  { shortcut: "/meet", label: "Meeting time", text: "Could we meet on {formdate: name=Day; format=dddd D MMMM; default=+1D} at {formmenu: name=Time; default=10:00; 11:00; 14:00; 15:00}?" },
];

api.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  const { snippets } = await api.storage.local.get("snippets");
  if (!snippets) {
    const now = Date.now();
    await api.storage.local.set({ snippets: STARTERS.map((s, i) => ({ id: `s${now}${i}`, ...s, folder: "Starters", created: now, edited: now })) });
  }
  api.runtime.openOptionsPage();
});

api.action.onClicked.addListener(() => api.runtime.openOptionsPage());

// The search box opens in whichever frame of the tab has the caret
api.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "open-search") return;
  const id = tab?.id ?? (await api.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (id != null) api.tabs.sendMessage(id, { type: "search" }).catch(() => {});
});

// Use counts live apart from the snippets, so a count never overwrites an edit made at the same moment.
// One write at a time, so two quick expansions don't lose a count.
let queue = Promise.resolve();
api.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "used" && msg.id) {
    queue = queue.then(async () => {
      const { uses = {} } = await api.storage.local.get("uses");
      uses[msg.id] = { n: (uses[msg.id]?.n ?? 0) + 1, last: Date.now() };
      await api.storage.local.set({ uses });
    }).catch(() => {});
  }
  if (msg?.type === "sync-now") void pull().then(push);
});

// ---- sync ----
// The browser syncs about 100 KB per extension, 8 KB per item. The snippets go up as JSON cut into pieces under that,
// with a note saying how many pieces and when. Each computer merges by snippet: the newer edit wins, and a delete
// wins over anything older than it.

const PIECE = 3000;
const LIMIT = 90000;
let applying = false;
let pushTimer = 0;

async function device() {
  const { device } = await api.storage.local.get("device");
  if (device) return device;
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  await api.storage.local.set({ device: id });
  return id;
}

async function syncOn() {
  const { settings = {} } = await api.storage.local.get("settings");
  return settings.sync !== false;
}

async function setState(state) {
  await api.storage.local.set({ syncState: { ...state, checked: Date.now() } });
}

function stamp(s) {
  return s.edited ?? s.created ?? 0;
}

function merge(local, localDeleted, remote, remoteDeleted) {
  const deleted = { ...localDeleted };
  for (const [id, at] of Object.entries(remoteDeleted ?? {})) deleted[id] = Math.max(deleted[id] ?? 0, at);
  const byId = new Map();
  for (const s of [...local, ...(remote ?? [])]) {
    const have = byId.get(s.id);
    if (!have || stamp(s) > stamp(have)) byId.set(s.id, s);
  }
  // Local order first, then anything new from the other computer
  const order = [...new Set([...local.map((s) => s.id), ...(remote ?? []).map((s) => s.id)])];
  const snippets = order.map((id) => byId.get(id)).filter((s) => s && !(deleted[s.id] >= stamp(s)));
  return { snippets, deleted };
}

async function pull() {
  if (!(await syncOn())) return;
  const meta = (await api.storage.sync.get("meta")).meta;
  if (!meta?.n) return;
  const { lastPulled = 0 } = await api.storage.local.get("lastPulled");
  const me = await device();
  if (meta.device === me || meta.at <= lastPulled) return;
  const keys = Array.from({ length: meta.n }, (_, i) => `p${i}`);
  const pieces = await api.storage.sync.get(keys);
  // Pieces from a write still arriving: wait for the rest
  if (keys.some((k) => typeof pieces[k] !== "string")) return;
  let remote;
  try { remote = JSON.parse(keys.map((k) => pieces[k]).join("")); } catch { return; }
  if (remote.at !== meta.at) return;
  const local = await api.storage.local.get(["snippets", "deleted"]);
  const merged = merge(local.snippets ?? [], local.deleted ?? {}, remote.snippets, remote.deleted);
  applying = true;
  try {
    await api.storage.local.set({ ...merged, lastPulled: meta.at });
  } finally {
    applying = false;
  }
  await setState({ ok: true, at: meta.at });
}

async function push() {
  if (!(await syncOn())) { await setState({ ok: false, off: true }); return; }
  const { snippets = [], deleted = {} } = await api.storage.local.get(["snippets", "deleted"]);
  // Deletes older than 60 days have reached every computer that syncs at all
  const cutoff = Date.now() - 60 * 864e5;
  for (const [id, at] of Object.entries(deleted)) if (at < cutoff) delete deleted[id];
  const at = Date.now();
  const body = JSON.stringify({ at, snippets, deleted });
  const pieces = [];
  for (let i = 0; i < body.length; i += PIECE) pieces.push(body.slice(i, i + PIECE));
  const size = pieces.reduce((n, p) => n + JSON.stringify(p).length + 4, 0);
  if (size > LIMIT) {
    await setState({ ok: false, tooBig: true, size, limit: LIMIT });
    return;
  }
  const old = (await api.storage.sync.get("meta")).meta;
  const items = { meta: { n: pieces.length, at, device: await device() } };
  pieces.forEach((p, i) => { items[`p${i}`] = p; });
  try {
    await api.storage.sync.set(items);
    if (old?.n > pieces.length) await api.storage.sync.remove(Array.from({ length: old.n - pieces.length }, (_, i) => `p${pieces.length + i}`));
    await setState({ ok: true, at, size, limit: LIMIT });
  } catch (err) {
    await setState({ ok: false, error: String(err?.message ?? err) });
  }
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.meta) void pull();
  if (area === "local" && (changes.snippets || changes.deleted) && !applying) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void push(), 2000);
  }
  if (area === "local" && changes.settings && changes.settings.newValue?.sync !== changes.settings.oldValue?.sync) void pull().then(push);
});

// On start: take what other computers sent while this one was off
void pull();
