/* 문서 스캐너 - 글자 인식(OCR) + 엑셀 내보내기
   이 파일은 "엑셀" 버튼을 처음 누를 때만 불러온다. (기본 스캔 기능과 분리)
   1) 표의 선을 찾아 칸을 나눈다  2) 칸마다 글자를 읽는다  3) 표 모양 그대로 .xlsx 로 만든다 */
(function (root) {
  'use strict';

  /* ================= 1. 표 선 / 칸 찾기 ================= */
  // 한 방향 최대/최소 필터 (axis 1 = 가로 방향, 0 = 세로 방향), 창 크기 k
  function filt(src, W, H, k, axis, isMax) {
    var out = new Uint8Array(W * H), r = k >> 1, n = axis ? W : H, m = axis ? H : W;
    var a = new Uint8Array(n), q = new Int32Array(n), i, j, o, h, t, nx, hi, v, base, step = axis ? 1 : W;
    for (j = 0; j < m; j++) {
      base = axis ? j * W : j;
      for (i = 0; i < n; i++) a[i] = src[base + i * step];
      h = 0; t = 0; nx = 0;
      for (o = 0; o < n; o++) {
        hi = Math.min(n - 1, o + r);
        while (nx <= hi) {
          v = a[nx];
          if (isMax) { while (t > h && a[q[t - 1]] <= v) t--; } else { while (t > h && a[q[t - 1]] >= v) t--; }
          q[t++] = nx; nx++;
        }
        while (q[h] < o - r) h++;
        out[base + o * step] = a[q[h]];
      }
    }
    return out;
  }
  // 연결된 덩어리 번호 붙이기 (4방향)
  function label(mask, W, H) {
    var lab = new Int32Array(W * H), boxes = [null], stack = new Int32Array(W * H), n = 0, p, s, q, x, y, sp;
    for (p = 0; p < W * H; p++) {
      if (!mask[p] || lab[p]) continue;
      n++; var b = [W, H, 0, 0, 0]; sp = 0; stack[sp++] = p; lab[p] = n;
      while (sp) {
        q = stack[--sp]; x = q % W; y = (q - x) / W; b[4]++;
        if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x >= b[2]) b[2] = x + 1; if (y >= b[3]) b[3] = y + 1;
        if (x > 0 && mask[q - 1] && !lab[q - 1]) { lab[q - 1] = n; stack[sp++] = q - 1; }
        if (x < W - 1 && mask[q + 1] && !lab[q + 1]) { lab[q + 1] = n; stack[sp++] = q + 1; }
        if (y > 0 && mask[q - W] && !lab[q - W]) { lab[q - W] = n; stack[sp++] = q - W; }
        if (y < H - 1 && mask[q + W] && !lab[q + W]) { lab[q + W] = n; stack[sp++] = q + W; }
      }
      boxes.push(b);
    }
    return { lab: lab, n: n, boxes: boxes };
  }
  function thresh(src, t) { var o = new Uint8Array(src.length); for (var i = 0; i < src.length; i++) o[i] = src[i] > t ? 1 : 0; return o; }
  // 약한 선이라도 진한 부분과 이어져 있으면 선으로 본다
  function hyst(r, W, H, thr) {
    var L = label(thresh(r, thr * 0.5), W, H), keep = new Uint8Array(L.n + 1), i, o = new Uint8Array(W * H);
    for (i = 0; i < r.length; i++) if (r[i] > thr) keep[L.lab[i]] = 1;
    for (i = 0; i < r.length; i++) if (L.lab[i] && keep[L.lab[i]]) o[i] = 1;
    return o;
  }
  function lineResp(d, W, H, L, axis, gap) {
    var t = filt(d, W, H, 3, 1 - axis, true);
    t = filt(t, W, H, gap, axis, true); t = filt(t, W, H, gap, axis, false);
    t = filt(t, W, H, L, axis, false); return filt(t, W, H, L, axis, true);
  }
  // 선은 가늘다: 두꺼운 덩어리(글자 줄, 색칠된 칸)는 뺀다
  function thinOnly(M, S, W, H, T, L, axis) {      // S: 진한 부분만 (두께 판단용)
    var thick = filt(filt(S, W, H, T, 1 - axis, false), W, H, T, 1 - axis, true);
    thick = filt(thick, W, H, T, 1 - axis, true);
    var o = new Uint8Array(W * H), i;
    for (i = 0; i < o.length; i++) o[i] = M[i] && !thick[i] ? 1 : 0;
    return filt(filt(o, W, H, L, axis, false), W, H, L, axis, true);
  }
  // M 의 덩어리 중 O 와 서로 떨어진 두 곳 이상에서 만나는 것만 남긴다
  function touching(M, O, W, H, axis, mind) {
    var Od = filt(filt(O, W, H, 15, 0, true), W, H, 15, 1, true), L = label(M, W, H);
    var lo = new Int32Array(L.n + 1).fill(1e9), hi = new Int32Array(L.n + 1).fill(-1), i, x, y, v, o = new Uint8Array(W * H);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      i = y * W + x; v = L.lab[i];
      if (v && Od[i]) { var p = axis ? x : y; if (p < lo[v]) lo[v] = p; if (p > hi[v]) hi[v] = p; }
    }
    for (i = 0; i < o.length; i++) { v = L.lab[i]; if (v && hi[v] - lo[v] >= mind) o[i] = 1; }
    return o;
  }
  /* gray: Uint8Array(W*H) (긴 변 2000 정도로 맞춘 그림) → { cells:[[x0,y0,x1,y1]], lines, d } */
  function analyze(gray, W, H) {
    var i, n = W * H, bg = filt(filt(gray, W, H, 17, 0, true), W, H, 17, 1, true), d = new Uint8Array(n);
    for (i = 0; i < n; i++) { var v = bg[i] - gray[i]; d[i] = v > 0 ? v : 0; }
    var Lh = Math.max(30, (W / 26) | 0) | 1, Lv = Math.max(22, (H / 45) | 0) | 1, thr = 12, T = 17;
    var rh = lineResp(d, W, H, Lh, 1, 5), rv = lineResp(d, W, H, Lv, 0, 5);
    var Hm = thinOnly(hyst(rh, W, H, thr), thresh(rh, thr), W, H, T, Lh, 1), Vm = thinOnly(hyst(rv, W, H, thr), thresh(rv, thr), W, H, T, Lv, 0);
    var V2 = touching(Vm, Hm, W, H, 0, Lv - 8), H2 = touching(Hm, V2, W, H, 1, Lh - 8);
    V2 = touching(V2, H2, W, H, 0, Lv - 8);
    var lines = new Uint8Array(n);
    for (i = 0; i < n; i++) lines[i] = H2[i] | V2[i];
    lines = filt(filt(lines, W, H, 3, 0, true), W, H, 3, 1, true);
    var free = new Uint8Array(n); for (i = 0; i < n; i++) free[i] = lines[i] ? 0 : 1;
    var L = label(free, W, H), cells = [];
    for (i = 1; i <= L.n; i++) {
      var b = L.boxes[i], w = b[2] - b[0], h = b[3] - b[1];
      if (b[0] <= 1 || b[1] <= 1 || b[2] >= W - 1 || b[3] >= H - 1) continue;
      if (w < 24 || h < 18) continue;
      if (b[4] / (w * h) < 0.8) continue;
      cells.push([b[0], b[1], b[2], b[3]]);
    }
    return { cells: cells, lines: lines, d: d };
  }

  /* 세로선이 흐려서 옆 칸과 붙어 버린 칸 나누기: 바로 위/아래 칸이 나뉘어 있는 자리에 글자가 없으면 거기서 자른다 */
  function splitCells(cells, d, W) {
    var out = [], again = true, list = cells.slice(), guard = 0;
    function clear(c, x) {
      var n = 0, s = 0, y, xx;
      for (y = c[1] + 4; y < c[3] - 4; y++) for (xx = x - 5; xx <= x + 5; xx++) { n++; if (d[y * W + xx] > 50) s++; }
      return n > 0 && s / n < 0.004;
    }
    while (again && guard++ < 6) {
      again = false; out = [];
      list.forEach(function (c) {
        var cut = 0;
        list.some(function (o) {
          if (o === c) return false;
          var adj = Math.abs(o[1] - c[3]) < 16 || Math.abs(c[1] - o[3]) < 16;       // 바로 위나 아래
          if (!adj) return false;
          return [o[0] - 4, o[2] + 4].some(function (x) {
            if (x > c[0] + 30 && x < c[2] - 30 && clear(c, Math.round(x))) { cut = Math.round(x); return true; }
            return false;
          });
        });
        if (cut) { out.push([c[0], c[1], cut - 4, c[3]], [cut + 4, c[1], c[2], c[3]]); again = true; } else out.push(c);
      });
      list = out;
    }
    return list;
  }

  /* ================= 2. 글자 읽기 ================= */
  var HAN = /[가-힣]/;
  function inkRatio(d, W, c) {
    var x0 = c[0] + 4, y0 = c[1] + 4, x1 = c[2] - 4, y1 = c[3] - 4, s = 0, n = 0, x, y;
    if (x1 - x0 < 4 || y1 - y0 < 4) return 0;
    for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) { n++; if (d[y * W + x] > 60) s++; }
    return s / n;
  }
  // 칸을 잘라 글자 높이가 충분하도록 키우고 흰 여백을 둔다
  function crop(gray, W, H, c, inset) {
    var x0 = Math.max(0, c[0] + inset), y0 = Math.max(0, c[1] + inset), x1 = Math.min(W, c[2] - inset), y1 = Math.min(H, c[3] - inset);
    var w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), k = Math.max(1, Math.min(3, 64 / (c[3] - c[1])));
    var ow = Math.round(w * k), oh = Math.round(h * k), P = 12, OW = ow + 2 * P, OH = oh + 2 * P, out = new Uint8Array(OW * OH).fill(255), x, y;
    for (y = 0; y < oh; y++) {
      var sy = Math.min(h - 1.001, (y + 0.5) / k - 0.5); if (sy < 0) sy = 0; var iy = sy | 0, fy = sy - iy, iy2 = Math.min(h - 1, iy + 1);
      for (x = 0; x < ow; x++) {
        var sx = Math.min(w - 1.001, (x + 0.5) / k - 0.5); if (sx < 0) sx = 0; var ix = sx | 0, fx = sx - ix, ix2 = Math.min(w - 1, ix + 1);
        var a = gray[(y0 + iy) * W + x0 + ix], b = gray[(y0 + iy) * W + x0 + ix2], e = gray[(y0 + iy2) * W + x0 + ix], f = gray[(y0 + iy2) * W + x0 + ix2];
        out[(y + P) * OW + x + P] = (a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + f * fx) * fy;
      }
    }
    return { data: out, w: OW, h: OH };
  }
  function fixNum(s) {      // 18.000 / 18,000 / ₩2,783,000 → 숫자
    var t = s.replace(/\s/g, '');
    if (/^[\\₩W(]*\d{1,3}([.,]\d{3})+[.)]*$/.test(t)) return t.replace(/[^\d]/g, '');
    return s;
  }
  function clean(s) {
    var lines = String(s || '').split(/\n+/).map(function (l) {
      return l.replace(/\s+/g, ' ').replace(/^[\s"'“”‘’`^~_|\\.,:;\-]+(?=[0-9A-Za-z가-힣(@])/, '').replace(/[\s"'“”‘’`^~_|\\]+$/, '').trim();
    }).filter(function (l) { return l.length; });
    if (lines.length > 1 && lines.every(function (l) { return l.length === 1; })) return lines.join('');   // 세로로 쓴 글자 (공/급/자)
    return fixNum(lines.join('\n'));
  }
  async function readCell(gray, W, H, c, recog) {
    var im = crop(gray, W, H, c, 2), psm = (c[3] - c[1]) > 70 ? 6 : 7;
    var t = (await recog(im, 'kor', psm, false)).text || '';
    if (!HAN.test(t)) { var e = (await recog(im, 'eng', psm, false)).text || ''; if (e.trim()) t = e; }   // 숫자·영문 칸은 영문 엔진이 더 정확
    t = clean(t);
    if (!t && psm === 7) {                                   // 한두 글자뿐인 칸은 '낱말 하나'로 다시 읽는다
      t = clean((await recog(im, 'eng', 8, false)).text || '');
      if (!/[0-9A-Za-z]/.test(t)) t = clean((await recog(im, 'kor', 8, false)).text || '');
    }
    return t;
  }
  // 표 밖에 있는 글자: 낱말 상자를 줄 단위로 묶는다
  function groupWords(words) {
    var ws = words.filter(function (w) {
      var h = w.y1 - w.y0; return w.conf >= 25 && h >= 12 && h <= 220 && /[0-9A-Za-z가-힣]/.test(w.text);
    }).sort(function (a, b) { return (a.y0 + a.y1) - (b.y0 + b.y1); });
    var rows = [];
    ws.forEach(function (w) {
      var yc = (w.y0 + w.y1) / 2, h = w.y1 - w.y0, r = rows[rows.length - 1];
      if (r && Math.abs(yc - r.yc) < 0.5 * Math.max(h, r.h)) { r.ws.push(w); r.yc = (r.yc * (r.ws.length - 1) + yc) / r.ws.length; r.h = Math.max(r.h, h); }
      else rows.push({ yc: yc, h: h, ws: [w] });
    });
    var out = [];
    rows.forEach(function (r) {
      r.ws.sort(function (a, b) { return a.x0 - b.x0; });
      var cur = null;
      r.ws.forEach(function (w) {
        if (cur && w.x0 - cur[2] < 1.8 * r.h) { cur[2] = Math.max(cur[2], w.x1); cur[1] = Math.min(cur[1], w.y0); cur[3] = Math.max(cur[3], w.y1); }
        else { cur = [w.x0, w.y0, w.x1, w.y1]; out.push(cur); }
      });
    });
    return out;
  }
  function parseTsv(tsv) {
    var out = [];
    String(tsv || '').split('\n').forEach(function (ln) {
      var f = ln.split('\t');
      if (f.length < 12 || f[0] !== '5') return;
      var x = +f[6], y = +f[7], w = +f[8], h = +f[9];
      out.push({ x0: x, y0: y, x1: x + w, y1: y + h, conf: +f[10], text: f.slice(11).join('\t') });
    });
    return out;
  }

  /* ================= 3. 표(행·열) 만들기 ================= */
  function cluster(vals, tol) {
    var s = vals.slice().sort(function (a, b) { return a - b; }), out = [], g = [];
    s.forEach(function (v) { if (g.length && v - g[g.length - 1] > tol) { out.push(g); g = []; } g.push(v); });
    if (g.length) out.push(g);
    return out.map(function (g) { return g.reduce(function (a, b) { return a + b; }, 0) / g.length; });
  }
  function nearest(edges, v) { var bi = 0, bd = 1e9; edges.forEach(function (e, i) { var d = Math.abs(e - v); if (d < bd) { bd = d; bi = i; } }); return bi; }
  function slot(edges, v) { var k = 0; for (var i = 0; i < edges.length; i++) if (edges[i] <= v) k = i; return Math.min(k, edges.length - 2); }
  /* items: [{box:[x0,y0,x1,y1], text, real}] → { rows, cols, cells:[{r,c,rs,cs,text,real}], colW:[px] } */
  function buildGrid(items, W, H) {
    var real = items.filter(function (t) { return t.real; }), xs = [0, W], ys = [0, H];
    real.forEach(function (t) { xs.push(t.box[0], t.box[2]); ys.push(t.box[1], t.box[3]); });
    var ex = cluster(xs, 16), ey = cluster(ys, 14), cells = [], used = {};
    function key(r, c) { return r + ',' + c; }
    real.forEach(function (t) {
      var c0 = nearest(ex, t.box[0]), c1 = nearest(ex, t.box[2]), r0 = nearest(ey, t.box[1]), r1 = nearest(ey, t.box[3]);
      if (c1 <= c0) c1 = c0 + 1; if (r1 <= r0) r1 = r0 + 1;
      var cell = { r: r0, c: c0, rs: r1 - r0, cs: c1 - c0, text: t.text, real: true };
      for (var r = r0; r < r1; r++) for (var c = c0; c < c1; c++) used[key(r, c)] = cell;
      cells.push(cell);
    });
    items.filter(function (t) { return !t.real && t.text; }).sort(function (a, b) { return a.box[1] - b.box[1] || a.box[0] - b.box[0]; }).forEach(function (t) {
      var c = slot(ex, t.box[0] + 8), r = slot(ey, (t.box[1] + t.box[3]) / 2), hit = used[key(r, c)];
      if (hit) { hit.text = hit.text ? hit.text + (hit.real ? ' ' : '\n') + t.text : t.text; return; }
      var cell = { r: r, c: c, rs: 1, cs: 1, text: t.text, real: false }; used[key(r, c)] = cell; cells.push(cell);
    });
    // 아무것도 없는 행·열은 없앤다
    var nR = ey.length - 1, nC = ex.length - 1, rowUsed = new Array(nR).fill(false), colUsed = new Array(nC).fill(false);
    cells.forEach(function (c) { for (var r = c.r; r < c.r + c.rs; r++) rowUsed[r] = true; for (var k = c.c; k < c.c + c.cs; k++) colUsed[k] = true; });
    function remap(usedArr) { var m = [], k = 0; usedArr.forEach(function (u) { m.push(k); if (u) k++; }); m.push(k); return m; }
    var rm = remap(rowUsed), cm = remap(colUsed), colW = [];
    colUsed.forEach(function (u, i) { if (u) colW.push(ex[i + 1] - ex[i]); });
    cells.forEach(function (c) {
      var r1 = rm[c.r + c.rs], c1 = cm[c.c + c.cs]; c.r = rm[c.r]; c.c = cm[c.c];
      c.rs = Math.max(1, r1 - c.r); c.cs = Math.max(1, c1 - c.c);
    });
    cells = cells.filter(function (c) { return c.text || c.real; });
    return { rows: rm[nR], cols: cm[nC], cells: cells, colW: colW };
  }

  /* 한 쪽 처리: gray(W×H) + 글자 읽는 함수 recog(im, lang, psm, wantWords) → 표 */
  async function processPage(gray, W, H, recog, progress) {
    progress = progress || function () {};
    var A = analyze(gray, W, H), items = [], todo = [], i;
    A.cells = splitCells(A.cells, A.d, W);
    A.cells.forEach(function (c) { if (inkRatio(A.d, W, c) >= 0.004) todo.push(c); else items.push({ box: c, text: '', real: true }); });
    // 표 밖의 글자 찾기: 칸과 선을 흰색으로 지운 그림에서
    var rest = new Uint8Array(gray), x, y, fat = filt(filt(A.lines, W, H, 7, 0, true), W, H, 7, 1, true);
    for (i = 0; i < rest.length; i++) if (fat[i]) rest[i] = 255;
    A.cells.forEach(function (c) { for (y = Math.max(0, c[1] - 4); y < Math.min(H, c[3] + 4); y++) for (x = Math.max(0, c[0] - 4); x < Math.min(W, c[2] + 4); x++) rest[y * W + x] = 255; });
    progress(0, '글자 위치 찾는 중');
    var res = await recog({ data: rest, w: W, h: H }, 'kor', 11, true), groups = groupWords(res.words || []);
    var total = todo.length + groups.length, done = 0;
    for (i = 0; i < todo.length; i++) {
      items.push({ box: todo[i], text: await readCell(gray, W, H, todo[i], recog), real: true });
      progress(++done / Math.max(1, total), '글자 읽는 중');
    }
    for (i = 0; i < groups.length; i++) {
      var g = groups[i], b = [Math.max(0, g[0] - 8), Math.max(0, g[1] - 8), Math.min(W, g[2] + 8), Math.min(H, g[3] + 8)];
      var im = crop(rest, W, H, b, 0), t = (await recog(im, 'kor', 7, false)).text || '';
      if (!HAN.test(t)) { var e = (await recog(im, 'eng', 7, false)).text || ''; if (e.trim()) t = e; }
      t = clean(t);
      if (t && /[0-9A-Za-z가-힣]/.test(t)) items.push({ box: g, text: t, real: false });
      progress(++done / Math.max(1, total), '글자 읽는 중');
    }
    return buildGrid(items, W, H);
  }

  /* ================= 4. 엑셀(.xlsx) 파일 만들기 ================= */
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u) { var c = 0xFFFFFFFF; for (var i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function utf8(s) { return new TextEncoder().encode(s); }
  function zip(files) {       // 압축 없는(stored) zip
    var parts = [], central = [], off = 0;
    function u16(v) { return [v & 255, (v >> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data, crc = crc32(data);
      var head = [].concat([0x50, 0x4b, 3, 4], u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(head), name, data);
      central.push({ h: [].concat([0x50, 0x4b, 1, 2], u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off)), name: name });
      off += head.length + name.length + data.length;
    });
    var cs = 0; central.forEach(function (c) { parts.push(new Uint8Array(c.h), c.name); cs += c.h.length + c.name.length; });
    parts.push(new Uint8Array([].concat([0x50, 0x4b, 5, 6], u16(0), u16(0), u16(files.length), u16(files.length), u32(cs), u32(off), u16(0))));
    return parts;
  }
  function esc(s) { return String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function colName(c) { var s = ''; c++; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = (c - m - 1) / 26; } return s; }
  function isNum(t) { return /^-?(0|[1-9]\d{0,13})(\.\d+)?$/.test(t); }
  /* sheets: [{name, grid:{rows, cols, cells, colW}}] → zip 조각 배열 (Blob 으로 감싸면 .xlsx) */
  function buildXlsx(sheets) {
    var files = [], X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    var NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', RS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', PK = 'http://schemas.openxmlformats.org/package/2006/';
    files.push({ name: '[Content_Types].xml', s: X + '<Types xmlns="' + PK + 'content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') + '</Types>' });
    files.push({ name: '_rels/.rels', s: X + '<Relationships xmlns="' + PK + 'relationships"><Relationship Id="rId1" Type="' + RS + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
    files.push({ name: 'xl/workbook.xml', s: X + '<workbook xmlns="' + NS + '" xmlns:r="' + RS + '"><sheets>' +
      sheets.map(function (s, i) { return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', s: X + '<Relationships xmlns="' + PK + 'relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="' + RS + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="' + RS + '/styles" Target="styles.xml"/></Relationships>' });
    // 서식 0: 기본, 1: 테두리+글자, 2: 테두리+숫자(천 단위 쉼표), 3: 테두리 없는 숫자
    var bd = '<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>';
    files.push({ name: 'xl/styles.xml', s: X + '<styleSheet xmlns="' + NS + '"><fonts count="1"><font><sz val="11"/><name val="맑은 고딕"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' + bd + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '</cellXfs></styleSheet>' });
    sheets.forEach(function (sh, si) {
      var g = sh.grid, rows = [], merges = [], r, c, sum = g.colW.reduce(function (a, b) { return a + b; }, 0) || 1;
      for (r = 0; r < g.rows; r++) rows.push({});
      g.cells.forEach(function (cell) {
        if (cell.r >= g.rows || cell.c >= g.cols) return;
        var num = isNum(cell.text), st = cell.real ? (num ? 2 : 1) : (num ? 3 : 0);
        rows[cell.r][cell.c] = { t: cell.text, num: num, st: st };
        if (cell.rs > 1 || cell.cs > 1) {
          merges.push(colName(cell.c) + (cell.r + 1) + ':' + colName(cell.c + cell.cs - 1) + (cell.r + cell.rs));
          for (var rr = cell.r; rr < cell.r + cell.rs && rr < g.rows; rr++) for (var cc = cell.c; cc < cell.c + cell.cs && cc < g.cols; cc++)
            if (!rows[rr][cc]) rows[rr][cc] = { t: '', num: false, st: st === 2 ? 1 : st };
        }
      });
      var xml = X + '<worksheet xmlns="' + NS + '"><cols>';
      for (c = 0; c < g.cols; c++) xml += '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + Math.max(3, Math.min(60, (g.colW[c] || 100) / sum * 130)).toFixed(1) + '" customWidth="1"/>';
      xml += '</cols><sheetData>';
      rows.forEach(function (row, ri) {
        var keys = Object.keys(row).map(Number).sort(function (a, b) { return a - b; }); if (!keys.length) return;
        var lines = 1; keys.forEach(function (k) { lines = Math.max(lines, String(row[k].t).split('\n').length); });
        xml += '<row r="' + (ri + 1) + '"' + (lines > 1 ? ' ht="' + (17 * lines) + '" customHeight="1"' : '') + '>';
        keys.forEach(function (k) {
          var v = row[k], ref = colName(k) + (ri + 1);
          if (v.t === '') xml += '<c r="' + ref + '" s="' + v.st + '"/>';
          else if (v.num) xml += '<c r="' + ref + '" s="' + v.st + '"><v>' + v.t + '</v></c>';
          else xml += '<c r="' + ref + '" s="' + v.st + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v.t) + '</t></is></c>';
        });
        xml += '</row>';
      });
      xml += '</sheetData>' + (merges.length ? '<mergeCells count="' + merges.length + '">' + merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>' : '') + '</worksheet>';
      files.push({ name: 'xl/worksheets/sheet' + (si + 1) + '.xml', s: xml });
    });
    return zip(files.map(function (f) { return { name: f.name, data: utf8(f.s) }; }));
  }

  var API = { analyze: analyze, processPage: processPage, buildGrid: buildGrid, buildXlsx: buildXlsx, parseTsv: parseTsv, groupWords: groupWords, clean: clean, crop: crop };
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; return; }

  /* ================= 5. 화면 (브라우저 전용) ================= */
  var TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  var WORK = 2000, workers = null, cache = {}, ui = null, ctx = null, cancelled = false, running = false;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function loadScript(url) {
    return new Promise(function (res, rej) {
      if (root.Tesseract) return res();
      var s = document.createElement('script'); s.src = url; s.onload = function () { res(); }; s.onerror = function () { s.remove(); rej(new Error('인식 프로그램을 내려받지 못했어요. 인터넷 연결을 확인해 주세요.')); };
      document.head.appendChild(s);
    });
  }
  async function getWorkers(onLoad) {
    if (workers) return workers;
    await loadScript(TESS_URL);
    var T = root.Tesseract, opt = { logger: function (m) { if (m && m.status && /load|init/i.test(m.status)) onLoad(m.progress || 0); } };
    var kor = await T.createWorker('kor', 1, opt), eng;
    try { eng = await T.createWorker('eng', 1, opt); } catch (e) { try { await kor.terminate(); } catch (x) {} throw e; }
    workers = { kor: kor, eng: eng, psm: {} };
    return workers;
  }
  function grayCanvas(im) {
    var c = document.createElement('canvas'); c.width = im.w; c.height = im.h;
    var x = c.getContext('2d'), id = x.createImageData(im.w, im.h), d = id.data, i, p;
    for (i = 0, p = 0; i < im.data.length; i++, p += 4) { d[p] = d[p + 1] = d[p + 2] = im.data[i]; d[p + 3] = 255; }
    x.putImageData(id, 0, 0); return c;
  }
  async function recog(im, lang, psm, wantWords) {
    if (cancelled) throw new Error('__cancel');
    var w = workers[lang];
    if (workers.psm[lang] !== psm) { await w.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '0' }); workers.psm[lang] = psm; }
    var r = await w.recognize(grayCanvas(im), {}, { text: true, tsv: !!wantWords, blocks: false, hocr: false });
    var d = r.data || {};
    return { text: d.text || '', words: wantWords ? parseTsv(d.tsv) : null };
  }
  function bytesToGray(bytes) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })), im = new Image();
      im.onload = function () {
        var k = Math.min(2.5, WORK / Math.max(im.naturalWidth, im.naturalHeight)), W = Math.round(im.naturalWidth * k), H = Math.round(im.naturalHeight * k);
        var c = document.createElement('canvas'); c.width = W; c.height = H;
        var x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, W, H);
        var d = x.getImageData(0, 0, W, H).data, g = new Uint8Array(W * H);
        for (var i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
        URL.revokeObjectURL(url); res({ gray: g, W: W, H: H });
      };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('사진을 읽을 수 없습니다')); };
      im.src = url;
    });
  }

  var CSS = '#ox{position:fixed;inset:0;background:#f2f4f8;z-index:35;display:none;flex-direction:column}#ox.on{display:flex}' +
    '#ox .oxTop{display:flex;align-items:center;justify-content:space-between;background:#1d6f42;color:#fff;padding:calc(8px + env(safe-area-inset-top)) 10px 8px}' +
    '#ox .oxTop b{font-size:16px}#ox .oxTop button{border:0;background:transparent;color:#fff;font-size:16px;padding:8px 10px;min-width:74px}' +
    '#oxBody{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;padding:14px}' +
    '#ox .oxCard{background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.08);line-height:1.6;font-size:14.5px}' +
    '#ox .oxCard h3{margin:0 0 6px;font-size:17px}#ox .oxCard ul{margin:6px 0 0;padding-left:18px;color:#4b5563}' +
    '#ox .oxBar{height:10px;border-radius:99px;background:#e5e7eb;overflow:hidden;margin:14px 0 8px}#ox .oxBar i{display:block;height:100%;width:0;background:#1d6f42;transition:width .2s}' +
    '#ox .oxBot{background:#fff;padding:10px 14px calc(10px + env(safe-area-inset-bottom));border-top:1px solid #e5e7eb;display:flex;flex-direction:column;gap:8px}' +
    '#ox .oxGo{border:0;border-radius:14px;padding:15px;font-weight:700;font-size:17px;background:#1d6f42;color:#fff;width:100%}#ox .oxGo:disabled{opacity:.45}' +
    '#ox .oxSub{border:0;border-radius:10px;padding:10px;font-size:14px;background:#e8edf7;color:#0b5fff;width:100%}' +
    '#ox .oxPg{font-weight:700;margin:16px 2px 6px;font-size:14px}#ox .oxPg:first-child{margin-top:0}' +
    '#ox .oxWrap{overflow:auto;background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08)}' +
    '#ox table{border-collapse:collapse;font-size:13px;min-width:100%}#ox td{border:1px solid #d1d5db;padding:5px 6px;min-width:34px;white-space:pre;vertical-align:middle;outline:none}' +
    '#ox td.free{border-style:dashed;border-color:#e5e7eb}#ox td:focus{background:#fff7d6}#ox td.num{text-align:right}' +
    '#ox .oxHint{font-size:12.5px;color:#6b7280;margin:8px 2px 0}';
  function build() {
    if (ui) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var o = el('div'); o.id = 'ox';
    o.innerHTML = '<div class="oxTop"><button id="oxClose">‹ 닫기</button><b>📊 엑셀로 내보내기</b><button id="oxRedo" style="visibility:hidden">다시 읽기</button></div><div id="oxBody"></div><div class="oxBot" id="oxBot"></div>';
    document.body.appendChild(o);
    ui = { root: o, body: o.querySelector('#oxBody'), bot: o.querySelector('#oxBot'), redo: o.querySelector('#oxRedo') };
    o.querySelector('#oxClose').onclick = close;
    ui.redo.onclick = function () { if (running) return; ctx.pages.forEach(function (p) { delete cache[pkey(p)]; }); showIntro(); };
  }
  function pkey(p) { return p.id + ':' + p.out.length; }
  function close() { cancelled = true; ui.root.classList.remove('on'); }
  function showIntro() {
    ui.redo.style.visibility = 'hidden'; ui.body.innerHTML = ''; ui.bot.innerHTML = '';
    var c = el('div', 'oxCard');
    c.innerHTML = '<h3>문서의 글자를 읽어 엑셀 파일로 만듭니다</h3>스캔한 ' + ctx.pages.length + '장을 표 모양 그대로 옮깁니다. 쪽마다 시트가 하나씩 생깁니다.' +
      '<ul><li><b>인터넷이 연결되어 있어야</b> 합니다. 처음 한 번은 인식 데이터를 내려받습니다.</li>' +
      '<li>사진은 휴대폰 안에서만 처리되고 밖으로 보내지 않습니다.</li>' +
      '<li>한 장에 수십 초 걸릴 수 있습니다.</li>' +
      '<li><b>틀리게 읽는 글자가 있습니다.</b> 결과 화면에서 칸을 눌러 고친 뒤 저장하세요. 금액은 꼭 확인하세요.</li></ul>';
    ui.body.appendChild(c);
    var go = el('button', 'oxGo', '글자 인식 시작'); go.onclick = run; ui.bot.appendChild(go);
  }
  async function run() {
    if (running) return; running = true; cancelled = false;
    ui.body.innerHTML = ''; ui.bot.innerHTML = '';
    var c = el('div', 'oxCard'), msg = el('div', null, '준비 중...'), bar = el('div', 'oxBar'), fill = el('i'), sub = el('div', 'oxHint', '화면을 끄거나 다른 앱으로 가지 마세요.');
    bar.appendChild(fill); c.appendChild(msg); c.appendChild(bar); c.appendChild(sub); ui.body.appendChild(c);
    var stop = el('button', 'oxSub', '취소'); stop.onclick = function () { cancelled = true; msg.textContent = '취소하는 중...'; }; ui.bot.appendChild(stop);
    function set(p, t) { fill.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%'; if (t) msg.textContent = t; }
    try {
      set(0.02, '인식 프로그램 준비 중... (처음에는 시간이 걸려요)');
      await getWorkers(function (p) { set(0.02 + 0.08 * p); });
      var n = ctx.pages.length;
      for (var i = 0; i < n; i++) {
        var pg = ctx.pages[i], k = pkey(pg);
        if (!cache[k]) {
          set(0.1 + 0.9 * i / n, (i + 1) + ' / ' + n + '쪽: 표 모양 찾는 중');
          await new Promise(function (r) { setTimeout(r, 30); });
          var g = await bytesToGray(pg.out);
          cache[k] = await processPage(g.gray, g.W, g.H, recog, (function (i) { return function (p, t) { set(0.1 + 0.9 * (i + p) / n, (i + 1) + ' / ' + n + '쪽: ' + t); }; })(i));
        }
      }
      running = false; showResult();
    } catch (e) {
      running = false;
      if (cancelled || (e && e.message === '__cancel')) { if (ui.root.classList.contains('on')) showIntro(); return; }
      ui.body.innerHTML = ''; ui.bot.innerHTML = '';
      var er = el('div', 'oxCard'); er.innerHTML = '<h3>글자 인식에 실패했어요</h3>';
      er.appendChild(el('div', null, (e && e.message) || String(e)));
      er.appendChild(el('div', 'oxHint', '인터넷 연결을 확인하고 다시 시도해 주세요. 스캔·PDF 기능은 그대로 쓸 수 있습니다.'));
      ui.body.appendChild(er);
      var again = el('button', 'oxGo', '다시 시도'); again.onclick = run; ui.bot.appendChild(again);
    }
  }
  function renderGrid(g) {
    var tb = el('table'), occ = {}, map = {}, r, c;
    g.cells.forEach(function (cell) { map[cell.r + ',' + cell.c] = cell; });
    for (r = 0; r < g.rows; r++) {
      var tr = el('tr');
      for (c = 0; c < g.cols; c++) {
        if (occ[r + ',' + c]) continue;
        var cell = map[r + ',' + c], td = el('td');
        td.contentEditable = 'true'; td.dataset.r = r; td.dataset.c = c;
        if (cell) {
          td.textContent = cell.text; td.dataset.real = cell.real ? '1' : '';
          if (cell.rs > 1) td.rowSpan = cell.rs; if (cell.cs > 1) td.colSpan = cell.cs;
          td.dataset.rs = cell.rs; td.dataset.cs = cell.cs;
          for (var rr = r; rr < r + cell.rs; rr++) for (var cc = c; cc < c + cell.cs; cc++) occ[rr + ',' + cc] = 1;
          if (!cell.real) td.className = 'free';
          if (/^-?\d+$/.test(cell.text)) { td.className += ' num'; td.textContent = Number(cell.text).toLocaleString('en-US'); }
        } else td.className = 'free';
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    return tb;
  }
  function readGrid(tb, g) {       // 화면에서 고친 내용을 다시 읽는다
    var cells = [];
    Array.prototype.forEach.call(tb.querySelectorAll('td'), function (td) {
      var t = (td.innerText || td.textContent || '').replace(/ /g, ' ').replace(/\r/g, '').replace(/\n+$/, '').trim(), real = td.dataset.real === '1';
      if (/^-?\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
      if (!t && !real) return;
      cells.push({ r: +td.dataset.r, c: +td.dataset.c, rs: +(td.dataset.rs || 1), cs: +(td.dataset.cs || 1), text: t, real: real });
    });
    return { rows: g.rows, cols: g.cols, cells: cells, colW: g.colW };
  }
  function showResult() {
    ui.redo.style.visibility = 'visible'; ui.body.innerHTML = ''; ui.bot.innerHTML = '';
    var tables = [];
    ctx.pages.forEach(function (p, i) {
      var g = cache[pkey(p)]; if (!g) return;
      ui.body.appendChild(el('div', 'oxPg', (i + 1) + '쪽'));
      var w = el('div', 'oxWrap'), tb = renderGrid(g); w.appendChild(tb); ui.body.appendChild(w);
      tables.push({ tb: tb, g: g, name: (i + 1) + '쪽' });
    });
    ui.body.appendChild(el('div', 'oxHint', '틀린 칸은 눌러서 바로 고칠 수 있어요. 금액과 수량은 원본과 꼭 비교해 주세요.'));
    function make() {
      var parts = buildXlsx(tables.map(function (t) { return { name: t.name, grid: readGrid(t.tb, t.g) }; }));
      return new Blob(parts, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
    var send = el('button', 'oxGo', '📊 엑셀 파일 보내기'), save = el('button', 'oxSub', '엑셀 파일 저장');
    send.onclick = async function () {
      var name = ctx.fileBase() + '.xlsx', blob = make(), file = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); } catch (e) { if (!(e && e.name === 'AbortError')) { ctx.toast('공유에 실패해 파일을 저장합니다'); ctx.download(blob, name); } }
      } else { ctx.toast('이 브라우저는 공유를 지원하지 않아 파일을 저장합니다'); ctx.download(blob, name); }
    };
    save.onclick = function () { ctx.download(make(), ctx.fileBase() + '.xlsx'); };
    ui.bot.appendChild(send); ui.bot.appendChild(save);
  }
  /* index.html 에서 부르는 입구. c = { pages:[{id,out}], fileBase(), toast(msg), download(blob,name) } */
  API.open = function (c) {
    build(); ctx = c; cancelled = false; ui.root.classList.add('on');
    if (running) return;
    if (ctx.pages.every(function (p) { return cache[pkey(p)]; })) showResult(); else showIntro();
  };
  API._test = { cache: cache, pkey: pkey, showResult: function () { showResult(); } };
  root.DocOCR = API;
})(typeof window !== 'undefined' ? window : this);
