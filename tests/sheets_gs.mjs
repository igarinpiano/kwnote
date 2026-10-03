// Runs tools/sheets/kwnote.gs (Google Apps Script) under Node against a small
// fake of the spreadsheet API: import → edit cells → export, and checks that
// the exported JSON merges into the app (sync.js mergeDocs) the way an edit
// made in the app would.
//
//   node tests/sheets_gs.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (cond, name, extra) => {
  if (!cond) { fails++; console.log("FAIL", name, extra === undefined ? "" : JSON.stringify(extra)); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, [a, b]);
// same document, whatever the order of records and keys
const canon = (x) => Array.isArray(x) ? x.map(canon)
  : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x;
const canonDoc = (d) => { const c = canon(d); for (const k of ["items", "sentences"]) c[k].sort((a, b) => (a.id < b.id ? -1 : 1)); return c; };
const sameDoc = (a, b, name) => eq(canonDoc(a), canonDoc(b), name);

// ---------------------------------------------------------------- fake Sheets
// Cells hold strings. Like Sheets: a leading ' is dropped (text marker), and
// an unescaped leading = would become a formula (the test fails on that).
class Sheet {
  constructor(name) { this.name = name; this.cells = []; this.maxRows = 5; this.maxCols = 26; this.hidden = false; }
  clear() { this.cells = []; return this; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  getLastRow() {
    for (let r = this.cells.length; r > 0; r--) if ((this.cells[r - 1] || []).some((v) => v !== "" && v !== undefined)) return r;
    return 0;
  }
  setFrozenRows() {} setColumnWidth() {} hideSheet() { this.hidden = true; }
  getRange(row, col, nr = 1, nc = 1) {
    const sh = this;
    if (row < 1 || col < 1 || row + nr - 1 > sh.maxRows || col + nc - 1 > sh.maxCols) throw new Error(`range outside ${sh.name}: ${row},${col},${nr},${nc}`);
    const chain = {
      setValues(vals) {
        if (vals.length !== nr || vals.some((r) => r.length !== nc)) throw new Error(`setValues size mismatch on ${sh.name}`);
        vals.forEach((r, i) => r.forEach((v, j) => {
          v = String(v);
          if (v.length > 50000) throw new Error("cell too long");
          if (v[0] === "=") throw new Error(`unescaped formula in ${sh.name}: ${v.slice(0, 30)}`);
          if (v[0] === "'") v = v.slice(1);
          (sh.cells[row - 1 + i] ||= [])[col - 1 + j] = v;
        }));
        return chain;
      },
      getDisplayValues() {
        return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (sh.cells[row - 1 + i] || [])[col - 1 + j] ?? ""));
      },
    };
    for (const m of ["setNumberFormat", "setVerticalAlignment", "setWrap", "setFontWeight", "setBackground", "setFontColor", "setNote"]) chain[m] = () => chain;
    return chain;
  }
  // test helpers (1-based, like the UI)
  set(row, col, v) { (this.cells[row - 1] ||= [])[col - 1] = v; this.maxRows = Math.max(this.maxRows, row); }
  get(row, col) { return (this.cells[row - 1] || [])[col - 1] ?? ""; }
  deleteRow(row) { this.cells.splice(row - 1, 1); }
  rowOf(id) { return this.cells.findIndex((r) => r && r[0] === id) + 1; }
}
const sheets = new Map();
const alerts = [];
let answer = "YES";
const ss = {
  getSheetByName: (n) => sheets.get(n) || null,
  insertSheet: (n) => { const s = new Sheet(n); sheets.set(n, s); return s; },
  setActiveSheet() {}, getSpreadsheetTimeZone: () => "Asia/Tokyo",
};
const ui = { ButtonSet: { OK: "OK", YES_NO: "YES_NO" }, Button: { YES: "YES", NO: "NO" }, alert: (...a) => { alerts.push(a); return answer; } };
let uuid = 0;
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ui },
  Utilities: {
    formatDate: () => "2026-10-03", getUuid: () => String(++uuid).padStart(8, "0") + "-0000",
    Charset: { UTF_8: "UTF-8" },
    base64Encode: (s) => Buffer.from(s, "utf8").toString("base64"),
    base64Decode: (b) => [...Buffer.from(b, "base64")],
    newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString("utf8") }),
  },
  HtmlService: {}, JSON, Math, Date, console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "tools/sheets/kwnote.gs"), "utf8"), ctx);
const G = (code) => vm.runInContext(code, ctx);
const call = (fn, ...args) => JSON.parse(JSON.stringify(ctx[fn](...args) ?? null));

// the app's merge
const sctx = { TextEncoder, TextDecoder, Math, JSON }; sctx.globalThis = sctx;
vm.createContext(sctx);
vm.runInContext(fs.readFileSync(path.join(root, "sync.js"), "utf8"), sctx);
const merge = (a, b) => JSON.parse(JSON.stringify(sctx.KWSync.mergeDocs(a, b)));

// ---------------------------------------------------------------- data
const T0 = 1790000000000;
const base = {
  version: 2,
  items: [
    { id: "id_a", question: "apple", answer: "りんご", note: "fruit", registeredDate: "2026-09-01", completedTurns: [1, 2], updatedAt: T0 },
    { id: "id_b", question: "=SUM(1)", answer: "'quoted", note: "", registeredDate: "2026-09-02", completedTurns: [], updatedAt: T0 + 1, custom: { keep: true } },
    { id: "id_c", question: "two\nlines", answer: "+81", note: null, registeredDate: "2026-09-03", completedTurns: [1, 2, 3, 4, 5, 12] },
    { id: "id_dead", question: "gone", answer: "x", note: "", registeredDate: "2026-08-01", completedTurns: [], updatedAt: T0, deleted: true },
    { id: "id_d", question: "delete me", answer: "x", note: "", registeredDate: "2026-09-04", completedTurns: [1], updatedAt: T0 + 5 },
    { id: "id_e", question: "blank me", answer: "x", note: "", registeredDate: "2026-09-05", completedTurns: [], updatedAt: 9990000000000 },
  ],
  sentences: [
    { id: "s_a", text: "Practice makes perfect.", registeredDate: "2026-09-01", completedTurns: [1], updatedAt: T0 },
    { id: "s_b", text: "second 🍎 ", registeredDate: "2026-09-02", completedTurns: [], updatedAt: T0 },
  ],
  settings: { n: [1, 2, 3, 5, 7, 10, 14], order: "due", updatedAt: T0, future: 1 },
  topLevelExtra: "kept",
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const byId = (list) => Object.fromEntries(list.map((r) => [r.id, r]));

// ---------------------------------------------------------------- 1. import
let r = call("kwImportText", JSON.stringify(base, null, 2), false);
ok(/もんだい 5 件・ぶんしょう 2 件/.test(r.message), "import message", r);
const qa = sheets.get("Q&A"), se = sheets.get("Sentences"), st = sheets.get("Settings");
eq(qa.cells[0], ["id", "Question", "Answer", "Supplement", "Registered", "Done turns"], "Q&A header");
eq(qa.cells[1], ["id_a", "apple", "りんご", "fruit", "2026-09-01", "1,2"], "Q&A row");
eq(qa.cells[2].slice(0, 3), ["id_b", "=SUM(1)", "'quoted"], "leading = and ' survive as text");
eq(qa.cells[3].slice(1, 6), ["two\nlines", "+81", "", "2026-09-03", "1,2,3,4,5,12"], "multi-line, +, null note, 12 turns");
ok(qa.rowOf("id_dead") === 0, "tombstones are not shown");
eq(st.cells.slice(1).map((x) => x.slice(0, 2)), [["n", "1,2,3,5,7,10,14"], ["order", "due"], ["limit", "0"]], "settings sheet");
ok(sheets.get("_kwnote_base").hidden, "base sheet hidden");

// ---------------------------------------------------------------- 2. export untouched
r = call("kwExport", false);
ok(/変更なし/.test(r.message), "no changes", r.message);
const lines = r.json.split("\n");
ok(lines.every((l) => l[0] !== '"' && l[0] !== "=" && l.length <= 50000), "JSON lines are cell-safe");
sameDoc(JSON.parse(r.json), base, "untouched export is the imported doc");
eq(JSON.parse(r.json).items.map((x) => x.id), ["id_a", "id_b", "id_c", "id_d", "id_e", "id_dead"], "rows in sheet order, then deleted records");

// ---------------------------------------------------------------- 3. edit
qa.set(qa.rowOf("id_a"), 3, "林檎");                 // change an answer
qa.set(qa.rowOf("id_c"), 6, "1 2, 3");              // turns, loose separators
qa.set(qa.rowOf("id_b"), 5, "2026/9/7");            // date, loose format
qa.deleteRow(qa.rowOf("id_d"));                     // delete a row
const blank = qa.rowOf("id_e");                     // clear a row's content, id left behind
[2, 3, 4].forEach((c) => qa.set(blank, c, ""));
const newRow = qa.getLastRow() + 2;                 // new row after a gap, no id, no date
qa.set(newRow, 2, "new question"); qa.set(newRow, 3, "new answer");
qa.set(newRow + 1, 1, "id_a"); qa.set(newRow + 1, 2, "copy of a row"); qa.set(newRow + 1, 3, "dup id");
se.set(se.rowOf("s_b"), 2, "second, edited");
st.set(2, 2, "1, 3, 7, 14, 30");
st.set(4, 2, "25");

r = call("kwExport", false);
ok(r.needConfirm && /2 件が削除/.test(r.message), "deletions ask first", r);
sameDoc(call("kwLoadBase_"), base, "nothing saved before confirming");
const before = Date.now();
r = call("kwExport", true);
ok(/変更 4 件・追加 2 件・削除 2 件・設定の変更/.test(r.message), "export summary", r.message);
ok(/id が重複/.test(r.message), "duplicate id warning", r.message);
const out = JSON.parse(r.json), items = byId(out.items), sents = byId(out.sentences);

eq(items.id_a.answer, "林檎", "edited answer");
ok(items.id_a.updatedAt >= before, "edited record is stamped now");
eq(items.id_c.completedTurns, [1, 2, 3], "turns parsed");
ok(items.id_c.note === null && items.id_c.updatedAt >= before, "untouched fields kept, legacy record stamped");
eq([items.id_b.registeredDate, items.id_b.question, items.id_b.custom], ["2026-09-07", "=SUM(1)", { keep: true }], "date normalised, unknown field kept");
ok(items.id_d.deleted === true && items.id_d.updatedAt >= before && items.id_d.question === "delete me", "deleted row → tombstone");
ok(items.id_e.deleted === true && items.id_e.updatedAt === 9990000000001, "blanked row → tombstone, strictly newer than a future stamp");
eq(items.id_dead, base.items[3], "old tombstone passed through");
const added = out.items.filter((x) => !byId(base.items)[x.id]);
eq(added.map((x) => [x.question, x.registeredDate, x.completedTurns, x.id.startsWith("id_")]),
  [["new question", "2026-10-03", [], true], ["copy of a row", "2026-10-03", [], true]], "new rows");
eq(sents.s_a, base.sentences[0], "untouched sentence identical");
eq(sents.s_b.text, "second, edited", "edited sentence");
eq([out.settings.n, out.settings.order, out.settings.limit, out.settings.future], [[1, 3, 7, 14, 30], "due", 25, 1], "settings");
ok(out.settings.updatedAt >= before && out.topLevelExtra === "kept", "settings stamped, top-level extra kept");
eq([qa.get(newRow, 1), qa.get(newRow + 1, 1)], added.map((x) => x.id), "new ids written back to the sheet");

// the app accepts the edits (either merge direction) …
for (const m of [merge(clone(base), out), merge(out, clone(base))]) {
  const mi = byId(m.items);
  ok(mi.id_a.answer === "林檎" && mi.id_d.deleted && mi.id_e.deleted && m.items.length === 8, "app merge takes the sheet's edits");
  eq(m.settings.n, [1, 3, 7, 14, 30], "app merge takes the settings");
}
// … and an edit made in the app after the export still wins over it
const later = clone(base); later.items[0].answer = "apple (app)"; later.items[0].updatedAt = Date.now() + 60000;
eq(byId(merge(later, out).items).id_a.answer, "apple (app)", "a later edit in the app wins");

// exporting again changes nothing and invents no ids
const again = call("kwExport", false);
ok(/変更なし/.test(again.message), "second export: no changes", again.message);
sameDoc(JSON.parse(again.json), out, "second export identical");

// ---------------------------------------------------------------- 4. errors leave everything alone
qa.set(qa.rowOf("id_a"), 5, "10月1日"); qa.set(qa.rowOf("id_b"), 6, "1,x"); st.set(3, 2, "sideways");
let err = "";
try { ctx.kwExport(true); } catch (e) { err = e.message; }
ok(/Q&A 2 行目.*日付/.test(err) && /Q&A 3 行目.*Done turns/.test(err), "row-numbered errors", err);
sameDoc(call("kwLoadBase_"), out, "failed export saved nothing");
qa.set(qa.rowOf("id_a"), 5, "2026-09-01"); qa.set(qa.rowOf("id_b"), 6, "");
try { err = ""; ctx.kwExport(true); } catch (e) { err = e.message; }
ok(/order は/.test(err), "settings error", err);
st.set(3, 2, "due");

// ---------------------------------------------------------------- 5. import over unexported edits asks
qa.set(qa.rowOf("id_a"), 2, "pending edit");
r = call("kwImportText", JSON.stringify(base), false);
ok(r.needConfirm && /変更 1 件/.test(r.message), "import asks before discarding edits", r);
eq(qa.get(qa.rowOf("id_a"), 2), "pending edit", "sheet untouched until confirmed");
for (const bad of ["", "not json", "[1]", "KW1:abc:1:1:xyz"]) {
  try { err = ""; ctx.kwImportText(bad, true); } catch (e) { err = e.message; }
  ok(err, "rejects " + JSON.stringify(bad));
}

// ---------------------------------------------------------------- 6. JSON sheet route + a large doc
const big = { version: 2, items: [], sentences: [], settings: { n: [1, 3, 7, 14] } };
for (let i = 0; i < 3000; i++) big.items.push({ id: "id_" + i, question: "問題 " + i + " ".repeat(i % 7), answer: "答え " + i, note: i % 3 ? "" : "補足", registeredDate: "2026-09-" + String(1 + (i % 28)).padStart(2, "0"), completedTurns: i % 4 ? [1] : [], updatedAt: T0 + i });
call("kwImportText", JSON.stringify(big), true);
ok(sheets.get("_kwnote_base").getLastRow() > 5, "base is split over several cells");
ok(sheets.get("_kwnote_base").cells.every((r) => /^J[A-Za-z0-9+\/=]+$/.test(r[0])), "base cells are plain ASCII");
sameDoc(call("kwLoadBase_"), big, "base round-trips through the cells");
alerts.length = 0;
ctx.kwMenuExportToSheet();
const js = sheets.get("JSON");
ok(js.getLastRow() === 3000 + 3, "JSON sheet: one record per row", js.getLastRow());
// paste it back (as the user would) and import from the sheet
sheets.get("Q&A").clear();
ctx.kwMenuImportFromSheet();
ok(/もんだい 3000 件/.test(alerts.at(-1)[1]), "import from the JSON sheet", alerts.at(-1));
sameDoc(JSON.parse(call("kwExport", false).json), big, "large doc round-trips unchanged");
sheets.delete("JSON"); alerts.length = 0;
ctx.kwMenuImportFromSheet();
ok(/貼り付けて/.test(alerts[0][0]) && sheets.has("JSON"), "empty JSON sheet: explains what to do");

// the panel HTML is one self-contained page
const html = G("KW_PANEL_HTML");
ok(html.includes("kwImportText") && html.includes("kwExport") && (html.match(/<script>/g) || []).length === 1, "panel html");
new vm.Script(html.split("<script>")[1].split("</script>")[0].replace(/google\.script\.run/g, "X"));

console.log(fails ? `${fails} check(s) failed` : "all spreadsheet checks passed");
process.exit(fails ? 1 : 0);
