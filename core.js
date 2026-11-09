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

  /* 문서(밝은 종이) 모서리 자동 인식. 작게 줄인 이미지({data,width,height})를 받아
     [TL,TR,BR,BL] (입력 좌표 기준) 또는 null 을 돌려준다. */
  function detectQuad(img) {
    var w = img.width, h = img.height, d = img.data, n = w * h, i;
    var g = new Float32Array(n);
    for (i = 0; i < n; i++) g[i] = (d[4 * i] * 77 + d[4 * i + 1] * 150 + d[4 * i + 2] * 29) / 256;
    var b = boxBlur(g, w, h, 1);
    var thr = otsu(b);
    var mask = new Uint8Array(n), bright = 0;
    for (i = 0; i < n; i++) { if (b[i] > thr) { mask[i] = 1; bright++; } }
    if (bright / n > 0.93 || bright / n < 0.08) return null;

    var label = new Int32Array(n), stack = new Int32Array(n), best = 0, bestSize = 0, cur = 0, s, p;
    for (s = 0; s < n; s++) {
      if (!mask[s] || label[s]) continue;
      cur++; var size = 0, sp = 0;
      stack[sp++] = s; label[s] = cur;
      while (sp) {
        p = stack[--sp]; size++;
        var px = p % w, py = (p / w) | 0, q;
        if (px > 0 && mask[q = p - 1] && !label[q]) { label[q] = cur; stack[sp++] = q; }
        if (px < w - 1 && mask[q = p + 1] && !label[q]) { label[q] = cur; stack[sp++] = q; }
        if (py > 0 && mask[q = p - w] && !label[q]) { label[q] = cur; stack[sp++] = q; }
        if (py < h - 1 && mask[q = p + w] && !label[q]) { label[q] = cur; stack[sp++] = q; }
      }
      if (size > bestSize) { bestSize = size; best = cur; }
    }
    if (bestSize / n < 0.12) return null;

    var minS = 1e9, maxS = -1e9, minD = 1e9, maxD = -1e9, tl, br, tr, bl;
    for (p = 0; p < n; p++) {
      if (label[p] !== best) continue;
      var x = p % w, y = (p / w) | 0, sum = x + y, dif = x - y;
      if (sum < minS) { minS = sum; tl = [x, y]; }
      if (sum > maxS) { maxS = sum; br = [x, y]; }
      if (dif > maxD) { maxD = dif; tr = [x, y]; }
      if (dif < minD) { minD = dif; bl = [x, y]; }
    }
    var quad = [tl, tr, br, bl];
    // 면적 검사 (신발끈 공식)
    var area = 0;
    for (i = 0; i < 4; i++) { var a = quad[i], c = quad[(i + 1) % 4]; area += a[0] * c[1] - c[0] * a[1]; }
    area = Math.abs(area) / 2;
    if (area / n < 0.1) return null;
    return quad;
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
              detectQuad: detectQuad, applyFilter: applyFilter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScanCore = api;
})(typeof self !== 'undefined' ? self : this);
