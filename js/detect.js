/* DocDetect — document quadrilateral detection (pure JS, runs in window, worker and Node).
   Pipeline: area downscale -> colour-opponent feature planes -> blurred Sobel + NMS -> keep only true STEP edges
   (paper vs background, measured on both sides of the edge, so text, table rules, tile grout and grids are ignored)
   -> orientation-guided Hough lines -> quadrilaterals from line pairs + a contour fallback -> score by step-edge
   support along every side -> prefer the outer quad over contained ones -> sub-pixel side refit. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.DocDetect = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  var VERSION = '2.0.0';
  var DEG = Math.PI / 180;

  /* ---------------- geometry ---------------- */
  function orderCorners(pts) {
    if (!pts || pts.length !== 4) return pts;
    var cx = 0, cy = 0, i;
    for (i = 0; i < 4; i++) { cx += pts[i].x; cy += pts[i].y; }
    cx /= 4; cy /= 4;
    var s = pts.map(function (p) { return { x: p.x, y: p.y, a: Math.atan2(p.y - cy, p.x - cx) }; });
    s.sort(function (a, b) { return a.a - b.a; });
    var start = 0, best = Infinity;
    for (i = 0; i < 4; i++) { var v = s[i].x + s[i].y; if (v < best) { best = v; start = i; } }
    var out = [];
    for (i = 0; i < 4; i++) { var p = s[(start + i) % 4]; out.push({ x: p.x, y: p.y }); }
    return out;
  }
  function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
  function polyArea(q) {
    var s = 0;
    for (var i = 0; i < q.length; i++) { var a = q[i], b = q[(i + 1) % q.length]; s += a.x * b.y - b.x * a.y; }
    return s / 2;
  }
  function isConvexQuad(q) {
    if (!q || q.length !== 4) return false;
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var p = q[i];
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return false;
      var c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
      if (Math.abs(c) < 1e-12) return false;
      var sg = c > 0 ? 1 : -1;
      if (sign === 0) sign = sg; else if (sg !== sign) return false;
    }
    return Math.abs(polyArea(q)) > 1e-9;
  }
  function interiorAngles(q) {
    var out = [];
    for (var i = 0; i < 4; i++) {
      var p = q[i], a = q[(i + 3) % 4], b = q[(i + 1) % 4];
      var ux = a.x - p.x, uy = a.y - p.y, vx = b.x - p.x, vy = b.y - p.y;
      var d = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
      out.push(Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / d))) / DEG);
    }
    return out;
  }
  function pointInQuad(p, q) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var c = cross(q[i], q[(i + 1) % 4], p);
      var sg = c > 0 ? 1 : (c < 0 ? -1 : 0);
      if (sg === 0) continue;
      if (sign === 0) sign = sg; else if (sg !== sign) return false;
    }
    return true;
  }

  /* ---------------- image planes ---------------- */
  function axisWeights(n, N) {
    var s = n / N, idx = [], wt = [], start = new Int32Array(N + 1);
    for (var o = 0; o < N; o++) {
      start[o] = idx.length;
      var a = o * s, b = (o + 1) * s, i0 = Math.floor(a), i1 = Math.min(n - 1, Math.ceil(b) - 1);
      for (var i = i0; i <= i1; i++) {
        var w = Math.min(i + 1, b) - Math.max(i, a);
        if (w > 0) { idx.push(i); wt.push(w / s); }
      }
    }
    start[N] = idx.length;
    return { idx: Int32Array.from(idx), wt: Float32Array.from(wt), start: start };
  }

  function makePlanes(img, maxDim) {
    var sw = img.width | 0, sh = img.height | 0, d = img.data;
    var s = Math.min(1, maxDim / Math.max(sw, sh));
    var W = Math.max(1, Math.round(sw * s)), H = Math.max(1, Math.round(sh * s));
    var n = W * H, F0 = new Float32Array(n), F1 = new Float32Array(n), F2 = new Float32Array(n);
    var x, y, i, k, r, g, b;
    if (W === sw && H === sh) {
      for (i = 0, k = 0; i < n; i++, k += 4) {
        r = d[k]; g = d[k + 1]; b = d[k + 2];
        F0[i] = 0.299 * r + 0.587 * g + 0.114 * b; F1[i] = 0.6 * (r - g); F2[i] = 0.6 * (b - 0.5 * (r + g));
      }
    } else {
      var ax = axisWeights(sw, W), ay = axisWeights(sh, H);
      var tR = new Float32Array(sh * W), tG = new Float32Array(sh * W), tB = new Float32Array(sh * W);
      for (y = 0; y < sh; y++) {
        var row = y * sw, orow = y * W;
        for (x = 0; x < W; x++) {
          var sr = 0, sg = 0, sb = 0;
          for (k = ax.start[x]; k < ax.start[x + 1]; k++) {
            var p = (row + ax.idx[k]) * 4, w = ax.wt[k];
            sr += d[p] * w; sg += d[p + 1] * w; sb += d[p + 2] * w;
          }
          tR[orow + x] = sr; tG[orow + x] = sg; tB[orow + x] = sb;
        }
      }
      for (y = 0; y < H; y++) {
        for (x = 0; x < W; x++) {
          r = 0; g = 0; b = 0;
          for (k = ay.start[y]; k < ay.start[y + 1]; k++) {
            var q = ay.idx[k] * W + x, wy = ay.wt[k];
            r += tR[q] * wy; g += tG[q] * wy; b += tB[q] * wy;
          }
          i = y * W + x;
          F0[i] = 0.299 * r + 0.587 * g + 0.114 * b; F1[i] = 0.6 * (r - g); F2[i] = 0.6 * (b - 0.5 * (r + g));
        }
      }
    }
    return { W: W, H: H, scale: W / sw, F: [F0, F1, F2] };
  }

  function box3(src, W, H) {
    var tmp = new Float32Array(W * H), out = new Float32Array(W * H), x, y, i;
    for (y = 0; y < H; y++) {
      var r = y * W;
      for (x = 0; x < W; x++) {
        var a = x > 0 ? src[r + x - 1] : src[r + x], c = x < W - 1 ? src[r + x + 1] : src[r + x];
        tmp[r + x] = (a + src[r + x] + c) / 3;
      }
    }
    for (y = 0; y < H; y++) {
      var up = (y > 0 ? y - 1 : y) * W, mid = y * W, dn = (y < H - 1 ? y + 1 : y) * W;
      for (x = 0; x < W; x++) out[mid + x] = (tmp[up + x] + tmp[mid + x] + tmp[dn + x]) / 3;
    }
    return out;
  }

  function sampler(P) {
    var W = P.W, H = P.H, F = P.F;
    return function (x, y, out) {
      if (x < 0) x = 0; else if (x > W - 1.001) x = W - 1.001;
      if (y < 0) y = 0; else if (y > H - 1.001) y = H - 1.001;
      var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0;
      var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      for (var c = 0; c < 3; c++) {
        var f = F[c];
        out[c] = f[i] * w00 + f[i + 1] * w10 + f[i + W] * w01 + f[i + W + 1] * w11;
      }
      return out;
    };
  }

  function rgbaSampler(img, rad) {
    var W = img.width, H = img.height, d = img.data;
    var tmp = [0, 0, 0];
    function px(x, y, o) {
      if (x < 0) x = 0; else if (x > W - 1.001) x = W - 1.001;
      if (y < 0) y = 0; else if (y > H - 1.001) y = H - 1.001;
      var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = (y0 * W + x0) * 4, j = i + W * 4;
      var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      for (var c = 0; c < 3; c++) o[c] = d[i + c] * w00 + d[i + 4 + c] * w10 + d[j + c] * w01 + d[j + 4 + c] * w11;
    }
    return function (x, y, out) {
      var r = 0, g = 0, b = 0;
      for (var k = 0; k < 4; k++) {
        px(x + (k & 1 ? rad : -rad), y + (k & 2 ? rad : -rad), tmp);
        r += tmp[0]; g += tmp[1]; b += tmp[2];
      }
      r /= 4; g /= 4; b /= 4;
      out[0] = 0.299 * r + 0.587 * g + 0.114 * b; out[1] = 0.6 * (r - g); out[2] = 0.6 * (b - 0.5 * (r + g));
      return out;
    };
  }

  function fdist(a, b) {
    var d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2];
    return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
  }

  /* ---------------- edges ---------------- */
  /* Step contrast across an edge, measured at two distances: a thin line (grid, grout, table rule, text) looks
     like a step close up but vanishes further out, while a paper/background boundary keeps its contrast. */
  function stepAt(samp, x, y, nx, ny, k, fa, fb) {
    samp(x + k * nx, y + k * ny, fa); samp(x - k * nx, y - k * ny, fb);
    var s1 = fdist(fa, fb), k2 = k * 1.8;
    samp(x + k2 * nx, y + k2 * ny, fa); samp(x - k2 * nx, y - k2 * ny, fb);
    var s2 = fdist(fa, fb);
    if (s2 < 0.55 * s1) return 0;
    return s1 < s2 ? s1 : s2;
  }

  function gradients(P) {
    var W = P.W, H = P.H, n = W * H;
    var gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
    var wts = [1, 0.85, 0.85];
    for (var c = 0; c < 3; c++) {
      var f = P.F[c], wc = wts[c];
      for (var y = 1; y < H - 1; y++) {
        for (var x = 1; x < W - 1; x++) {
          var i = y * W + x;
          var a = f[i - W - 1], b = f[i - W], cc = f[i - W + 1], dd = f[i - 1], e = f[i + 1], g = f[i + W - 1], h = f[i + W], k = f[i + W + 1];
          var sx = (cc + 2 * e + k - a - 2 * dd - g) * wc, sy = (g + 2 * h + k - a - 2 * b - cc) * wc;
          var m = Math.sqrt(sx * sx + sy * sy);
          if (m > mag[i]) { mag[i] = m; gx[i] = sx; gy[i] = sy; }
        }
      }
    }
    return { gx: gx, gy: gy, mag: mag };
  }

  function stepEdges(P, G, k, tStep, gMin) {
    var W = P.W, H = P.H, gx = G.gx, gy = G.gy, mag = G.mag, samp = sampler(P);
    var xs = [], ys = [], ws = [], ts = [];
    var fa = [0, 0, 0], fb = [0, 0, 0];
    for (var y = 2; y < H - 2; y++) {
      for (var x = 2; x < W - 2; x++) {
        var i = y * W + x, m = mag[i];
        if (m < gMin) continue;
        var ax = Math.abs(gx[i]), ay = Math.abs(gy[i]), n1, n2;
        if (ay <= ax * 0.4142) { n1 = mag[i - 1]; n2 = mag[i + 1]; }
        else if (ay >= ax * 2.4142) { n1 = mag[i - W]; n2 = mag[i + W]; }
        else if (gx[i] * gy[i] > 0) { n1 = mag[i - W - 1]; n2 = mag[i + W + 1]; }
        else { n1 = mag[i - W + 1]; n2 = mag[i + W - 1]; }
        if (m < n1 || m < n2) continue;
        var nx = gx[i] / m, ny = gy[i] / m;
        var st = stepAt(samp, x, y, nx, ny, k, fa, fb);
        if (st < tStep) continue;
        xs.push(x); ys.push(y); ws.push(Math.min(st, 90)); ts.push(Math.atan2(ny, nx));
      }
    }
    return { x: xs, y: ys, w: ws, t: ts };
  }

  /* ---------------- Hough ---------------- */
  function houghLines(P, E, K) {
    var W = P.W, H = P.H, cx = W / 2, cy = H / 2, D = Math.hypot(W, H);
    var NT = 180, nR = Math.ceil(D) + 3, off = nR / 2, acc = new Float32Array(NT * nR);
    var cs = new Float32Array(NT), sn = new Float32Array(NT), t, i;
    for (t = 0; t < NT; t++) { cs[t] = Math.cos(t * DEG); sn[t] = Math.sin(t * DEG); }
    var spread = [0.45, 0.8, 1, 0.8, 0.45];
    for (i = 0; i < E.x.length; i++) {
      var phi = E.t[i]; if (phi < 0) phi += Math.PI;
      var ti = Math.round(phi / DEG) % NT, px = E.x[i] - cx, py = E.y[i] - cy, w = E.w[i];
      for (var dt = -2; dt <= 2; dt++) {
        t = (ti + dt + NT) % NT;
        var ri = Math.round(px * cs[t] + py * sn[t] + off);
        if (ri >= 0 && ri < nR) acc[t * nR + ri] += w * spread[dt + 2];
      }
    }
    var mx = 0;
    for (i = 0; i < acc.length; i++) if (acc[i] > mx) mx = acc[i];
    if (mx <= 0) return [];
    var thr = mx * 0.06, cand = [];
    for (t = 0; t < NT; t++) {
      for (var r = 2; r < nR - 2; r++) {
        var v = acc[t * nR + r];
        if (v < thr) continue;
        var isMax = true;
        for (var a = -2; a <= 2 && isMax; a++) {
          var tt = (t + a + NT) % NT;
          for (var b = -3; b <= 3; b++) {
            if (!a && !b) continue;
            var rr = (t + a < 0 || t + a >= NT) ? (nR - 1 - (r + b)) : (r + b);
            if (rr < 0 || rr >= nR) continue;
            if (acc[tt * nR + rr] > v) { isMax = false; break; }
          }
        }
        if (isMax) cand.push({ t: t, r: r - off, v: v });
      }
    }
    cand.sort(function (p, q) { return q.v - p.v; });
    var out = [], minDR = 0.022 * D;
    for (i = 0; i < cand.length && out.length < K; i++) {
      var c = cand[i], dup = false;
      for (var j = 0; j < out.length; j++) {
        var o = out[j], dth = Math.abs(c.t - o.td), rr2 = o.r;
        if (dth > 90) { dth = 180 - dth; rr2 = -o.r; }
        if (dth < 5 && Math.abs(c.r - rr2) < minDR) { dup = true; break; }
      }
      if (!dup) out.push({ td: c.t, th: c.t * DEG, c: cs[c.t], s: sn[c.t], r: c.r, v: c.v, cx: cx, cy: cy });
    }
    return out;
  }

  function intersect(a, b) {
    var det = a.c * b.s - b.c * a.s;
    if (Math.abs(det) < 0.25) return null;
    var u = (a.r * b.s - b.r * a.s) / det, v = (a.c * b.r - b.c * a.r) / det;
    return { x: u + a.cx, y: v + a.cy };
  }
  function lineAngleDiff(a, b) { var d = Math.abs(a.td - b.td); return d > 90 ? 180 - d : d; }

  /* ---------------- scoring ---------------- */
  function scoreQuad(q, ctx, stepPx) {
    var samp = ctx.samp, mag = ctx.G.mag, gx = ctx.G.gx, gy = ctx.G.gy, W = ctx.P.W, H = ctx.P.H, k = ctx.k;
    var fa = [0, 0, 0], fb = [0, 0, 0], sup = [], pol = [], total = 0;
    for (var s = 0; s < 4; s++) {
      var p0 = q[s], p1 = q[(s + 1) % 4], len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (len < 4) return null;
      var dx = (p1.x - p0.x) / len, dy = (p1.y - p0.y) / len, nx = -dy, ny = dx;
      var N = Math.max(6, Math.floor(len * 0.88 / stepPx)), hit = 0, signSum = 0, cnt = 0;
      for (var j = 0; j < N; j++) {
        var t = 0.06 + 0.88 * (j + 0.5) / N, x = p0.x + (p1.x - p0.x) * t, y = p0.y + (p1.y - p0.y) * t;
        if (x < 1 || y < 1 || x > W - 2 || y > H - 2) continue;
        cnt++;
        var best = 0, bi = -1;
        for (var o = -1; o <= 1; o++) {
          var xi = Math.round(x + o * nx), yi = Math.round(y + o * ny);
          if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
          var ii = yi * W + xi;
          if (mag[ii] > best) { best = mag[ii]; bi = ii; }
        }
        if (bi < 0 || best < ctx.gMin) continue;
        if (Math.abs(gx[bi] * nx + gy[bi] * ny) < 0.7 * best) continue;
        if (stepAt(samp, x, y, nx, ny, k, fa, fb) < ctx.tStep) continue;
        hit++;
        signSum += fa[0] > fb[0] ? 1 : -1;
      }
      if (cnt < 3) { sup.push(0); pol.push(0); continue; }
      sup.push(hit / cnt); pol.push(hit ? signSum / hit : 0);
      total += hit / cnt;
    }
    var mean = total / 4, mn = Math.min(sup[0], sup[1], sup[2], sup[3]);
    var base = 0.55 * mean + 0.45 * mn;
    var signs = pol.map(function (v) { return v > 0.3 ? 1 : (v < -0.3 ? -1 : 0); });
    var consistent = signs.every(function (v) { return v === signs[0] && v !== 0; });
    var area = Math.abs(polyArea(q)) / (W * H);
    var score = base * (consistent ? 1 : 0.85) * (0.82 + 0.18 * Math.min(1, area / 0.45));
    return { score: score, sup: sup, area: area };
  }

  function geomOk(q, W, H, minArea) {
    if (!isConvexQuad(q)) return false;
    var mX = W * 0.03, mY = H * 0.03;
    for (var i = 0; i < 4; i++) if (q[i].x < -mX || q[i].y < -mY || q[i].x > W + mX || q[i].y > H + mY) return false;
    var area = Math.abs(polyArea(q)) / (W * H);
    if (area < minArea || area > 1.06) return false;
    var ang = interiorAngles(q);
    for (i = 0; i < 4; i++) if (ang[i] < 32 || ang[i] > 148) return false;
    for (i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.08 * Math.min(W, H)) return false;
    }
    return true;
  }

  /* ---------------- contour fallback ---------------- */
  function contourQuad(P, E, minArea) {
    var W = P.W, H = P.H, n = W * H, wall = new Uint8Array(n), i, x, y;
    for (i = 0; i < E.x.length; i++) {
      var cx0 = E.x[i], cy0 = E.y[i];
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        x = cx0 + dx; y = cy0 + dy;
        if (x >= 0 && y >= 0 && x < W && y < H) wall[y * W + x] = 1;
      }
    }
    var out = new Uint8Array(n), stack = new Int32Array(n), sp = 0;
    function push(px, py) {
      var j = py * W + px;
      if (out[j] || wall[j]) return;
      out[j] = 1; stack[sp++] = j;
    }
    for (x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    while (sp) {
      var j = stack[--sp], jx = j % W, jy = (j / W) | 0;
      if (jx > 0) push(jx - 1, jy); if (jx < W - 1) push(jx + 1, jy);
      if (jy > 0) push(jx, jy - 1); if (jy < H - 1) push(jx, jy + 1);
    }
    var pts = [];
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      i = y * W + x;
      if (out[i]) continue;
      if (out[i - 1] || out[i + 1] || out[i - W] || out[i + W]) pts.push({ x: x, y: y });
    }
    if (pts.length < 20) return null;
    var hull = convexHull(pts);
    if (hull.length < 4 || Math.abs(polyArea(hull)) < minArea * W * H) return null;
    return reduceToQuad(hull);
  }
  function convexHull(points) {
    var p = points.slice().sort(function (a, b) { return a.x === b.x ? a.y - b.y : a.x - b.x; });
    var lower = [], upper = [], i;
    for (i = 0; i < p.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
      lower.push(p[i]);
    }
    for (i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }
  function reduceToQuad(hull) {
    var h = hull.slice();
    while (h.length > 4) {
      var bi = 0, bl = Infinity;
      for (var i = 0; i < h.length; i++) {
        var a = h[(i - 1 + h.length) % h.length], b = h[i], c = h[(i + 1) % h.length];
        var loss = Math.abs(cross(a, b, c));
        if (loss < bl) { bl = loss; bi = i; }
      }
      h.splice(bi, 1);
    }
    return h.length === 4 ? orderCorners(h) : null;
  }

  /* ---------------- side refit ---------------- */
  function fitLine(px, py, pw) {
    var sw = 0, mx = 0, my = 0, i;
    for (i = 0; i < px.length; i++) { sw += pw[i]; mx += px[i] * pw[i]; my += py[i] * pw[i]; }
    if (sw <= 0) return null;
    mx /= sw; my /= sw;
    var sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < px.length; i++) {
      var dx = px[i] - mx, dy = py[i] - my;
      sxx += pw[i] * dx * dx; syy += pw[i] * dy * dy; sxy += pw[i] * dx * dy;
    }
    var th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { mx: mx, my: my, dx: Math.cos(th), dy: Math.sin(th) };
  }
  function refineSides(q, samp, W, H, opt) {
    var r = opt.r, a = opt.a, h = opt.h, tMin = opt.tStep, lines = [], fa = [0, 0, 0], fb = [0, 0, 0];
    for (var s = 0; s < 4; s++) {
      var p0 = q[s], p1 = q[(s + 1) % 4], len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      var dx = (p1.x - p0.x) / len, dy = (p1.y - p0.y) / len, nx = -dy, ny = dx;
      var N = Math.max(8, Math.min(400, Math.floor(len / opt.spacing))), PX = [], PY = [], PW = [];
      var ns = Math.round(r / h), D = new Float32Array(2 * ns + 1);
      for (var j = 0; j < N; j++) {
        var t = 0.05 + 0.9 * (j + 0.5) / N, x = p0.x + (p1.x - p0.x) * t, y = p0.y + (p1.y - p0.y) * t;
        var bk = -1, bv = 0;
        for (var k = -ns; k <= ns; k++) {
          var o = k * h, qx = x + o * nx, qy = y + o * ny;
          samp(qx + a * nx, qy + a * ny, fa); samp(qx - a * nx, qy - a * ny, fb);
          var v = fdist(fa, fb);
          D[k + ns] = v;
          var wv = v * (1 - 0.35 * Math.abs(k) / ns);
          if (wv > bv) { bv = wv; bk = k; }
        }
        if (bk < 0 || D[bk + ns] < tMin) continue;
        var off = bk * h;
        if (bk > -ns && bk < ns) {
          var y0 = D[bk + ns - 1], y1 = D[bk + ns], y2 = D[bk + ns + 1], den = y0 - 2 * y1 + y2;
          if (den < 0) off += h * Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den));
        }
        PX.push(x + off * nx); PY.push(y + off * ny); PW.push(D[bk + ns]);
      }
      if (PX.length < Math.max(5, N * 0.25)) { lines.push(null); continue; }
      var w0 = PW.slice(), L = fitLine(PX, PY, w0);
      for (var it = 0; it < 3 && L; it++) {
        var c = opt.tukey, wts = [];
        for (var m = 0; m < PX.length; m++) {
          var res = Math.abs((PX[m] - L.mx) * -L.dy + (PY[m] - L.my) * L.dx), u = res / c;
          wts.push(u < 1 ? w0[m] * (1 - u * u) * (1 - u * u) : 0);
        }
        L = fitLine(PX, PY, wts);
      }
      lines.push(L);
    }
    var out = [];
    for (s = 0; s < 4; s++) {
      var A = lines[(s + 3) % 4], B = lines[s], P0 = q[s];
      if (!A || !B) { out.push({ x: P0.x, y: P0.y }); continue; }
      var det = A.dx * -B.dy + B.dx * A.dy;
      if (Math.abs(det) < 0.2) { out.push({ x: P0.x, y: P0.y }); continue; }
      var tA = ((B.mx - A.mx) * -B.dy + B.dx * (B.my - A.my)) / det;
      var X = A.mx + A.dx * tA, Y = A.my + A.dy * tA;
      if (!isFinite(X) || Math.hypot(X - P0.x, Y - P0.y) > opt.maxMove) out.push({ x: P0.x, y: P0.y });
      else out.push({ x: X, y: Y });
    }
    return isConvexQuad(out) ? out : q;
  }

  /* A page that already fills the photo (flat scan, screenshot, close-up): the frame border is paper itself. */
  function borderLooksLikePaper(P) {
    var W = P.W, H = P.H, b = Math.max(2, Math.round(Math.min(W, H) * 0.025)), F0 = P.F[0], F1 = P.F[1], F2 = P.F[2];
    var n = 0, paper = 0, bright = 0;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (x >= b && x < W - b && y >= b && y < H - b) { x = W - b - 1; continue; }
        var i = y * W + x, L = F0[i], ch = Math.abs(F1[i]) + Math.abs(F2[i]);
        n++;
        if (ch < 42 && L > 120) { paper++; if (L > 175) bright++; }
      }
    }
    // shadows may darken part of the frame, so ask for "mostly paper", with a clearly white share
    return n > 0 && paper / n > 0.45 && bright / n > 0.25;
  }
  function fullFrame() {
    return { corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], confidence: 0.3, method: 'page' };
  }

  /* ---------------- main ---------------- */
  function emptyInput(img) {
    return !img || !img.data || !(img.width > 0) || !(img.height > 0) || img.data.length < img.width * img.height * 4;
  }

  function detect(img, opts) {
    try {
      opts = opts && typeof opts === 'object' ? opts : {};
      if (emptyInput(img) || img.width < 16 || img.height < 16) return null;
      var live = opts.mode === 'live';
      var maxDim = +opts.maxDim > 32 ? +opts.maxDim : (live ? 320 : 560);
      var P = makePlanes(img, maxDim), W = P.W, H = P.H;
      if (W < 16 || H < 16) return null;
      P.F = [box3(box3(P.F[0], W, H), W, H), box3(box3(P.F[1], W, H), W, H), box3(box3(P.F[2], W, H), W, H)];
      var minDim = Math.min(W, H), k = Math.max(2.5, minDim / 110), tStep = 9, gMin = 10;
      var G = gradients(P), E = stepEdges(P, G, k, tStep, gMin);
      if (E.x.length < 30) return null;
      var ctx = { P: P, G: G, k: k, tStep: tStep, gMin: gMin, samp: sampler(P) };
      var minArea = 0.05, lines = houghLines(P, E, live ? 12 : 22);

      var cands = [], i, j, a, b;
      var pairs = [], diag = Math.hypot(W, H);
      for (i = 0; i < lines.length; i++) for (j = i + 1; j < lines.length; j++) {
        a = lines[i]; b = lines[j];
        if (lineAngleDiff(a, b) > 38) continue;
        var X = intersect(a, b);
        if (X && X.x > -0.1 * W && X.x < 1.1 * W && X.y > -0.1 * H && X.y < 1.1 * H) continue;
        var sep = Math.abs(a.r - (Math.abs(a.td - b.td) > 90 ? -b.r : b.r));
        if (sep < 0.12 * minDim) continue;
        pairs.push([a, b, (a.td + (Math.abs(a.td - b.td) > 90 ? (b.td > a.td ? b.td - 180 : b.td + 180) : b.td)) / 2]);
      }
      for (i = 0; i < pairs.length; i++) for (j = i + 1; j < pairs.length; j++) {
        var A = pairs[i], B = pairs[j], fam = Math.abs(A[2] - B[2]) % 180;
        if (fam > 90) fam = 180 - fam;
        if (fam < 40) continue;
        if (A[0] === B[0] || A[0] === B[1] || A[1] === B[0] || A[1] === B[1]) continue;
        var c1 = intersect(A[0], B[0]), c2 = intersect(A[0], B[1]), c3 = intersect(A[1], B[1]), c4 = intersect(A[1], B[0]);
        if (!c1 || !c2 || !c3 || !c4) continue;
        var q = orderCorners([c1, c2, c3, c4]);
        if (!geomOk(q, W, H, minArea)) continue;
        cands.push({ q: q, kind: 'lines' });
      }
      var cq = contourQuad(P, E, minArea);
      if (cq && geomOk(cq, W, H, minArea)) cands.push({ q: cq, kind: 'contour' });
      if (!cands.length) return null;

      var coarse = live ? 7 : 5;
      for (i = 0; i < cands.length; i++) {
        var sc = scoreQuad(cands[i].q, ctx, coarse);
        cands[i].score = sc ? sc.score : 0;
      }
      cands.sort(function (p, q2) { return q2.score - p.score; });
      cands = cands.slice(0, live ? 12 : 30);
      for (i = 0; i < cands.length; i++) {
        var fs = scoreQuad(cands[i].q, ctx, 2);
        cands[i].score = fs ? fs.score : 0; cands[i].area = fs ? fs.area : 0;
      }
      cands.sort(function (p, q2) { return q2.score - p.score; });
      var best = cands[0];
      if (!best || best.score < 0.28) return null;
      for (i = 1; i < cands.length; i++) {
        var c = cands[i];
        if (c.area < best.area * 1.25 || c.score < Math.max(0.55, best.score * 0.85)) continue;
        var inside = best.q.every(function (p) {
          return pointInQuad({ x: p.x, y: p.y }, c.q);
        });
        if (inside) best = c;
      }

      var q2 = refineSides(best.q, ctx.samp, W, H, {
        r: Math.max(2.5, 0.012 * diag), a: 1.6, h: 0.5, tStep: tStep * 0.8, spacing: live ? 3 : 2,
        tukey: Math.max(1.2, 0.0035 * diag), maxMove: Math.max(4, 0.03 * diag),
      });
      var conf = Math.max(0, Math.min(1, (best.score - 0.2) / 0.55));
      if (!live && conf < 0.6 && borderLooksLikePaper(P)) return fullFrame();
      var corners = orderCorners(q2).map(function (p) {
        return { x: Math.max(0, Math.min(1, p.x / W)), y: Math.max(0, Math.min(1, p.y / H)) };
      });
      if (!isConvexQuad(corners)) return null;
      return { corners: corners, confidence: conf, method: best.kind };
    } catch (e) {
      return null;
    }
  }

  function refine(img, corners, opts) {
    try {
      if (emptyInput(img) || !corners || corners.length !== 4) return corners;
      for (var i = 0; i < 4; i++) if (!corners[i] || !isFinite(corners[i].x) || !isFinite(corners[i].y)) return corners;
      if (!isConvexQuad(corners)) return corners;
      var W = img.width, H = img.height, diag = Math.hypot(W, H);
      var q = corners.map(function (p) { return { x: p.x * W, y: p.y * H }; });
      var rad = Math.max(0.5, diag * 0.0006);
      var out = refineSides(q, rgbaSampler(img, rad), W, H, {
        r: (opts && opts.radius) || 0.012 * diag, a: Math.max(1.6, diag * 0.0012), h: Math.max(0.5, diag * 0.0004),
        tStep: 10, spacing: Math.max(2, diag / 700), tukey: Math.max(1.5, 0.0025 * diag), maxMove: 0.02 * diag,
      });
      return orderCorners(out.map(function (p) {
        return { x: Math.max(0, Math.min(1, p.x / W)), y: Math.max(0, Math.min(1, p.y / H)) };
      }));
    } catch (e) {
      return corners;
    }
  }

  var canvasCache = null;
  function detectCanvas(src, opts) {
    try {
      if (!src || typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
      opts = opts || {};
      var w = src.videoWidth || src.naturalWidth || src.width, h = src.videoHeight || src.naturalHeight || src.height;
      if (!(w > 0) || !(h > 0)) return null;
      var maxDim = +opts.maxDim > 32 ? +opts.maxDim : (opts.mode === 'live' ? 320 : 560);
      var s = Math.min(1, maxDim / Math.max(w, h)), W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
      if (!canvasCache) canvasCache = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(W, H);
      canvasCache.width = W; canvasCache.height = H;
      var ctx = canvasCache.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, W, H);
      return detect(ctx.getImageData(0, 0, W, H), { mode: opts.mode, maxDim: maxDim });
    } catch (e) {
      return null;
    }
  }

  return {
    version: VERSION,
    detect: detect,
    detectCanvas: detectCanvas,
    refine: refine,
    orderCorners: orderCorners,
    isConvexQuad: isConvexQuad,
  };
});
