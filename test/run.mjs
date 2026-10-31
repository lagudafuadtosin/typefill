// Loads the built Chrome extension into Chrome for Testing and types into a test page with real key presses
import puppeteer from "puppeteer-core";
import http from "node:http";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FIREFOX = process.env.BROWSER === "firefox";
let ext = resolve(FIREFOX ? "dist/firefox" : "dist/chrome");
// Firefox won't let the test open the extension's own page, so a test-only copy takes snippets from the test page
if (FIREFOX) {
  const testExt = resolve("dist/firefox-test");
  rmSync(testExt, { recursive: true, force: true });
  cpSync(ext, testExt, { recursive: true });
  writeFileSync(`${testExt}/test-seed.js`, `window.addEventListener("message", async (e) => {
    if (e.data?.typefillTest === "set") { await browser.storage.local.set(e.data.value); window.postMessage({ typefillTest: "done" }, "*"); }
    if (e.data?.typefillTest === "get") { const v = await browser.storage.local.get(e.data.key); window.postMessage({ typefillTest: "got", value: v }, "*"); }
  });`);
  const m = JSON.parse(readFileSync(`${testExt}/manifest.json`, "utf8"));
  m.content_scripts.push({ matches: ["http://localhost/*", "http://127.0.0.1/*"], js: ["test-seed.js"], run_at: "document_start" });
  writeFileSync(`${testExt}/manifest.json`, JSON.stringify(m));
  ext = testExt;
}
const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(readFileSync("test/page.html")); }).listen(0);
const url = `http://localhost:${server.address().port}/`;

const browser = FIREFOX
  ? await puppeteer.launch({ browser: "firefox", executablePath: "C:/Program Files/Mozilla Firefox/firefox.exe", headless: !process.env.SHOW, extraPrefsFirefox: { "dom.events.testing.asyncClipboard": true, "extensions.manifestV3.enabled": true, "extensions.webextensions.uuids": JSON.stringify({ "typefill@lagudafuadtosin": "8c0e8a52-6a0e-4d55-9a8e-1b1f2b3c4d5e" }) } })
  : await puppeteer.launch({
    executablePath: process.env.CFT, headless: !process.env.SHOW, slowMo: process.env.SHOW ? 90 : 0, defaultViewport: null,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-first-run"],
  });
let failed = 0, ticks = 0;
const check = (name, got, want) => {
  const ok = typeof want === "function" ? want(got) : got === want;
  if (!ok) failed++;
  ticks++;
  console.log(`${String(ticks).padStart(2)}. ${ok ? "✔" : "✘ FAIL"} ${name}${ok ? "" : `\n     got:  ${JSON.stringify(got)}\n     want: ${typeof want === "function" ? want.toString() : JSON.stringify(want)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, process.env.SHOW ? ms * 3 : ms));

// Put test snippets in through the extension's own page
let opts;
if (FIREFOX) {
  await browser.installExtension(ext);
  await sleep(1500);
  opts = await browser.newPage();
  await opts.goto(url);
  await sleep(500);
  // Same calls as the extension page, passed through the test-only script
  opts.evaluate = ((orig) => async (fn) => {
    const src = fn.toString();
    if (src.includes("storage.local.set")) {
      const value = await orig.call(opts, (code) => { let v; const chrome = { storage: { local: { set: async (x) => { v = x; } } } }; return eval("(" + code + ")")().then(() => v); }, src);
      return orig.call(opts, (value) => new Promise((r) => { addEventListener("message", (e) => e.data?.typefillTest === "done" && r()); postMessage({ typefillTest: "set", value }, "*"); }), value);
    }
    if (src.includes("storage.local.get(\"uses\")")) {
      return orig.call(opts, () => new Promise((r) => { addEventListener("message", (e) => e.data?.typefillTest === "got" && r(e.data.value.uses ?? {})); postMessage({ typefillTest: "get", key: "uses" }, "*"); }));
    }
    return orig.call(opts, fn);
  })(opts.evaluate);
} else {
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker");
  const extId = new URL(worker.url()).host;
  await sleep(800);
  opts = await browser.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
}
await opts.evaluate(async () => {
  await chrome.storage.local.set({ snippets: [
    { id: "a", shortcut: "/date", text: "{time: YYYY-MM-DD}" },
    { id: "b", shortcut: "/thanks", label: "Thanks", text: "Hi {formtext: name=Name},\nThanks! {cursor}\nBest" },
    { id: "c", shortcut: "/meet", text: "Meet {formmenu: name=Day; default=Monday; Tuesday; Wednesday} with {=Day} notes" },
    { id: "d", shortcut: "/sig", text: "Fuad\nPostbarrel" },
    { id: "e", shortcut: "/ps", text: "Hello{formtoggle: name=PS; default=no} PS here{endformtoggle}." },
    { id: "f", shortcut: "/clip", text: "[{clipboard}]" },
    { id: "g", shortcut: "/bold", rich: true, html: "Hi <b>{formtext: name=Who}</b>, see <a href=\"https://example.com\">this</a>" },
    { id: "h", shortcut: "/due", text: "Due {formdate: name=Due; format=YYYY/MM/DD; default=2026-12-25}" },
    { id: "i", shortcut: "/full", text: "Start {import: /sig} end" },
    { id: "j", shortcut: "/xss", text: "{formtext: name=Bad}" },
    { id: "k", shortcut: "/xssrich", rich: true, html: "<i>{formtext: name=Bad}</i><img src=x onerror=\"window.hacked=1\">" },
    { id: "p1", shortcut: "/calc", text: "{formtext: name=Qty; default=3} x 2.50 = {=fixed(Qty * 2.5, 2)}" },
    { id: "p2", shortcut: "/size", text: "{formmenu: name=Size; default=S; M; L}{if: Size = 'L'} large{elseif: Size = 'M'} medium{else} small{endif}" },
    { id: "p3", shortcut: "/who", text: "Dear {site: text; selector=#cust} on {site: title}" },
    { id: "p4", shortcut: "/fill", text: "Sam{key: tab}sam@example.com" },
  ] });
});
const today = await opts.evaluate(() => new Date().toLocaleDateString("en-CA"));

const page = await browser.newPage();
await page.goto(url);
await sleep(500);
const val = (sel) => page.$eval(sel, (el) => (el.value ?? el.innerText));
const clear = async (sel) => { await page.$eval(sel, (el) => { if ("value" in el) el.value = ""; else el.textContent = ""; }); await page.click(sel); };
const formOpen = () => page.evaluate(() => !!document.querySelector("typefill-box"));

// 1. plain input
await page.click("#input");
await page.keyboard.type("on /date ok");
check("input: /date", await val("#input"), `on ${today} ok`);

// 2. textarea with a text box and a caret spot
await page.click("#area");
await page.keyboard.type("/thanks");
await sleep(300);
check("textarea: form opens", await formOpen(), true);
await page.keyboard.type("Sam");
await page.keyboard.press("Enter");
await sleep(200);
check("textarea: form closes", await formOpen(), false);
await page.keyboard.type("X");
check("textarea: text and caret", await val("#area"), "Hi Sam,\nThanks! X\nBest");

// 3. contenteditable with a dropdown and a repeat
await page.click("#ce");
await page.keyboard.type("/meet");
await sleep(300);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await sleep(200);
check("contenteditable: dropdown", await val("#ce"), "Meet Wednesday with Wednesday notes");

// 4. contenteditable, two lines, plain
await page.click("#ce");
await page.keyboard.press("End");
await page.keyboard.type(" /sig");
await sleep(200);
check("contenteditable: two lines", await val("#ce"), (v) => v.startsWith("Meet Wednesday with Wednesday notes Fuad") && v.endsWith("Postbarrel"));

// 5. rich editor taking a paste
await page.click("#rich");
await page.keyboard.type("x /sig");
await sleep(200);
check("rich editor: paste", [await val("#rich"), await page.evaluate(() => window.richPastes), await page.evaluate(() => window.lastPaste)], (v) => v[0].replace(/ /g, " ") === "x Fuad\nPostbarrel" && v[1] === 1);

// 6. toggle off by default, then on
await clear("#input");
await page.keyboard.type("/ps");
await sleep(300);
await page.keyboard.press("Enter");
await sleep(200);
check("toggle: off", await val("#input"), "Hello.");
await page.keyboard.type(" /ps");
await sleep(300);
await page.keyboard.press(" ");
await page.keyboard.press("Enter");
await sleep(200);
check("toggle: ticked", await val("#input"), "Hello. Hello PS here.");

// 7. Escape cancels and leaves the shortcut
await clear("#area");
await page.keyboard.type("/thanks");
await sleep(300);
await page.keyboard.press("Escape");
await sleep(200);
check("escape: shortcut kept", [await val("#area"), await formOpen()], (v) => v[0] === "/thanks" && v[1] === false);

// 8. a framework input hears about the change
await page.click("#react");
await page.keyboard.type("/date");
check("framework input", await page.evaluate(() => window.reactValue), today);

// 9. undo brings the shortcut back
await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
check("undo", await val("#react"), "/date");

// 10. clipboard
if (!FIREFOX) {
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions(new URL(url).origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
await clear("#input");
await page.evaluate(() => navigator.clipboard.writeText("copied text"));
await page.keyboard.type("/clip");
await sleep(400);
check("clipboard", await val("#input"), "[copied text]");
}

// 10b. clipboard on a site that was never given clipboard access, copied with Ctrl+C
const plain = await browser.newPage();
await plain.goto(url.replace("localhost", "127.0.0.1"));
await sleep(500);
await plain.click("#area");
await plain.keyboard.type("second copy");
await plain.keyboard.down("Control"); await plain.keyboard.press("a"); await plain.keyboard.press("c"); await plain.keyboard.up("Control");
await plain.click("#input");
await plain.keyboard.type("/clip");
await sleep(500);
check("clipboard without page permission", await plain.$eval("#input", (el) => el.value), "[second copy]");

await page.bringToFront();
// 11b. an editor that takes the paste a moment later (Outlook): the caret still ends up at {cursor}
await clear("#late");
await page.keyboard.type("/thanks");
await sleep(300);
await page.keyboard.type("Sam");
await page.keyboard.press("Enter");
await sleep(700);
await page.keyboard.type("X");
// trimEnd: emptying the box first leaves Chrome's placeholder line break after the text
check("late editor: caret spot", (await val("#late")).trimEnd(), "Hi Sam,\nThanks! X\nBest");

// 11c. a post box inside the page's own modal dialog (LinkedIn): the form box comes out in front and takes typing
await page.evaluate(() => document.getElementById("modal").showModal());
await page.click("#inmodal");
await page.keyboard.type("/thanks");
await sleep(300);
await page.keyboard.type("Sam");
await page.keyboard.press("Enter");
await sleep(500);
check("inside a page's modal dialog", (await val("#inmodal")).replace(/ /g, " "), (v) => v.startsWith("Hi Sam,"));
await page.evaluate(() => document.getElementById("modal").close());

// 12. formatted snippet in a rich editor: bold and the link arrive as HTML
await page.evaluate(() => { window.lastHtml = null; document.getElementById("rich").addEventListener("paste", (e) => { window.lastHtml = e.clipboardData.getData("text/html"); }, true); });
await clear("#rich");
await page.keyboard.type("/bold");
await sleep(300);
await page.keyboard.type("Sam & Co");
await page.keyboard.press("Enter");
await sleep(300);
check("formatted: html pasted", await page.evaluate(() => window.lastHtml), (h) => /<b>Sam &amp; Co<\/b>/.test(h ?? "") && /href="https:\/\/example.com"/.test(h ?? ""));
check("formatted: text in a plain box", await (async () => { await clear("#input"); await page.keyboard.type("/bold"); await sleep(300); await page.keyboard.type("Sam"); await page.keyboard.press("Enter"); await sleep(200); return val("#input"); })(), "Hi Sam, see this (https://example.com)");

// 13. date picker: the default date, then a typed one
await clear("#input");
await page.keyboard.type("/due");
await sleep(300);
await page.keyboard.press("Enter");
await sleep(200);
check("date picker: default", await val("#input"), "Due 2026/12/25");

// 14. a snippet inside a snippet
await clear("#area");
await page.keyboard.type("/full");
check("snippet inside a snippet", await val("#area"), "Start Fuad\nPostbarrel end");

// 15. what's typed in a field can't add HTML or run script
await clear("#rich");
await page.keyboard.type("/xssrich");
await sleep(300);
await page.keyboard.type("<img src=y onerror=window.hacked=2>");
await page.keyboard.press("Enter");
await sleep(400);
check("field text stays text", [await page.evaluate(() => window.hacked ?? 0), await page.$eval("#rich", (el) => el.querySelectorAll("img").length)], (v) => v[0] === 0 && v[1] === 0);

// 16. the search box puts a snippet in by name
if (!FIREFOX) {
  await clear("#area");
  await page.keyboard.type("Re: ");
  await opts.evaluate(async () => { for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, { type: "search" }).catch(() => {}); });
  await sleep(500);
  await page.keyboard.type("postbarrel");
  await page.keyboard.press("Enter");
  await sleep(300);
  check("search box", await val("#area"), "Re: Fuad\nPostbarrel");
}

// 17. a Pro snippet in the free build: a plain note, and the shortcut stays
await page.bringToFront();
await clear("#input");
await page.keyboard.type("/calc");
await sleep(400);
const freeNote = await page.evaluate(() => !!document.querySelector("typefill-box"));
await page.keyboard.press("Enter");
await sleep(200);
check("free build: a Pro snippet shows a note, shortcut stays", [freeNote, await val("#input")], (v) => v[0] === true && v[1] === "/calc");

// 11. use counts reach the options page
await sleep(300);
const uses = await opts.evaluate(async () => (await chrome.storage.local.get("uses")).uses ?? {});
check("use counts", uses.a?.n, 2);

if (!FIREFOX) {
  // 17. sync: this computer's snippets go up, and another computer's new snippet and delete come down
  await sleep(2600);
  const meta = await opts.evaluate(async () => (await chrome.storage.sync.get("meta")).meta);
  check("sync: snippets sent", meta?.n, (n) => n >= 1);
  await opts.evaluate(async () => {
    const at = Date.now() + 1000;
    const body = JSON.stringify({ at, snippets: [{ id: "z", shortcut: "/remote", text: "From the other computer", created: at, edited: at }], deleted: { j: at } });
    await chrome.storage.sync.set({ meta: { n: 1, at, device: "other" }, p0: body });
  });
  await sleep(800);
  const local = await opts.evaluate(async () => (await chrome.storage.local.get("snippets")).snippets.map((s) => s.id));
  check("sync: other computer's changes arrive", [local.includes("z"), local.includes("j"), local.includes("a")], (v) => v[0] && !v[1] && v[2]);
  await page.bringToFront();
  await clear("#input");
  await page.keyboard.type("/remote");
  check("sync: new snippet works", await val("#input"), "From the other computer");

  // 18. making a snippet on the snippet page with real clicks: shortcut, text, a dropdown, bold
  await opts.bringToFront();
  await opts.reload();
  await sleep(500);
  await opts.click("#add");
  await opts.keyboard.type("/ui");
  await opts.click("#text");
  await opts.keyboard.type("Pick ");
  await opts.click('button[data-insert^="{formmenu"]');
  await opts.click("#rich");
  await opts.click("#richText");
  await opts.keyboard.down("Control"); await opts.keyboard.press("a"); await opts.keyboard.up("Control");
  await opts.click('button[data-cmd="bold"]');
  await sleep(600);
  const made = await opts.evaluate(async () => (await chrome.storage.local.get("snippets")).snippets.find((s) => s.shortcut === "/ui"));
  check("snippet page: made with clicks", made, (s) => !!s && s.rich === true && /<b>Pick \{formmenu: name=Choice; default=First; Second; Third\}<\/b>/.test(s.html ?? ""));
  await page.bringToFront();
  await clear("#input");
  await page.keyboard.type("/ui");
  await sleep(300);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await sleep(300);
  check("snippet page: new snippet works", await val("#input"), "Pick Second");
}

if (process.env.SHOW) await sleep(1500);
await browser.close();
server.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
