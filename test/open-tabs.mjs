// Chrome: a tab that was already open when Typefill is installed takes shortcuts straight away, without a reload.
// Chrome only (Firefox adds an extension's page scripts to open tabs by itself). Run: node test/open-tabs.mjs
import puppeteer from "puppeteer-core";
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ext = resolve("dist/chrome");
const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(readFileSync("test/page.html")); }).listen(0);
const url = `http://localhost:${server.address().port}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, got, want) => {
  const ok = typeof want === "function" ? want(got) : got === want;
  if (!ok) failed++;
  console.log(`${ok ? "\u2714" : "\u2718 FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
};

// Chrome starts with no Typefill, the test page is opened, and only then is Typefill installed
const browser = await puppeteer.launch({ executablePath: process.env.CFT, headless: true, pipe: true, enableExtensions: true, args: ["--no-first-run"] });
const page = await browser.newPage();
await page.goto(url);
await sleep(500);
await browser.installExtension(ext);
await sleep(2500);
await page.bringToFront();
await page.click("#input");
await page.keyboard.type("Hi /date");
await sleep(500);
check("a tab open before the install expands a starter shortcut", await page.$eval("#input", (e) => e.value), (v) => /^Hi \d{1,2} \w+ \d{4}$/.test(v));
await browser.close();
server.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
