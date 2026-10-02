var K_ITEMS="srs_items", K_SETTINGS="srs_settings", K_SENTENCES="srs_sentences";

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
function loadSettings(){ return safeGet(K_SETTINGS, {n:[1,3,7,14]}); }
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
  return { version:2, items: loadItems(), settings: loadSettings(), sentences: loadSentences() };
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
  for(var t=1; t<=4; t++){
    if(entity.completedTurns && entity.completedTurns.indexOf(t) !== -1) continue;
    var sched = addDays(entity.registeredDate, n[t-1] || 0);
    if(sched <= today) return t;
    return null;
  }
  return null;
}
// first unfinished turn and its date, or null when all four are done
function nextTurn(entity, settings){
  for(var t=1; t<=4; t++){
    if(entity.completedTurns && entity.completedTurns.indexOf(t) !== -1) continue;
    return {turn:t, date:addDays(entity.registeredDate, settings.n[t-1] || 0)};
  }
  return null;
}

// ---- 画面の状態 ----
// pane: "reading"（ぶんしょう） / "qa"（一問一答）
// 選択（フォーカス）があるのは一問一答だけ。ぶんしょうは行ごとのチェックで完了にする。
var panes = {
  reading: { due:[], all:false, filter:"" },           // due: [{id, turn}] 本日分として固定されたリスト
  qa:      { due:[], all:false, filter:"", sel:null }
};
var revealState = {};
var undoStack = [];          // [{pane, before}] 直前の状態
var editing = null;          // {pane, id, prevRegDate}

function computeDueList(items, settings, today){
  var list = [];
  items.forEach(function(it){
    if(!alive(it)) return;
    var t = dueTurn(it, settings, today);
    if(t){ list.push({id:it.id, turn:t}); }
  });
  // Fisher-Yates shuffle
  for(var i = list.length - 1; i > 0; i--){
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
  }
  return list;
}

function refreshDueList(){
  var settings = loadSettings();
  var today = getToday();
  panes.qa.due = computeDueList(loadItems(), settings, today);
  panes.reading.due = computeDueList(loadSentences(), settings, today);
  revealState = {};
  var rows = paneRows("qa");
  panes.qa.sel = rows.length ? rows[0].id : null;
}

// After a save/sync: keep today's order, drop deleted, append newly due.
function reconcileDueLists(){
  var settings = loadSettings(), today = getToday();
  ["reading", "qa"].forEach(function(p){
    var recs = loadRecords(p).filter(alive), byId = {};
    recs.forEach(function(r){ byId[r.id] = r; });
    var due = panes[p].due.filter(function(e){ return byId[e.id]; });
    var have = {};
    due.forEach(function(e){ have[e.id] = true; });
    recs.forEach(function(r){
      var t = dueTurn(r, settings, today);
      if(t && !have[r.id]) due.push({id:r.id, turn:t});
    });
    panes[p].due = due;
  });
  var rows = paneRows("qa");
  if(!rows.some(function(r){ return r.id === panes.qa.sel; })) panes.qa.sel = rows.length ? rows[0].id : null;
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
    cols.push(all ? ["actions", ""] : ["done", "Done"]);
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
  document.querySelectorAll(".undo-btn").forEach(function(b){ b.disabled = !undoStack.length; });
}
// only after keyboard / button navigation, never on background re-renders
function scrollToSelected(){
  var sel = document.querySelector("#qa-tbody tr.selected");
  if(sel && sel.scrollIntoView) sel.scrollIntoView({block:"nearest"});
}

function renderQa(){
  renderHead("qa");
  var tbody = document.getElementById("qa-tbody");
  tbody.innerHTML = "";
  var rows = paneRows("qa"), all = panes.qa.all;
  document.getElementById("qa-empty").style.display = rows.length ? "none" : "block";

  rows.forEach(function(row){
    var it = row.rec;
    var tr = el("tr", "qa-row turn-color-" + (row.turn || "done") +
      (row.done ? " qa-row-done" : "") + (row.id === panes.qa.sel ? " selected" : ""));
    tr.dataset.id = row.id;
    tr.dataset.pane = "qa";
    tr.addEventListener("click", function(){ panes.qa.sel = row.id; render(); });
    tr.appendChild(turnCell(row, all));

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
    ansSpan.addEventListener("click", function(e){ e.stopPropagation(); panes.qa.sel = row.id; toggleReveal(row.id); });
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
    var tr = el("tr", "qa-row reading-row turn-color-" + (row.turn || "done") + (row.done ? " qa-row-done" : ""));
    tr.dataset.id = row.id;
    tr.dataset.pane = "reading";
    tr.appendChild(turnCell(row, all));
    var tdText = document.createElement("td");
    tdText.className = "qa-cell qa-cell-sentence";
    tdText.textContent = row.rec.text;
    tr.appendChild(tdText);
    if(all){
      tr.appendChild(actionsCell("reading", row));
    } else {
      // 読んだらチェック → このターンを完了（もう一度で取消）
      var td = el("td", "qa-cell qa-cell-done");
      var box = el("input", "done-check");
      box.type = "checkbox";
      box.checked = row.done;
      box.title = "読んだ / Done";
      box.addEventListener("change", function(){ markOk(row.id, "reading"); });
      td.appendChild(box);
      tr.appendChild(td);
    }
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
// 文字入力中か（チェックボックスやボタンは含めない: j/k/c を奪わないため）
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

function clone(o){ return JSON.parse(JSON.stringify(o)); }
// strictly newer than prev: a same-millisecond tie would merge instead of win
function nextStamp(prev){ return Math.max(Date.now(), (+prev || 0) + 1); }

// Apply fn to the stored record, remember the old one for undo, save.
function updateRecord(p, id, fn){
  var list = loadRecords(p);
  var rec = list.find(function(x){ return x.id === id; });
  if(!rec) return null;
  undoStack.push({pane:p, before:clone(rec)});
  if(undoStack.length > 100) undoStack.shift();
  fn(rec);
  rec.updatedAt = nextStamp(rec.updatedAt);
  saveRecords(p, list);
  return rec;
}

function markOk(id, p){
  p = p || "qa";
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

  // autofocus（一問一答のみ）
  if(nowDone && p === "qa"){
    var rows = paneRows("qa");
    var curIdx = rows.findIndex(function(x){ return x.id === id; });
    if(curIdx !== -1){
      var n = rows.length;
      for(var d = 1; d < n; d++){
        var prevIdx = curIdx - d;
        if(prevIdx >= 0 && !rows[prevIdx].done){
          panes.qa.sel = rows[prevIdx].id;
          break;
        }
        var nextIdx = curIdx + d;
        if(nextIdx < n && !rows[nextIdx].done){
          panes.qa.sel = rows[nextIdx].id;
          break;
        }
      }
    }
  }

  render();
}

function undo(){
  var u = undoStack.pop();
  if(!u){ message("元に戻せる操作はありません"); render(); return; }
  var list = loadRecords(u.pane);
  var before = u.before;
  var i = list.findIndex(function(x){ return x.id === before.id; });
  before.updatedAt = nextStamp(Math.max(+before.updatedAt || 0, i === -1 ? 0 : +list[i].updatedAt || 0));
  if(i === -1) list.push(before); else list[i] = before;
  saveRecords(u.pane, list);
  reconcileDueLists();
  if(u.pane === "qa" && paneRows("qa").some(function(r){ return r.id === before.id; })) panes.qa.sel = before.id;
  message("元に戻しました");
  render();
}

function deleteRecord(p, id){
  var rec = loadRecords(p).find(function(x){ return x.id === id; });
  if(!rec) return;
  var label = p === "qa" ? rec.question : rec.text;
  if(!confirm("削除しますか？ / Delete?\n\n" + label)) return;
  updateRecord(p, id, function(r){ r.deleted = true; });
  reconcileDueLists();
  message("削除しました（↶ で元に戻せます）");
  render();
}

function moveSelection(delta){
  var rows = paneRows("qa");
  if(!rows.length) return;
  var idx = rows.findIndex(function(d){ return d.id === panes.qa.sel; });
  if(idx === -1) idx = 0;
  idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
  panes.qa.sel = rows[idx].id;
  render();
  scrollToSelected();
}
function toggleView(p){
  panes[p].all = !panes[p].all;
  if(p === "qa"){
    var rows = paneRows("qa");
    panes.qa.sel = rows.length ? rows[0].id : null;
  }
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
function loadSettingsToForm(){
  var s = loadSettings();
  document.getElementById("n1").value = s.n[0];
  document.getElementById("n2").value = s.n[1];
  document.getElementById("n3").value = s.n[2];
  document.getElementById("n4").value = s.n[3];
}
function applySettings(n){
  saveSettings({n:n, updatedAt:Date.now()});
  loadSettingsToForm();
  doRefresh();
}
document.getElementById("save-settings-btn").addEventListener("click", function(){
  applySettings([
    parseInt(document.getElementById("n1").value,10) || 0,
    parseInt(document.getElementById("n2").value,10) || 0,
    parseInt(document.getElementById("n3").value,10) || 0,
    parseInt(document.getElementById("n4").value,10) || 0
  ]);
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
document.getElementById("m-show").addEventListener("click", function(){ if(panes.qa.sel) toggleReveal(panes.qa.sel); });
document.getElementById("m-ok").addEventListener("click", function(){ if(panes.qa.sel) markOk(panes.qa.sel, "qa"); });
document.getElementById("m-undo").addEventListener("click", undo);
document.getElementById("m-more").addEventListener("click", function(){
  var d = KWSync.dialog("Menu");
  [
    [panes.qa.all ? "もんだい: 今日の分を表示" : "もんだい: 全部を表示（編集・削除）", function(){ toggleView("qa"); }],
    [panes.reading.all ? "ぶんしょう: 今日の分を表示" : "ぶんしょう: 全部を表示（編集・削除）", function(){ toggleView("reading"); }],
    ["⟳ LAN同期 / Sync", function(){ syncNow(false); }],
    ["▦ QRを表示 / Show QR", showSyncQr],
    ["⌖ QRを読む / Scan QR", scanSyncQr]
  ].forEach(function(a){
    var b = el("button", "menu-item", a[0]);
    b.addEventListener("click", function(){ KWSync.closeDialog(); a[1](); });
    d.body.appendChild(b);
  });
});

// ---- 見出しのボタン（元に戻す / 今日⇄全部 / 全部表示での絞り込み） ----
document.querySelectorAll(".view-toggle").forEach(function(b){
  b.addEventListener("click", function(){ toggleView(b.dataset.pane); });
});
document.querySelectorAll(".undo-btn").forEach(function(b){ b.addEventListener("click", undo); });
document.querySelectorAll(".pane-filter").forEach(function(f){
  f.addEventListener("input", function(){
    panes[f.dataset.pane].filter = f.value;
    if(f.dataset.pane === "qa"){
      var rows = paneRows("qa");
      if(!rows.some(function(r){ return r.id === panes.qa.sel; })) panes.qa.sel = rows.length ? rows[0].id : null;
    }
    render();
  });
});

// ---- スワイプ（右: Sure / 左: Show。ぶんしょうは右で完了） ----
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
    if(p === "qa") panes.qa.sel = rid;
    if(dx > 0) markOk(rid, p);
    else if(p === "qa") toggleReveal(rid);
  });
});

// ---- キーボード操作 ----
// オリジナルと同じ j / k / Enter / c だけ（Vimium と競合しないよう、ほかの一文字キーは使わない）。
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
  if(!paneRows("qa").length) return;

  if(e.key === "j"){ e.preventDefault(); moveSelection(1); }
  else if(e.key === "k"){ e.preventDefault(); moveSelection(-1); }
  else if(e.key === "Enter"){ e.preventDefault(); if(panes.qa.sel) toggleReveal(panes.qa.sel); }
  else if(e.key === "c" || e.key === "C"){ e.preventDefault(); if(panes.qa.sel) markOk(panes.qa.sel, "qa"); }
});

// ---- 起動 ----
refreshDueList();
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
  navigator.serviceWorker.register("sw.js").catch(function(){});
}
