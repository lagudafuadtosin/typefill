// Types shortcuts into the editors big sites are built on (Quill, TinyMCE, CKEditor 5, ProseMirror, Lexical) and reads
// the result back through each editor's own API, so it checks what the site would save, not just what shows.
import puppeteer from "puppeteer-core";
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ext = resolve("dist/chrome");
const show = !!process.env.SHOW;
const sleep = (ms) => new Promise((r) => setTimeout(r, show ? ms * 2 : ms));
const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(readFileSync("test/editors.html")); }).listen(0);
const url = `http://localhost:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: process.env.CFT, headless: !show, slowMo: show ? 60 : 0, defaultViewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-first-run"],
});
let failed = 0, ticks = Number(process.env.START ?? 0);
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  ticks++;
  console.log(`${String(ticks).padStart(2)}. ${ok ? "✔" : "✘ FAIL"} ${name}${ok ? "" : `\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
};

const worker = await browser.waitForTarget((t) => t.type() === "service_worker");
const extId = new URL(worker.url()).host;
await sleep(800);
const opts = await browser.newPage();
await opts.goto(`chrome-extension://${extId}/options.html`);
await opts.evaluate(async () => {
  await chrome.storage.local.set({ snippets: [
    { id: "a", shortcut: "/hi", text: "Hello there" },
    { id: "b", shortcut: "/nm", text: "Dear {formtext: name=Name}!" },
    { id: "c", shortcut: "/two", text: "Line one\nLine two" },
    { id: "d", shortcut: "/tf", text: "Hi {formtext: name=Name},\n\nThanks {cursor}\n\nBye" },
  ] });
});

const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.editorsReady && window.tiny?.initialized && window.ck, { timeout: 30000 });
await sleep(800);

const want = "a Hello there Dear Sam! Line one\nLine two";
const editors = [
  ["Quill", "quill", () => page.click("#quill .ql-editor")],
  ["TinyMCE", "tiny", async () => { const f = await (await page.$(".tox-edit-area iframe")).contentFrame(); await f.click("body"); }],
  ["CKEditor 5", "ck", () => page.click(".ck-editor__editable")],
  ["ProseMirror", "pm", () => page.click("#pm .ProseMirror")],
  ["Lexical", "lex", () => page.click("#lex")],
];
for (const [name, key, focus] of editors) {
  await focus();
  await page.keyboard.type("a /hi /nm", { delay: 60 });
  await sleep(400);
  await page.keyboard.type("Sam", { delay: 60 });
  await page.keyboard.press("Enter");
  await sleep(400);
  await page.keyboard.type(" /two", { delay: 60 });
  await sleep(500);
  const got = await page.evaluate((k) => window.editors[k](), key);
  const flat = (s) => s.replace(/ /g, " ").replace(/\n+/g, "\n").trim();

  // A box to fill, then several lines with a caret spot, all in one go (WhatsApp lost part of the shortcut here)
  await sleep(1000);
  await page.keyboard.press("Enter");
  await page.keyboard.type("x /tf", { delay: 60 });
  await sleep(400);
  await page.keyboard.type("Ann", { delay: 60 });
  await page.keyboard.press("Enter");
  await sleep(900);
  await page.keyboard.type("Q", { delay: 60 });
  await sleep(300);
  const got2 = flat(await page.evaluate((k) => window.editors[k](), key));
  // TinyMCE puts pasted paragraphs in a paragraph of their own, so "x" may sit on the line before
  const tail = got2.split("\n").join(" | ");
  check(`${name}: form, lines and caret spot`, /(^|\| )x\s*(\|\s*)?Hi Ann, \| Thanks Q \| Bye$/.test(tail) ? "ok" : tail, "ok");
  check(`${name}: shortcut, form and two lines`, got.replace(/ /g, " ").replace(/\n+/g, "\n").trim(), want);
}

if (show) await sleep(1500);
await browser.close();
server.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
