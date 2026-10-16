// ---- KWBeta: URL に ?beta=true（1 / on / yes も可）を付けたときだけ動く試験的な機能 ----
// - フラッシュカードモード（もんだい）: Space で裏返す、← わからない、→ 覚えた
// - 「わからない」の記録（item.misses）と、それによる予定の延長（extendDate）
// beta が無いときは KWBeta.enabled = false で、script.js はほかの関数を呼ばない。
// script.js より先に読み込む（起動時に今日のリストを作るとき turnDate が extendDate を使うため）。
// 中で使う loadItems / updateRecord / turnDate などは script.js のもの（呼ぶのは起動後だけ）。
// CLI / TUI は misses を知らないフィールドとしてそのまま保持するだけ（予定はずらさない）。
(function(global){
  "use strict";

  var enabled = /[?&]beta=(1|true|on|yes)(&|$)/i.test(location.search);
  var K_FLASH = "kw_flash";   // この端末だけ: {date, settled:[id…], reverse}

  // ================================================================ schedule
  // item.misses: [{date:"YYYY-MM-DD", turn:t}] 「わからない」を押した日とそのときの turn
  // turn m を d 日に「わからない」→ turn m は d の翌日にもう一度出る。それより後の turn も
  // turn m からの間隔を保ったまま、その分うしろへずれる（本来の予定より早くはならない）。
  // 例: n = 1・3・7・14、turn 2（3 日後）の日に「わからない」→ turn 2 は 4 日後、turn 3 は 8 日後、turn 4 は 15 日後
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function misses(r){
    return (Array.isArray(r.misses) ? r.misses : []).filter(function(m){
      return m && typeof m.date === "string" && DATE_RE.test(m.date) && parseInt(m.turn, 10) > 0;
    });
  }
  function extendDate(r, settings, t, base){
    var d = base, n = settings.n;
    misses(r).forEach(function(m){
      var mt = parseInt(m.turn, 10);
      if(mt > t) return;
      var c = addDays(m.date, 1 + Math.max(0, (n[t-1] || 0) - (n[mt-1] || 0)));
      if(c > d) d = c;
    });
    return d;
  }

  // ================================================================ flashcards
  function loadFlash(){
    var f = safeGet(K_FLASH, null);
    f = f && typeof f === "object" ? f : {};
    if(f.date !== getToday() || !Array.isArray(f.settled)){ f.date = getToday(); f.settled = []; }
    return f;
  }
  function saveFlash(f){ safeSet(K_FLASH, f); }

  // fc: 開いている間の状態
  //   queue: [{id, turn}] 先頭が今のカード / practice: 苦手の練習（記録を変えない）
  //   flipped: 裏を表示中 / known: 覚えた枚数 / missed: {id: true} この回でわからなかった
  var fc = null, root = null;

  function recById(id){ return loadItems().find(function(r){ return r.id === id && alive(r); }); }
  function isDone(r, turn){ return (r.completedTurns || []).indexOf(turn) !== -1; }

  // 今日のもんだいのうち、まだ終えていないもの（今日のリストの順のまま）
  function todayDeck(){
    var settled = loadFlash().settled;
    return panes.qa.due.filter(function(e){
      var r = recById(e.id);
      return r && !isDone(r, e.turn) && settled.indexOf(e.id) === -1;
    }).map(function(e){ return {id:e.id, turn:e.turn}; });
  }
  // 「わからない」の記録がある問題（多い順）
  function missDeck(){
    return loadItems().filter(function(r){ return alive(r) && misses(r).length; })
      .sort(function(a, b){ return misses(b).length - misses(a).length; })
      .map(function(r){ return {id:r.id, turn:null}; });
  }

  // 先頭のカード。ほかの端末との同期で消えた・終わったものは飛ばす
  function current(){
    while(fc.queue.length){
      var c = fc.queue[0], r = recById(c.id);
      if(r && (fc.practice || !isDone(r, c.turn))) return {card:c, rec:r};
      fc.queue.shift();
    }
    return null;
  }

  function open(practice){
    if(!root){ build(); }
    fc = {queue: practice ? missDeck() : todayDeck(), practice: !!practice, flipped: false, known: 0, missed: {}, order: []};
    root.style.display = "";
    if(document.activeElement) document.activeElement.blur();   // Space がボタンを押さないように
    draw();
  }
  function close(){
    if(!root) return;
    root.style.display = "none";
    fc = null;
    render();
  }
  function isOpen(){ return !!fc; }

  function flip(){
    if(!current()) return;
    fc.flipped = !fc.flipped;
    draw(true);
  }

  // → 覚えた: 今日のターンを OK にする（c と同じ）。ただし今日「わからない」を押した問題は、
  // 予定が明日に移っているので完了にはせず、今日の分としては済ませる（明日もう一度出る）。
  function know(){
    var cur = current();
    if(!cur) return;
    var c = cur.card;
    if(!fc.practice){
      if(turnDate(cur.rec, loadSettings(), c.turn) > getToday()){
        var f = loadFlash();
        if(f.settled.indexOf(c.id) === -1) f.settled.push(c.id);
        saveFlash(f);
        message("思い出せました — 今日わからなかったので、明日もう一度出ます");
      } else {
        updateRecord("qa", c.id, function(it){
          if(!it.completedTurns) it.completedTurns = [];
          if(it.completedTurns.indexOf(c.turn) === -1) it.completedTurns.push(c.turn);
        });
        message("OK — turn " + c.turn + " done");
      }
      render();
    }
    fc.known++;
    fc.queue.shift();
    fc.flipped = false;
    draw();
  }

  // ← わからない: その日・その turn を記録し（1 日 1 回）、カードを山の最後に戻す
  function miss(){
    var cur = current();
    if(!cur) return;
    var c = cur.card, today = getToday();
    if(!fc.practice){
      var dup = misses(cur.rec).some(function(m){ return m.date === today && +m.turn === c.turn; });
      if(!dup){
        updateRecord("qa", c.id, function(it){
          it.misses = (Array.isArray(it.misses) ? it.misses : []).concat([{date:today, turn:c.turn}]);
        });
        render();
      }
    }
    if(!fc.missed[c.id]){ fc.missed[c.id] = true; fc.order.push(c.id); }
    fc.queue.push(fc.queue.shift());
    fc.flipped = false;
    draw();
  }

  // ================================================================ view
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(text !== undefined) e.textContent = text;
    return e;
  }
  function button(label, title, fn){
    var b = el("button", "", label);
    if(title) b.title = title;
    b.addEventListener("mousedown", function(e){ e.preventDefault(); });   // フォーカスを取らない（Space で押されないように）
    b.addEventListener("click", fn);
    return b;
  }

  var ui = {};
  function build(){
    root = el("div", "modal-backdrop flash-backdrop");
    var win = el("div", "modal flash-window");
    var bar = el("div", "modal-title");
    bar.appendChild(el("span", "", "フラッシュカード / Flashcards β"));
    var x = el("button", "modal-close", "×");
    x.setAttribute("aria-label", "close");
    x.addEventListener("click", close);
    bar.appendChild(x);
    var body = el("div", "modal-body flash-body");

    var top = el("div", "flash-top");
    ui.progress = el("span", "flash-progress");
    var rev = el("label", "flash-reverse");
    ui.reverse = el("input");
    ui.reverse.type = "checkbox";
    ui.reverse.checked = !!safeGet(K_FLASH, {}).reverse;
    ui.reverse.addEventListener("change", function(){
      var f = loadFlash();
      f.reverse = ui.reverse.checked;
      saveFlash(f);
      ui.reverse.blur();
      fc.flipped = false;
      draw();
    });
    rev.appendChild(ui.reverse);
    rev.appendChild(document.createTextNode(" 答えから出す / Answer first"));
    top.appendChild(ui.progress);
    top.appendChild(rev);

    ui.card = el("div", "flash-card");
    ui.card.addEventListener("click", flip);
    swipe(ui.card);

    ui.controls = el("div", "flash-controls");
    ui.controls.appendChild(button("← わからない", "Don't know (←)", miss));
    ui.controls.appendChild(button("裏返す", "Flip (Space)", flip));
    ui.controls.appendChild(button("覚えた →", "Got it (→)", know));

    ui.done = el("div", "flash-done");
    ui.hint = el("p", "modal-hint flash-hint",
      "Space / Enter: 裏返す　←: わからない（明日もう一度。あとの回もその分ずれる）　→ / c: 覚えた（OK）　j / k: 次 / 前のカード　Esc: 閉じる　／　スマホ: タップで裏返す・左右スワイプ");

    [top, ui.card, ui.controls, ui.done, ui.hint].forEach(function(n){ body.appendChild(n); });
    win.appendChild(bar);
    win.appendChild(body);
    root.appendChild(win);
    root.addEventListener("click", function(e){ if(e.target === root) close(); });
    document.body.appendChild(root);
  }

  function swipe(node){
    var sx = 0, sy = 0, on = false;
    node.addEventListener("touchstart", function(e){
      if(e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; on = true;
    }, {passive:true});
    node.addEventListener("touchmove", function(e){
      if(!on) return;
      var dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if(Math.abs(dx) > Math.abs(dy)) node.style.transform = "translateX(" + Math.max(-100, Math.min(100, dx)) + "px) rotate(" + (dx / 40) + "deg)";
    }, {passive:true});
    node.addEventListener("touchend", function(e){
      if(!on) return;
      on = false;
      node.style.transform = "";
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if(Math.abs(dx) < 70 || Math.abs(dy) > 60) return;
      e.preventDefault();   // 続く click（裏返し）を起こさない
      if(dx > 0) know(); else miss();
    });
  }

  function missedCount(){ return Object.keys(fc.missed).length; }

  function draw(flipping){
    var cur = current();
    var reverse = ui.reverse.checked;
    ui.progress.textContent = (fc.practice ? "苦手の練習（記録は変えません）　" : "") +
      "残り " + fc.queue.length + "　覚えた " + fc.known + "　わからない " + missedCount();
    ui.card.style.display = ui.controls.style.display = cur ? "" : "none";
    ui.done.style.display = cur ? "none" : "";
    if(!cur){ drawDone(); return; }

    var r = cur.rec, c = cur.card;
    var showAnswer = fc.flipped !== reverse;   // 表に出す面
    ui.card.innerHTML = "";
    ui.card.className = "flash-card turn-color-" + (c.turn ? Math.min(c.turn, 8) : "done") + (fc.flipped ? " flash-flipped" : "");
    var head = el("div", "flash-card-head");
    var n = misses(r).length;
    head.appendChild(el("span", "", [c.turn ? "turn " + c.turn : "", n ? "✗" + n : ""].join("　").trim()));
    head.appendChild(el("span", "flash-side", showAnswer ? "こたえ / A" : "もんだい / Q"));
    var main = el("div", "flash-main");
    main.appendChild(el("div", "flash-text", showAnswer ? r.answer : r.question));
    if(showAnswer && r.note) main.appendChild(el("div", "flash-note", r.note));
    ui.card.appendChild(head);
    ui.card.appendChild(main);
    ui.card.appendChild(el("div", "flash-tap", fc.flipped ? "" : "Space / タップで裏返す"));
    if(flipping){
      ui.card.classList.remove("flash-anim");
      void ui.card.offsetWidth;   // アニメーションをやり直す
      ui.card.classList.add("flash-anim");
    }
  }

  function drawDone(){
    var box = ui.done;
    box.innerHTML = "";
    var started = fc.known || missedCount();
    box.appendChild(el("p", "flash-done-title", started ? "おつかれさまでした / Done" :
      fc.practice ? "わからなかった問題はありません / Nothing to practice" : "今日のもんだいは終わっています / Nothing left today"));
    if(started) box.appendChild(el("p", "", "覚えた " + fc.known + "　わからない " + missedCount()));
    if(fc.order.length){
      if(!fc.practice) box.appendChild(el("p", "modal-hint", "わからなかった問題は明日もう一度出て、そのあとの回もその分うしろにずれます。"));
      var list = el("ul", "flash-missed");
      fc.order.forEach(function(id){
        var r = recById(id);
        if(r) list.appendChild(el("li", "", r.question + " → " + r.answer));
      });
      box.appendChild(list);
    }
    var row = el("div", "flash-controls");
    var weak = missDeck().length;
    if(weak) row.appendChild(button("苦手を練習 (" + weak + ")", "「わからない」の記録がある問題を、記録を変えずに練習", function(){ open(true); }));
    if(fc.practice && todayDeck().length) row.appendChild(button("今日の分へ", "Today's cards", function(){ open(false); }));
    row.appendChild(button("閉じる / Close", "Esc", close));
    box.appendChild(row);
  }

  // j: 次のカード（判定せずに山の最後へ）/ k: 前のカード（最後のカードを先頭へ戻す）
  function step(delta){
    if(!current() || fc.queue.length < 2) return;
    if(delta > 0) fc.queue.push(fc.queue.shift());
    else fc.queue.unshift(fc.queue.pop());
    fc.flipped = false;
    draw();
  }

  // script.js の keydown から、開いている間だけ呼ばれる（ほかのキーは奪わない）。
  // 文字のキーは通常版と同じ j / k / c / Enter だけ（Vimium と衝突させないため増やさない）。
  var KEYS = {" ": "flip", "Spacebar": "flip", "Enter": "flip", "ArrowLeft": "miss", "ArrowRight": "know",
              "c": "know", "j": "next", "k": "prev"};
  function key(e){
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    if(e.key === "Escape"){ e.preventDefault(); close(); return; }
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    var act = KEYS[k];
    if(!act || (e.shiftKey && k.length === 1 && k !== " ")) return;   // Shift+J/K などは何もしない
    if(document.activeElement === ui.reverse && (k === " " || k === "Enter")) return;
    e.preventDefault();
    if(e.repeat && act !== "next" && act !== "prev") return;
    if(!current()){ if(k === "Enter") close(); return; }
    if(act === "miss") miss();
    else if(act === "know") know();
    else if(act === "next") step(1);
    else if(act === "prev") step(-1);
    else flip();
  }

  // ================================================================ main page
  // 一覧の問題に「わからない」の回数を付ける
  function decorateRow(tr, row){
    var n = misses(row.rec).length, q = tr.querySelector(".qa-cell-question");
    if(n && q){
      var b = el("span", "miss-badge", "✗" + n);
      b.title = "わからない " + n + " 回 / missed " + n + " times";
      q.appendChild(b);
    }
  }

  function init(){
    document.body.classList.add("beta");
    var title = document.querySelector(".app-title");
    if(title){
      var badge = el("span", "beta-badge", "β");
      badge.title = "beta: ?beta=true を外すと通常版 / remove ?beta=true for the normal version";
      title.appendChild(badge);
    }
    var tools = document.querySelector('#qa-head .pane-tools');
    if(tools){
      var b = button("🂠 FLASHCARD", "フラッシュカード / Flashcards (β)", function(){ open(false); });
      b.className = "flash-btn";
      tools.insertBefore(b, tools.firstChild);
    }
  }

  global.KWBeta = {
    enabled: enabled,
    extendDate: extendDate,
    init: init,
    isOpen: isOpen,
    key: key,
    decorateRow: decorateRow
  };
})(this);
