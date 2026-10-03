/**
 * kwnote ⇄ Google スプレッドシート（一括編集用）
 *
 * kwnote のデータ（Web アプリの SAVE FILE / `kwnote export` の JSON）を表にして
 * 編集し、また JSON に戻します。戻した JSON は Web アプリの OPEN FILE /
 * PASTE CODE、または `kwnote import` で取り込みます（取り込みはマージ）。
 *
 * 入れ方: スプレッドシートの「拡張機能 → Apps Script」を開き、このファイルの
 * 中身をまるごと貼り付けて保存 → スプレッドシートを再読み込みすると、
 * メニューに「kwnote」が出ます。詳しくは README の「スプレッドシートで一括編集」。
 *
 * しくみ（大事なところ）:
 * - Import した JSON を隠しシート `_kwnote_base` に控えておき、Export のときに
 *   表と比べます。**変えた行だけ** updatedAt を新しくするので、アプリ側の
 *   マージで「表で直した内容」が勝ちます。触っていない行はそのままです。
 * - id が空の行は新規登録、表から消えた行は「削除した」という印（deleted）
 *   として書き出します（消すだけだと同期で復活するため）。
 * - 表にない項目（知らないフィールド、削除済みの記録）は控えからそのまま戻します。
 *
 * 前半の kw… 関数は Apps Script に依存しない純粋なロジックで、
 * tests/sheets_gs.mjs が Node で検証します。
 *
 * @OnlyCurrentDoc
 */

var KW = {
  QA: 'Q&A',
  SENT: 'Sentences',
  SET: 'Settings',
  JSON: 'JSON',
  BASE: '_kwnote_base',
  QA_HEAD: ['id', 'Question', 'Answer', 'Supplement', 'Registered', 'Done turns'],
  SENT_HEAD: ['id', 'Sentence', 'Registered', 'Done turns'],
  SET_HEAD: ['key', 'value', '説明'],
  ORDERS: ['random', 'due', 'oldest', 'newest'],
  MAX_TURNS: 20,     // cli/src/model.rs MAX_TURNS と同じ
  CELL_MAX: 50000,   // 1 セルの文字数の上限
  CHUNK: 40000
};

// ====================================================================
// ロジック（Apps Script に依存しない）
// ====================================================================

function kwClone(x) { return JSON.parse(JSON.stringify(x)); }
function kwStr(v) { return v === null || v === undefined ? '' : String(v); }

function kwParseDoc(text) {
  var t = kwStr(text).replace(/^﻿/, '').trim();
  if (!t) throw new Error('JSON が空です。');
  if (t.indexOf('KW1:') === 0) {
    throw new Error('これは同期コード（COPY CODE）です。アプリの SAVE FILE か `kwnote export` の JSON を使ってください。');
  }
  var doc;
  try { doc = JSON.parse(t); } catch (e) { throw new Error('JSON として読めません: ' + e.message); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('kwnote の JSON ではありません。');
  if (!Array.isArray(doc.items)) doc.items = [];
  if (!Array.isArray(doc.sentences)) doc.sentences = [];
  if (!doc.settings || typeof doc.settings !== 'object') doc.settings = { n: [1, 3, 7, 14] };
  doc.items = doc.items.filter(function (r) { return r && r.id; });
  doc.sentences = doc.sentences.filter(function (r) { return r && r.id; });
  return doc;
}

function kwTurns(list) {
  var seen = {}, out = [];
  (Array.isArray(list) ? list : []).forEach(function (t) {
    t = Math.floor(Number(t));
    if (t >= 1 && t <= 255 && !seen[t]) { seen[t] = true; out.push(t); }
  });
  return out.sort(function (a, b) { return a - b; });
}

function kwSettingsView(s) {
  s = s || {};
  var n = (Array.isArray(s.n) ? s.n : []).map(function (x) { x = parseInt(x, 10); return x > 0 ? x : 0; });
  if (!n.length) n = [1, 3, 7, 14];
  var limit = parseInt(s.limit, 10);
  return {
    n: n.join(','),
    order: KW.ORDERS.indexOf(s.order) !== -1 ? s.order : 'random',
    limit: String(limit > 0 ? limit : 0)
  };
}

// doc → 表（すべて文字列。削除済みの記録は出さない）
function kwDocToTables(doc) {
  var alive = function (r) { return !r.deleted; };
  return {
    qa: doc.items.filter(alive).map(function (r) {
      return [kwStr(r.id), kwStr(r.question), kwStr(r.answer), kwStr(r.note),
        kwStr(r.registeredDate), kwTurns(r.completedTurns).join(',')];
    }),
    sentences: doc.sentences.filter(alive).map(function (r) {
      return [kwStr(r.id), kwStr(r.text), kwStr(r.registeredDate), kwTurns(r.completedTurns).join(',')];
    }),
    settings: kwSettingsView(doc.settings)
  };
}

// "2026-10-01" / "2026/10/1" → "2026-10-01"。空は ''、読めなければ null
function kwDate(v) {
  var s = kwStr(v).trim();
  if (!s) return '';
  var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(s);
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3];
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return m[1] + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}

// "1,2,3" / "1 2 3" / "1、2" → [1,2,3]。読めなければ null
function kwParseTurns(v) {
  var s = kwStr(v).trim();
  if (!s) return [];
  var parts = s.split(/[\s,、，・;]+/).filter(function (x) { return x !== ''; });
  var nums = [];
  for (var i = 0; i < parts.length; i++) {
    if (!/^\d+$/.test(parts[i])) return null;
    var t = parseInt(parts[i], 10);
    if (t < 1 || t > 255) return null;
    nums.push(t);
  }
  return kwTurns(nums);
}

function kwSame(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// 1 つの表（kind: 'qa' | 's'）を控え（baseRecs）と突き合わせる
function kwApplyTable(baseRecs, rows, kind, ctx) {
  var sheetName = kind === 'qa' ? KW.QA : KW.SENT;
  var byId = {}, seen = {}, out = [], rowIds = [];
  baseRecs.forEach(function (r) { byId[r.id] = r; });

  (rows || []).forEach(function (row, i) {
    var where = sheetName + ' ' + (i + 2) + ' 行目';
    var id = kwStr(row[0]).trim();
    var f = kind === 'qa'
      ? { question: kwStr(row[1]), answer: kwStr(row[2]), note: kwStr(row[3]) }
      : { text: kwStr(row[1]) };
    var regRaw = kind === 'qa' ? row[4] : row[2], turnsRaw = kind === 'qa' ? row[5] : row[3];
    var content = kind === 'qa' ? f.question + f.answer + f.note : f.text;
    // 中身が空の行は「無い行」として扱う（id だけ残っていれば削除になる）
    if (!content.trim()) { rowIds.push(null); return; }

    if (id && seen[id]) {
      ctx.warnings.push(where + ': id が重複しているので、新しい記録として扱いました。');
      id = '';
    }
    var base = id ? byId[id] : null;
    var reg = kwDate(regRaw);
    if (reg === null) { ctx.errors.push(where + ': Registered の日付「' + kwStr(regRaw) + '」が読めません（例: 2026-10-01）。'); reg = ''; }
    if (!reg) reg = (base && kwDate(base.registeredDate)) || ctx.today;
    var turns = kwParseTurns(turnsRaw);
    if (turns === null) { ctx.errors.push(where + ': Done turns「' + kwStr(turnsRaw) + '」が読めません（例: 1,2,3）。'); turns = []; }
    [f.question, f.answer, f.note, f.text].forEach(function (v) {
      if (v && v.length > KW.CELL_MAX) ctx.errors.push(where + ': 1 セルが長すぎます。');
    });

    var rec;
    if (base) {
      var before = kind === 'qa'
        ? [kwStr(base.question), kwStr(base.answer), kwStr(base.note)]
        : [kwStr(base.text)];
      var after = kind === 'qa' ? [f.question, f.answer, f.note] : [f.text];
      var same = !base.deleted && kwSame(before, after) &&
        kwStr(base.registeredDate) === reg && kwSame(kwTurns(base.completedTurns), turns);
      if (same) {
        rec = base;
      } else {
        rec = kwClone(base);
        // 変わった欄だけ書き換える（null の補足などはそのまま残す）
        for (var k in f) if (kwStr(base[k]) !== f[k]) rec[k] = f[k];
        rec.registeredDate = reg;
        rec.completedTurns = turns;
        delete rec.deleted;
        // 直前より必ず新しく（マージで勝たせる）
        rec.updatedAt = Math.max(ctx.now, (+base.updatedAt || 0) + 1);
        ctx.summary[base.deleted ? 'added' : 'changed']++;
      }
    } else {
      rec = { id: id || ctx.newId(kind === 'qa' ? 'id_' : 's_') };
      for (var k2 in f) rec[k2] = f[k2];
      rec.registeredDate = reg;
      rec.completedTurns = turns;
      rec.updatedAt = ctx.now;
      ctx.summary.added++;
    }
    seen[rec.id] = true;
    out.push(rec);
    rowIds.push(rec.id);
  });

  // 表に無い記録: 削除済みはそのまま、生きていたものは削除の印を付ける
  baseRecs.forEach(function (r) {
    if (seen[r.id]) return;
    if (r.deleted) { out.push(r); return; }
    // 中身は残さない（アプリの削除と同じ形: sync.js tombstone）
    var t = kwClone(r);
    (kind === 'qa' ? ['question', 'answer', 'note'] : ['text']).forEach(function (k) { t[k] = ''; });
    t.completedTurns = [];
    t.deleted = true;
    t.updatedAt = Math.max(ctx.now, (+r.updatedAt || 0) + 1);
    out.push(t);
    ctx.summary.deleted++;
  });
  return { records: out, rowIds: rowIds };
}

function kwApplySettings(baseSettings, view, ctx) {
  if (!view) return baseSettings;
  var cur = kwSettingsView(baseSettings);
  var nText = kwStr(view.n).trim(), order = kwStr(view.order).trim() || 'random', limText = kwStr(view.limit).trim() || '0';
  var parts = nText.split(/[\s,、，・;]+/).filter(function (x) { return x !== ''; });
  var bad = !parts.length || parts.length > KW.MAX_TURNS || parts.some(function (x) { return !/^\d+$/.test(x); });
  if (bad) ctx.errors.push(KW.SET + ': n は 0 以上の整数を 1〜' + KW.MAX_TURNS + ' 個、カンマ区切りで（例: 1,3,7,14）。');
  if (KW.ORDERS.indexOf(order) === -1) ctx.errors.push(KW.SET + ': order は ' + KW.ORDERS.join(' / ') + ' のどれかです。');
  if (!/^\d+$/.test(limText)) ctx.errors.push(KW.SET + ': limit は 0 以上の整数です（0 = 上限なし）。');
  if (ctx.errors.length) return baseSettings;
  var n = parts.map(function (x) { return parseInt(x, 10); });
  var limit = parseInt(limText, 10);
  if (n.join(',') === cur.n && order === cur.order && String(limit) === cur.limit) return baseSettings;
  var s = kwClone(baseSettings || {});
  s.n = n;
  s.order = order;
  s.limit = limit;
  s.updatedAt = Math.max(ctx.now, (+(baseSettings || {}).updatedAt || 0) + 1);
  ctx.summary.settings = 1;
  return s;
}

/**
 * 表 → doc。base は Import したときの doc。
 * opts: { now(ms), today('YYYY-MM-DD'), newId(prefix) }
 * 返り値: { doc, summary{changed,added,deleted,settings}, errors[], warnings[], rowIds{qa,sentences} }
 */
function kwTablesToDoc(base, tables, opts) {
  var ctx = {
    now: opts.now, today: opts.today, newId: opts.newId,
    summary: { changed: 0, added: 0, deleted: 0, settings: 0 }, errors: [], warnings: []
  };
  var qa = kwApplyTable(base.items, tables.qa, 'qa', ctx);
  var se = kwApplyTable(base.sentences, tables.sentences, 's', ctx);
  var doc = {};
  for (var k in base) doc[k] = base[k];
  doc.version = Math.max(2, +base.version || 0);
  doc.items = qa.records;
  doc.sentences = se.records;
  doc.settings = kwApplySettings(base.settings, tables.settings, ctx);
  return {
    doc: doc, summary: ctx.summary, errors: ctx.errors, warnings: ctx.warnings,
    rowIds: { qa: qa.rowIds, sentences: se.rowIds }
  };
}

function kwSummaryText(s) {
  var parts = [];
  if (s.changed) parts.push('変更 ' + s.changed + ' 件');
  if (s.added) parts.push('追加 ' + s.added + ' 件');
  if (s.deleted) parts.push('削除 ' + s.deleted + ' 件');
  if (s.settings) parts.push('設定の変更');
  return parts.length ? parts.join('・') : '変更なし';
}
function kwSummaryCount(s) { return s.changed + s.added + s.deleted + s.settings; }

// 1 行 = 1 記録の JSON（JSON シートに 1 行 1 セルで置けて、そのまま JSON として読める）。
// どの行も " で始めない: 表計算ソフトは " で始まる行を「引用符で囲んだセル」と
// 解釈して、貼り付けたときに複数行をつなげてしまうことがある。
function kwJsonLines(doc) {
  var lines = [], open = '{"version":' + JSON.stringify(doc.version || 2) + ',';
  ['items', 'sentences'].forEach(function (key) {
    lines.push(open + JSON.stringify(key) + ':[');
    doc[key].forEach(function (r, i) { lines.push(JSON.stringify(r) + (i < doc[key].length - 1 ? ',' : '')); });
    open = '],';
  });
  var tail = open;
  for (var k in doc) {
    if (k === 'version' || k === 'items' || k === 'sentences' || k === 'settings') continue;
    tail += JSON.stringify(k) + ':' + JSON.stringify(doc[k]) + ',';
  }
  lines.push(tail + '"settings":' + JSON.stringify(doc.settings) + '}');
  return lines;
}

// 文字列を 1 セルに入る長さに分ける（控えの保存用）
function kwChunks(text, size) {
  var out = [];
  for (var i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

// ====================================================================
// スプレッドシート側
// ====================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('kwnote')
    .addItem('パネルを開く（Import / Export）', 'kwShowPanel')
    .addSeparator()
    .addItem('JSON シート → 表（Import）', 'kwMenuImportFromSheet')
    .addItem('表 → JSON シート（Export）', 'kwMenuExportToSheet')
    .addSeparator()
    .addItem('使い方', 'kwShowHelp')
    .addToUi();
}

function kwShowPanel() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutput(KW_PANEL_HTML).setTitle('kwnote'));
}

function kwShowHelp() {
  SpreadsheetApp.getUi().alert('kwnote の一括編集',
    '1. アプリの SAVE FILE（または kwnote export）で JSON を保存\n' +
    '2. メニュー kwnote → パネルを開く → ファイルを選んで Import\n' +
    '3. 「' + KW.QA + '」「' + KW.SENT + '」「' + KW.SET + '」シートを編集\n' +
    '   ・id 列は触らない / 新しい行は id を空のまま / 行を消すと削除\n' +
    '   ・Registered は 2026-10-01 の形、Done turns は 1,2,3 の形\n' +
    '4. パネルの Export → JSON をダウンロード（またはコピー）\n' +
    '5. アプリの OPEN FILE（または PASTE CODE、kwnote import）で取り込む\n\n' +
    'パネルが使えないときは「JSON」シートの A 列に JSON を貼り（1 行 1 セル）、\n' +
    'メニューの「JSON シート → 表」「表 → JSON シート」を使ってください。',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function kwToday_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

function kwNewId_(prefix) {
  var hex = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  return prefix + Date.now() + '_' + hex;
}

function kwSheet_(name, create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh && create) sh = ss.insertSheet(name);
  return sh;
}

// 先頭が = + ' のセルは式や書式指定と解釈されるので、' を付けて文字として入れる
function kwCell_(s) {
  s = kwStr(s);
  if (s.length > KW.CELL_MAX) throw new Error('1 セルに入らない長さの項目があります（' + s.slice(0, 20) + '…）。');
  return /^[=+']/.test(s) ? "'" + s : s;
}

// シートを作り直して header + rows を書く（全セルを書式なしテキストにする）
function kwWriteSheet_(name, header, rows, widths) {
  var sh = kwSheet_(name, true);
  sh.clear();
  var need = rows.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  if (sh.getMaxColumns() < header.length) sh.insertColumnsAfter(sh.getMaxColumns(), header.length - sh.getMaxColumns());
  sh.getRange(1, 1, sh.getMaxRows(), header.length).setNumberFormat('@').setVerticalAlignment('top').setWrap(true);
  var values = [header].concat(rows).map(function (r) { return r.map(kwCell_); });
  sh.getRange(1, 1, values.length, header.length).setValues(values);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#0058e6').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  (widths || []).forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  return sh;
}

// 2 行目以降を、見えているとおりの文字列で読む
function kwReadSheet_(name, cols) {
  var sh = kwSheet_(name, false);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols).getDisplayValues();
}

function kwSaveBase_(doc) {
  var sh = kwSheet_(KW.BASE, true);
  sh.clear();
  // base64 にして入れる: セルの区切りが絵文字の途中に来たり、端の空白が
  // 落ちたりしても壊れない。先頭の J は式や数値と解釈されないための印。
  var b64 = Utilities.base64Encode(JSON.stringify(doc), Utilities.Charset.UTF_8);
  var chunks = kwChunks(b64, KW.CHUNK).map(function (c) { return ['J' + c]; });
  if (sh.getMaxRows() < chunks.length) sh.insertRowsAfter(sh.getMaxRows(), chunks.length - sh.getMaxRows());
  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@');
  sh.getRange(1, 1, chunks.length, 1).setValues(chunks);
  try { sh.hideSheet(); } catch (e) { /* ほかに見えるシートが無いときは隠せない */ }
}

function kwLoadBase_() {
  var sh = kwSheet_(KW.BASE, false);
  if (!sh || sh.getLastRow() < 1) return null;
  var b64 = sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues()
    .map(function (r) { return r[0].slice(1); }).join('');
  if (!b64) return null;
  try {
    return kwParseDoc(Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString('UTF-8'));
  } catch (e) {
    throw new Error('控え（' + KW.BASE + ' シート）が壊れています。Import し直してください。');
  }
}

function kwReadTables_() {
  var qa = kwReadSheet_(KW.QA, KW.QA_HEAD.length);
  var se = kwReadSheet_(KW.SENT, KW.SENT_HEAD.length);
  if (qa === null && se === null) return null;
  var set = kwReadSheet_(KW.SET, 2), view = null;
  if (set) {
    view = {};
    set.forEach(function (r) { if (r[0]) view[String(r[0]).trim()] = r[1]; });
    if (view.n === undefined) view = null;
  }
  return { qa: qa || [], sentences: se || [], settings: view };
}

function kwWriteTables_(doc) {
  var t = kwDocToTables(doc);
  kwWriteSheet_(KW.QA, KW.QA_HEAD, t.qa, [190, 320, 320, 220, 100, 90]);
  kwWriteSheet_(KW.SENT, KW.SENT_HEAD, t.sentences, [190, 560, 100, 90]);
  kwWriteSheet_(KW.SET, KW.SET_HEAD, [
    ['n', t.settings.n, '何日後に出すか（カンマ区切り）。数の個数 = 表示回数（1〜' + KW.MAX_TURNS + '）'],
    ['order', t.settings.order, '今日のリストの並び順: ' + KW.ORDERS.join(' / ')],
    ['limit', t.settings.limit, '今日のリストの 1 日の上限（0 = なし）']
  ], [80, 200, 460]);
  [KW.QA, KW.SENT].forEach(function (name) {
    var sh = kwSheet_(name, false);
    sh.getRange(1, 1, sh.getMaxRows(), 1).setFontColor('#888888');
    sh.getRange(1, 1).setFontColor('#ffffff')
      .setNote('id は変更しないでください。新しい行は id を空のままにします。行を消すと削除になります。');
  });
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(kwSheet_(KW.QA, false));
}

// まだ Export していない変更の数（表が無ければ 0）
function kwPending_() {
  var base = kwLoadBase_(), tables = kwReadTables_();
  if (!base || !tables) return null;
  return kwTablesToDoc(base, tables, { now: Date.now(), today: kwToday_(), newId: kwNewId_ });
}

/** JSON テキスト → 表。force でなければ、未 Export の変更があるとき確認を返す */
function kwImportText(text, force) {
  var doc = kwParseDoc(text);
  if (!force) {
    var pending = kwPending_();
    if (pending && kwSummaryCount(pending.summary)) {
      return {
        needConfirm: true,
        message: 'まだ Export していない編集があります（' + kwSummaryText(pending.summary) + '）。\n捨てて読み込みますか？'
      };
    }
  }
  // 書き始める前に、セルに入らない長さの項目が無いか確かめる
  var t = kwDocToTables(doc);
  t.qa.concat(t.sentences).forEach(function (row) { row.forEach(kwCell_); });
  kwSaveBase_(doc);
  kwWriteTables_(doc);
  return { message: '読み込みました: もんだい ' + t.qa.length + ' 件・ぶんしょう ' + t.sentences.length + ' 件' };
}

/** 表 → JSON。force でなければ、削除があるとき確認を返す */
function kwExport(force) {
  var base = kwLoadBase_(), tables = kwReadTables_();
  if (!base || !tables) throw new Error('先に Import してください（表がありません）。');
  var res = kwTablesToDoc(base, tables, { now: Date.now(), today: kwToday_(), newId: kwNewId_ });
  if (res.errors.length) throw new Error(res.errors.slice(0, 8).join('\n') + (res.errors.length > 8 ? '\n…ほか ' + (res.errors.length - 8) + ' 件' : ''));
  if (!force && res.summary.deleted) {
    return {
      needConfirm: true,
      message: res.summary.deleted + ' 件が削除として書き出されます（表から消えた行、または中身が空の行）。\n続けますか？'
    };
  }
  // 新しい行に振った id を表に書き戻し、控えを更新する（もう一度 Export しても二重にならない）
  [[KW.QA, res.rowIds.qa], [KW.SENT, res.rowIds.sentences]].forEach(function (p) {
    if (!p[1].length) return;
    kwSheet_(p[0], false).getRange(2, 1, p[1].length, 1)
      .setValues(p[1].map(function (id) { return [id || '']; }));
  });
  kwSaveBase_(res.doc);
  return {
    json: kwJsonLines(res.doc).join('\n'),
    name: 'kwnote-sheet-' + kwToday_() + '.json',
    message: 'Export しました: ' + kwSummaryText(res.summary) +
      (res.warnings.length ? '\n' + res.warnings.join('\n') : '')
  };
}

// ---- メニュー（パネルを使わない経路: JSON シートに 1 行 1 セル）----

function kwMenuImportFromSheet() {
  var ui = SpreadsheetApp.getUi();
  var sh = kwSheet_(KW.JSON, false);
  if (!sh || sh.getLastRow() < 1) {
    sh = kwSheet_(KW.JSON, true);
    sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@');
    sh.setColumnWidth(1, 900);
    SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sh);
    ui.alert('「' + KW.JSON + '」シートの A1 に JSON を貼り付けてから（改行ごとに下のセルへ入ります）、もう一度このメニューを選んでください。');
    return;
  }
  var text = sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues()
    .map(function (r) { return r[0]; }).join('\n');
  try {
    var r = kwImportText(text, false);
    if (r.needConfirm) {
      if (ui.alert('kwnote', r.message, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
      r = kwImportText(text, true);
    }
    ui.alert('kwnote', r.message, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('kwnote', e.message, ui.ButtonSet.OK);
  }
}

function kwMenuExportToSheet() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = kwExport(false);
    if (r.needConfirm) {
      if (ui.alert('kwnote', r.message, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
      r = kwExport(true);
    }
    var lines = r.json.split('\n');
    var sh = kwSheet_(KW.JSON, true);
    sh.clear();
    if (sh.getMaxRows() < lines.length) sh.insertRowsAfter(sh.getMaxRows(), lines.length - sh.getMaxRows());
    sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@').setWrap(false);
    sh.getRange(1, 1, lines.length, 1).setValues(lines.map(function (l) { return [kwCell_(l)]; }));
    sh.setColumnWidth(1, 900);
    SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sh);
    ui.alert('kwnote', r.message + '\n\n「' + KW.JSON + '」シートの A 列をまるごとコピーして、アプリの PASTE CODE に貼るか、.json ファイルに保存して OPEN FILE で読み込んでください。', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('kwnote', e.message, ui.ButtonSet.OK);
  }
}

// ---- パネル（サイドバー）----

var KW_PANEL_HTML = [
  '<!DOCTYPE html><html><head><base target="_top"><meta charset="utf-8"><style>',
  'body{font:13px/1.5 "Hiragino Sans","Yu Gothic",sans-serif;margin:0;padding:10px;background:#ece9d8;color:#000}',
  'h3{margin:0 0 6px;font-size:14px;color:#0c4ed5}',
  'section{background:#fff;border:1px solid #7f9db9;padding:8px;margin-bottom:10px}',
  'button{font-size:13px;padding:3px 10px;margin:4px 4px 0 0}',
  'textarea{width:100%;box-sizing:border-box;height:90px;font:11px monospace}',
  'p{margin:4px 0}small{color:#555}',
  '#msg{white-space:pre-wrap;padding:6px;border:1px solid #7f9db9;background:#ffffe1;display:none}',
  '#msg.err{background:#ffe1e1}',
  '#ask{margin:-6px 0 10px}',
  '</style></head><body>',
  '<div id="msg"></div>',
  '<div id="ask" style="display:none"><button id="yes">はい</button><button id="no">いいえ</button></div>',
  '<section><h3>1. Import（JSON → 表）</h3>',
  '<p><small>アプリの SAVE FILE / <code>kwnote export</code> の JSON</small></p>',
  '<input type="file" id="file" accept=".json,.txt,application/json,text/plain">',
  '<p><small>または下に貼り付け:</small></p>',
  '<textarea id="in" placeholder="{ &quot;version&quot;: 2, ... }"></textarea>',
  '<button id="imp">Import</button></section>',
  '<section><h3>2. 表を編集</h3>',
  '<p><small>id 列は触らない。新しい行は id を空のまま。行を消すと削除。<br>Registered は 2026-10-01、Done turns は 1,2,3 の形。</small></p></section>',
  '<section><h3>3. Export（表 → JSON）</h3>',
  '<button id="exp">Export</button>',
  '<div id="outbox" style="display:none">',
  '<textarea id="out" readonly></textarea>',
  '<button id="dl">ダウンロード</button><button id="cp">コピー</button>',
  '<p><small>アプリの OPEN FILE（ファイル）か PASTE CODE（コピーした内容）で取り込みます。</small></p>',
  '</div></section>',
  '<script>',
  'var $=function(id){return document.getElementById(id)},last=null;',
  'function msg(t,err){var m=$("msg");m.textContent=t;m.className=err?"err":"";m.style.display=t?"block":"none";$("ask").style.display="none";}',
  // 確認はパネルの中で聞く（サイドバーでは confirm() が使えない環境がある）
  'function ask(t,yes){msg(t);$("ask").style.display="block";',
  '  $("yes").onclick=function(){msg("");yes();};$("no").onclick=function(){msg("やめました。");};}',
  'function busy(b){["imp","exp"].forEach(function(id){$(id).disabled=b;});if(b)msg("処理中…");}',
  'function call(fn,args,ok){busy(true);var r=google.script.run',
  '  .withSuccessHandler(function(x){busy(false);ok(x);})',
  '  .withFailureHandler(function(e){busy(false);msg(e.message||String(e),true);});',
  '  r[fn].apply(r,args);}',
  'function doImport(text,force){call("kwImportText",[text,force],function(r){',
  '  if(r.needConfirm){ask(r.message,function(){doImport(text,true);});return;}',
  '  msg(r.message);$("in").value="";$("file").value="";});}',
  '$("imp").onclick=function(){var f=$("file").files[0];',
  '  if(f){var rd=new FileReader();rd.onload=function(){doImport(String(rd.result),false);};',
  '    rd.onerror=function(){msg("ファイルを読めませんでした。",true);};rd.readAsText(f);}',
  '  else if($("in").value.trim())doImport($("in").value,false);',
  '  else msg("ファイルを選ぶか、JSON を貼り付けてください。",true);};',
  'function doExport(force){call("kwExport",[force],function(r){',
  '  if(r.needConfirm){ask(r.message,function(){doExport(true);});return;}',
  '  last=r;$("out").value=r.json;$("outbox").style.display="block";msg(r.message);});}',
  '$("exp").onclick=function(){doExport(false);};',
  '$("dl").onclick=function(){if(!last)return;var a=document.createElement("a");',
  '  a.href=URL.createObjectURL(new Blob([last.json],{type:"application/json"}));',
  '  a.download=last.name;document.body.appendChild(a);a.click();a.remove();};',
  '$("cp").onclick=function(){var o=$("out");o.focus();o.select();var ok=false;',
  '  try{ok=document.execCommand("copy");}catch(e){}',
  '  msg(ok?"コピーしました。":"選択しました。Ctrl+C / ⌘C でコピーしてください。");};',
  '</script></body></html>'
].join('\n');
