// Builds the free Typefill extension into dist/chrome and dist/firefox from src. The two differ only in their manifests.
// The store version is built from the private Typefill Pro project, which adds its parts to these same files.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const base = JSON.parse(readFileSync("manifest.base.json", "utf8"));

const targets = {
  chrome: {
    ...base,
    background: { service_worker: "background.js" },
    // Docs takes key presses through an about:blank frame; this lets the script run there
    content_scripts: base.content_scripts.map((c) => ({ ...c, match_origin_as_fallback: true })),
  },
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: { gecko: { id: "typefill@lagudafuadtosin", strict_min_version: "128.0" } },
  },
};

for (const [name, manifest] of Object.entries(targets)) {
  const out = `dist/${name}`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync("src", out, { recursive: true });
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`built ${out}`);
}
