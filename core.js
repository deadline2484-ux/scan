/* 문서 스캐너 - 이미지 처리 핵심 (원근 보정, 문서 자동 인식, 문서 필터) */
(function (root) {
  'use strict';

  /* 단위 정사각형 -> 사각형(q) 으로 가는 호모그래피. q = [TL, TR, BR, BL] */
  function homography(q) {
    var x0 = q[0][0], y0 = q[0][1], x1 = q[1][0], y1 = q[1][1];
    var x2 = q[2][0], y2 = q[2][1], x3 = q[3][0], y3 = q[3][1];
    var dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    var dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    var g = 0, h = 0;
    if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
      var den = dx1 * dy2 - dx2 * dy1;
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
    }
    return { a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0,
             d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0, g: g, h: h };
  }

  function dist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); }

  /* 결과 이미지 크기 (긴 변이 maxLong 을 넘지 않게) */
  function outputSize(q, maxLong) {
    var w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    var h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    var s = Math.min(1, maxLong / Math.max(w, h));
    return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
  }

  /* 원근 보정: src({data,width,height}) 의 사각형 q 를 ow x oh 의 반듯한 이미지로 펴 준다 */
  function warp(src, q, ow, oh) {
    var H = homography(q), sw = src.width, sh = src.height, sd = src.data;
    var out = new Uint8ClampedArray(ow * oh * 4);
    var o = 0, maxX = sw - 1, maxY = sh - 1;
    for (var j = 0; j < oh; j++) {
      var v = (j + 0.5) / oh;
      for (var i = 0; i < ow; i++) {
        var u = (i + 0.5) / ow;
        var w = H.g * u + H.h * v + 1;
        var x = (H.a * u + H.b * v + H.c) / w - 0.5;
        var y = (H.d * u + H.e * v + H.f) / w - 0.5;
        if (x < 0) x = 0; else if (x > maxX) x = maxX;
        if (y < 0) y = 0; else if (y > maxY) y = maxY;
        var x0 = x | 0, y0 = y | 0;
        var x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
        var fx = x - x0, fy = y - y0;
        var p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4;
        var p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o]     = sd[p00] * w00 + sd[p10] * w10 + sd[p01] * w01 + sd[p11] * w11;
        out[o + 1] = sd[p00 + 1] * w00 + sd[p10 + 1] * w10 + sd[p01 + 1] * w01 + sd[p11 + 1] * w11;
        out[o + 2] = sd[p00 + 2] * w00 + sd[p10 + 2] * w10 + sd[p01 + 2] * w01 + sd[p11 + 2] * w11;
        out[o + 3] = 255;
        o += 4;
      }
    }
    return { data: out, width: ow, height: oh };
  }

  function boxBlur(src, w, h, r) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, k, sum, cnt;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        sum = 0; cnt = 0;
        for (k = -r; k <= r; k++) { var xx = x + k; if (xx >= 0 && xx < w) { sum += src[y * w + xx]; cnt++; } }
        tmp[y * w + x] = sum / cnt;
      }
    }
    for (x = 0; x < w; x++) {
      for (y = 0; y < h; y++) {
        sum = 0; cnt = 0;
        for (k = -r; k <= r; k++) { var yy = y + k; if (yy >= 0 && yy < h) { sum += tmp[yy * w + x]; cnt++; } }
        out[y * w + x] = sum / cnt;
      }
    }
    return out;
  }

  function otsu(gray) {
    var hist = new Float64Array(256), i, total = gray.length;
    for (i = 0; i < total; i++) hist[Math.max(0, Math.min(255, gray[i] | 0))]++;
    var sumAll = 0; for (i = 0; i < 256; i++) sumAll += i * hist[i];
    var wB = 0, sumB = 0, best = -1, thr = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      var wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sumAll - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  /* ====================== 문서 모서리 자동 인식 ======================
     배경과 문서의 밝기 대비를 이용해 문서 영역을 찾는다.
       1) 여러 밝기 기준값으로 '문서 후보 영역'을 만든다 (어두운 배경 + 밝은 문서가 기본)
       2) 표 선·글씨 구멍 메우기, 가는 연결부 끊기, 가장 큰 덩어리 선택
       3) 덩어리의 볼록 껍질에서 가장 큰 사각형을 찾고, 가장자리 점들에 직선을 맞춰 모서리 보정
       4) '얼마나 사각형다운가'로 점수를 매겨 가장 좋은 후보를 고른다 */

  function morph(m, w, h, r, dilateMode) {
    var n = w * h, tmp = new Uint8Array(n), out = new Uint8Array(n);
    var pre = new Int32Array(Math.max(w, h) + 1), x, y, lo, hi, s;
    for (y = 0; y < h; y++) {
      pre[0] = 0; for (x = 0; x < w; x++) pre[x + 1] = pre[x] + m[y * w + x];
      for (x = 0; x < w; x++) {
        lo = x - r < 0 ? 0 : x - r; hi = x + r > w - 1 ? w - 1 : x + r; s = pre[hi + 1] - pre[lo];
        tmp[y * w + x] = dilateMode ? (s > 0 ? 1 : 0) : (s === hi - lo + 1 ? 1 : 0);
      }
    }
    for (x = 0; x < w; x++) {
      pre[0] = 0; for (y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
      for (y = 0; y < h; y++) {
        lo = y - r < 0 ? 0 : y - r; hi = y + r > h - 1 ? h - 1 : y + r; s = pre[hi + 1] - pre[lo];
        out[y * w + x] = dilateMode ? (s > 0 ? 1 : 0) : (s === hi - lo + 1 ? 1 : 0);
      }
    }
    return out;
  }
  function closeMask(m, w, h, r) { return morph(morph(m, w, h, r, true), w, h, r, false); }
  function openMask(m, w, h, r) { return morph(morph(m, w, h, r, false), w, h, r, true); }

  function fillHoles(m, w, h) {
    var n = w * h, bg = new Uint8Array(n), stack = new Int32Array(n), sp = 0, i, x, y;
    function seed(p) { if (!m[p] && !bg[p]) { bg[p] = 1; stack[sp++] = p; } }
    for (x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (sp) {
      var p = stack[--sp], px = p % w, py = (p / w) | 0, q;
      if (px > 0 && !m[q = p - 1] && !bg[q]) { bg[q] = 1; stack[sp++] = q; }
      if (px < w - 1 && !m[q = p + 1] && !bg[q]) { bg[q] = 1; stack[sp++] = q; }
      if (py > 0 && !m[q = p - w] && !bg[q]) { bg[q] = 1; stack[sp++] = q; }
      if (py < h - 1 && !m[q = p + w] && !bg[q]) { bg[q] = 1; stack[sp++] = q; }
    }
    var out = new Uint8Array(n); for (i = 0; i < n; i++) out[i] = bg[i] ? 0 : 1;
    return out;
  }

  function largestComponent(m, w, h) {
    var n = w * h, label = new Int32Array(n), stack = new Int32Array(n), best = 0, bestSize = 0, cur = 0, s;
    for (s = 0; s < n; s++) {
      if (!m[s] || label[s]) continue;
      cur++; var size = 0, sp = 0; stack[sp++] = s; label[s] = cur;
      while (sp) {
        var p = stack[--sp]; size++;
        var px = p % w, py = (p / w) | 0, q;
        if (px > 0 && m[q = p - 1] && !label[q]) { label[q] = cur; stack[sp++] = q; }
        if (px < w - 1 && m[q = p + 1] && !label[q]) { label[q] = cur; stack[sp++] = q; }
        if (py > 0 && m[q = p - w] && !label[q]) { label[q] = cur; stack[sp++] = q; }
        if (py < h - 1 && m[q = p + w] && !label[q]) { label[q] = cur; stack[sp++] = q; }
      }
      if (size > bestSize) { bestSize = size; best = cur; }
    }
    var out = new Uint8Array(n);
    for (s = 0; s < n; s++) if (label[s] === best) out[s] = 1;
    return { mask: out, size: bestSize };
  }

  function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
  function convexHull(pts) {
    pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    var tc = t < 0 ? 0 : t > 1 ? 1 : t;
    return { d: Math.hypot(p[0] - (a[0] + tc * dx), p[1] - (a[1] + tc * dy)), t: t };
  }
  function simplifyClosed(poly, eps) {
    var n = poly.length; if (n <= 4) return poly.slice();
    var far = 0, fd = -1, i;
    for (i = 1; i < n; i++) { var d = Math.hypot(poly[i][0] - poly[0][0], poly[i][1] - poly[0][1]); if (d > fd) { fd = d; far = i; } }
    var keep = new Uint8Array(n); keep[0] = 1; keep[far] = 1;
    function rec(i0, j0) {   // i0 .. j0 (인덱스는 순환)
      var a = poly[i0 % n], b = poly[j0 % n], bi = -1, bd = eps;
      for (var k = i0 + 1; k < j0; k++) { var sd = segDist(poly[k % n], a, b).d; if (sd > bd) { bd = sd; bi = k; } }
      if (bi >= 0) { keep[bi % n] = 1; rec(i0, bi); rec(bi, j0); }
    }
    rec(0, far); rec(far, n);
    var out = []; for (i = 0; i < n; i++) if (keep[i]) out.push(poly[i]);
    return out;
  }
  function polyArea(p) {
    var a = 0, i; for (i = 0; i < p.length; i++) { var q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
    return Math.abs(a) / 2;
  }
  function maxAreaQuad(hull) {
    var eps = 0.6, poly = simplifyClosed(hull, eps);
    while (poly.length > 36 && eps < 30) { eps *= 1.5; poly = simplifyClosed(hull, eps); }
    var k = poly.length; if (k < 4) return null; if (k === 4) return poly;
    var X = poly.map(function (p) { return p[0]; }), Y = poly.map(function (p) { return p[1]; });
    var best = -1, ba = 0, bb = 1, bc = 2, bd = 3, a, b, c, d;
    for (a = 0; a < k - 3; a++) for (b = a + 1; b < k - 2; b++) for (c = b + 1; c < k - 1; c++) {
      var t1 = (X[a] * Y[b] - X[b] * Y[a]) + (X[b] * Y[c] - X[c] * Y[b]);
      for (d = c + 1; d < k; d++) {
        var ar = Math.abs(t1 + (X[c] * Y[d] - X[d] * Y[c]) + (X[d] * Y[a] - X[a] * Y[d]));
        if (ar > best) { best = ar; ba = a; bb = b; bc = c; bd = d; }
      }
    }
    return [poly[ba], poly[bb], poly[bc], poly[bd]];
  }
  /* 껍질 다각형에서 '가장 긴 네 변'을 찾아 그 직선들의 교점으로 사각형을 만든다.
     (모서리가 물건에 가려졌거나 사진 밖으로 잘려도 변의 연장선으로 모서리를 복원) */
  function angDiff(a, b) { var d = Math.abs(a - b) % Math.PI; return d > Math.PI / 2 ? Math.PI - d : d; }
  function quadFromSides(hull, bpts, w, h) {
    var diag = Math.hypot(w, h), P = simplifyClosed(hull, Math.max(1, 0.004 * diag)), n = P.length, k;
    if (n < 4) return null;
    var E = [];
    for (k = 0; k < n; k++) { var a = P[k], b = P[(k + 1) % n]; E.push({ a: a, b: b, len: Math.hypot(b[0] - a[0], b[1] - a[1]), ang: Math.atan2(b[1] - a[1], b[0] - a[0]) }); }
    var lim = 12 * Math.PI / 180, start = -1;
    for (k = 0; k < n; k++) if (angDiff(E[k].ang, E[(k + n - 1) % n].ang) > lim) { start = k; break; }
    if (start < 0) return null;
    var sides = [], cur = null, per = 0;
    for (var i = 0; i < n; i++) {
      var ed = E[(start + i) % n]; per += ed.len;
      if (cur && angDiff(ed.ang, cur.ang) <= lim) { cur.b = ed.b; cur.len += ed.len; }
      else { cur = { a: ed.a, b: ed.b, len: ed.len, ang: ed.ang }; sides.push(cur); }
    }
    if (sides.length < 4) return null;
    var idx = sides.map(function (s, j) { return j; }).sort(function (x, y) { return sides[y].len - sides[x].len; }).slice(0, 4).sort(function (x, y) { return x - y; });
    var chosen = idx.map(function (j) { return sides[j]; }), cov = 0;
    chosen.forEach(function (s) { cov += s.len; });
    if (cov / per < 0.6) return null;
    var tol = Math.max(2, 0.012 * diag), lines = chosen.map(function (s) {
      var pts = [];
      for (var q = 0; q < bpts.length; q++) { var r = segDist(bpts[q], s.a, s.b); if (r.d <= tol && r.t > -0.02 && r.t < 1.02) pts.push(bpts[q]); }
      return pts.length >= 8 ? robustFit(pts) : lineThrough(s.a, s.b);
    });
    var out = [];
    for (k = 0; k < 4; k++) {
      var c = intersect(lines[(k + 3) % 4], lines[k]);
      if (!c || c[0] < -0.3 * w || c[0] > 1.3 * w || c[1] < -0.3 * h || c[1] > 1.3 * h) return null;
      out.push(c);
    }
    return orderQuad(out);
  }
  function makeRng(seed) { var s = seed >>> 0 || 1; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  /* 경계점들에서 '한 직선 위에 많이 놓인 점들'을 차례로 찾아 직선 목록을 만든다 (RANSAC) */
  function ransacLines(pts, tol, minLen, maxLines) {
    var rem = pts.slice(), lines = [], R = makeRng(20261109), total = pts.length, it, t, k;
    for (it = 0; it < maxLines && rem.length >= 15; it++) {
      var m = rem.length, bestCnt = 0, bestL = null, trials = Math.min(260, m * 3);
      for (t = 0; t < trials; t++) {
        var p = rem[(R() * m) | 0], q = rem[(R() * m) | 0], dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
        if (l < minLen) continue;
        var L = { x: p[0], y: p[1], dx: dx / l, dy: dy / l }, c = 0;
        for (k = 0; k < m; k++) if (Math.abs((rem[k][0] - L.x) * -L.dy + (rem[k][1] - L.y) * L.dx) <= tol) c++;
        if (c > bestCnt) { bestCnt = c; bestL = L; }
      }
      if (!bestL || bestCnt < Math.max(12, 0.04 * total)) break;
      var inl = [], keep = [];
      for (k = 0; k < m; k++) (lineResidual(bestL, rem[k]) <= tol ? inl : keep).push(rem[k]);
      var Lr = fitLine(inl); inl = []; keep = [];
      for (k = 0; k < m; k++) (lineResidual(Lr, rem[k]) <= tol * 1.6 ? inl : keep).push(rem[k]);
      lines.push({ L: inl.length >= 6 ? fitLine(inl) : Lr, n: inl.length });
      rem = keep;
    }
    return lines;
  }
  function lineAng(L) { return Math.atan2(L.dy, L.dx); }
  /* 직선 4개 조합으로 만들 수 있는 사각형들 (마주 보는 변끼리 짝을 지어 교점 계산) */
  function quadsFromLines(lines, w, h) {
    var n = lines.length, out = [], a, b, c, d;
    var pairings = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2]];
    for (a = 0; a < n - 3; a++) for (b = a + 1; b < n - 2; b++) for (c = b + 1; c < n - 1; c++) for (d = c + 1; d < n; d++) {
      var S = [lines[a], lines[b], lines[c], lines[d]], nb = 0;
      S.forEach(function (s) { if (s.border) nb++; });
      if (nb > 2) continue;
      var bestP = null, bestV = 1e9;
      pairings.forEach(function (pp) {
        var v = angDiff(lineAng(S[pp[0]].L), lineAng(S[pp[1]].L)) + angDiff(lineAng(S[pp[2]].L), lineAng(S[pp[3]].L));
        if (v < bestV) { bestV = v; bestP = pp; }
      });
      var A1 = S[bestP[0]].L, A2 = S[bestP[1]].L, B1 = S[bestP[2]].L, B2 = S[bestP[3]].L;
      if (angDiff(lineAng(A1), lineAng(B1)) < 40 * Math.PI / 180 || angDiff(lineAng(A2), lineAng(B2)) < 40 * Math.PI / 180) continue;
      var cs = [intersect(A1, B1), intersect(B1, A2), intersect(A2, B2), intersect(B2, A1)], ok = true;
      cs.forEach(function (p) { if (!p || p[0] < -0.3 * w || p[0] > 1.3 * w || p[1] < -0.3 * h || p[1] > 1.3 * h) ok = false; });
      if (!ok) continue;
      var q = orderQuad(cs);
      if (quadIsSane(q)) out.push(q);
    }
    return out;
  }
  /* 다각형을 이미지 사각형 안으로 자르기 (사진 밖으로 나간 부분 제외한 면적 계산용) */
  function clipToRect(poly, w, h) {
    function clip(pts, inside, inter) {
      var out = [];
      for (var i = 0; i < pts.length; i++) {
        var cu = pts[i], pr = pts[(i + pts.length - 1) % pts.length], ci = inside(cu), pi = inside(pr);
        if (ci) { if (!pi) out.push(inter(pr, cu)); out.push(cu); } else if (pi) out.push(inter(pr, cu));
      }
      return out;
    }
    function ix(xv) { return function (a, b) { var t = (xv - a[0]) / (b[0] - a[0]); return [xv, a[1] + t * (b[1] - a[1])]; }; }
    function iy(yv) { return function (a, b) { var t = (yv - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), yv]; }; }
    var p = poly;
    p = clip(p, function (q) { return q[0] >= 0; }, ix(0)); if (!p.length) return p;
    p = clip(p, function (q) { return q[0] <= w; }, ix(w)); if (!p.length) return p;
    p = clip(p, function (q) { return q[1] >= 0; }, iy(0)); if (!p.length) return p;
    return clip(p, function (q) { return q[1] <= h; }, iy(h));
  }
  /* 4점을 [TL,TR,BR,BL] 순서(시계 방향)로 정렬 */
  function orderQuad(q) {
    var cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    var s = q.slice().sort(function (a, b) { return Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx); });
    var tl = 0, i;
    for (i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[tl][0] + s[tl][1]) tl = i;
    return [s[tl], s[(tl + 1) % 4], s[(tl + 2) % 4], s[(tl + 3) % 4]];
  }
  /* 점들에 직선(총최소제곱) 맞추기 → {x,y,dx,dy} */
  function fitLine(pts) {
    var n = pts.length, mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += pts[i][0]; my += pts[i][1]; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < n; i++) { var dx = pts[i][0] - mx, dy = pts[i][1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    var th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { x: mx, y: my, dx: Math.cos(th), dy: Math.sin(th) };
  }
  function lineResidual(L, p) { return Math.abs((p[0] - L.x) * -L.dy + (p[1] - L.y) * L.dx); }
  function robustFit(pts) {
    var cur = pts, L = fitLine(cur), it, i;
    for (it = 0; it < 3 && cur.length >= 6; it++) {
      var res = cur.map(function (p) { return lineResidual(L, p); }), sorted = res.slice().sort(function (a, b) { return a - b; });
      var med = sorted[(sorted.length / 2) | 0], lim = Math.max(0.8, 2.5 * med), nxt = [];
      for (i = 0; i < cur.length; i++) if (res[i] <= lim) nxt.push(cur[i]);
      if (nxt.length < 6 || nxt.length === cur.length) break;
      cur = nxt; L = fitLine(cur);
    }
    return L;
  }
  function intersect(L1, L2) {
    var det = L1.dx * L2.dy - L1.dy * L2.dx; if (Math.abs(det) < 1e-6) return null;
    var t = ((L2.x - L1.x) * L2.dy - (L2.y - L1.y) * L2.dx) / det;
    return [L1.x + t * L1.dx, L1.y + t * L1.dy];
  }
  function lineThrough(a, b) { var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return { x: a[0], y: a[1], dx: dx / l, dy: dy / l }; }

  /* 가장자리 점들로 네 변의 직선을 다시 맞춰 모서리를 보정 */
  function refineByBoundary(quad, bpts, diag) {
    var tol = Math.max(3, 0.03 * diag), sides = [[], [], [], []], i, j;
    for (i = 0; i < bpts.length; i++) {
      var p = bpts[i], bi = -1, bd = 1e9, bt = 0;
      for (j = 0; j < 4; j++) { var r = segDist(p, quad[j], quad[(j + 1) % 4]); if (r.d < bd) { bd = r.d; bi = j; bt = r.t; } }
      if (bd <= tol && bt > 0.08 && bt < 0.92) sides[bi].push(p);
    }
    var lines = [];
    for (j = 0; j < 4; j++) lines.push(sides[j].length >= 8 ? robustFit(sides[j]) : lineThrough(quad[j], quad[(j + 1) % 4]));
    var out = [];
    for (j = 0; j < 4; j++) {
      var c = intersect(lines[(j + 3) % 4], lines[j]);   // 변 j-1 과 변 j 의 교점 = 모서리 j
      out.push(c && Math.hypot(c[0] - quad[j][0], c[1] - quad[j][1]) < 0.08 * diag ? c : quad[j]);
    }
    return out;
  }

  function quadIsSane(q) {
    for (var i = 0; i < 4; i++) {
      var a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
      var v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
      var cs = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1);
      var ang = Math.acos(Math.max(-1, Math.min(1, cs))) * 180 / Math.PI;
      if (ang < 50 || ang > 130) return false;
      if (cross(a, b, c) <= 0) return false;      // 볼록 + 시계 방향
    }
    return true;
  }

  /* 문서 후보 마스크 → 사각형 + 점수 */
  function candidateFromMask(mask, w, h, b) {
    var n = w * h, cnt = 0, i;
    for (i = 0; i < n; i++) cnt += mask[i];
    if (cnt / n < 0.06 || cnt / n > 0.985) return null;
    var r1 = Math.max(2, Math.round(Math.max(w, h) * 0.008));
    var m = closeMask(mask, w, h, r1);          // 표 선·글씨 때문에 끊긴 부분 잇기
    m = fillHoles(m, w, h);                     // 안쪽 구멍 메우기
    m = openMask(m, w, h, Math.max(1, r1 - 1)); // 가는 연결부 끊기
    var comp = largestComponent(m, w, h);
    if (comp.size / n < 0.08) return null;
    var cm = comp.mask, hullPts = [], bpts = [], x, y, sin = 0, sout = 0;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var p = y * w + x;
      if (!cm[p]) { sout += b[p]; continue; }
      sin += b[p];
      var onImg = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      var edge = (x > 0 && !cm[p - 1]) || (x < w - 1 && !cm[p + 1]) || (y > 0 && !cm[p - w]) || (y < h - 1 && !cm[p + w]);
      if (edge) { hullPts.push([x + 0.5, y + 0.5]); if (!onImg) bpts.push([x + 0.5, y + 0.5]); }
      else if (onImg) hullPts.push([x + 0.5, y + 0.5]);
    }
    if (hullPts.length < 8 || bpts.length < 20) return null;
    var bright = sin / comp.size > sout / Math.max(1, n - comp.size);
    var hull = convexHull(hullPts), diag = Math.hypot(w, h), tolS = Math.max(1.5, 0.007 * diag);
    var quads = [], q4 = maxAreaQuad(hull);
    if (q4) { q4 = orderQuad(q4); var rq = refineByBoundary(q4, bpts, diag); quads.push(quadIsSane(rq) ? rq : q4); }
    var sp = bpts; if (sp.length > 700) { var st = sp.length / 700; sp = []; for (var z = 0; z < 700; z++) sp.push(bpts[Math.floor(z * st)]); }
    var lines = ransacLines(sp, Math.max(1.2, 0.0045 * diag), 0.04 * diag, 6);
    var touch = [0, 0, 0, 0];                    // 덩어리가 사진 가장자리(위/오른쪽/아래/왼쪽)에 닿은 길이
    for (x = 0; x < w; x++) { if (cm[x]) touch[0]++; if (cm[(h - 1) * w + x]) touch[2]++; }
    for (y = 0; y < h; y++) { if (cm[y * w + w - 1]) touch[1]++; if (cm[y * w]) touch[3]++; }
    if (touch[0] > 0.05 * w) lines.push({ L: { x: 0, y: 0, dx: 1, dy: 0 }, n: 0, border: true });
    if (touch[1] > 0.05 * h) lines.push({ L: { x: w, y: 0, dx: 0, dy: 1 }, n: 0, border: true });
    if (touch[2] > 0.05 * w) lines.push({ L: { x: 0, y: h, dx: 1, dy: 0 }, n: 0, border: true });
    if (touch[3] > 0.05 * h) lines.push({ L: { x: 0, y: 0, dx: 0, dy: 1 }, n: 0, border: true });
    quads = quads.concat(quadsFromLines(lines, w, h));
    bpts = sp;
    var best = null;
    quads.forEach(function (quad) {
      if (!quadIsSane(quad)) return;
      var aq = polyArea(clipToRect(quad, w, h)), frac = aq / n;
      if (frac < 0.08 || frac > 0.995) return;
      var ratio = Math.min(comp.size, aq) / Math.max(comp.size, aq), on = 0;
      for (var k = 0; k < bpts.length; k++) {
        var md = 1e9; for (var j = 0; j < 4; j++) { var dd = segDist(bpts[k], quad[j], quad[(j + 1) % 4]).d; if (dd < md) md = dd; }
        if (md <= tolS) on++;
      }
      var support = on / bpts.length;          // 경계선이 사각형 변에 얼마나 붙어 있나
      var score = ratio * Math.sqrt(support) * (0.92 + 0.08 * Math.min(1, frac / 0.3));
      if (!best || score > best.score) best = { quad: quad, score: score, ratio: ratio, support: support, frac: frac, bright: bright };
    });
    return best;
  }

  function pointInQuad(q, p, tol) {   // 사각형 안(가장자리에서 tol 바깥까지 허용)인가
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
      if ((ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / l < -tol) return false;
    }
    return true;
  }
  /* img({data,width,height} RGBA) → { quad:[TL,TR,BR,BL], score:0~1, bright:boolean } 또는 null */
  function detectQuadInfo(img) {
    var w = img.width, h = img.height, d = img.data, n = w * h, i, x, y;
    var g = new Float32Array(n);
    for (i = 0; i < n; i++) g[i] = (d[4 * i] * 77 + d[4 * i + 1] * 150 + d[4 * i + 2] * 29) / 256;
    var b = boxBlur(g, w, h, 1);
    var hist = new Float64Array(256);
    for (i = 0; i < n; i++) hist[Math.max(0, Math.min(255, b[i] | 0))]++;
    function pct(p) { var c = 0, t = p * n; for (var k = 0; k < 256; k++) { c += hist[k]; if (c >= t) return k; } return 255; }
    var t0 = otsu(b), p10 = pct(0.10), p90 = pct(0.90), rg = p90 - p10;
    var ths = [t0, t0 * 0.8, t0 * 1.2, p10 + 0.2 * rg, p10 + 0.35 * rg, p10 + 0.5 * rg, p10 + 0.65 * rg];
    var best = null, seen = {}, k, all = [];
    function consider(c, pen) { if (!c) return; c.score *= pen; all.push(c); if (!best || c.score > best.score) best = c; }
    // ① 밝기 기준: 어두운 배경 위 밝은 문서
    for (k = 0; k < ths.length; k++) {
      var t = Math.round(ths[k]); if (t < 6 || t > 250 || seen[t]) continue; seen[t] = 1;
      var m = new Uint8Array(n); for (i = 0; i < n; i++) m[i] = b[i] > t ? 1 : 0;
      consider(candidateFromMask(m, w, h, b), 1);
    }
    // ② 경계선 기준: 선명한 경계로 둘러싸인 영역 (그림자는 경계가 흐려 통과됨)
    var G = new Float32Array(n);
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) { var p = y * w + x; G[p] = Math.abs(b[p + 1] - b[p - 1]) + Math.abs(b[p + w] - b[p - w]); }
    var samp = []; for (i = 0; i < n; i += 5) samp.push(G[i]); samp.sort(function (u, v) { return u - v; });
    [0.80, 0.88, 0.94].forEach(function (pq) {
      var tE = Math.max(6, samp[(samp.length * pq) | 0]), bar = new Uint8Array(n);
      for (i = 0; i < n; i++) bar[i] = G[i] > tE ? 1 : 0;
      bar = morph(bar, w, h, 1, true);
      var m2 = morph(fillHoles(bar, w, h), w, h, 2, false);   // 테두리에서 경계선을 넘지 않고 닿는 곳 = 배경 (경계 띠 두께만큼 깎기)
      consider(candidateFromMask(m2, w, h, b), 0.97);
    });
    // ③ 보조: 밝은 배경 위 어두운 문서
    if (!best || best.score < 0.75) {
      for (k = 0; k < 3; k++) {
        var t2 = Math.round([t0, p10 + 0.35 * rg, p10 + 0.65 * rg][k]);
        var m3 = new Uint8Array(n); for (i = 0; i < n; i++) m3[i] = b[i] < t2 ? 1 : 0;
        consider(candidateFromMask(m3, w, h, b), 0.85);
      }
    }
    if (!best || best.score < 0.5) return null;
    // 점수가 거의 같으면, 최고 후보를 안에 품는 더 큰 사각형(= 조명/그림자로 잘리지 않은 문서 전체)을 고른다
    var top = best, aTop = polyArea(clipToRect(best.quad, w, h));
    all.forEach(function (c) {
      if (c === best || c.score < best.score - 0.05) return;
      var a = polyArea(clipToRect(c.quad, w, h)); if (a < aTop * 1.15) return;
      var inside = best.quad.every(function (p) { return pointInQuad(c.quad, p, 0.01 * Math.hypot(w, h)); });
      if (inside && (top === best || a > polyArea(clipToRect(top.quad, w, h)))) top = c;
    });
    return { quad: top.quad, score: top.score, bright: top.bright };
  }
  function detectQuad(img) { var r = detectQuadInfo(img); return r ? r.quad : null; }

  /* 더 큰 이미지에서 네 변의 실제 경계(밝기가 급변하는 곳)를 찾아 모서리를 정밀하게 다듬는다.
     img: 큰 이미지(RGBA), quad: 그 이미지 좌표의 대략적인 모서리, bright: 문서가 배경보다 밝은가 */
  function refineQuad(img, quad, bright) {
    var w = img.width, h = img.height, d = img.data, i, j;
    var gray = new Float32Array(w * h);
    for (i = 0; i < w * h; i++) gray[i] = (d[4 * i] * 77 + d[4 * i + 1] * 150 + d[4 * i + 2] * 29) / 256;
    function L(x, y) {
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
      var x0 = x | 0, y0 = y | 0, x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1), fx = x - x0, fy = y - y0;
      return (gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx) * (1 - fy) + (gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx) * fy;
    }
    var diag = Math.hypot(w, h), win = Math.max(8, Math.round(0.02 * diag)), step = 0.5;
    var cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4, cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
    var lines = [];
    for (j = 0; j < 4; j++) {
      var a = quad[j], bq = quad[(j + 1) % 4], ex = bq[0] - a[0], ey = bq[1] - a[1], el = Math.hypot(ex, ey) || 1;
      var tx = ex / el, ty = ey / el, nx = ty, ny = -tx;
      if ((a[0] + bq[0]) / 2 - cx) { /* 법선이 바깥쪽을 향하게 */ }
      if (nx * ((a[0] + bq[0]) / 2 - cx) + ny * ((a[1] + bq[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
      var pts = [], S = 28, s;
      for (s = 0; s < S; s++) {
        var u = 0.1 + 0.8 * (s + 0.5) / S, px = a[0] + ex * u, py = a[1] + ey * u;
        var K = Math.round(2 * win / step) + 1, prof = new Float32Array(K), ok = true, k2;
        for (k2 = 0; k2 < K; k2++) {
          var t = -win + k2 * step, sum = 0, cn = 0;
          for (var o = -3; o <= 3; o += 1.5) {
            var v = L(px + nx * t + tx * o, py + ny * t + ty * o);
            if (v === v) { sum += v; cn++; }
          }
          if (cn < 3) { ok = false; break; }
          prof[k2] = sum / cn;
        }
        if (!ok) continue;
        var gr = new Float32Array(K), gmax = 0;
        for (k2 = 1; k2 < K - 1; k2++) { gr[k2] = (prof[k2 + 1] - prof[k2 - 1]) * (bright ? -1 : 1); if (gr[k2] > gmax) gmax = gr[k2]; }
        if (gmax < 12) continue;
        var pick = -1;                            // 강한 경계 중 가장 바깥쪽 (문서 안쪽의 테두리선/표 선을 피함)
        for (k2 = K - 2; k2 >= 1; k2--) {
          if (gr[k2] >= 0.5 * gmax && gr[k2] >= gr[k2 - 1] && gr[k2] >= gr[k2 + 1]) { pick = k2; break; }
        }
        if (pick < 0) continue;
        var g0 = gr[pick - 1], g1 = gr[pick], g2 = gr[pick + 1], den = g0 - 2 * g1 + g2;
        var off = den !== 0 ? 0.5 * (g0 - g2) / den : 0;
        var tt = -win + (pick + off) * step;
        pts.push([px + nx * tt, py + ny * tt]);
      }
      lines.push(pts.length >= 8 ? robustFit(pts) : lineThrough(a, bq));
    }
    var out = [];
    for (j = 0; j < 4; j++) {
      var c = intersect(lines[(j + 3) % 4], lines[j]);
      out.push(c && Math.hypot(c[0] - quad[j][0], c[1] - quad[j][1]) < 0.05 * diag ? c : quad[j]);
    }
    return quadIsSane(out) ? out : quad;
  }

  /* 문서 필터. mode: 'doc'(그림자 제거 + 선명) | 'bw'(흑백) | 'color'(원본). img.data 를 직접 수정 */
  function applyFilter(img, mode) {
    if (mode === 'color') return img;
    var w = img.width, h = img.height, d = img.data, x, y, i;
    var B = Math.max(8, Math.round(Math.max(w, h) / 80));
    var bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    var bg = new Float32Array(bw * bh);
    for (y = 0; y < h; y++) {
      var by = (y / B) | 0;
      for (x = 0; x < w; x++) {
        var k = (y * w + x) * 4;
        var lum = (d[k] * 77 + d[k + 1] * 150 + d[k + 2] * 29) / 256;
        var bi = by * bw + ((x / B) | 0);
        if (lum > bg[bi]) bg[bi] = lum;
      }
    }
    bg = boxBlur(boxBlur(bg, bw, bh, 1), bw, bh, 1);
    var lo = mode === 'bw' ? 105 : 55, hi = mode === 'bw' ? 215 : 232, span = hi - lo;
    for (y = 0; y < h; y++) {
      var fy = y / B - 0.5; if (fy < 0) fy = 0; if (fy > bh - 1) fy = bh - 1;
      var y0 = fy | 0, y1 = Math.min(y0 + 1, bh - 1), ty = fy - y0;
      for (x = 0; x < w; x++) {
        var fx = x / B - 0.5; if (fx < 0) fx = 0; if (fx > bw - 1) fx = bw - 1;
        var x0 = fx | 0, x1 = Math.min(x0 + 1, bw - 1), tx = fx - x0;
        var bgv = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) +
                  (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
        if (bgv < 40) bgv = 40;
        var sc = 255 / bgv;
        i = (y * w + x) * 4;
        var r = d[i] * sc, gg = d[i + 1] * sc, bb = d[i + 2] * sc;
        if (r > 255) r = 255; if (gg > 255) gg = 255; if (bb > 255) bb = 255;
        if (mode === 'bw') {
          var gr = (r * 77 + gg * 150 + bb * 29) / 256;
          gr = (gr - lo) * 255 / span;
          gr = gr < 0 ? 0 : gr > 255 ? 255 : gr;
          d[i] = d[i + 1] = d[i + 2] = gr;
        } else {
          r = (r - lo) * 255 / span; gg = (gg - lo) * 255 / span; bb = (bb - lo) * 255 / span;
          d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
          d[i + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg;
          d[i + 2] = bb < 0 ? 0 : bb > 255 ? 255 : bb;
        }
      }
    }
    return img;
  }

  var api = { homography: homography, outputSize: outputSize, warp: warp,
              detectQuad: detectQuad, detectQuadInfo: detectQuadInfo, refineQuad: refineQuad, applyFilter: applyFilter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScanCore = api;
})(typeof self !== 'undefined' ? self : this);
