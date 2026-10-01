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
var panes = {
  reading: { due:[], sel:null, all:false },  // due: [{id, turn}] 本日分として固定されたリスト
  qa:      { due:[], sel:null, all:false }
};
var focusPane = "qa";
var revealState = {};
var undoStack = [];          // [{pane, before}] 直前の状態
var editing = null;          // {pane, id, prevRegDate}
var lastSearch = null;

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
  ["reading", "qa"].forEach(function(p){
    var rows = paneRows(p);
    panes[p].sel = rows.length ? rows[0].id : null;
  });
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
    var rows = paneRows(p);
    if(!rows.some(function(r){ return r.id === panes[p].sel; })) panes[p].sel = rows.length ? rows[0].id : null;
  });
}

// Rows currently shown in a pane: today's list, or every record ("t").
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
  var settings = loadSettings();
  return recs.filter(alive).map(function(r){
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

function rowElement(p, row){
  var all = panes[p].all;
  var tr = el("tr", "qa-row turn-color-" + (row.turn || "done") +
    (row.done ? " qa-row-done" : "") +
    (row.id === panes[p].sel ? " selected" + (focusPane === p ? "" : " selected-blur") : ""));
  tr.dataset.id = row.id;
  tr.dataset.pane = p;
  tr.addEventListener("click", function(){ focusPane = p; panes[p].sel = row.id; render(); });
  tr.appendChild(turnCell(row, all));
  return tr;
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
  });
}
// only after keyboard / button navigation, never on background re-renders
function scrollToSelected(){
  var sel = document.querySelector("tr.selected:not(.selected-blur)");
  if(sel && sel.scrollIntoView) sel.scrollIntoView({block:"nearest"});
}

function renderQa(){
  var tbody = document.getElementById("qa-tbody");
  tbody.innerHTML = "";
  var rows = paneRows("qa");
  document.getElementById("qa-empty").style.display = rows.length ? "none" : "block";

  rows.forEach(function(row){
    var it = row.rec;
    var tr = rowElement("qa", row);

    var tdQ = document.createElement("td");
    tdQ.className = "qa-cell qa-cell-question";
    tdQ.textContent = it.question;
    tr.appendChild(tdQ);

    var revealed = panes.qa.all || !!revealState[row.id];
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

    tbody.appendChild(tr);
  });
}

function renderReading(){
  var tbody = document.getElementById("reading-tbody");
  tbody.innerHTML = "";
  var rows = paneRows("reading");
  document.getElementById("reading-empty").style.display = rows.length ? "none" : "block";

  rows.forEach(function(row){
    var tr = rowElement("reading", row);
    var tdText = document.createElement("td");
    tdText.className = "qa-cell qa-cell-sentence";
    tdText.textContent = row.rec.text;
    tr.appendChild(tdText);
    tbody.appendChild(tr);
  });
}

// ---- ステータスバー（vim風） ----
var msgTimer = null;
function message(text, isError){
  var m = document.getElementById("sb-msg");
  m.textContent = text || "";
  m.classList.toggle("sb-error", !!isError);
  document.getElementById("statusbar").classList.toggle("has-msg", !!text);
  clearTimeout(msgTimer);
  if(text) msgTimer = setTimeout(function(){ message(""); }, isError ? 6000 : 3500);
}
function updateMode(){
  var mode = "NORMAL";
  if(document.getElementById("sb-cmd").style.display !== "none") mode = "COMMAND";
  else if(isInputFocused()) mode = "INSERT";
  var m = document.getElementById("sb-mode");
  m.textContent = mode;
  m.className = "sb-mode sb-mode-" + mode.toLowerCase();
}
function isInputFocused(){
  var a = document.activeElement;
  if(!a) return false;
  var tag = a.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || a.isContentEditable;
}

// ---- 操作 ----
function selectedRow(p){
  p = p || focusPane;
  var rows = paneRows(p);
  for(var i = 0; i < rows.length; i++) if(rows[i].id === panes[p].sel) return rows[i];
  return null;
}

function toggleReveal(id){
  revealState[id] = !revealState[id];
  render();
}

function clone(o){ return JSON.parse(JSON.stringify(o)); }
// strictly newer than prev: a same-millisecond tie would merge instead of win
function nextStamp(prev){ return Math.max(Date.now(), (+prev || 0) + 1); }

// Apply fn to the stored record, remember the old one for "u", save.
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
  p = p || focusPane;
  if(panes[p].all){ message("c は「今日」表示で使えます (t で切替)", true); return; }
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

function undo(){
  var u = undoStack.pop();
  if(!u){ message("Already at oldest change"); return; }
  var list = loadRecords(u.pane);
  var before = u.before;
  var i = list.findIndex(function(x){ return x.id === before.id; });
  before.updatedAt = nextStamp(Math.max(+before.updatedAt || 0, i === -1 ? 0 : +list[i].updatedAt || 0));
  if(i === -1) list.push(before); else list[i] = before;
  saveRecords(u.pane, list);
  reconcileDueLists();
  focusPane = u.pane;
  if(paneRows(u.pane).some(function(r){ return r.id === before.id; })) panes[u.pane].sel = before.id;
  message("元に戻しました (" + undoStack.length + ")");
  render();
}

function deleteSelected(){
  var row = selectedRow();
  if(!row) return;
  var label = focusPane === "qa" ? row.rec.question : row.rec.text;
  if(!confirm("削除しますか？ / Delete?\n\n" + label)) return;
  updateRecord(focusPane, row.id, function(r){ r.deleted = true; });
  reconcileDueLists();
  message("削除しました（u で元に戻す）");
  render();
}

function moveSelection(delta, p){
  p = p || focusPane;
  var rows = paneRows(p);
  if(!rows.length) return;
  var idx = rows.findIndex(function(d){ return d.id === panes[p].sel; });
  if(idx === -1) idx = 0;
  idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
  panes[p].sel = rows[idx].id;
  render();
  scrollToSelected();
}
function moveTo(idx){
  var rows = paneRows(focusPane);
  if(!rows.length) return;
  idx = Math.max(0, Math.min(rows.length - 1, idx));
  panes[focusPane].sel = rows[idx].id;
  render();
  scrollToSelected();
}
function switchPane(p){
  focusPane = p || (focusPane === "qa" ? "reading" : "qa");
  render();
  scrollToSelected();
}
function toggleView(p){
  p = p || focusPane;
  panes[p].all = !panes[p].all;
  var rows = paneRows(p);
  panes[p].sel = rows.length ? rows[0].id : null;
  render();
}
function search(forward){
  if(!lastSearch){ message("no previous search pattern", true); return; }
  var pat = lastSearch.toLowerCase();
  var rows = paneRows(focusPane), n = rows.length;
  var cur = Math.max(0, rows.findIndex(function(r){ return r.id === panes[focusPane].sel; }));
  for(var step = 1; step <= n; step++){
    var i = forward ? (cur + step) % n : (cur - step + n * 2) % n;
    var r = rows[i].rec;
    var hay = (focusPane === "qa" ? [r.question, r.answer, r.note].join("\n") : r.text || "").toLowerCase();
    if(hay.indexOf(pat) !== -1){
      panes[focusPane].sel = rows[i].id;
      message("/" + lastSearch + (step === n ? "  (only match)" : ""));
      render();
      scrollToSelected();
      return;
    }
  }
  message("Pattern not found: " + lastSearch, true);
}

// ---- 登録・編集フォーム ----
function formFields(p){
  return p === "qa"
    ? ["input-question", "input-answer", "input-note"]
    : ["new-sentence-input"];
}
function startInsert(p){
  p = p || focusPane;
  if(editing && editing.pane !== p) cancelEdit();
  var first = document.getElementById(formFields(p)[0]);
  first.focus();
  first.scrollIntoView({block:"center"});
}
function startEdit(){
  var row = selectedRow();
  if(!row){ message("nothing selected", true); return; }
  cancelEdit();
  var p = focusPane, r = row.rec;
  var reg = document.getElementById("reg-date-input");
  editing = {pane:p, id:row.id, prevRegDate:reg.value};
  reg.value = r.registeredDate;
  if(p === "qa"){
    document.getElementById("input-question").value = r.question;
    document.getElementById("input-answer").value = r.answer;
    document.getElementById("input-note").value = r.note || "";
  } else {
    document.getElementById("new-sentence-input").value = r.text;
  }
  setFormMode(p, true);
  startInsert(p);
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
  var area = document.getElementById("backup-area");
  area.value = text;
  area.select();
  try{ document.execCommand("copy"); }catch(e){}
  area.blur();
  return Promise.resolve();
}
document.getElementById("code-copy-btn").addEventListener("click", function(){
  KWSync.encodeFrames(getDoc(), 100000).then(function(frames){
    var code = frames.join("\n");
    document.getElementById("backup-area").value = code;
    return copyText(code).then(function(){ message("同期コードをコピーしました（相手の LOAD に貼り付け）"); });
  }).catch(function(err){ message("コピー失敗: " + err.message, true); });
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

// ---- バックアップ ----
document.getElementById("export-btn").addEventListener("click", function(){
  document.getElementById("backup-area").value = JSON.stringify(getDoc(), null, 2);
});
document.getElementById("import-btn").addEventListener("click", function(){
  var raw = document.getElementById("backup-area").value.trim();
  if(!raw) return;
  KWSync.decodeAny(raw).then(function(data){
    mergeIncoming(data);
    scheduleAutoSync();
    message("読み込みました（マージ）");
  }).catch(function(e){
    alert("JSONの読み込みに失敗しました：" + e.message);
  });
});
document.getElementById("replace-btn").addEventListener("click", function(){
  var raw = document.getElementById("backup-area").value.trim();
  if(!raw) return;
  if(!confirm("現在のデータを置き換えます。よろしいですか？\nReplace all local data?")) return;
  KWSync.decodeAny(raw).then(function(data){
    if(data.items) saveItems(data.items);
    if(data.settings) saveSettings(data.settings);
    if(data.sentences) saveSentences(data.sentences);
    loadSettingsToForm();
    doRefresh();
  }).catch(function(e){
    alert("JSONの読み込みに失敗しました：" + e.message);
  });
});

// ---- モバイル操作ボタン ----
document.getElementById("m-up").addEventListener("click", function(){ moveSelection(-1); });
document.getElementById("m-down").addEventListener("click", function(){ moveSelection(1); });
document.getElementById("m-pane").addEventListener("click", function(){ switchPane(); });
document.getElementById("m-show").addEventListener("click", function(){
  if(focusPane !== "qa"){ message("ぶんしょうには隠れた答えがありません"); return; }
  if(panes.qa.sel) toggleReveal(panes.qa.sel);
});
document.getElementById("m-ok").addEventListener("click", function(){ if(panes[focusPane].sel) markOk(panes[focusPane].sel); });
document.getElementById("m-undo").addEventListener("click", undo);
document.getElementById("m-more").addEventListener("click", function(){
  var d = KWSync.dialog("Menu");
  [
    ["✎ 編集 / Edit (e)", startEdit],
    ["🗑 削除 / Delete (dd)", deleteSelected],
    [panes[focusPane].all ? "今日の分を表示 / Today (t)" : "全部を表示 / All records (t)", function(){ toggleView(); }],
    ["⟳ LAN同期 / Sync (s)", function(){ syncNow(false); }],
    ["▦ QRを表示 / Show QR", showSyncQr],
    ["⌖ QRを読む / Scan QR", scanSyncQr],
    ["？ キー一覧 / Keys (?)", showHelp]
  ].forEach(function(a){
    var b = el("button", "menu-item", a[0]);
    b.addEventListener("click", function(){ KWSync.closeDialog(); a[1](); });
    d.body.appendChild(b);
  });
});
document.querySelectorAll(".view-toggle").forEach(function(b){
  b.addEventListener("click", function(){ focusPane = b.dataset.pane; toggleView(b.dataset.pane); });
});
document.querySelectorAll(".pane-head").forEach(function(h){
  h.addEventListener("click", function(e){ if(e.target.tagName !== "BUTTON") switchPane(h.dataset.pane); });
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
    else if(p === "qa") toggleReveal(rid);
    else render();
  });
});

// ---- キーボード操作（vim風） ----
// Kept in step with the Rust TUI (cli/src/tui.rs).
var KEYMAP = [
  ["移動", ""],
  ["j / k  ↓ / ↑", "次 / 前の行（5j のように回数指定可）"],
  ["gg / G", "先頭 / 末尾（3G で3行目）"],
  ["Ctrl-d / Ctrl-u", "半ページ下 / 上"],
  ["h / l  Tab", "ぶんしょう ⇄ もんだい を切替"],
  ["復習", ""],
  ["Enter / Space / za", "答えの表示 / 非表示"],
  ["zR / zM", "すべて表示 / すべて隠す"],
  ["c", "OK（このターンを完了。もう一度で取消）"],
  ["u", "直前の変更を元に戻す（OK・編集・削除）"],
  ["r", "今日の一覧をシャッフルし直す"],
  ["t", "表示切替: 今日 ⇄ 全部"],
  ["編集", ""],
  ["o / a / i", "新規登録（入力欄へ）"],
  ["e", "選択中の項目を編集"],
  ["dd / x", "選択中の項目を削除"],
  ["/文字列  n / N", "検索・次 / 前"],
  ["入力中", "Enter: 次の欄・最後で登録 / Ctrl+Enter: 登録 / Esc: 抜ける"],
  ["同期", ""],
  ["s", "LANサーバーと同期"],
  [":qr  :scan", "QRを表示 / 読み取り"],
  [":コマンド", ""],
  [":sync  :export  :stats", "同期 / 書き出し / 統計"],
  [":date 2026-10-01 / +N / -N / today", "基準日を変更"],
  [":set n=1,3,7,14", "復習間隔（:set n2=4 も可）"],
  [":all  :today", "表示切替"],
  ["?", "このヘルプ"]
];
function showHelp(){
  var d = KWSync.dialog("Keys — vim風キー操作");
  var t = el("table", "help-table");
  KEYMAP.forEach(function(k){
    var tr = el("tr");
    if(!k[1]){ var th = el("th", "", k[0]); th.colSpan = 2; tr.appendChild(th); }
    else { tr.appendChild(el("td", "help-key", k[0])); tr.appendChild(el("td", "", k[1])); }
    t.appendChild(tr);
  });
  d.body.appendChild(t);
  d.body.appendChild(el("p", "modal-hint", "CLI 版（kwnote）も同じキーで動きます。"));
}

// ':' / '/' command line
var cmdMode = null;
function openCmdline(kind){
  cmdMode = kind;
  document.getElementById("sb-cmd-prefix").textContent = kind === "search" ? "/" : ":";
  document.getElementById("sb-cmd").style.display = "";
  document.getElementById("sb-msg").style.display = "none";
  var c = document.getElementById("cmdline");
  c.value = "";
  c.focus();
  updateMode();
}
function closeCmdline(){
  cmdMode = null;
  document.getElementById("sb-cmd").style.display = "none";
  document.getElementById("sb-msg").style.display = "";
  document.getElementById("cmdline").blur();
  updateMode();
}
document.getElementById("cmdline").addEventListener("keydown", function(e){
  if(e.isComposing || e.keyCode === 229) return;
  if(e.key === "Escape" || (e.key === "Backspace" && !this.value)){ e.preventDefault(); closeCmdline(); return; }
  if(e.key !== "Enter") return;
  e.preventDefault();
  var v = this.value.trim(), kind = cmdMode;
  closeCmdline();
  if(kind === "search"){ if(v) lastSearch = v; search(true); }
  else runCommand(v);
});
document.getElementById("cmdline").addEventListener("blur", function(){ if(cmdMode) closeCmdline(); });

function runCommand(cmd){
  var parts = cmd.split(/\s+/), head = parts[0], arg = parts.slice(1).join(" ");
  switch(head){
    case "": return;
    case "q": case "q!": case "wq": case "x": case "quit":
      message("ブラウザ版は閉じられません :)  (it's a web page)"); return;
    case "w": case "write": message("保存済み（変更は自動保存されます）"); scheduleAutoSync(); return;
    case "sync": syncNow(false); return;
    case "qr": showSyncQr(); return;
    case "scan": scanSyncQr(); return;
    case "export": document.getElementById("export-btn").click(); document.getElementById("backup-area").scrollIntoView({block:"center"}); return;
    case "all": panes.reading.all = panes.qa.all = true; render(); return;
    case "today": panes.reading.all = panes.qa.all = false; reconcileDueLists(); render(); return;
    case "help": case "h": showHelp(); return;
    case "e!": case "reload": doRefresh(); return;
    case "stats": {
      var s = loadSettings(), today = getToday(), tomorrow = addDays(today, 1);
      var items = loadItems().filter(alive), sents = loadSentences().filter(alive);
      var all = items.concat(sents);
      message("Q&A " + items.length + "（今日 " + items.filter(function(r){ return dueTurn(r, s, today); }).length +
        "）· ぶんしょう " + sents.length + "（今日 " + sents.filter(function(r){ return dueTurn(r, s, today); }).length +
        "）· 明日 " + all.filter(function(r){ return !dueTurn(r, s, today) && dueTurn(r, s, tomorrow); }).length +
        " · 完了 " + all.filter(function(r){ return !nextTurn(r, s); }).length);
      return;
    }
    case "date": {
      var base = getToday(), d = null;
      if(!arg || arg === "today") d = todayStr();
      else if(/^[+-]\d+$/.test(arg)) d = addDays(base, parseInt(arg, 10));
      else if(/^\d{4}-\d{2}-\d{2}$/.test(arg)) d = arg;
      if(!d){ message("usage: :date YYYY-MM-DD | today | +N | -N", true); return; }
      document.getElementById("today-date-input").value = d;
      doRefresh();
      message("基準日 " + d);
      return;
    }
    case "set": {
      var n = loadSettings().n.slice(), m;
      if(!arg){ message("n=" + n.join(",")); return; }
      if((m = /^n=(\d+),(\d+),(\d+),(\d+)$/.exec(arg.replace(/\s/g, "")))) n = m.slice(1, 5).map(Number);
      else if((m = /^n([1-4])=(\d+)$/.exec(arg.replace(/\s/g, "")))) n[+m[1] - 1] = +m[2];
      else { message("usage: :set n=1,3,7,14  or  :set n2=4", true); return; }
      applySettings(n);
      message("intervals " + n.join(","));
      return;
    }
  }
  message("E492: Not an editor command: " + cmd, true);
}

var pendingKey = null, countBuf = "";
function showKeys(){ document.getElementById("sb-keys").textContent = countBuf + (pendingKey || ""); }

document.addEventListener("keydown", function(e){
  if(e.isComposing || e.keyCode === 229) return;
  if(KWSync.isDialogOpen()){ KWSync.dialogKey(e); return; }

  if(e.key === "Escape"){
    e.preventDefault();
    if(editing && isInputFocused()) cancelEdit();
    if(document.activeElement) document.activeElement.blur();
    pendingKey = null; countBuf = ""; showKeys();
    updateMode();
    return;
  }

  if(isInputFocused()) return;
  if(e.altKey || e.metaKey) return;
  var k = e.key, ctrl = e.ctrlKey;

  if(pendingKey){
    var p = pendingKey, cnt = countBuf ? parseInt(countBuf, 10) : null;
    pendingKey = null; countBuf = ""; showKeys();
    e.preventDefault();
    if(p === "g" && k === "g") moveTo(cnt ? cnt - 1 : 0);
    else if(p === "d" && k === "d") deleteSelected();
    else if(p === "z" && k === "a"){ if(focusPane === "qa" && panes.qa.sel) toggleReveal(panes.qa.sel); }
    else if(p === "z" && k === "R"){ paneRows("qa").forEach(function(r){ revealState[r.id] = true; }); render(); }
    else if(p === "z" && k === "M"){ revealState = {}; render(); }
    return;
  }
  if(!ctrl && /^[0-9]$/.test(k) && (k !== "0" || countBuf)){
    countBuf += k; showKeys(); e.preventDefault(); return;
  }
  var count = countBuf ? parseInt(countBuf, 10) : null, n = count || 1;
  countBuf = ""; showKeys();
  var half = Math.max(1, Math.floor(paneRows(focusPane).length / 2));

  var handled = true;
  if(ctrl){
    if(k === "d") moveSelection(Math.min(10, half) * n);
    else if(k === "u") moveSelection(-Math.min(10, half) * n);
    else if(k === "n") moveSelection(n);
    else if(k === "p") moveSelection(-n);
    else if(k === "Enter"){ /* noop */ }
    else handled = false;
  }
  else if(k === "j" || k === "ArrowDown") moveSelection(n);
  else if(k === "k" || k === "ArrowUp") moveSelection(-n);
  else if(k === "G" || k === "End") moveTo(count ? count - 1 : 1e9);
  else if(k === "Home") moveTo(0);
  else if(k === "g" || k === "d" || k === "z"){ pendingKey = k; if(count) countBuf = String(count); showKeys(); }
  else if(k === "h" || k === "ArrowLeft") switchPane("reading");
  else if(k === "l" || k === "ArrowRight") switchPane("qa");
  else if(k === "Tab") switchPane();
  else if(k === "Enter" || k === " "){
    if(focusPane === "qa"){ if(panes.qa.sel) toggleReveal(panes.qa.sel); }
    else message("ぶんしょうには隠れた答えがありません — 読んだら c");
  }
  else if(k === "c" || k === "C"){ if(panes[focusPane].sel) markOk(panes[focusPane].sel); }
  else if(k === "u") undo();
  else if(k === "x") deleteSelected();
  else if(k === "o" || k === "O" || k === "a" || k === "A" || k === "i" || k === "I") startInsert();
  else if(k === "e") startEdit();
  else if(k === "r"){ doRefresh(); message("シャッフルしました"); }
  else if(k === "t") toggleView();
  else if(k === "/") openCmdline("search");
  else if(k === "n") search(true);
  else if(k === "N") search(false);
  else if(k === ":" || (k === ";" && e.shiftKey)) openCmdline("command");
  else if(k === "?") showHelp();
  else if(k === "s") syncNow(false);
  else handled = false;
  if(handled) e.preventDefault();
});
document.addEventListener("focusin", updateMode);
document.addEventListener("focusout", function(){ setTimeout(updateMode, 0); });

// ---- 起動 ----
refreshDueList();
render();
updateMode();
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
