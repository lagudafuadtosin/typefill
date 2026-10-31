// Types into a real Google Doc with the Chrome build loaded. DOC_URL is a doc shared as "Anyone with the link: Editor",
// so no sign-in is needed. The doc's text is read back through its plain-text export.
import puppeteer from "puppeteer-core";
import { resolve } from "node:path";

const docUrl = process.env.DOC_URL;
if (!docUrl) throw new Error("set DOC_URL to a Google Doc shared as editor");
const ext = resolve("dist/chrome");
const show = !!process.env.SHOW;
const sleep = (ms) => new Promise((r) => setTimeout(r, show ? ms * 2 : ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CFT, headless: !show, slowMo: show ? 90 : 0, defaultViewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-first-run"],
});
let failed = 0, ticks = 15;
const check = (name, got, want) => {
  const ok = typeof want === "function" ? want(got) : got === want;
  if (!ok) failed++;
  ticks++;
  console.log(`${ticks}. ${ok ? "✔" : "✘ FAIL"} ${name}${ok ? "" : `\n     got:  ${JSON.stringify(got)}\n     doc:  ${JSON.stringify(lastText)}`}`);
};

const worker = await browser.waitForTarget((t) => t.type() === "service_worker");
const extId = new URL(worker.url()).host;
await sleep(800);
const opts = await browser.newPage();
await opts.goto(`chrome-extension://${extId}/options.html`);
await opts.evaluate(async () => {
  await chrome.storage.local.set({ snippets: [
    { id: "a", shortcut: "/hi", text: "Hello from Typefill" },
    { id: "b", shortcut: "/name", text: "Dear {formtext: name=Name}," },
    { id: "c", shortcut: "/sig", text: "Best wishes\nFuad" },
    { id: "d", shortcut: "/br", text: "[{cursor}]" },
  ] });
});

const page = await browser.newPage();
await page.goto(docUrl, { waitUntil: "networkidle2" });
await sleep(2500);
const docId = /\/document\/d\/([^/]+)/.exec(docUrl)[1];
let lastText = "";
const text = async () => {
  const r = await fetch(`https://docs.google.com/document/d/${docId}/export?format=txt`);
  return (lastText = (await r.text()).replace(/^﻿/, "").replace(/\r\n/g, "\n"));
};
// Docs saves a moment after typing stops
const settled = async () => { await sleep(2500); return text(); };

// Into the page body, then clear whatever is there
await page.click(".kix-appview-editor");
await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
await page.keyboard.press("Backspace");

await page.keyboard.type("/hi");
await sleep(600);
check("docs: plain shortcut", (await settled()).trim(), "Hello from Typefill");

await page.keyboard.press("Enter");
await page.keyboard.type("/name");
await sleep(800);
await page.keyboard.type("Sam");
await page.keyboard.press("Enter");
await sleep(800);
check("docs: form", (await settled()).trim(), "Hello from Typefill\nDear Sam,");

await page.keyboard.press("Enter");
await page.keyboard.type("/sig");
await sleep(800);
check("docs: two lines", (await settled()).trim(), "Hello from Typefill\nDear Sam,\nBest wishes\nFuad");

await page.keyboard.press("Enter");
await page.keyboard.type("/br");
await sleep(800);
await page.keyboard.type("x");
check("docs: caret spot", (await settled()).trim().split("\n").pop(), "[x]");

if (show) await sleep(2000);
await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
