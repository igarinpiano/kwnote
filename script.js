var K_ITEMS="srs_items", K_SETTINGS="srs_settings", K_SENTENCES="srs_sentences";
var K_TODAY="kw_today";   // 今日のリスト（この端末だけ。並び順と上限を 1 日保つ）

// 設定: { n:[turn ごとの日数…（個数 = 表示回数）], order, limit, updatedAt }
// 値と意味は cli/src/model.rs（Settings / PRESETS / Order）と揃える。
var DEFAULT_N = [1,3,7,14], MAX_TURNS = 20;
var PRESETS = [
  ["standard", "標準",  [1,3,7,14]],
  ["dense",    "こまめ", [1,2,3,5,7,10,14]],
  ["long",     "長期",  [1,3,7,14,30,60,120]],
  ["daily",    "毎日",  [1,2,3,4,5,6,7]]
];
var ORDERS = [
  ["random", "ランダム / Random"],
  ["due",    "遅れている順 / Most overdue"],
  ["oldest", "登録が古い順 / Oldest"],
  ["newest", "登録が新しい順 / Newest"]
];

function safeGet(key, fallback){
  try{ var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch(e){ return fallback; }
}
function safeSet(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){ console.error("storage error", e); }
}

// Records are never removed: deletion leaves a tombstone ({deleted:true}) so
// that it can propagate through sync. Every change stamps updatedAt.
function loadItems(){ return safeGet(K_ITEMS, []); }
function saveItems(v){ safeSet(K_ITEMS, v); scheduleAutoSync(); }
// 保存されている値は変えずに、使うときだけ整える（壊れた値・空の n は既定値）
function normSettings(s){
  var out = {}, k;
  s = s && typeof s === "object" ? s : {};
  for(k in s) if(s.hasOwnProperty(k)) out[k] = s[k];
  var n = Array.isArray(s.n) ? s.n.map(function(x){ x = parseInt(x, 10); return x > 0 ? x : 0; }) : [];
  out.n = n.length ? n : DEFAULT_N.slice();
  return out;
}
function settingOrder(s){ return ORDERS.some(function(o){ return o[0] === s.order; }) ? s.order : "random"; }
function settingLimit(s){ var l = parseInt(s.limit, 10); return l > 0 ? l : 0; }
function loadSettings(){ return normSettings(safeGet(K_SETTINGS, null)); }
function saveSettings(v){ safeSet(K_SETTINGS, v); scheduleAutoSync(); }
function loadSentences(){
  var list = safeGet(K_SENTENCES, []);
  var changed = false;
  list.forEach(function(s){
    if(!s.registeredDate){ s.registeredDate = todayStr(); changed = true; }
    if(!s.completedTurns){ s.completedTurns = []; changed = true; }
  });
  if(changed) safeSet(K_SENTENCES, list);
  return list;
}
function saveSentences(v){ safeSet(K_SENTENCES, v); scheduleAutoSync(); }
function alive(r){ return r && !r.deleted; }

function loadRecords(pane){ return pane === "qa" ? loadItems() : loadSentences(); }
function saveRecords(pane, v){ if(pane === "qa") saveItems(v); else saveSentences(v); }

function getDoc(){
  return { version:2, items: loadItems(), settings: safeGet(K_SETTINGS, {n:DEFAULT_N.slice()}), sentences: loadSentences() };
}
function setDoc(doc){
  safeSet(K_ITEMS, doc.items || []);
  safeSet(K_SENTENCES, doc.sentences || []);
  if(doc.settings) safeSet(K_SETTINGS, doc.settings);
}

function todayStr(){
  var d = new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function addDays(dateStr, n){
  var d = new Date(dateStr+"T00:00:00");
  d.setDate(d.getDate()+n);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function getToday(){
  var v = document.getElementById("today-date-input").value;
  return v || todayStr();
}
function getRegDate(){
  var v = document.getElementById("reg-date-input").value;
  return v || todayStr();
}
function dueTurn(entity, settings, today){
  var n = settings.n;
  for(var t=1; t<=n.length; t++){
    if(entity.completedTurns && entity.completedTurns.indexOf(t) !== -1) continue;
    var sched = addDays(entity.registeredDate, n[t-1] || 0);
    if(sched <= today) return t;
    return null;
  }
  return null;
}
// first unfinished turn and its date, or null when all turns are done
function nextTurn(entity, settings){
  for(var t=1; t<=settings.n.length; t++){
    if(entity.completedTurns && entity.completedTurns.indexOf(t) !== -1) continue;
    return {turn:t, date:addDays(entity.registeredDate, settings.n[t-1] || 0)};
  }
  return null;
}

// ---- 画面の状態 ----
// pane: "reading"（ぶんしょう） / "qa"（一問一答）
// j/k・c・Enter はフォーカス中の表に効く。Shift+J / Shift+K で表を切り替える。
var panes = {
  reading: { due:[], all:false, filter:"", sel:null },  // due: [{id, turn}] 本日分として固定されたリスト
  qa:      { due:[], all:false, filter:"", sel:null }
};
var focusPane = "qa";
var revealState = {};
var editing = null;          // {pane, id, prevRegDate}

function shuffle(list){
  for(var i = list.length - 1; i > 0; i--){
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
  }
  return list;
}
function cmp(a, b){ return a < b ? -1 : a > b ? 1 : 0; }

// 今日のリスト（cli/src/model.rs build_today と同じ考え方）:
// carry（引き継ぐ行）をそのままの順で先頭に置き、残りの「今日の分」を
// 設定の並び順で後ろに足す。上限（limit）があればそこまで。
// 終わった行も今日のうちはリストに残るので、上限に数えられる。
function buildToday(recs, settings, today, carry){
  var byId = {}, have = {}, out = [], cand = [];
  recs.forEach(function(r){ if(alive(r)) byId[r.id] = r; });
  (carry || []).forEach(function(e){
    if(byId[e.id] && !have[e.id]){ have[e.id] = true; out.push({id:e.id, turn:e.turn}); }
  });
  recs.forEach(function(r){
    if(!alive(r) || have[r.id]) return;
    var t = dueTurn(r, settings, today);
    if(t) cand.push({id:r.id, turn:t, sched:addDays(r.registeredDate, settings.n[t-1] || 0), reg:r.registeredDate || ""});
  });
  var order = settingOrder(settings);
  if(order === "random") shuffle(cand);
  else cand.sort(function(a, b){
    if(order === "due") return cmp(a.sched, b.sched) || cmp(a.reg, b.reg);
    if(order === "oldest") return cmp(a.reg, b.reg);
    return cmp(b.reg, a.reg);
  });
  var limit = settingLimit(settings);
  if(limit) cand = cand.slice(0, Math.max(0, limit - out.length));
  return out.concat(cand.map(function(c){ return {id:c.id, turn:c.turn}; }));
}

// list の中で、その turn をもう終えている行だけ
function doneEntries(recs, list){
  var byId = {};
  recs.forEach(function(r){ byId[r.id] = r; });
  return (list || []).filter(function(e){
    var r = byId[e.id];
    return r && (r.completedTurns || []).indexOf(e.turn) !== -1;
  });
}

function todaySig(s){ return JSON.stringify([s.n, settingOrder(s), settingLimit(s)]); }
function saveToday(){
  safeSet(K_TODAY, {date:listDate, sig:todaySig(loadSettings()), reading:panes.reading.due, qa:panes.qa.due});
}

// 今日のリストを作り直す（日付・設定の変更時）。同じ日のうちは終えた行を残す。
// restore=true（起動時）: 同じ日・同じ設定で前回作ったリストがあればそれを使う。
var listDate = null;
function refreshDueList(restore){
  var settings = loadSettings(), today = getToday();
  var saved = restore ? safeGet(K_TODAY, null) : null;
  if(saved && saved.date !== today) saved = null;
  ["reading", "qa"].forEach(function(p){
    var recs = loadRecords(p), carry;
    if(saved && saved.sig === todaySig(settings)) carry = saved[p] || [];
    else if(saved) carry = doneEntries(recs, saved[p]);
    else carry = listDate === today ? doneEntries(recs, panes[p].due) : [];
    panes[p].due = buildToday(recs, settings, today, carry);
  });
  listDate = today;
  saveToday();
  revealState = {};
  ["reading", "qa"].forEach(function(p){
    var rows = paneRows(p), first = rows.find(function(r){ return !r.done; }) || rows[0];
    panes[p].sel = first ? first.id : null;
  });
}

// After a save/sync: keep today's order, drop deleted, append newly due (within the limit).
function reconcileDueLists(){
  var settings = loadSettings(), today = getToday();
  ["reading", "qa"].forEach(function(p){
    panes[p].due = buildToday(loadRecords(p), settings, today, panes[p].due);
    var rows = paneRows(p);
    if(!rows.some(function(r){ return r.id === panes[p].sel; })) panes[p].sel = rows.length ? rows[0].id : null;
  });
  listDate = today;
  saveToday();
}

function haystack(p, r){
  return (p === "qa" ? [r.question, r.answer, r.note].join("\n") : r.text || "").toLowerCase();
}

// Rows currently shown in a pane: today's list, or every record (全部 view, filterable).
function paneRows(p, recs){
  recs = recs || loadRecords(p);
  var byId = {};
  recs.forEach(function(r){ if(alive(r)) byId[r.id] = r; });
  if(!panes[p].all){
    return panes[p].due.filter(function(e){ return byId[e.id]; }).map(function(e){
      var r = byId[e.id];
      return {id:e.id, turn:e.turn, rec:r, done:(r.completedTurns || []).indexOf(e.turn) !== -1};
    });
  }
  var settings = loadSettings(), pat = panes[p].filter.trim().toLowerCase();
  return recs.filter(alive).filter(function(r){
    return !pat || haystack(p, r).indexOf(pat) !== -1;
  }).map(function(r){
    var nx = nextTurn(r, settings);
    return {id:r.id, turn:nx ? nx.turn : null, sched:nx ? nx.date : null, rec:r, done:false};
  }).sort(function(a, b){
    if(a.sched && b.sched) return a.sched < b.sched ? -1 : a.sched > b.sched ? 1 : 0;
    if(a.sched) return -1;
    if(b.sched) return 1;
    return 0;
  });
}

function showLoading(id, on){
  document.getElementById(id).classList.toggle("active", on);
}

// full=true: recompute (and reshuffle) today's lists; otherwise keep order.
function doRefresh(full){
  showLoading("qa-loading", true);
  showLoading("reading-loading", true);
  setTimeout(function(){
    if(full === false) reconcileDueLists(); else refreshDueList();
    render();
    showLoading("qa-loading", false);
    showLoading("reading-loading", false);
  }, 500);
}

// ---- 描画 ----
function el(tag, cls, text){
  var e = document.createElement(tag);
  if(cls) e.className = cls;
  if(text !== undefined) e.textContent = text;
  return e;
}

// 表の見出し: 今日の分はオリジナルどおり。ぶんしょうには完了チェック列、全部表示には操作列が付く。
function renderHead(p){
  var all = panes[p].all, cols;
  if(p === "qa"){
    cols = [["turn", "Turn"], ["question", "Que."], ["answer", "Ans."], ["note", "Sup."]];
    if(all) cols.push(["actions", ""]);
  } else {
    cols = [["turn", "Turn"], ["sentence", "Sentences"]];
    if(all) cols.push(["actions", ""]);
  }
  var table = document.getElementById(p + "-tbody").parentNode;
  table.classList.toggle("with-extra", cols.length > (p === "qa" ? 4 : 2));
  var tr = el("tr", "qa-row");
  cols.forEach(function(c){ tr.appendChild(el("th", "qa-cell qa-cell-" + c[0], c[1])); });
  var thead = table.querySelector("thead");
  thead.innerHTML = "";
  thead.appendChild(tr);
}

function turnCell(row, all){
  var td = el("td", "qa-cell qa-cell-turn");
  if(all){
    td.textContent = row.turn ? row.turn + " · " + row.sched.slice(5).replace("-", "/") : "✓";
    if(row.sched && row.sched <= getToday()) td.classList.add("turn-due");
  } else {
    td.textContent = row.turn;
  }
  return td;
}

// 全部表示の行に付く 編集 / 削除 ボタン
function actionsCell(p, row){
  var td = el("td", "qa-cell qa-cell-actions");
  var edit = el("button", "row-btn", "✎");
  edit.title = "編集 / Edit";
  edit.addEventListener("click", function(e){ e.stopPropagation(); startEdit(p, row.id); });
  var del = el("button", "row-btn", "🗑");
  del.title = "削除 / Delete";
  del.addEventListener("click", function(e){ e.stopPropagation(); deleteRecord(p, row.id); });
  td.appendChild(edit);
  td.appendChild(del);
  return td;
}

function render(){
  renderReading();
  renderQa();
  ["reading", "qa"].forEach(function(p){
    document.getElementById(p + "-head").classList.toggle("pane-focused", focusPane === p);
    var rows = paneRows(p);
    var done = rows.filter(function(r){ return r.done; }).length;
    document.getElementById(p + "-count").textContent = panes[p].all
      ? "全部 " + rows.length + " 件"
      : rows.length ? done + " / " + rows.length : "";
    document.querySelector('.view-toggle[data-pane="' + p + '"]').textContent = panes[p].all ? "全部 → 今日" : "今日 → 全部";
    var f = document.querySelector('.pane-filter[data-pane="' + p + '"]');
    f.style.display = panes[p].all ? "" : "none";
    if(f !== document.activeElement) f.value = panes[p].filter;
  });
}
// only after keyboard / button navigation, never on background re-renders
function scrollToSelected(){
  var sel = document.querySelector("#" + focusPane + "-tbody tr.selected");
  if(sel && sel.scrollIntoView) sel.scrollIntoView({block:"nearest"});
}

function rowElement(p, row){
  var tr = el("tr", "qa-row turn-color-" + (row.turn ? Math.min(row.turn, 8) : "done") +
    (row.done ? " qa-row-done" : "") +
    (row.id === panes[p].sel ? " selected" + (focusPane === p ? "" : " selected-blur") : ""));
  tr.dataset.id = row.id;
  tr.dataset.pane = p;
  tr.addEventListener("click", function(){ focusPane = p; panes[p].sel = row.id; render(); });
  tr.appendChild(turnCell(row, panes[p].all));
  return tr;
}

function renderQa(){
  renderHead("qa");
  var tbody = document.getElementById("qa-tbody");
  tbody.innerHTML = "";
  var rows = paneRows("qa"), all = panes.qa.all;
  document.getElementById("qa-empty").style.display = rows.length ? "none" : "block";

  rows.forEach(function(row){
    var it = row.rec;
    var tr = rowElement("qa", row);

    var tdQ = document.createElement("td");
    tdQ.className = "qa-cell qa-cell-question";
    tdQ.textContent = it.question;
    tr.appendChild(tdQ);

    var revealed = all || !!revealState[row.id];
    var tdA = document.createElement("td");
    tdA.className = "qa-cell qa-cell-answer";
    var ansSpan = document.createElement("span");
    ansSpan.className = revealed ? "answer-visible" : "answer-hidden";
    ansSpan.textContent = revealed ? it.answer : it.answer.replace(/./gs, "＝");
    ansSpan.addEventListener("click", function(e){ e.stopPropagation(); focusPane = "qa"; panes.qa.sel = row.id; toggleReveal(row.id); });
    tdA.appendChild(ansSpan);
    tr.appendChild(tdA);

    var tdNote = document.createElement("td");
    tdNote.className = "qa-cell qa-cell-note";
    tdNote.textContent = revealed ? (it.note || "") : "";
    tr.appendChild(tdNote);

    if(all) tr.appendChild(actionsCell("qa", row));
    tbody.appendChild(tr);
  });
}

function renderReading(){
  renderHead("reading");
  var tbody = document.getElementById("reading-tbody");
  tbody.innerHTML = "";
  var rows = paneRows("reading"), all = panes.reading.all;
  document.getElementById("reading-empty").style.display = rows.length ? "none" : "block";

  rows.forEach(function(row){
    var tr = rowElement("reading", row);
    var tdText = document.createElement("td");
    tdText.className = "qa-cell qa-cell-sentence";
    tdText.textContent = row.rec.text;
    tr.appendChild(tdText);
    if(all) tr.appendChild(actionsCell("reading", row));
    tbody.appendChild(tr);
  });
}

// ---- メッセージ（XP のツールチップ風） ----
var msgTimer = null;
function message(text, isError){
  var m = document.getElementById("sb-msg");
  m.textContent = text || "";
  m.classList.toggle("sb-error", !!isError);
  document.getElementById("statusbar").classList.toggle("has-msg", !!text);
  clearTimeout(msgTimer);
  if(text) msgTimer = setTimeout(function(){ message(""); }, isError ? 6000 : 3500);
}
// 文字入力中か（ボタン等は含めない: j/k/c を奪わないため）
function isInputFocused(){
  var a = document.activeElement;
  if(!a) return false;
  if(a.tagName === "INPUT") return !/^(checkbox|radio|button|submit|reset|file|range|color)$/i.test(a.type);
  return a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable;
}

// ---- 操作 ----
function toggleReveal(id){
  revealState[id] = !revealState[id];
  render();
}

// strictly newer than prev: a same-millisecond tie would merge instead of win
function nextStamp(prev){ return Math.max(Date.now(), (+prev || 0) + 1); }

// Apply fn to the stored record and save.
function updateRecord(p, id, fn){
  var list = loadRecords(p);
  var rec = list.find(function(x){ return x.id === id; });
  if(!rec) return null;
  fn(rec);
  rec.updatedAt = nextStamp(rec.updatedAt);
  saveRecords(p, list);
  return rec;
}

function markOk(id, p){
  p = p || focusPane;
  if(panes[p].all){ message("OK は「今日」の表示で使えます", true); return; }
  var entry = panes[p].due.find(function(x){ return x.id === id; });
  if(!entry) return;
  var nowDone = false;
  updateRecord(p, id, function(it){
    if(!it.completedTurns) it.completedTurns = [];
    var idx2 = it.completedTurns.indexOf(entry.turn);
    if(idx2 === -1){ it.completedTurns.push(entry.turn); nowDone = true; }
    else it.completedTurns.splice(idx2, 1);
  });
  message(nowDone ? "OK — turn " + entry.turn + " done" : "turn " + entry.turn + " を未完了に戻しました");

  // autofocus
  if(nowDone){
    var rows = paneRows(p);
    var curIdx = rows.findIndex(function(x){ return x.id === id; });
    if(curIdx !== -1){
      var n = rows.length;
      for(var d = 1; d < n; d++){
        var prevIdx = curIdx - d;
        if(prevIdx >= 0 && !rows[prevIdx].done){
          panes[p].sel = rows[prevIdx].id;
          break;
        }
        var nextIdx = curIdx + d;
        if(nextIdx < n && !rows[nextIdx].done){
          panes[p].sel = rows[nextIdx].id;
          break;
        }
      }
    }
  }

  render();
}

function deleteRecord(p, id){
  var rec = loadRecords(p).find(function(x){ return x.id === id; });
  if(!rec) return;
  var label = p === "qa" ? rec.question : rec.text;
  if(!confirm("削除しますか？ / Delete?\n\n" + label)) return;
  updateRecord(p, id, function(r){ r.deleted = true; });
  reconcileDueLists();
  message("削除しました");
  render();
}

function moveSelection(delta){
  var p = focusPane, rows = paneRows(p);
  if(!rows.length) return;
  var idx = rows.findIndex(function(d){ return d.id === panes[p].sel; });
  if(idx === -1) idx = 0;
  idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
  panes[p].sel = rows[idx].id;
  render();
  scrollToSelected();
}
// ぶんしょう ⇄ もんだい（引数なしなら反対側へ）
function switchPane(p){
  focusPane = p || (focusPane === "qa" ? "reading" : "qa");
  render();
  scrollToSelected();
}
function toggleView(p){
  panes[p].all = !panes[p].all;
  var rows = paneRows(p);
  panes[p].sel = rows.length ? rows[0].id : null;
  render();
}

// ---- 登録・編集フォーム ----
function formFields(p){
  return p === "qa"
    ? ["input-question", "input-answer", "input-note"]
    : ["new-sentence-input"];
}
function startEdit(p, id){
  var r = loadRecords(p).find(function(x){ return x.id === id; });
  if(!r) return;
  cancelEdit();
  var reg = document.getElementById("reg-date-input");
  editing = {pane:p, id:id, prevRegDate:reg.value};
  reg.value = r.registeredDate;
  if(p === "qa"){
    document.getElementById("input-question").value = r.question;
    document.getElementById("input-answer").value = r.answer;
    document.getElementById("input-note").value = r.note || "";
  } else {
    document.getElementById("new-sentence-input").value = r.text;
  }
  setFormMode(p, true);
  var first = document.getElementById(formFields(p)[0]);
  first.focus();
  first.scrollIntoView({block:"center"});
}

function setFormMode(p, isEdit){
  var btn = document.getElementById(p === "qa" ? "add-qa-btn" : "add-sentence-btn");
  btn.textContent = isEdit ? "UPDATE" : "REGISTER";
  document.getElementById(p === "qa" ? "cancel-qa-btn" : "cancel-sentence-btn").style.display = isEdit ? "" : "none";
  document.getElementById(p === "qa" ? "qa-form" : "sentence-form").classList.toggle("editing", isEdit);
  document.getElementById("edit-badge").style.display = editing ? "" : "none";
}
function cancelEdit(){
  if(!editing) return;
  var p = editing.pane;
  document.getElementById("reg-date-input").value = editing.prevRegDate || todayStr();
  formFields(p).forEach(function(id){ document.getElementById(id).value = ""; });
  editing = null;
  setFormMode(p, false);
}

function submitQa(btn){
  var q = document.getElementById("input-question").value.trim();
  var a = document.getElementById("input-answer").value.trim();
  var note = document.getElementById("input-note").value.trim();
  if(!q || !a){ message("Question と Answer は必須です", true); return; }
  btn.disabled = true;
  btn.textContent = "登録中…";
  setTimeout(function(){
    if(editing && editing.pane === "qa"){
      var id = editing.id, reg = getRegDate();
      updateRecord("qa", id, function(it){ it.question = q; it.answer = a; it.note = note; it.registeredDate = reg; });
      cancelEdit();
      message("更新しました");
    } else {
      var items = loadItems();
      items.push({
        id: "id_" + Date.now() + "_" + Math.random().toString(36).slice(2,8),
        question: q, answer: a, note: note,
        registeredDate: getRegDate(), completedTurns: [], updatedAt: Date.now()
      });
      saveItems(items);
      document.getElementById("input-question").value = "";
      document.getElementById("input-answer").value = "";
      document.getElementById("input-note").value = "";
      message("登録しました — 初回 " + addDays(getRegDate(), loadSettings().n[0] || 0));
    }
    btn.textContent = editing ? "UPDATE" : "REGISTER";
    btn.disabled = false;
    doRefresh(false);
  }, 200);
}

function submitSentence(btn){
  var input = document.getElementById("new-sentence-input");
  var text = input.value.trim();
  if(!text) return;
  btn.disabled = true;
  btn.textContent = "登録中…";
  setTimeout(function(){
    if(editing && editing.pane === "reading"){
      var id = editing.id, reg = getRegDate();
      updateRecord("reading", id, function(s){ s.text = text; s.registeredDate = reg; });
      cancelEdit();
      message("更新しました");
    } else {
      var list = loadSentences();
      list.push({ id:"s_"+Date.now()+"_"+Math.random().toString(36).slice(2,6), text:text, registeredDate:getRegDate(), completedTurns:[], updatedAt:Date.now() });
      saveSentences(list);
      input.value = "";
      message("登録しました — 初回 " + addDays(getRegDate(), loadSettings().n[0] || 0));
    }
    btn.textContent = editing ? "UPDATE" : "REGISTER";
    btn.disabled = false;
    doRefresh(false);
  }, 200);
}

// ---- 日付フィールド ----
document.getElementById("reg-date-input").value = todayStr();
document.getElementById("today-date-input").value = todayStr();
document.getElementById("today-date-input").addEventListener("change", function(){
  doRefresh();
});

// ---- 一問一答 登録 ----
document.getElementById("add-qa-btn").addEventListener("click", function(){ submitQa(this); });
document.getElementById("cancel-qa-btn").addEventListener("click", cancelEdit);

// ---- 英文 登録 ----
document.getElementById("add-sentence-btn").addEventListener("click", function(){ submitSentence(this); });
document.getElementById("cancel-sentence-btn").addEventListener("click", cancelEdit);

// Enter: 次の欄へ / 最後の欄なら登録。Ctrl+Enter: どこからでも登録
["reading", "qa"].forEach(function(p){
  var ids = formFields(p);
  ids.forEach(function(id, i){
    document.getElementById(id).addEventListener("keydown", function(e){
      if(e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if(i < ids.length - 1 && !(e.ctrlKey || e.metaKey)) document.getElementById(ids[i + 1]).focus();
      else document.getElementById(p === "qa" ? "add-qa-btn" : "add-sentence-btn").click();
    });
  });
});

// ---- 設定 ----
// フォームは SAVE するまで保存しない（＋1回・－1回・プリセットはフォームだけ変える）
function turnInputs(){ return [].slice.call(document.querySelectorAll("#turn-inputs input")); }
function formIntervals(){ return turnInputs().map(function(i){ var v = parseInt(i.value, 10); return v > 0 ? v : 0; }); }
function renderTurnInputs(n){
  var box = document.getElementById("turn-inputs");
  box.innerHTML = "";
  n.forEach(function(d, i){
    var label = el("label", "", "turn " + (i + 1) + ": ");
    var input = el("input");
    input.type = "number"; input.min = "0"; input.id = "n" + (i + 1); input.value = d;
    input.addEventListener("input", updateSettingsNote);
    label.appendChild(input);
    box.appendChild(label);
  });
  document.getElementById("turn-add-btn").disabled = n.length >= MAX_TURNS;
  document.getElementById("turn-del-btn").disabled = n.length <= 1;
  updateSettingsNote();
}
function updateSettingsNote(){
  var n = formIntervals();
  var limit = parseInt(document.getElementById("limit-input").value, 10) || 0;
  document.getElementById("settings-note").textContent =
    "表示 " + n.length + " 回：登録の " + n.join("・") + " 日後" +
    (limit > 0 ? "　/　今日のリストは各 " + limit + " 件まで" : "");
}
function loadSettingsToForm(){
  var s = loadSettings();
  renderTurnInputs(s.n);
  document.getElementById("order-select").value = settingOrder(s);
  document.getElementById("limit-input").value = settingLimit(s);
  updateSettingsNote();
}
function applySettings(n){
  var s = normSettings(safeGet(K_SETTINGS, null));   // 知らない項目も残す
  s.n = n;
  s.order = document.getElementById("order-select").value;
  s.limit = Math.max(0, parseInt(document.getElementById("limit-input").value, 10) || 0);
  s.updatedAt = nextStamp(s.updatedAt);
  saveSettings(s);
  loadSettingsToForm();
  doRefresh();
}
(function(){
  var preset = document.getElementById("preset-select");
  PRESETS.forEach(function(p){
    var o = el("option", "", p[1] + "（" + p[2].join("・") + "）");
    o.value = p[0];
    preset.appendChild(o);
  });
  preset.addEventListener("change", function(){
    var p = PRESETS.find(function(x){ return x[0] === preset.value; });
    preset.value = "";
    if(!p) return;
    renderTurnInputs(p[2].slice());
    message("「" + p[1] + "」を入れました — SAVE で保存");
  });
  var order = document.getElementById("order-select");
  ORDERS.forEach(function(x){ var o = el("option", "", x[1]); o.value = x[0]; order.appendChild(o); });
  document.getElementById("limit-input").addEventListener("input", updateSettingsNote);
})();
document.getElementById("turn-add-btn").addEventListener("click", function(){
  var n = formIntervals(), last = n.length ? n[n.length - 1] : 1;
  if(n.length >= MAX_TURNS) return;
  n.push(Math.max(last * 2, last + 1));   // 新しい回は前の回の 2 倍の日数から
  renderTurnInputs(n);
  var inputs = turnInputs();
  inputs[inputs.length - 1].focus();
});
document.getElementById("turn-del-btn").addEventListener("click", function(){
  var n = formIntervals();
  if(n.length > 1){ n.pop(); renderTurnInputs(n); }
});
document.getElementById("save-settings-btn").addEventListener("click", function(){
  applySettings(formIntervals());
  message("設定を保存しました / Saved");
});
loadSettingsToForm();


// ---- 同期 ----
var syncTimer = null, syncing = false, syncAgain = false, suppressAutoSync = false;

function scheduleAutoSync(){
  if(suppressAutoSync) return;
  var cfg = KWSync.getServer();
  if(!cfg || !cfg.url || cfg.auto === false) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(function(){ syncNow(true); }, 1200);
}

// Merge an incoming document into local storage and refresh the view.
function mergeIncoming(doc){
  var merged = KWSync.mergeDocs(getDoc(), doc);
  suppressAutoSync = true;
  setDoc(merged);
  suppressAutoSync = false;
  loadSettingsToForm();
  reconcileDueLists();
  render();
  return merged;
}

function setSyncStatus(text, state){
  var s = document.getElementById("sync-status");
  s.textContent = text;
  s.className = "sync-status" + (state ? " sync-" + state : "");
}
function describeServer(){
  var cfg = KWSync.getServer();
  if(!cfg || !cfg.url){ setSyncStatus("LAN: 未接続 / not connected"); return; }
  document.getElementById("sync-url").value = cfg.url;
  document.getElementById("sync-key").value = cfg.key || "";
  setSyncStatus("LAN: " + cfg.url + (cfg.lastSync ? "  ·  last sync " + new Date(cfg.lastSync).toLocaleTimeString() : ""), cfg.lastSync ? "ok" : "");
}

function syncNow(quiet){
  var cfg = KWSync.getServer();
  if(!cfg || !cfg.url){ if(!quiet) message("同期サーバー未設定 — Sync 欄に URL を入力してください", true); return Promise.resolve(); }
  if(syncing){ syncAgain = true; return Promise.resolve(); }
  syncing = true;
  setSyncStatus("LAN: syncing… " + cfg.url, "busy");
  var sent = JSON.stringify(getDoc());
  return KWSync.syncWithServer(JSON.parse(sent), cfg).then(function(remote){
    var changedMeanwhile = JSON.stringify(getDoc()) !== sent;
    mergeIncoming(remote);       // merge (not replace): keeps edits made while waiting
    cfg.lastSync = Date.now();
    KWSync.setServer(cfg);
    describeServer();
    if(!quiet) message("同期しました / synced");
    if(changedMeanwhile) syncAgain = true;
  }, function(err){
    setSyncStatus("LAN: " + cfg.url + " — " + err.message, "error");
    if(!quiet) message("同期失敗: " + err.message, true);
  }).then(function(){
    syncing = false;
    if(syncAgain){ syncAgain = false; scheduleAutoSync(); }
  });
}

document.getElementById("sync-btn").addEventListener("click", function(){
  var url = KWSync.normalizeUrl(document.getElementById("sync-url").value);
  var key = document.getElementById("sync-key").value.trim();
  var m = /#key=([0-9a-zA-Z]+)/.exec(document.getElementById("sync-url").value);
  if(m && !key) key = m[1];
  if(!url){ message("URL を入力してください (例: http://192.168.1.20:7878)", true); return; }
  if(location.protocol === "https:" && url.indexOf("http:") === 0){
    message("https のページから http のLANサーバーには接続できません。サーバーのURLを直接開いてください。", true);
  }
  var cur = KWSync.getServer() || {};
  KWSync.setServer({url:url, key:key, auto:true, lastSync: cur.url === url ? cur.lastSync : null});
  syncNow(false);
});
document.getElementById("sync-forget-btn").addEventListener("click", function(){
  KWSync.setServer(null);
  document.getElementById("sync-url").value = "";
  document.getElementById("sync-key").value = "";
  describeServer();
  message("同期設定を消去しました");
});

function showSyncQr(){
  KWSync.encodeFrames(getDoc()).then(function(frames){
    KWSync.showQr(frames, {title: "Sync QR — " + frames.length + " frame" + (frames.length > 1 ? "s" : "")});
  }, function(err){ message("QR作成失敗: " + err.message, true); });
}
function scanSyncQr(){
  KWSync.scanQr(function(doc){
    var before = loadItems().filter(alive).length + loadSentences().filter(alive).length;
    mergeIncoming(doc);
    var after = loadItems().filter(alive).length + loadSentences().filter(alive).length;
    message("QRから読み込みました（マージ） " + before + " → " + after + " 件");
  });
}
document.getElementById("qr-show-btn").addEventListener("click", showSyncQr);
document.getElementById("qr-scan-btn").addEventListener("click", scanSyncQr);

function copyText(text){
  if(navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  var area = el("textarea");
  area.value = text;
  area.style.position = "fixed"; area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  var ok = false;
  try{ ok = document.execCommand("copy"); }catch(e){}
  area.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error("clipboard unavailable"));
}
// コード（または JSON）を表示・入力する小さなダイアログ
function codeDialog(title, value, onLoad){
  var d = KWSync.dialog(title);
  var area = el("textarea", "code-area");
  area.value = value || "";
  area.placeholder = "KW1:… の同期コード、または EXPORT / SAVE FILE の JSON を貼り付け";
  d.body.appendChild(area);
  if(onLoad){
    var btn = el("button", "", "LOAD（マージ）");
    btn.addEventListener("click", function(){ onLoad(area.value.trim()); });
    d.body.appendChild(btn);
    setTimeout(function(){ area.focus(); }, 0);
  } else {
    d.body.appendChild(el("p", "modal-hint", "自動でコピーできなかったので、全選択してコピーしてください。"));
    setTimeout(function(){ area.focus(); area.select(); }, 0);
  }
}
document.getElementById("code-copy-btn").addEventListener("click", function(){
  KWSync.encodeFrames(getDoc(), 100000).then(function(frames){
    var code = frames.join("\n");
    return copyText(code).then(function(){
      message("同期コードをコピーしました（相手の PASTE CODE に貼り付け）");
    }, function(){ codeDialog("Sync code", code, null); });
  }).catch(function(err){ message("コピー失敗: " + err.message, true); });
});
document.getElementById("code-paste-btn").addEventListener("click", function(){
  codeDialog("Paste code", "", function(raw){
    if(!raw) return;
    KWSync.decodeAny(raw).then(function(data){
      KWSync.closeDialog();
      mergeIncoming(data);
      scheduleAutoSync();
      message("読み込みました（マージ）");
    }).catch(function(e){ message("読み込み失敗: " + e.message, true); });
  });
});

function backupFileName(){ return "kwnote-" + todayStr() + ".json"; }
document.getElementById("file-save-btn").addEventListener("click", function(){
  var blob = new Blob([JSON.stringify(getDoc(), null, 2)], {type:"application/json"});
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = backupFileName();
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});
document.getElementById("file-open-btn").addEventListener("click", function(){ document.getElementById("file-input").click(); });
document.getElementById("file-input").addEventListener("change", function(){
  var f = this.files && this.files[0];
  if(!f) return;
  var input = this;
  f.text().then(KWSync.decodeAny).then(function(doc){
    mergeIncoming(doc);
    message(f.name + " を読み込みました（マージ）");
  }).catch(function(err){ message("読み込み失敗: " + err.message, true); })
    .then(function(){ input.value = ""; });
});
(function(){
  var probe;
  try{ probe = new File(["{}"], "x.json", {type:"application/json"}); }catch(e){ return; }
  if(!navigator.canShare || !navigator.canShare({files:[probe]})) return;
  var btn = document.getElementById("share-btn");
  btn.style.display = "";
  btn.addEventListener("click", function(){
    var file = new File([JSON.stringify(getDoc())], backupFileName(), {type:"application/json"});
    navigator.share({files:[file], title:"kwnote backup"}).catch(function(){});
  });
})();

// ---- モバイル操作ボタン ----
document.getElementById("m-up").addEventListener("click", function(){ moveSelection(-1); });
document.getElementById("m-down").addEventListener("click", function(){ moveSelection(1); });
document.getElementById("m-pane").addEventListener("click", function(){ switchPane(); });
document.getElementById("m-show").addEventListener("click", showAnswer);
document.getElementById("m-ok").addEventListener("click", function(){ if(panes[focusPane].sel) markOk(panes[focusPane].sel); });
// ---- 見出し（クリックでその表にフォーカス）と、今日⇄全部 / 全部表示での絞り込み ----
document.querySelectorAll(".view-toggle").forEach(function(b){
  b.addEventListener("click", function(){ toggleView(b.dataset.pane); });
});
document.querySelectorAll(".pane-head").forEach(function(h){
  h.addEventListener("click", function(e){
    if(e.target.tagName !== "BUTTON" && e.target.tagName !== "INPUT") switchPane(h.dataset.pane);
  });
});
document.querySelectorAll(".pane-filter").forEach(function(f){
  f.addEventListener("input", function(){
    var p = f.dataset.pane;
    panes[p].filter = f.value;
    var rows = paneRows(p);
    if(!rows.some(function(r){ return r.id === panes[p].sel; })) panes[p].sel = rows.length ? rows[0].id : null;
    render();
  });
});

// ---- スワイプ（右: Sure / 左: Show） ----
["reading-tbody", "qa-tbody"].forEach(function(id){
  var tbody = document.getElementById(id), sx = 0, sy = 0, tr = null;
  tbody.addEventListener("touchstart", function(e){
    if(e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    tr = e.target.closest("tr");
  }, {passive:true});
  tbody.addEventListener("touchmove", function(e){
    if(!tr) return;
    var dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    if(Math.abs(dx) > Math.abs(dy)) tr.style.transform = "translateX(" + Math.max(-80, Math.min(80, dx)) + "px)";
  }, {passive:true});
  tbody.addEventListener("touchend", function(e){
    if(!tr) return;
    var row = tr; tr = null;
    row.style.transform = "";
    var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if(Math.abs(dx) < 70 || Math.abs(dy) > 45) return;
    var p = row.dataset.pane, rid = row.dataset.id;
    focusPane = p; panes[p].sel = rid;
    if(dx > 0) markOk(rid, p);
    else showAnswer();
  });
});

// Enter / Show: 答えの表示（ぶんしょうには隠れた答えがない）
function showAnswer(){
  if(focusPane !== "qa"){ message("ぶんしょうには隠れた答えがありません — 読んだら OK（c / Sure）"); render(); return; }
  if(panes.qa.sel) toggleReveal(panes.qa.sel);
}

// ---- キーボード操作 ----
// オリジナルの j / k / Enter / c に、表の切り替え Shift+J（もんだいへ）/ Shift+K（ぶんしょうへ）だけを足す。
document.addEventListener("keydown", function(e){
  if(e.isComposing || e.keyCode === 229) return;
  if(KWSync.isDialogOpen()){ KWSync.dialogKey(e); return; }
  if(e.key === "Escape"){
    e.preventDefault();
    if(editing && isInputFocused()) cancelEdit();
    if(document.activeElement) document.activeElement.blur();
    return;
  }

  if(isInputFocused()) return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;

  var key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Shift が押されていれば表の切り替え（Caps Lock だけなら普通の j/k として扱う）
  if(e.shiftKey && key === "j"){ e.preventDefault(); switchPane("qa"); return; }
  if(e.shiftKey && key === "k"){ e.preventDefault(); switchPane("reading"); return; }
  if(!paneRows(focusPane).length) return;

  if(key === "j"){ e.preventDefault(); moveSelection(1); }
  else if(key === "k"){ e.preventDefault(); moveSelection(-1); }
  else if(e.key === "Enter"){ e.preventDefault(); showAnswer(); }
  else if(key === "c"){ e.preventDefault(); if(panes[focusPane].sel) markOk(panes[focusPane].sel); }
});

// ---- 起動 ----
refreshDueList(true);
render();
describeServer();
function pairWithServer(){
  return KWSync.detectServer().then(function(cfg){
    describeServer();
    if(cfg && cfg.url && cfg.auto !== false) syncNow(true);
  });
}
pairWithServer();
// "#key=..." pasted into an already-open tab doesn't reload the page
window.addEventListener("hashchange", function(){ if(/key=/.test(location.hash)) pairWithServer(); });
document.addEventListener("visibilitychange", function(){
  if(document.visibilityState === "visible"){
    var cfg = KWSync.getServer();
    if(cfg && cfg.url && cfg.auto !== false) syncNow(true);
  }
});
// keep other tabs of this app in step
window.addEventListener("storage", function(e){
  if(e.key === K_ITEMS || e.key === K_SENTENCES || e.key === K_SETTINGS){ loadSettingsToForm(); reconcileDueLists(); render(); }
});
if("serviceWorker" in navigator && window.isSecureContext && location.protocol !== "file:"){
  // a new version took over (after a deploy): reload once so the page and
  // its scripts all come from the new version
  var hadController = !!navigator.serviceWorker.controller, reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", function(){
    if(hadController && !reloading){ reloading = true; location.reload(); }
  });
  navigator.serviceWorker.register("sw.js").then(function(reg){ reg.update(); }).catch(function(){});
}
