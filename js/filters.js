/* Filters: document enhancement (illumination normalisation, colour boost, adaptive black & white).
   Pure ImageData-like cores run in Node; Filters.apply is the browser canvas helper. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Filters = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIST = [
    { id: 'original', label: 'Original', sub: 'sem filtro' },
    { id: 'auto', label: 'Auto Jutsu', sub: 'limpa e realça' },
    { id: 'magic', label: 'Chakra Cor', sub: 'cores vivas' },
    { id: 'gray', label: 'Sombra', sub: 'tons de cinza' },
    { id: 'bw', label: 'Nanquim', sub: 'preto e branco' }
  ];

  /* gamma: mid-tone darkening after levels; wpScale/bpScale: white/black points relative to the measured
     paper level and ink level; sat: extra saturation on coloured pixels; sharpen: unsharp amount. */
  var PRESETS = {
    auto: { gray: false, gamma: 1.2, wpScale: 0.93, bpScale: 0.7, sat: 0.12, sharpen: 0.5 },
    magic: { gray: false, gamma: 1.45, wpScale: 0.88, bpScale: 1.0, sat: 0.6, sharpen: 0.7 },
    gray: { gray: true, gamma: 1.3, wpScale: 0.91, bpScale: 0.85, sat: 0, sharpen: 0.6 },
    bw: { gray: true, gamma: 1.0, wpScale: 0.93, bpScale: 0.8, sat: 0, sharpen: 0,
      keep: 0.78, dark: 140, light: 232, mid: 200, flat: 40, window: 1 / 14, speck: 1.5e-6, smooth: false }
  };

  var BG_TARGET = 480;     // long side of the low-resolution background map
  var LUT_N = 1024;        // tone LUT resolution over ratio 0..1

  function makeImage(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }

  function copyImage(img) {
    var out = makeImage(img.width, img.height), n = img.width * img.height * 4, s = img.data, d = out.data;
    if (s.length === n) d.set(s);
    else for (var i = 0; i < n; i++) d[i] = s[i];
    return out;
  }

  /* ---------- low-resolution float plane helpers ---------- */

  /* Integer box reduction into three float planes (partial edge blocks averaged over their real size). */
  function reducePlanes(img, k) {
    var W = img.width, H = img.height, src = img.data;
    var bw = Math.ceil(W / k), bh = Math.ceil(H / k), n = bw * bh;
    var R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    var xb = new Int32Array(W), x, y;
    for (x = 0; x < W; x++) xb[x] = (x / k) | 0;
    for (y = 0; y < H; y++) {
      var row = ((y / k) | 0) * bw, si = y * W * 4;
      for (x = 0; x < W; x++, si += 4) {
        var o = row + xb[x];
        R[o] += src[si]; G[o] += src[si + 1]; B[o] += src[si + 2];
      }
    }
    for (var by = 0; by < bh; by++) {
      var rows = Math.min(H, (by + 1) * k) - by * k;
      for (var bx = 0; bx < bw; bx++) {
        var inv = 1 / (rows * (Math.min(W, (bx + 1) * k) - bx * k)), j = by * bw + bx;
        R[j] *= inv; G[j] *= inv; B[j] *= inv;
      }
    }
    return { w: bw, h: bh, R: R, G: G, B: B };
  }

  /* Separable square max (sign = 1) or min (sign = -1) filter with windows clamped to the plane,
     van Herk / Gil-Werman: O(1) per pixel whatever the radius. */
  function rankFilter(src, w, h, r, sign) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    var m = Math.max(w, h) + 2 * r, pad = new Float32Array(m), g = new Float32Array(m), hh = new Float32Array(m);
    function line(a, b, off, stride, n) {
      var len = n + 2 * r, wnd = 2 * r + 1, i, v;
      for (i = 0; i < len; i++) pad[i] = -Infinity;
      for (i = 0; i < n; i++) pad[i + r] = a[off + i * stride] * sign;
      for (i = 0; i < len; i++) g[i] = (i % wnd === 0) ? pad[i] : (pad[i] > g[i - 1] ? pad[i] : g[i - 1]);
      hh[len - 1] = pad[len - 1];
      for (i = len - 2; i >= 0; i--) hh[i] = ((i + 1) % wnd === 0) ? pad[i] : (pad[i] > hh[i + 1] ? pad[i] : hh[i + 1]);
      for (i = 0; i < n; i++) {
        v = hh[i] > g[i + 2 * r] ? hh[i] : g[i + 2 * r];
        b[off + i * stride] = v * sign;
      }
    }
    var y, x;
    for (y = 0; y < h; y++) line(src, tmp, y * w, 1, w);
    for (x = 0; x < w; x++) line(tmp, out, x, w, h);
    return out;
  }

  /* Separable box blur with clamped windows (average over the valid part). */
  function boxBlur(src, w, h, r) {
    if (r < 1) return Float32Array.from(src);
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, s, a, b;
    for (y = 0; y < h; y++) {
      var row = y * w;
      s = 0;
      for (x = 0; x <= Math.min(r, w - 1); x++) s += src[row + x];
      for (x = 0; x < w; x++) {
        a = x - r - 1; b = x + r;
        if (x > 0) {
          if (b < w) s += src[row + b];
          if (a >= 0) s -= src[row + a];
        }
        tmp[row + x] = s / (Math.min(w - 1, b) - Math.max(0, a + 1) + 1);
      }
    }
    for (x = 0; x < w; x++) {
      s = 0;
      for (y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
      for (y = 0; y < h; y++) {
        a = y - r - 1; b = y + r;
        if (y > 0) {
          if (b < h) s += tmp[b * w + x];
          if (a >= 0) s -= tmp[a * w + x];
        }
        out[y * w + x] = s / (Math.min(h - 1, b) - Math.max(0, a + 1) + 1);
      }
    }
    return out;
  }

  /* Fills masked pixels ring by ring from the average of their already-known 8-neighbours. */
  function fillHoles(chs, mask, w, h) {
    var n = w * h, list = new Int32Array(n), m = 0, i, j;
    for (i = 0; i < n; i++) if (mask[i]) list[m++] = i;
    var vals = new Float32Array(m * 3), ready = new Int32Array(m);
    var c0 = chs[0], c1 = chs[1], c2 = chs[2];
    while (m > 0) {
      var cnt = 0, keep = 0;
      for (j = 0; j < m; j++) {
        var p = list[j], x = p % w, y = (p - x) / w, s0 = 0, s1 = 0, s2 = 0, c = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
            var q = yy * w + xx;
            if (!mask[q]) { s0 += c0[q]; s1 += c1[q]; s2 += c2[q]; c++; }
          }
        }
        if (c) { vals[cnt * 3] = s0 / c; vals[cnt * 3 + 1] = s1 / c; vals[cnt * 3 + 2] = s2 / c; ready[cnt++] = p; }
        else list[keep++] = p;
      }
      if (!cnt) break;
      for (j = 0; j < cnt; j++) {
        var pp = ready[j];
        c0[pp] = vals[j * 3]; c1[pp] = vals[j * 3 + 1]; c2[pp] = vals[j * 3 + 2];
        mask[pp] = 0;
      }
      m = keep;
    }
  }

  function percentile(arr, p) {
    var s = Float32Array.from(arr).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  }

  /* ---------- background (paper illumination) model ---------- */

  /* Low-resolution per-channel estimate of the paper colour under the scene lighting:
     morphological closing removes ink smaller than ~4.5% of the page, large coloured or very dark objects
     (logos, photos) are masked and in-painted from the surrounding paper, then the map is lightly smoothed.
     Returns inverse planes scaled so that value * inv indexes the tone LUT. */
  function backgroundModel(img) {
    var W = img.width, H = img.height;
    var k = Math.max(1, Math.round(Math.max(W, H) / BG_TARGET));
    var p = reducePlanes(img, k), w = p.w, h = p.h, n = w * h, i;
    var r = Math.max(1, Math.round(Math.max(w, h) * 0.022));
    var ch = [p.R, p.G, p.B];
    for (i = 0; i < 3; i++) ch[i] = rankFilter(rankFilter(ch[i], w, h, r, 1), w, h, r, -1);
    var R = ch[0], G = ch[1], B = ch[2];
    var Lc = new Float32Array(n);
    for (i = 0; i < n; i++) Lc[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
    var lRef = percentile(Lc, 0.8), pr = 0, pg = 0, pb = 0, pc = 0;
    for (i = 0; i < n; i++) if (Lc[i] >= lRef) { pr += R[i]; pg += G[i]; pb += B[i]; pc++; }
    pr = Math.max(1, pr / pc); pg = Math.max(1, pg / pc); pb = Math.max(1, pb / pc);
    var paperL = 0.299 * pr + 0.587 * pg + 0.114 * pb;

    if (n > 9) {
      var env = boxBlur(rankFilter(Lc, w, h, 3 * r, 1), w, h, r);
      var mask = new Uint8Array(n), holes = 0, x, y;
      for (i = 0; i < n; i++) {
        var rr = R[i] / pr, gg = G[i] / pg, bb = B[i] / pb;
        var mx = rr > gg ? (rr > bb ? rr : bb) : (gg > bb ? gg : bb);
        var mn = rr < gg ? (rr < bb ? rr : bb) : (gg < bb ? gg : bb);
        if (Lc[i] < 0.25 * env[i] || (mx > 0 && (mx - mn) / mx > 0.25)) mask[i] = 1;
      }
      var grown = new Uint8Array(n);
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var j = y * w + x;
          if (!mask[j]) continue;
          for (var yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
            for (var xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) grown[yy * w + xx] = 1;
          }
        }
      }
      for (i = 0; i < n; i++) holes += grown[i];
      if (holes > 0 && holes < 0.6 * n) fillHoles(ch, grown, w, h);
    }

    // erode-then-blur by one cell: smooth, and never brighter than the closed map next to shadow edges
    // (an over-estimate turns into a grey band; an under-estimate just clips to white)
    var floor = Math.max(12, 0.15 * paperL), inv = [];
    for (var c = 0; c < 3; c++) {
      var plane = boxBlur(rankFilter(ch[c], w, h, 1, -1), w, h, 1);
      var iv = new Float32Array(n);
      for (i = 0; i < n; i++) iv[i] = (LUT_N - 1) / Math.max(floor, plane[i]);
      inv.push(iv);
    }
    return { k: k, w: w, h: h, inv: inv };
  }

  /* Bilinear upsampling helpers: per-column source index/weight and per-row interpolated inverse planes. */
  function makeSampler(model, W) {
    var k = model.k, bw = model.w, bh = model.h;
    var xi = new Int32Array(W), xw = new Float32Array(W);
    for (var x = 0; x < W; x++) {
      var s = (x + 0.5) / k - 0.5;
      if (s < 0) s = 0;
      var i = s | 0;
      if (i >= bw - 1) { i = bw - 1; s = i; }
      xi[x] = i; xw[x] = s - i;
    }
    var rows = [new Float32Array(bw + 1), new Float32Array(bw + 1), new Float32Array(bw + 1)];
    function row(y) {
      var s = (y + 0.5) / k - 0.5;
      if (s < 0) s = 0;
      var y0 = s | 0;
      if (y0 >= bh - 1) { y0 = bh - 1; s = y0; }
      var y1 = Math.min(bh - 1, y0 + 1), wy = s - y0, a = y0 * bw, b = y1 * bw;
      for (var c = 0; c < 3; c++) {
        var iv = model.inv[c], rw = rows[c];
        for (var bx = 0; bx < bw; bx++) rw[bx] = iv[a + bx] + (iv[b + bx] - iv[a + bx]) * wy;
        rw[bw] = rw[bw - 1];
      }
      return rows;
    }
    return { xi: xi, xw: xw, row: row };
  }

  /* Black point (ink level) and white point (paper level) of the normalised luminance, from a sparse sample. */
  function measureLevels(img, model, sampler, preset) {
    var W = img.width, H = img.height, src = img.data;
    var step = Math.max(1, Math.round(Math.sqrt((W * H) / 200000)));
    var bins = 2 * LUT_N, hist = new Uint32Array(bins), total = 0, xi = sampler.xi, xw = sampler.xw;
    for (var y = (step >> 1); y < H; y += step) {
      var rows = sampler.row(y), rR = rows[0], rG = rows[1], rB = rows[2];
      for (var x = (step >> 1); x < W; x += step) {
        var a = xi[x], t = xw[x], si = (y * W + x) * 4;
        var q = 0.299 * src[si] * (rR[a] + (rR[a + 1] - rR[a]) * t) +
          0.587 * src[si + 1] * (rG[a] + (rG[a + 1] - rG[a]) * t) +
          0.114 * src[si + 2] * (rB[a] + (rB[a + 1] - rB[a]) * t);
        var bi = q | 0;
        hist[bi < bins ? bi : bins - 1]++;
        total++;
      }
    }
    function pct(p) {
      var target = p * total, acc = 0;
      for (var b = 0; b < bins; b++) { acc += hist[b]; if (acc > target) return (b + 0.5) / (LUT_N - 1); }
      return 1;
    }
    var paper = pct(0.7), ink = pct(0.005);
    var wp = Math.min(0.97, Math.max(0.6, paper * preset.wpScale));
    var bp = Math.min(0.3, Math.max(0, ink * preset.bpScale));
    if (bp > wp - 0.3) bp = Math.max(0, wp - 0.3);
    return { wp: wp, bp: bp };
  }

  function toneLut(levels, gamma) {
    var lut = new Uint8ClampedArray(LUT_N), wp = levels.wp, bp = levels.bp;
    for (var i = 0; i < LUT_N; i++) {
      var t = (i / (LUT_N - 1) - bp) / (wp - bp);
      t = t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(t, gamma);
      lut[i] = Math.round(255 * t);
    }
    return lut;
  }

  /* ---------- per-pixel passes ---------- */

  /* Colour pass: per-channel division by the background, tone curve, optional saturation boost on coloured
     pixels. Writes RGBA into out and luma into lum (for sharpening). */
  function colourPass(img, sampler, lut, sat, out, lum) {
    var W = img.width, H = img.height, src = img.data, xi = sampler.xi, xw = sampler.xw, top = LUT_N - 1;
    var satOn = sat > 0;
    for (var y = 0; y < H; y++) {
      var rows = sampler.row(y), rR = rows[0], rG = rows[1], rB = rows[2], p = y * W, si = p * 4;
      for (var x = 0; x < W; x++, p++, si += 4) {
        var a = xi[x], t = xw[x];
        var qr = (src[si] * (rR[a] + (rR[a + 1] - rR[a]) * t)) | 0;
        var qg = (src[si + 1] * (rG[a] + (rG[a + 1] - rG[a]) * t)) | 0;
        var qb = (src[si + 2] * (rB[a] + (rB[a + 1] - rB[a]) * t)) | 0;
        var R = lut[qr > top ? top : qr], G = lut[qg > top ? top : qg], B = lut[qb > top ? top : qb];
        if (satOn) {
          var mx = R > G ? (R > B ? R : B) : (G > B ? G : B);
          var mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
          var cr = mx - mn;
          if (cr > 24) {
            // ramp the boost in with chroma so grey ink, JPEG fringes and paper stay neutral
            var L0 = 0.299 * R + 0.587 * G + 0.114 * B;
            var f = 1 + sat * (cr >= 72 ? 1 : (cr - 24) / 48);
            R = L0 + (R - L0) * f; G = L0 + (G - L0) * f; B = L0 + (B - L0) * f;
          }
        }
        out[si] = R; out[si + 1] = G; out[si + 2] = B; out[si + 3] = src[si + 3];
        lum[p] = (77 * out[si] + 150 * out[si + 1] + 29 * out[si + 2] + 128) >> 8;
      }
    }
  }

  /* Gray pass: tone curve applied to the normalised luminance. */
  function grayPass(img, sampler, lut, lum) {
    var W = img.width, H = img.height, src = img.data, xi = sampler.xi, xw = sampler.xw, top = LUT_N - 1;
    for (var y = 0; y < H; y++) {
      var rows = sampler.row(y), rR = rows[0], rG = rows[1], rB = rows[2], p = y * W, si = p * 4;
      for (var x = 0; x < W; x++, p++, si += 4) {
        var a = xi[x], t = xw[x];
        var q = (0.299 * src[si] * (rR[a] + (rR[a + 1] - rR[a]) * t) +
          0.587 * src[si + 1] * (rG[a] + (rG[a + 1] - rG[a]) * t) +
          0.114 * src[si + 2] * (rB[a] + (rB[a + 1] - rB[a]) * t)) | 0;
        lum[p] = lut[q > top ? top : q];
      }
    }
  }

  /* 3x3 box blur of an 8-bit plane (edges replicated). */
  function blur3(src, W, H) {
    var tmp = new Uint16Array(W * H), out = new Uint8Array(W * H), x, y;
    for (y = 0; y < H; y++) {
      var r = y * W;
      for (x = 0; x < W; x++) {
        tmp[r + x] = src[r + (x > 0 ? x - 1 : 0)] + src[r + x] + src[r + (x < W - 1 ? x + 1 : x)];
      }
    }
    for (y = 0; y < H; y++) {
      var ru = (y > 0 ? y - 1 : 0) * W, rc = y * W, rd = (y < H - 1 ? y + 1 : y) * W;
      for (x = 0; x < W; x++) out[rc + x] = ((tmp[ru + x] + tmp[rc + x] + tmp[rd + x]) * 7282 + 32768) >> 16;
    }
    return out;
  }

  /* Unsharp mask on luminance detail, added equally to every channel (keeps hue). */
  function sharpen(out, lum, W, H, amount) {
    if (!(amount > 0) || W < 3 || H < 3) return;
    var bl = blur3(lum, W, H), a = Math.round(amount * 256), n = W * H;
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      var d = lum[p] - bl[p];
      if (d > -2 && d < 2) continue;
      d = (d * a) >> 8;
      out[i] += d; out[i + 1] += d; out[i + 2] += d;
    }
  }

  function enhance(img, preset) {
    var W = img.width, H = img.height, out = makeImage(W, H), od = out.data;
    var model = backgroundModel(img), sampler = makeSampler(model, W);
    var lut = toneLut(measureLevels(img, model, sampler, preset), preset.gamma);
    var lum = new Uint8Array(W * H);
    if (preset.gray) {
      grayPass(img, sampler, lut, lum);
      var sd = img.data;
      for (var p = 0, i = 0; p < W * H; p++, i += 4) {
        od[i] = od[i + 1] = od[i + 2] = lum[p]; od[i + 3] = sd[i + 3];
      }
    } else {
      colourPass(img, sampler, lut, preset.sat, od, lum);
    }
    sharpen(od, lum, W, H, preset.sharpen);
    return out;
  }

  /* ---------- black & white ---------- */

  /* Removes isolated black specks: 8-connected components smaller than minArea with no other ink within
     `gap` pixels (so i-dots, accents and punctuation next to letters survive). mask: 1 = black. */
  function removeSpecks(mask, W, H, minArea, gap) {
    var n = W * H, stack = new Int32Array(n), comp = new Int32Array(minArea), i, j;
    for (i = 0; i < n; i++) {
      if (mask[i] !== 1) continue;
      var sp = 0, cn = 0, bx0 = W, by0 = H, bx1 = 0, by1 = 0;
      stack[sp++] = i; mask[i] = 2;
      while (sp > 0) {
        var p = stack[--sp], y = (p / W) | 0, x = p - y * W;
        if (cn < minArea) {
          comp[cn] = p;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
        cn++;
        var x0 = x > 0 ? -1 : 0, x1 = x < W - 1 ? 1 : 0, y0 = y > 0 ? -1 : 0, y1 = y < H - 1 ? 1 : 0;
        for (var dy = y0; dy <= y1; dy++) {
          for (var dx = x0; dx <= x1; dx++) {
            var q = p + dy * W + dx;
            if (mask[q] === 1) { mask[q] = 2; stack[sp++] = q; }
          }
        }
      }
      if (cn >= minArea) continue;
      for (j = 0; j < cn; j++) mask[comp[j]] = 3;
      var near = false, ya = Math.max(0, by0 - gap), yb = Math.min(H - 1, by1 + gap);
      var xa = Math.max(0, bx0 - gap), xb = Math.min(W - 1, bx1 + gap);
      for (var yy = ya; yy <= yb && !near; yy++) {
        for (var k = yy * W + xa, e = yy * W + xb; k <= e; k++) {
          if (mask[k] === 1 || mask[k] === 2) { near = true; break; }
        }
      }
      for (j = 0; j < cn; j++) mask[comp[j]] = near ? 2 : 0;
    }
  }

  function localRange(a, W, H, x, y, r) {
    var mx = 0, mn = 255, ya = y - r < 0 ? 0 : y - r, yb = y + r >= H ? H - 1 : y + r;
    var xa = x - r < 0 ? 0 : x - r, xb = x + r >= W ? W - 1 : x + r;
    for (var yy = ya; yy <= yb; yy++) {
      for (var i = yy * W + xa, e = yy * W + xb; i <= e; i++) {
        var v = a[i];
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
    }
    return mx - mn;
  }

  /* Bradley-Roth local mean threshold on the illumination-normalised luminance (integral image), with
     absolute guards: clearly dark ink is always black, clearly white paper always white, and flat mid-tone
     areas (filled shapes, bars) are decided globally so they come out solid instead of hollow. */
  function blackWhite(img, preset) {
    var W = img.width, H = img.height, n = W * H, i;
    var model = backgroundModel(img), sampler = makeSampler(model, W);
    var lut = toneLut(measureLevels(img, model, sampler, preset), preset.gamma);
    var g = new Uint8Array(n);
    grayPass(img, sampler, lut, g);

    var iw = W + 1, I = n * 255 < 4294967296 ? new Uint32Array(iw * (H + 1)) : new Float64Array(iw * (H + 1));
    for (var y = 0; y < H; y++) {
      var rs = 0, o = (y + 1) * iw + 1, u = y * iw + 1, p = y * W;
      for (var x = 0; x < W; x++) { rs += g[p + x]; I[o + x] = I[u + x] + rs; }
    }
    var half = Math.max(4, Math.round(Math.max(W, H) * preset.window / 2)), keep = preset.keep;
    var DARK = preset.dark, LIGHT = preset.light, MID = preset.mid, FLAT = preset.flat;
    var gb = W >= 3 && H >= 3 ? blur3(g, W, H) : g, gt = preset.smooth ? gb : g;
    var mask = new Uint8Array(n);
    for (y = 0; y < H; y++) {
      var ya = Math.max(0, y - half), yb = Math.min(H - 1, y + half), rA = ya * iw, rB = (yb + 1) * iw, hh = yb - ya + 1;
      var pp = y * W;
      for (x = 0; x < W; x++) {
        var v = gt[pp + x];
        if (g[pp + x] >= LIGHT) continue;
        var vb = gb[pp + x];
        if (vb < DARK) { mask[pp + x] = 1; continue; }
        if (localRange(gb, W, H, x, y, 2) < FLAT) { if (vb < MID) mask[pp + x] = 1; continue; }
        var xa = x - half < 0 ? 0 : x - half, xb = x + half >= W ? W - 1 : x + half;
        var sum = I[rB + xb + 1] - I[rA + xb + 1] - I[rB + xa] + I[rA + xa];
        if (v * (xb - xa + 1) * hh < sum * keep) mask[pp + x] = 1;
      }
    }
    var L = Math.max(W, H);
    if (preset.speck > 0) removeSpecks(mask, W, H, Math.max(2, Math.round(L * L * preset.speck)), Math.max(2, Math.round(L / 600)));
    var out = makeImage(W, H), od = out.data, sd = img.data;
    for (y = 0; y < H; y++) {
      var inner = y > 0 && y < H - 1;
      for (x = 0; x < W; x++) {
        i = y * W + x;
        var black = mask[i] !== 0 ||
          (inner && x > 0 && x < W - 1 && mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W]);
        var j4 = i * 4;
        od[j4] = od[j4 + 1] = od[j4 + 2] = black ? 0 : 255;
        od[j4 + 3] = sd[j4 + 3];
      }
    }
    return out;
  }

  /* ---------- public API ---------- */

  /* tuning (optional, for evaluation): overrides merged into the preset. */
  function applyImageData(img, id, tuning) {
    if (!img || !(img.width > 0) || !(img.height > 0) || !img.data) throw new TypeError('Filters: invalid image');
    var base = PRESETS[id];
    if (!base) return copyImage(img);
    var preset = base;
    if (tuning) {
      preset = {};
      for (var key in base) preset[key] = base[key];
      for (key in tuning) preset[key] = tuning[key];
    }
    return id === 'bw' ? blackWhite(img, preset) : enhance(img, preset);
  }

  function sourceCanvas(src) {
    if (src && typeof src.getContext === 'function') return src;
    var w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return c;
  }

  function apply(canvas, id) {
    var src = sourceCanvas(canvas), w = src.width, h = src.height;
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var octx = out.getContext('2d');
    if (!PRESETS[id]) { octx.drawImage(src, 0, 0); return out; }
    var sctx = src.getContext('2d', { willReadFrequently: true }) || src.getContext('2d');
    var res = applyImageData(sctx.getImageData(0, 0, w, h), id), idata;
    try { idata = new ImageData(res.data, w, h); } catch (e) {
      idata = octx.createImageData(w, h);
      idata.data.set(res.data);
    }
    octx.putImageData(idata, 0, 0);
    return out;
  }

  return {
    version: '2.0.0',
    LIST: LIST,
    applyImageData: applyImageData,
    apply: apply,
    _backgroundModel: backgroundModel,
    _rankFilter: rankFilter,
    _presets: PRESETS
  };
});
