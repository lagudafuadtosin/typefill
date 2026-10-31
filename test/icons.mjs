// Draws the icon at each size the stores want
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#3d6cf0"/>
  <rect x="26" y="40" width="52" height="12" rx="6" fill="#fff"/>
  <rect x="26" y="62" width="76" height="12" rx="6" fill="#fff" opacity=".85"/>
  <rect x="26" y="84" width="40" height="12" rx="6" fill="#fff" opacity=".7"/>
  <path d="M92 26 l4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4z" fill="#ffd54a"/>
</svg>`;
mkdirSync("src/icons", { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CFT, headless: true });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `src/icons/${size}.png`, omitBackground: true });
}
await browser.close();
console.log("icons done");
