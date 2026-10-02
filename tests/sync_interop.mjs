// Interop between sync.js (browser) and the Rust CLI:
//  * sync codes made by JS import into the CLI and vice versa
//  * mergeDocs in JS == `kwnote import` merge in Rust (randomised)
//   cargo build && node tests/sync_interop.mjs
import fs from "node:fs";
import os from "node:os";
import vm from "node:vm";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = process.env.KWNOTE_BIN || path.join(root, "target/debug/kwnote");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kwnote-test-"));
const ctx = { TextEncoder, TextDecoder, CompressionStream, DecompressionStream, Blob, Response, btoa, atob, Math, JSON };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "sync.js"), "utf8"), ctx);
const S = ctx.KWSync;

const kw = (data, ...args) =>
  execFileSync(bin, ["--data", data, ...args], { encoding: "utf8", env: { ...process.env, KWNOTE_HOME: tmp } });
const norm = (doc) => {
  const rec = (r) => {
    const o = { ...r, completedTurns: [...(r.completedTurns || [])].sort((a, b) => a - b), updatedAt: r.updatedAt || 0 };
    if (!o.deleted) delete o.deleted;
    if (o.note === undefined && "question" in o) o.note = "";
    return JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = o[k]), a), {}));
  };
  return {
    items: (doc.items || []).map(rec).sort(),
    sentences: (doc.sentences || []).map(rec).sort(),
    n: JSON.stringify(doc.settings?.n ?? [1, 3, 7, 14]),
    order: doc.settings?.order ?? null,
    limit: doc.settings?.limit ?? null,
  };
};
let fails = 0;
const check = (name, a, b) => {
  const ok = JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  if (!ok) { fails++; console.log("FAIL", name, JSON.stringify(norm(a)), JSON.stringify(norm(b))); }
};

// --- deterministic pseudo random
let seed = 12345;
const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
const randDoc = () => {
  const ids = ["a", "b", "c", "d", "e"];
  const items = ids.filter(() => rnd(3)).map((id) => ({
    id: "id_" + id, question: "問" + id + rnd(3), answer: "答" + rnd(5), note: rnd(2) ? "" : "n" + rnd(9),
    registeredDate: "2026-09-0" + (1 + rnd(9)), completedTurns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter(() => rnd(2)),
    updatedAt: rnd(3) * 1000, ...(rnd(5) ? {} : { deleted: true }),
  }));
  const sentences = ids.filter(() => rnd(2)).map((id) => ({
    id: "s_" + id, text: "sentence " + id + rnd(4), registeredDate: "2026-09-10",
    completedTurns: [1, 2].filter(() => rnd(2)), updatedAt: rnd(3) * 1000,
  }));
  // settings: 1–12 turns, sometimes an order / daily limit
  const settings = { n: [rnd(4), 3, 7, 14, 30, 60, 90, 120, 150, 180, 240, 365].slice(0, 1 + rnd(12)), updatedAt: rnd(3) };
  if (rnd(2)) settings.order = ["random", "due", "oldest", "newest"][rnd(4)];
  if (rnd(2)) settings.limit = rnd(30);
  return { version: 2, items, sentences, settings };
};

// 1. JS code -> Rust
const big = randDoc();
for (let i = 0; i < 300; i++) big.items.push({ id: "bulk" + i, question: "長い問題文 " + i, answer: "A" + i, note: "", registeredDate: "2026-09-01", completedTurns: [], updatedAt: i });
const frames = await S.encodeFrames(big, 200);
fs.writeFileSync(path.join(tmp, "code.txt"), frames.reverse().join("\n"));
const dataA = path.join(tmp, "a.json");
kw(dataA, "import", "--replace", path.join(tmp, "code.txt"));
check("js code -> rust", JSON.parse(fs.readFileSync(dataA, "utf8")), big);
console.log(`JS → Rust: ${frames.length} frames`);

// 2. Rust code -> JS
const rustCode = kw(dataA, "code", "--chunk", "150");
const back = await S.decodeAny(rustCode);
check("rust code -> js", back, big);
console.log(`Rust → JS: ${rustCode.trim().split("\n").length} frames`);

// 3. merge parity
for (let t = 0; t < 200; t++) {
  const A = randDoc(), B = randDoc();
  const f = path.join(tmp, "m.json");
  fs.writeFileSync(f, JSON.stringify(A));
  fs.writeFileSync(path.join(tmp, "b.json"), JSON.stringify(B));
  kw(f, "import", path.join(tmp, "b.json"));
  check("merge #" + t, JSON.parse(fs.readFileSync(f, "utf8")), S.mergeDocs(A, B));
}
console.log(fails ? `${fails} failures` : "all interop checks passed");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
