// Verifies qr.js against reference matrices from the Rust `qrcode` crate.
//   (cd cli && cargo run -q --example qr_fixtures) > /tmp/qr.json
//   node tests/qr_crosscheck.mjs /tmp/qr.json
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = { TextEncoder };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "qr.js"), "utf8"), ctx);

const fixtures = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let fail = 0;
for (const fx of fixtures) {
  let matched = -1, version = null;
  for (let m = 0; m < 8 && matched < 0; m++) {
    const qr = ctx.KWQR.encode(fx.text, fx.ecl, m);
    version = qr.version;
    const rows = qr.modules.map((r) => r.map((d) => (d ? "1" : "0")).join(""));
    if (rows.length === fx.rows.length && rows.every((r, i) => r === fx.rows[i])) matched = m;
  }
  const label = `${fx.ecl} v${fx.version} len=${fx.text.length}`;
  if (matched < 0 || version !== fx.version) {
    fail++;
    console.log(`FAIL ${label} (js version ${version})`);
  }
}
console.log(`${fixtures.length - fail}/${fixtures.length} matrices identical`);
process.exit(fail ? 1 : 0);
