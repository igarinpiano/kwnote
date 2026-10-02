// index.htm loads its assets as "file?v=<hash of the asset files>" so a
// browser can never combine a fresh index.htm with stale cached scripts
// (GitHub Pages caches every file for 10 minutes, independently).
//   node tests/web_version.mjs         check (CI)
//   node tests/web_version.mjs --fix   rewrite index.htm after editing web files
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = ["style.css", "qr.js", "sync.js", "script.js"];
const hash = crypto.createHash("sha256");
for (const f of ASSETS) hash.update(fs.readFileSync(path.join(root, f)));
const version = hash.digest("hex").slice(0, 10);

const file = path.join(root, "index.htm");
const html = fs.readFileSync(file, "utf8");
let found = 0;
const fixed = html.replace(/(href|src)="(style\.css|qr\.js|sync\.js|script\.js)(\?v=[0-9a-f]*)?"/g, (_, attr, name) => {
  found++;
  return `${attr}="${name}?v=${version}"`;
});
if (found !== ASSETS.length) {
  console.error(`expected ${ASSETS.length} asset references in index.htm, found ${found}`);
  process.exit(1);
}
if (process.argv.includes("--fix")) {
  fs.writeFileSync(file, fixed);
  console.log(`index.htm assets -> ?v=${version}`);
} else if (fixed !== html) {
  console.error(`index.htm asset version is stale (expected ?v=${version}); run: node tests/web_version.mjs --fix`);
  process.exit(1);
} else {
  console.log(`index.htm asset version up to date (?v=${version})`);
}
