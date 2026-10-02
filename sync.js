// ---- KWSync: merge rules, sync code (QR / text), LAN server client, QR dialogs ----
// Formats and merge rules are shared with the Rust CLI (cli/src/model.rs,
// cli/src/codec.rs). Change both sides together.
(function(global){
  "use strict";

  var JSQR_URL = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
  var JSQR_SRI = "sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx";
  var PREFIX = "KW1";
  var DEFAULT_CHUNK = 360;
  var K_SYNC = "kw_sync";

  // ================================================================ merge
  // Same id -> larger updatedAt wins. Tie -> union completedTurns, OR deleted.
  function pick(local, other){
    var lu = +local.updatedAt || 0, ou = +other.updatedAt || 0;
    if(ou > lu) return JSON.parse(JSON.stringify(other));
    if(lu > ou) return local;
    var turns = (local.completedTurns || []).concat(other.completedTurns || []);
    var r = JSON.parse(JSON.stringify(local));
    r.completedTurns = turns.filter(function(t, i){ return turns.indexOf(t) === i; }).sort(function(a, b){ return a - b; });
    if(local.deleted || other.deleted) r.deleted = true;
    return r;
  }
  function mergeRecords(local, other){
    var out = [], index = {};
    (local || []).concat(other || []).forEach(function(r){
      if(!r || !r.id) return;
      if(index.hasOwnProperty(r.id)) out[index[r.id]] = pick(out[index[r.id]], r);
      else { index[r.id] = out.length; out.push(r); }
    });
    return out;
  }
  function mergeDocs(local, other){
    local = local || {}; other = other || {};
    var ls = local.settings || {n:[1,3,7,14]}, os = other.settings;
    return {
      version: 2,
      items: mergeRecords(local.items, other.items),
      sentences: mergeRecords(local.sentences, other.sentences),
      settings: (os && (+os.updatedAt || 0) > (+ls.updatedAt || 0)) ? os : ls
    };
  }

  // ================================================================ sync code
  function utf8(s){ return new TextEncoder().encode(s); }
  function b64u(bytes){
    var s = "";
    for(var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(str){
    str = str.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    while(str.length % 4) str += "=";
    var bin = atob(str), out = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function pipe(bytes, stream){
    return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()
      .then(function(buf){ return new Uint8Array(buf); });
  }
  function concat(flag, bytes){
    var out = new Uint8Array(bytes.length + 1);
    out[0] = flag; out.set(bytes, 1);
    return out;
  }
  function fnv1a(s){
    var h = 0x811c9dc5;
    for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }

  // payload = base64url('z' + zlib(json))  or  base64url('j' + json)
  function encodePayload(doc){
    var json = utf8(JSON.stringify(doc));
    if(typeof CompressionStream === "undefined") return Promise.resolve(b64u(concat(0x6a, json)));
    return pipe(json, new CompressionStream("deflate"))
      .then(function(z){ return b64u(concat(0x7a, z)); })
      .catch(function(){ return b64u(concat(0x6a, json)); });
  }
  function decodePayload(payload){
    var bytes = unb64u(payload);
    var body = bytes.subarray(1);
    var p;
    if(bytes[0] === 0x7a){
      if(typeof DecompressionStream === "undefined") return Promise.reject(new Error("このブラウザは圧縮コードを展開できません"));
      p = pipe(body, new DecompressionStream("deflate"));
    } else if(bytes[0] === 0x6a){
      p = Promise.resolve(body);
    } else {
      return Promise.reject(new Error("sync code: unknown format"));
    }
    return p.then(function(b){ return JSON.parse(new TextDecoder().decode(b)); });
  }
  // -> Promise<string[]>  "KW1:<sid>:<i>:<n>:<chunk>"
  function encodeFrames(doc, chunk){
    chunk = Math.max(16, chunk || DEFAULT_CHUNK);
    return encodePayload(doc).then(function(payload){
      var sid = ("00000" + (fnv1a(payload) & 0xffffff).toString(16)).slice(-6);
      var parts = [];
      for(var i = 0; i < payload.length; i += chunk) parts.push(payload.slice(i, i + chunk));
      if(!parts.length) parts.push("");
      return parts.map(function(p, i){ return [PREFIX, sid, i + 1, parts.length, p].join(":"); });
    });
  }

  function Assembler(){ this.sid = null; this.parts = []; }
  // -> true when complete; throws on garbage
  Assembler.prototype.push = function(frame){
    var m = /^KW1:([0-9a-f]+):(\d+):(\d+):([A-Za-z0-9_-]*)$/.exec(String(frame).trim());
    if(!m) throw new Error("not a kwnote sync frame");
    var i = +m[2], n = +m[3];
    if(!n || !i || i > n) throw new Error("bad frame index");
    if(this.sid !== m[1] || this.parts.length !== n){ this.sid = m[1]; this.parts = new Array(n).fill(null); }
    this.parts[i - 1] = m[4];
    return this.complete();
  };
  Assembler.prototype.complete = function(){
    return this.parts.length > 0 && this.parts.every(function(p){ return p !== null; });
  };
  Assembler.prototype.progress = function(){
    return {have: this.parts.filter(function(p){ return p !== null; }).length, total: this.parts.length};
  };
  Assembler.prototype.finish = function(){ return decodePayload(this.parts.join("")); };

  // JSON export, multi-line sync code, or bare payload -> Promise<doc>
  function decodeAny(text){
    var t = String(text || "").trim();
    try{
      if(t.charAt(0) === "{") return Promise.resolve(JSON.parse(t));
      if(t.indexOf(PREFIX + ":") === 0){
        var a = new Assembler();
        t.split(/\s+/).forEach(function(f){ a.push(f); });
        if(!a.complete()){
          var p = a.progress();
          throw new Error("コードが足りません (" + p.have + "/" + p.total + ")");
        }
        return a.finish();
      }
      return decodePayload(t);
    }catch(e){ return Promise.reject(e); }
  }

  // ================================================================ LAN server
  function getServer(){
    try{ return JSON.parse(localStorage.getItem(K_SYNC)) || null; }catch(e){ return null; }
  }
  function setServer(cfg){
    try{
      if(cfg) localStorage.setItem(K_SYNC, JSON.stringify(cfg));
      else localStorage.removeItem(K_SYNC);
    }catch(e){}
  }
  function normalizeUrl(u){
    u = String(u || "").trim().replace(/#.*$/, "").replace(/\/+$/, "");
    if(u && !/^https?:\/\//.test(u)) u = "http://" + u;
    return u;
  }
  function withTimeout(promise, ms){
    return new Promise(function(resolve, reject){
      var t = setTimeout(function(){ reject(new Error("timeout")); }, ms);
      promise.then(function(v){ clearTimeout(t); resolve(v); }, function(e){ clearTimeout(t); reject(e); });
    });
  }
  // Called on load: pick up "#key=..." and detect "served by `kwnote serve`".
  function detectServer(){
    var m = /[#&]key=([0-9a-zA-Z]+)/.exec(location.hash);
    var key = m ? m[1] : null;
    if(m){ try{ history.replaceState(null, "", location.pathname + location.search); }catch(e){} }
    if(!/^https?:$/.test(location.protocol)) return Promise.resolve(getServer());
    return withTimeout(fetch(location.origin + "/api/info", {cache: "no-store"}), 2500)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(info){
        if(!info || info.app !== "kwnote") return getServer();
        var cur = getServer();
        var cfg = {url: location.origin, key: key || (cur && cur.url === location.origin ? cur.key : ""), auto: true};
        setServer(cfg);
        return cfg;
      })
      .catch(function(){ return getServer(); });
  }
  // POST our document, get the merged one back.
  function syncWithServer(doc, cfg){
    cfg = cfg || getServer();
    if(!cfg || !cfg.url) return Promise.reject(new Error("同期サーバーが未設定です"));
    return withTimeout(fetch(normalizeUrl(cfg.url) + "/api/sync", {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Kwnote-Key": cfg.key || ""},
      body: JSON.stringify(doc),
      cache: "no-store"
    }), 15000).then(function(r){
      if(r.status === 401) throw new Error("キーが違います (key rejected)");
      if(!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  // ================================================================ dialogs
  var activeDialog = null;

  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(text !== undefined) e.textContent = text;
    return e;
  }
  function dialog(title){
    closeDialog();
    var back = el("div", "modal-backdrop");
    var win = el("div", "modal");
    var bar = el("div", "modal-title");
    bar.appendChild(el("span", "", title));
    var x = el("button", "modal-close", "×");
    x.setAttribute("aria-label", "close");
    x.addEventListener("click", closeDialog);
    bar.appendChild(x);
    var body = el("div", "modal-body");
    win.appendChild(bar); win.appendChild(body); back.appendChild(win);
    back.addEventListener("click", function(e){ if(e.target === back) closeDialog(); });
    document.body.appendChild(back);
    activeDialog = {root: back, body: body, cleanup: []};
    return activeDialog;
  }
  function closeDialog(){
    if(!activeDialog) return;
    var d = activeDialog;
    activeDialog = null;
    d.cleanup.forEach(function(f){ try{ f(); }catch(e){} });
    d.root.remove();
  }
  // Lets script.js route keys to an open dialog: only Esc (closes it), so
  // nothing collides with browser extensions such as Vimium.
  function dialogKey(e){
    if(!activeDialog) return false;
    if(e.key === "Escape"){ e.preventDefault(); closeDialog(); }
    return true;
  }

  // Animated QR sequence. Frames cycle; the receiver collects them in any order.
  function showQr(frames, opts){
    opts = opts || {};
    var d = dialog(opts.title || "Sync QR");
    var canvas = el("canvas", "qr-canvas");
    var info = el("div", "qr-info");
    var ctrl = el("div", "qr-controls");
    var bPrev = el("button", "", "◀"), bPause = el("button", "", "❚❚"), bNext = el("button", "", "▶");
    // 速さの操作（間隔の数字の増減と取り違えないよう、記号ではなく言葉で）
    var bSlow = el("button", "", "遅く"), bFast = el("button", "", "速く");
    bSlow.title = "Slower"; bFast.title = "Faster";
    [bPrev, bPause, bNext, bSlow, bFast].forEach(function(b){ ctrl.appendChild(b); });
    var hint = el("p", "modal-hint", opts.hint ||
      "受け取る端末で「SCAN QR」を押してこの画面を映してください。コードは自動で切り替わり、順不同で集まれば完了します。");
    d.body.appendChild(canvas); d.body.appendChild(info); d.body.appendChild(ctrl); d.body.appendChild(hint);

    var idx = 0, paused = false, interval = 400, timer = null;
    var codes = frames.map(function(f){ return KWQR.encode(f, "M"); });
    function paint(){
      var px = Math.min(window.innerWidth - 48, window.innerHeight - 220, 520);
      KWQR.draw(canvas, codes[idx], Math.max(160, px) * (window.devicePixelRatio || 1));
      info.textContent = (idx + 1) + " / " + codes.length + (paused ? "  (paused)" : "") + "  ·  " + interval + " ms";
      bPause.textContent = paused ? "▶︎ play" : "❚❚";
    }
    function loop(){
      clearTimeout(timer);
      if(!paused && codes.length > 1){
        timer = setTimeout(function(){ idx = (idx + 1) % codes.length; paint(); loop(); }, interval);
      }
    }
    function step(dlt){ paused = true; idx = (idx + dlt + codes.length) % codes.length; paint(); loop(); }
    function speed(dlt){ interval = Math.min(3000, Math.max(120, interval + dlt)); paint(); loop(); }
    bPrev.onclick = function(){ step(-1); };
    bNext.onclick = function(){ step(1); };
    bPause.onclick = function(){ paused = !paused; paint(); loop(); };
    bSlow.onclick = function(){ speed(100); };
    bFast.onclick = function(){ speed(-100); };
    d.cleanup.push(function(){ clearTimeout(timer); });
    paint(); loop();
  }

  var jsqrPromise = null;
  function loadJsQR(){
    if(global.jsQR) return Promise.resolve(global.jsQR);
    if(jsqrPromise) return jsqrPromise;
    jsqrPromise = new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = JSQR_URL; s.integrity = JSQR_SRI; s.crossOrigin = "anonymous";
      s.onload = function(){ global.jsQR ? resolve(global.jsQR) : reject(new Error("jsQR missing")); };
      s.onerror = function(){ jsqrPromise = null; reject(new Error("QRデコーダを読み込めません（オフライン？）")); };
      document.head.appendChild(s);
    });
    return jsqrPromise;
  }
  function makeDetector(){
    if(!("BarcodeDetector" in global)) return Promise.resolve(null);
    return BarcodeDetector.getSupportedFormats()
      .then(function(f){ return f.indexOf("qr_code") !== -1 ? new BarcodeDetector({formats: ["qr_code"]}) : null; })
      .catch(function(){ return null; });
  }

  // Camera scanner; resolves onDoc(doc) when every frame has been seen.
  function scanQr(onDoc){
    var d = dialog("Scan QR");
    var video = el("video", "qr-video");
    video.setAttribute("playsinline", ""); video.muted = true;
    var bar = el("div", "qr-progress"), fill = el("div", "qr-progress-fill");
    bar.appendChild(fill);
    var status = el("div", "qr-info", "カメラを起動中… / starting camera…");
    var grid = el("div", "qr-grid");
    d.body.appendChild(video); d.body.appendChild(bar); d.body.appendChild(grid); d.body.appendChild(status);

    if(!global.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      status.textContent = "カメラは https または localhost でのみ使えます。LAN同期か COPY CODE / PASTE CODE を使ってください。";
      video.remove(); bar.remove();
      return;
    }
    var asm = new Assembler(), stream = null, stopped = false, busy = false;
    var canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", {willReadFrequently: true});
    d.cleanup.push(function(){
      stopped = true;
      if(stream) stream.getTracks().forEach(function(t){ t.stop(); });
    });

    function drawGrid(){
      var p = asm.progress();
      fill.style.width = p.total ? (100 * p.have / p.total) + "%" : "0";
      if(grid.childNodes.length !== p.total){
        grid.innerHTML = "";
        for(var i = 0; i < p.total; i++) grid.appendChild(el("span", "qr-cell"));
      }
      asm.parts.forEach(function(v, i){ grid.childNodes[i].classList.toggle("got", v !== null); });
      status.textContent = p.total ? ("受信 " + p.have + " / " + p.total) : "QRコードを映してください / point at the QR code";
    }
    function accept(text){
      if(!text || text.indexOf(PREFIX + ":") !== 0) return;
      var done;
      try{ done = asm.push(text); }catch(e){ return; }
      drawGrid();
      if(done && !stopped){
        stopped = true;
        status.textContent = "展開中… / decoding…";
        asm.finish().then(function(doc){
          closeDialog();
          onDoc(doc);
        }, function(err){
          status.textContent = "失敗: " + err.message;
        });
      }
    }

    Promise.all([
      navigator.mediaDevices.getUserMedia({video: {facingMode: "environment", width: {ideal: 1280}, height: {ideal: 720}}, audio: false}),
      makeDetector()
    ]).then(function(res){
      stream = res[0];
      if(stopped){ stream.getTracks().forEach(function(t){ t.stop(); }); return; }
      video.srcObject = stream;
      return video.play().then(function(){ return res[1] || loadJsQR().then(function(){ return null; }); });
    }).then(function(detector){
      if(stopped) return;
      drawGrid();
      function tick(){
        if(stopped) return;
        if(busy || video.readyState < 2){ setTimeout(tick, 60); return; }
        busy = true;
        var p;
        if(detector){
          p = detector.detect(video).then(function(codes){ codes.forEach(function(c){ accept(c.rawValue); }); });
        } else {
          var w = video.videoWidth, h = video.videoHeight, s = Math.min(1, 720 / Math.max(w, h));
          canvas.width = Math.round(w * s); canvas.height = Math.round(h * s);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var code = global.jsQR(img.data, img.width, img.height, {inversionAttempts: "dontInvert"});
          if(code) accept(code.data);
          p = Promise.resolve();
        }
        p.catch(function(){}).then(function(){ busy = false; setTimeout(tick, 40); });
      }
      tick();
    }).catch(function(err){
      status.textContent = "カメラを使えません: " + (err && err.message || err);
    });
  }

  global.KWSync = {
    PREFIX: PREFIX,
    DEFAULT_CHUNK: DEFAULT_CHUNK,
    mergeDocs: mergeDocs,
    encodePayload: encodePayload,
    decodePayload: decodePayload,
    encodeFrames: encodeFrames,
    decodeAny: decodeAny,
    Assembler: Assembler,
    getServer: getServer,
    setServer: setServer,
    normalizeUrl: normalizeUrl,
    detectServer: detectServer,
    syncWithServer: syncWithServer,
    showQr: showQr,
    scanQr: scanQr,
    dialog: dialog,
    closeDialog: closeDialog,
    dialogKey: dialogKey,
    isDialogOpen: function(){ return !!activeDialog; }
  };
})(typeof window !== "undefined" ? window : globalThis);
