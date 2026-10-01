// ---- KWQR: minimal QR Code encoder (byte mode, versions 1-40, ECC L/M/Q/H) ----
// No dependencies, works from file://. Follows ISO/IEC 18004; the module
// layout is checked against the Rust `qrcode` crate (see CLAUDE.md).
//   KWQR.encode(text, "M" [, forceMask]) -> {version, size, mask, modules[y][x]}  (true = dark)
//   KWQR.draw(canvas, qr, pixelSizeHint)
(function(global){
  "use strict";

  // index = version; [L, M, Q, H]
  var ECC_PER_BLOCK = [
    [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
  ];
  var NUM_BLOCKS = [
    [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
  ];
  var ECL_INDEX = {L:0, M:1, Q:2, H:3};
  var ECL_FORMAT = [1, 0, 3, 2]; // format-info bits for L, M, Q, H

  function rawModules(ver){
    var r = (16 * ver + 128) * ver + 64;
    if(ver >= 2){
      var na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if(ver >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(ver, e){
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];
  }

  // GF(256) with polynomial 0x11D
  function gfMul(x, y){
    var z = 0;
    for(var i = 7; i >= 0; i--){
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(degree){
    var r = [];
    for(var i = 0; i < degree - 1; i++) r.push(0);
    r.push(1);
    var root = 1;
    for(i = 0; i < degree; i++){
      for(var j = 0; j < r.length; j++){
        r[j] = gfMul(r[j], root);
        if(j + 1 < r.length) r[j] ^= r[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return r;
  }
  function rsRemainder(data, div){
    var r = div.map(function(){ return 0; });
    data.forEach(function(b){
      var f = b ^ r.shift();
      r.push(0);
      for(var i = 0; i < div.length; i++) r[i] ^= gfMul(div[i], f);
    });
    return r;
  }

  function utf8(text){
    if(typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
    var s = unescape(encodeURIComponent(text)), out = [];
    for(var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function encode(text, ecl, forceMask){
    var e = ECL_INDEX[ecl || "M"];
    if(e === undefined) e = 1;
    var bytes = typeof text === "string" ? utf8(text) : Array.from(text);

    var ver, cap;
    for(ver = 1; ver <= 40; ver++){
      cap = dataCodewords(ver, e) * 8;
      if(4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= cap) break;
    }
    if(ver > 40) throw new Error("QR: data too long (" + bytes.length + " bytes)");

    // ---- bit stream: mode 0100 (byte), count, data, terminator, padding
    var bits = [];
    function put(val, len){ for(var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach(function(b){ put(b, 8); });
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for(var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for(var i = 0; i < bits.length; i += 8){
      var b = 0;
      for(var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }

    // ---- split into blocks, add Reed-Solomon ECC, interleave
    var nb = NUM_BLOCKS[e][ver], eccLen = ECC_PER_BLOCK[e][ver];
    var raw = Math.floor(rawModules(ver) / 8);
    var numShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
    var div = rsDivisor(eccLen), blocks = [], k = 0;
    for(i = 0; i < nb; i++){
      var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, div);
      if(i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var codewords = [];
    for(i = 0; i < blocks[0].length; i++){
      for(j = 0; j < nb; j++){
        if(i !== shortLen - eccLen || j >= numShort) codewords.push(blocks[j][i]);
      }
    }

    // ---- matrix
    var size = ver * 4 + 17;
    var mod = [], fn = [];
    for(i = 0; i < size; i++){
      mod.push(new Array(size).fill(false));
      fn.push(new Array(size).fill(false));
    }
    function setF(x, y, dark){ mod[y][x] = dark; fn[y][x] = true; }

    for(i = 0; i < size; i++){ setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function(c){
      for(var dy = -4; dy <= 4; dy++) for(var dx = -4; dx <= 4; dx++){
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = c[0] + dx, yy = c[1] + dy;
        if(xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, d !== 2 && d !== 4);
      }
    });
    var align = [];
    if(ver > 1){
      var na = Math.floor(ver / 7) + 2;
      var step = Math.floor((ver * 8 + na * 3 + 5) / (na * 4 - 4)) * 2;
      for(var pos = size - 7; align.length < na - 1; pos -= step) align.unshift(pos);
      align.unshift(6);
    }
    for(i = 0; i < align.length; i++) for(j = 0; j < align.length; j++){
      if((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for(var ay = -2; ay <= 2; ay++) for(var ax = -2; ax <= 2; ax++){
        setF(align[i] + ax, align[j] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
      }
    }
    function drawFormat(mask){
      var d = ECL_FORMAT[e] << 3 | mask, rem = d;
      for(var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = (d << 10 | rem) ^ 0x5412;
      function bit(i){ return ((bits >>> i) & 1) !== 0; }
      for(i = 0; i <= 5; i++) setF(8, i, bit(i));
      setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
      for(i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
      for(i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
      for(i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
      setF(8, size - 8, true);
    }
    drawFormat(0); // reserve
    if(ver >= 7){
      var rem = ver;
      for(i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vb = ver << 12 | rem;
      for(i = 0; i < 18; i++){
        var bt = ((vb >>> i) & 1) !== 0, a = size - 11 + i % 3, c = Math.floor(i / 3);
        setF(a, c, bt); setF(c, a, bt);
      }
    }

    // ---- codewords in the zig-zag
    var bi = 0, total = codewords.length * 8;
    for(var right = size - 1; right >= 1; right -= 2){
      if(right === 6) right = 5;
      for(var vert = 0; vert < size; vert++){
        for(j = 0; j < 2; j++){
          var x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
          if(!fn[y][x] && bi < total){
            mod[y][x] = ((codewords[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0;
            bi++;
          }
        }
      }
    }

    // ---- choose the mask with the lowest penalty
    var MASKS = [
      function(x, y){ return (x + y) % 2 === 0; },
      function(x, y){ return y % 2 === 0; },
      function(x){ return x % 3 === 0; },
      function(x, y){ return (x + y) % 3 === 0; },
      function(x, y){ return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
      function(x, y){ return x * y % 2 + x * y % 3 === 0; },
      function(x, y){ return (x * y % 2 + x * y % 3) % 2 === 0; },
      function(x, y){ return ((x + y) % 2 + x * y % 3) % 2 === 0; }
    ];
    function applyMask(m){
      for(var y = 0; y < size; y++) for(var x = 0; x < size; x++){
        if(!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x];
      }
    }
    function penalty(){
      var p = 0, dark = 0, x, y;
      function runs(get){
        for(var a = 0; a < size; a++){
          var run = 1, line = [];
          for(var b = 0; b < size; b++) line.push(get(a, b));
          for(b = 1; b <= size; b++){
            if(b < size && line[b] === line[b - 1]){ run++; continue; }
            if(run >= 5) p += run - 2;
            run = 1;
          }
          // finder-like 1:1:3:1:1 with 4 light modules on either side
          var s = line.map(function(v){ return v ? "1" : "0"; }).join("");
          s = "0000" + s + "0000";
          for(var at = s.indexOf("1011101"); at !== -1; at = s.indexOf("1011101", at + 1)){
            if(s.substr(at - 4, 4) === "0000" || s.substr(at + 7, 4) === "0000") p += 40;
          }
        }
      }
      runs(function(a, b){ return mod[a][b]; });
      runs(function(a, b){ return mod[b][a]; });
      for(y = 0; y < size - 1; y++) for(x = 0; x < size - 1; x++){
        var c = mod[y][x];
        if(c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
      }
      for(y = 0; y < size; y++) for(x = 0; x < size; x++) if(mod[y][x]) dark++;
      var t = size * size;
      p += (Math.ceil(Math.abs(dark * 20 - t * 10) / t) - 1) * 10;
      return p;
    }
    var best = 0, bestP = Infinity;
    for(var m = 0; m < 8; m++){
      if(forceMask !== undefined && m !== forceMask) continue;
      applyMask(m); drawFormat(m);
      var pen = penalty();
      if(pen < bestP){ bestP = pen; best = m; }
      applyMask(m); // undo (XOR)
    }
    applyMask(best); drawFormat(best);
    return {version: ver, size: size, mask: best, modules: mod};
  }

  function draw(canvas, qr, maxPx){
    var quiet = 4, n = qr.size + quiet * 2;
    var scale = Math.max(1, Math.floor((maxPx || 360) / n));
    canvas.width = canvas.height = n * scale;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for(var y = 0; y < qr.size; y++) for(var x = 0; x < qr.size; x++){
      if(qr.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }

  global.KWQR = {encode: encode, draw: draw};
})(typeof window !== "undefined" ? window : globalThis);
