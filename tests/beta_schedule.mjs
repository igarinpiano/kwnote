// beta.js（?beta=true）の「わからない」による予定の延長（KWBeta.extendDate）を確かめる。
//   node tests/beta_schedule.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "beta.js"), "utf8");

function load(search) {
  const ctx = { location: { search } };
  // script.js と同じ addDays（beta.js は呼ぶときに global のものを使う）
  vm.runInNewContext(`function addDays(dateStr, n){
    var d = new Date(dateStr+"T00:00:00");
    d.setDate(d.getDate()+n);
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }`, ctx);
  vm.runInNewContext(src, ctx);
  return ctx;
}

for (const q of ["", "?beta=false", "?beta=0", "?betax=true", "?x=1"]) assert.equal(load(q).KWBeta.enabled, false, q);
for (const q of ["?beta=true", "?beta=1", "?x=1&beta=TRUE", "?beta=yes&y=2"]) assert.equal(load(q).KWBeta.enabled, true, q);

const ctx = load("?beta=true");
const ext = ctx.KWBeta.extendDate;
const s = { n: [1, 3, 7, 14] };
const reg = "2026-01-01";
const base = (t) => ctx.addDays(reg, s.n[t - 1]);
const sched = (r) => [1, 2, 3, 4].map((t) => ext(r, s, t, base(t)));

// 記録なし・壊れた記録 → 元の予定のまま
assert.deepEqual(sched({}), ["2026-01-02", "2026-01-04", "2026-01-08", "2026-01-15"]);
assert.deepEqual(sched({ misses: "x" }), sched({}));
assert.deepEqual(sched({ misses: [null, { date: "bad", turn: 2 }, { date: "2026-01-04", turn: 0 }, { turn: 2 }] }), sched({}));

// turn 2 の予定日（1/4）に「わからない」→ turn 2 は翌日、そのあとも間隔を保って 1 日ずつうしろへ
assert.deepEqual(sched({ misses: [{ date: "2026-01-04", turn: 2 }] }),
  ["2026-01-02", "2026-01-05", "2026-01-09", "2026-01-16"]);

// 遅れて復習して「わからない」（1/10, turn 2）→ turn 2 は 1/11、turn 3 は +4 日、turn 4 は +11 日
assert.deepEqual(sched({ misses: [{ date: "2026-01-10", turn: 2 }] }),
  ["2026-01-02", "2026-01-11", "2026-01-15", "2026-01-22"]);

// 何度も: いちばん遅くなるものが効く。前の turn の記録はあとの turn にも効く
assert.deepEqual(sched({ misses: [{ date: "2026-01-04", turn: 2 }, { date: "2026-01-05", turn: 2 }, { date: "2026-01-09", turn: 3 }] }),
  ["2026-01-02", "2026-01-06", "2026-01-10", "2026-01-17"]);

// 本来の予定より早くはならない・turn の数を減らしたあとの記録（turn 9）は無視
assert.deepEqual(sched({ misses: [{ date: "2025-12-01", turn: 1 }, { date: "2026-03-01", turn: 9 }] }), sched({}));

console.log("beta schedule ok");
