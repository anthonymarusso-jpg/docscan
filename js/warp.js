/* Warp: perspective rectification, rotation and downscaling.
   Pure ImageData-like cores run in Node; canvas helpers are browser-only. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Warp = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_MAX_OUT = 2400;
  var DEFAULT_FOCAL = 0.75; // prior focal length in long-side units (24-26 mm equiv. phone main camera, 4:3)

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function checkCorners(q) {
    if (!q || q.length !== 4) throw new TypeError('Warp: expected 4 corners');
    for (var i = 0; i < 4; i++) {
      if (!q[i] || !isFinite(q[i].x) || !isFinite(q[i].y)) throw new TypeError('Warp: invalid corner');
    }
  }

  /* Unit square -> quad homography (Heckbert). (0,0)->TL, (1,0)->TR, (1,1)->BR, (0,1)->BL.
     x = (a u + b v + c) / (g u + h v + 1), y = (d u + e v + f) / (g u + h v + 1) */
  function squareToQuad(q) {
    var x0 = q[0].x, y0 = q[0].y, x1 = q[1].x, y1 = q[1].y;
    var x2 = q[2].x, y2 = q[2].y, x3 = q[3].x, y3 = q[3].y;
    var dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
    var a, b, c, d, e, f, g, h;
    if (Math.abs(dx3) < 1e-10 && Math.abs(dy3) < 1e-10) {
      a = x1 - x0; b = x3 - x0; c = x0;
      d = y1 - y0; e = y3 - y0; f = y0;
      g = 0; h = 0;
    } else {
      var dx1 = x1 - x2, dy1 = y1 - y2, dx2 = x3 - x2, dy2 = y3 - y2;
      var den = dx1 * dy2 - dx2 * dy1;
      if (Math.abs(den) < 1e-12) den = den < 0 ? -1e-12 : 1e-12;
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
      a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
      d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
    }
    return [a, b, c, d, e, f, g, h];
  }

  function mapUnit(H, u, v) {
    var w = H[6] * u + H[7] * v + 1;
    return { x: (H[0] * u + H[1] * v + H[2]) / w, y: (H[3] * u + H[4] * v + H[5]) / w };
  }

  /* ---------- aspect ratio estimation ---------- */

  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  function sideAspect(q) {
    var w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
    var h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
    return h > 0 ? w / h : 1;
  }

  /* Rectangle aspect from its perspective image (Zhang & He, "Whiteboard scanning", 2007):
     principal point at the image centre, square pixels; the focal length is solved from the two
     vanishing directions when both are well conditioned, otherwise a phone-camera prior is used. */
  function estimateAspect(q, imgW, imgH, opts) {
    checkCorners(q);
    opts = opts || {};
    var naive = sideAspect(q);
    if (!(imgW > 0 && imgH > 0)) return { aspect: naive, method: 'sides', focal: null };
    var L = Math.max(imgW, imgH), u0 = imgW / 2, v0 = imgH / 2;
    function hp(p) { return [(p.x - u0) / L, (p.y - v0) / L, 1]; }
    var m1 = hp(q[0]), m2 = hp(q[1]), m4 = hp(q[2]), m3 = hp(q[3]);
    var c14 = cross(m1, m4);
    var den2 = dot(cross(m2, m4), m3), den3 = dot(cross(m3, m4), m2);
    if (Math.abs(den2) < 1e-12 || Math.abs(den3) < 1e-12) return { aspect: naive, method: 'sides', focal: null };
    var k2 = dot(c14, m3) / den2, k3 = dot(c14, m2) / den3;
    if (!(k2 > 0 && k3 > 0)) return { aspect: naive, method: 'sides', focal: null };
    var n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    var n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    var a2 = n2[0] * n2[0] + n2[1] * n2[1], a3 = n3[0] * n3[0] + n3[1] * n3[1];
    if (!(a2 > 0 && a3 > 0)) return { aspect: naive, method: 'sides', focal: null };
    // perspective strength per direction = 1 / distance of its vanishing point (in long-side units)
    var p2 = Math.abs(n2[2]) / Math.sqrt(a2), p3 = Math.abs(n3[2]) / Math.sqrt(a3);
    var prior = opts.focal > 0 ? opts.focal : DEFAULT_FOCAL;
    var pRef = opts.pRef > 0 ? opts.pRef : 0.1;
    var f = prior, method = 'prior-focal';
    var pm = Math.min(p2, p3);
    if (p2 < 0.01 && p3 < 0.01) method = 'affine';
    else if (pm > (opts.pMin > 0 ? opts.pMin : 0.02)) {
      var f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
      if (f2 > 0) {
        // the focal estimate is ill-conditioned when a vanishing point is far: shrink it toward the prior
        var fe = Math.min(2.5, Math.max(0.35, Math.sqrt(f2)));
        var we = (pm / pRef) * (pm / pRef);
        f = Math.exp((we * Math.log(fe) + Math.log(prior)) / (we + 1));
        method = we >= 1 ? 'projective' : 'blend';
      }
    }
    var ff = f * f;
    var aspect = Math.sqrt((a2 + ff * n2[2] * n2[2]) / (a3 + ff * n3[2] * n3[2]));
    if (!(aspect > 0) || !isFinite(aspect)) return { aspect: naive, method: 'sides', focal: null };
    var rel = aspect / naive;
    if (rel < 0.55 || rel > 1.8) return { aspect: naive, method: 'sides', focal: null };
    return { aspect: aspect, method: method, focal: f * L };
  }

  function outputSize(q, imgW, imgH, maxOutDim) {
    checkCorners(q);
    var maxDim = maxOutDim > 0 ? maxOutDim : DEFAULT_MAX_OUT;
    var r = estimateAspect(q, imgW, imgH).aspect;
    var wM = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    var hM = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    var w = Math.max(wM, hM * r, 1);
    var h = w / r;
    var s = Math.min(1, maxDim / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  /* ---------- pure ImageData-like helpers ---------- */

  function makeImage(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }

  function view32(data) {
    if (data.byteOffset % 4 === 0 && data.byteLength >= data.length) {
      return new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
    }
    var copy = new Uint8Array(data.length);
    copy.set(data);
    return new Uint32Array(copy.buffer);
  }

  function cropImage(img, x0, y0, w, h) {
    if (x0 === 0 && y0 === 0 && w === img.width && h === img.height) return img;
    var out = makeImage(w, h), sd = img.data, od = out.data, rowBytes = w * 4;
    for (var y = 0; y < h; y++) {
      var si = ((y0 + y) * img.width + x0) * 4;
      od.set(sd.subarray(si, si + rowBytes), y * rowBytes);
    }
    return out;
  }

  /* Integer box reduction by k (partial edge blocks averaged over their real size). */
  function boxReduce(img, k) {
    var sw = img.width, sh = img.height, src = img.data;
    var w = Math.ceil(sw / k), h = Math.ceil(sh / k);
    var out = makeImage(w, h), od = out.data;
    var acc = new Uint32Array(w * 4);
    for (var by = 0; by < h; by++) {
      acc.fill(0);
      var yEnd = Math.min(sh, (by + 1) * k), rows = yEnd - by * k;
      for (var y = by * k; y < yEnd; y++) {
        var si = y * sw * 4;
        for (var x = 0; x < sw; x++, si += 4) {
          var ai = ((x / k) | 0) * 4;
          acc[ai] += src[si]; acc[ai + 1] += src[si + 1]; acc[ai + 2] += src[si + 2]; acc[ai + 3] += src[si + 3];
        }
      }
      for (var bx = 0; bx < w; bx++) {
        var cols = Math.min(sw, (bx + 1) * k) - bx * k, n = cols * rows, oi = (by * w + bx) * 4, a = bx * 4;
        od[oi] = acc[a] / n; od[oi + 1] = acc[a + 1] / n;
        od[oi + 2] = acc[a + 2] / n; od[oi + 3] = acc[a + 3] / n;
      }
    }
    return out;
  }

  /* Bilinear perspective warp. Output pixel centres span the quad exactly; samples falling outside
     the source become white. opts.prefilter (default true) box-reduces the source first when the
     whole quad is minified >= 2x, to avoid aliasing. */
  function rectifyImageData(src, corners, outW, outH, opts) {
    checkCorners(corners);
    outW = Math.max(1, Math.round(outW)); outH = Math.max(1, Math.round(outH));
    var q = corners;
    if (!opts || opts.prefilter !== false) {
      var sMin = Math.min(dist(q[0], q[1]) / outW, dist(q[3], q[2]) / outW,
        dist(q[0], q[3]) / outH, dist(q[1], q[2]) / outH);
      var k = Math.floor(sMin);
      if (k >= 2) {
        var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        q.forEach(function (p) {
          bx0 = Math.min(bx0, p.x); by0 = Math.min(by0, p.y); bx1 = Math.max(bx1, p.x); by1 = Math.max(by1, p.y);
        });
        bx0 = Math.max(0, Math.floor(bx0) - 2 * k); by0 = Math.max(0, Math.floor(by0) - 2 * k);
        bx1 = Math.min(src.width, Math.ceil(bx1) + 2 * k); by1 = Math.min(src.height, Math.ceil(by1) + 2 * k);
        if (bx1 > bx0 && by1 > by0) {
          src = boxReduce(cropImage(src, bx0, by0, bx1 - bx0, by1 - by0), k);
          q = q.map(function (p) { return { x: (p.x - bx0) / k, y: (p.y - by0) / k }; });
        }
      }
    }
    var sw = src.width, sh = src.height;
    var out = makeImage(outW, outH);
    var out32 = new Uint32Array(out.data.buffer);
    if (sw < 1 || sh < 1) { out32.fill(0xFFFFFFFF); return out; }
    var s32 = view32(src.data);
    var H = squareToQuad(q);
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    var du = 1 / outW, ax = a * du, dx = d * du, gx = g * du;
    var xMax = sw - 0.5, yMax = sh - 0.5, swm = sw - 1, shm = sh - 1;
    var o = 0;
    for (var Y = 0; Y < outH; Y++) {
      var v = (Y + 0.5) / outH, u = 0.5 * du;
      var nx = a * u + b * v + c, ny = d * u + e * v + f, dn = g * u + h * v + 1;
      for (var X = 0; X < outW; X++, o++) {
        var iw = 1 / dn;
        var fx = nx * iw - 0.5, fy = ny * iw - 0.5;
        nx += ax; ny += dx; dn += gx;
        if (!(fx >= -0.5 && fy >= -0.5 && fx <= xMax && fy <= yMax)) { out32[o] = 0xFFFFFFFF; continue; }
        var x0 = Math.floor(fx), y0 = Math.floor(fy);
        var wx = ((fx - x0) * 256 + 0.5) | 0, wy = ((fy - y0) * 256 + 0.5) | 0;
        var x1 = x0 + 1, y1 = y0 + 1;
        if (x0 < 0) x0 = 0;
        if (x1 > swm) x1 = swm;
        if (y0 < 0) y0 = 0;
        if (y1 > shm) y1 = shm;
        var r0 = y0 * sw, r1 = y1 * sw;
        var p00 = s32[r0 + x0], p10 = s32[r0 + x1], p01 = s32[r1 + x0], p11 = s32[r1 + x1];
        var iwx = 256 - wx, iwy = 256 - wy;
        var w00 = iwx * iwy, w10 = wx * iwy, w01 = iwx * wy, w11 = wx * wy;
        var R = ((p00 & 255) * w00 + (p10 & 255) * w10 + (p01 & 255) * w01 + (p11 & 255) * w11 + 32768) >>> 16;
        var G = (((p00 >>> 8) & 255) * w00 + ((p10 >>> 8) & 255) * w10 + ((p01 >>> 8) & 255) * w01 +
          ((p11 >>> 8) & 255) * w11 + 32768) >>> 16;
        var B = (((p00 >>> 16) & 255) * w00 + ((p10 >>> 16) & 255) * w10 + ((p01 >>> 16) & 255) * w01 +
          ((p11 >>> 16) & 255) * w11 + 32768) >>> 16;
        out32[o] = (R | (G << 8) | (B << 16) | 0xFF000000) >>> 0;
      }
    }
    return out;
  }

  function rotateImageData(img, quarterTurns) {
    var t = (((quarterTurns | 0) % 4) + 4) % 4;
    var w = img.width, h = img.height;
    var ow = t % 2 ? h : w, oh = t % 2 ? w : h;
    var out = makeImage(ow, oh);
    var s32 = view32(img.data), o32 = new Uint32Array(out.data.buffer);
    var x, y, i = 0;
    if (t === 0) { o32.set(s32); return out; }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++, i++) {
        var nx, ny;
        if (t === 1) { nx = h - 1 - y; ny = x; }
        else if (t === 2) { nx = w - 1 - x; ny = h - 1 - y; }
        else { nx = y; ny = w - 1 - x; }
        o32[ny * ow + nx] = s32[i];
      }
    }
    return out;
  }

  /* Exact area-average resampling (separable box with fractional coverage). */
  function resampleArea(img, ow, oh) {
    var sw = img.width, sh = img.height, src = img.data;
    ow = Math.max(1, Math.round(ow)); oh = Math.max(1, Math.round(oh));
    function weights(n, m) {
      var sc = n / m, idx = [], wts = [], start = new Int32Array(m + 1);
      for (var o = 0; o < m; o++) {
        start[o] = idx.length;
        var a = o * sc, b = (o + 1) * sc;
        for (var s = Math.floor(a); s < Math.min(n, Math.ceil(b)); s++) {
          var ov = Math.min(b, s + 1) - Math.max(a, s);
          if (ov > 1e-9) { idx.push(s); wts.push(ov / sc); }
        }
      }
      start[m] = idx.length;
      return { start: start, idx: Int32Array.from(idx), w: Float32Array.from(wts) };
    }
    var wxs = weights(sw, ow), wys = weights(sh, oh);
    var tmp = new Float32Array(ow * sh * 4);
    for (var y = 0; y < sh; y++) {
      for (var ox = 0; ox < ow; ox++) {
        var r = 0, g = 0, b = 0, al = 0;
        for (var k = wxs.start[ox]; k < wxs.start[ox + 1]; k++) {
          var si = (y * sw + wxs.idx[k]) * 4, wt = wxs.w[k];
          r += src[si] * wt; g += src[si + 1] * wt; b += src[si + 2] * wt; al += src[si + 3] * wt;
        }
        var ti = (y * ow + ox) * 4;
        tmp[ti] = r; tmp[ti + 1] = g; tmp[ti + 2] = b; tmp[ti + 3] = al;
      }
    }
    var out = makeImage(ow, oh), od = out.data;
    for (var oy = 0; oy < oh; oy++) {
      for (var x2 = 0; x2 < ow; x2++) {
        var r2 = 0, g2 = 0, b2 = 0, a2 = 0;
        for (var k2 = wys.start[oy]; k2 < wys.start[oy + 1]; k2++) {
          var ti2 = (wys.idx[k2] * ow + x2) * 4, wt2 = wys.w[k2];
          r2 += tmp[ti2] * wt2; g2 += tmp[ti2 + 1] * wt2; b2 += tmp[ti2 + 2] * wt2; a2 += tmp[ti2 + 3] * wt2;
        }
        var oi = (oy * ow + x2) * 4;
        od[oi] = r2; od[oi + 1] = g2; od[oi + 2] = b2; od[oi + 3] = a2;
      }
    }
    return out;
  }

  function downscaleImageData(img, maxDim) {
    var s = Math.min(1, maxDim / Math.max(img.width, img.height));
    if (s >= 1) {
      var copy = makeImage(img.width, img.height);
      copy.data.set(img.data);
      return copy;
    }
    return resampleArea(img, img.width * s, img.height * s);
  }

  /* ---------- browser canvas helpers ---------- */

  function newCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function release(c) { if (c) { c.width = 0; c.height = 0; } }

  function sourceSize(src) {
    var w = src.naturalWidth || src.videoWidth || src.width || 0;
    var h = src.naturalHeight || src.videoHeight || src.height || 0;
    return { w: w, h: h };
  }

  function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }) || c.getContext('2d'); }

  function toCanvas(src) {
    if (src && typeof src.getContext === 'function') return src;
    var s = sourceSize(src), c = newCanvas(s.w, s.h);
    c.getContext('2d').drawImage(src, 0, 0, s.w, s.h);
    return c;
  }

  function putImage(img) {
    var c = newCanvas(img.width, img.height), ctx = c.getContext('2d');
    var id = ctx.createImageData(img.width, img.height);
    id.data.set(img.data);
    ctx.putImageData(id, 0, 0);
    return c;
  }

  function rectify(srcCanvas, pixelCorners, opts) {
    checkCorners(pixelCorners);
    opts = opts || {};
    var canvas = toCanvas(srcCanvas);
    var W = canvas.width, H = canvas.height;
    var size = opts.width > 0 && opts.height > 0
      ? { w: Math.round(opts.width), h: Math.round(opts.height) }
      : outputSize(pixelCorners, W, H, opts.maxOutDim || DEFAULT_MAX_OUT);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pixelCorners.forEach(function (p) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    var x0 = Math.max(0, Math.floor(minX) - 2), y0 = Math.max(0, Math.floor(minY) - 2);
    var x1 = Math.min(W, Math.ceil(maxX) + 2), y1 = Math.min(H, Math.ceil(maxY) + 2);
    if (x1 - x0 < 1 || y1 - y0 < 1) {
      var blank = newCanvas(size.w, size.h), bctx = blank.getContext('2d');
      bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, size.w, size.h);
      return blank;
    }
    var region = ctx2d(canvas).getImageData(x0, y0, x1 - x0, y1 - y0);
    // the crop is clamped to the image, so quad parts outside the image still sample as white
    var q = pixelCorners.map(function (p) { return { x: p.x - x0, y: p.y - y0 }; });
    var out = rectifyImageData(region, q, size.w, size.h, opts);
    region = null;
    return putImage(out);
  }

  function rotate(canvas, quarterTurns) {
    var t = (((quarterTurns | 0) % 4) + 4) % 4;
    var w = canvas.width, h = canvas.height;
    var out = t % 2 ? newCanvas(h, w) : newCanvas(w, h);
    var ctx = out.getContext('2d');
    if (t === 1) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
    else if (t === 2) { ctx.translate(w, h); ctx.rotate(Math.PI); }
    else if (t === 3) { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(canvas, 0, 0);
    return out;
  }

  function downscale(src, maxDim) {
    var s = sourceSize(src), w = s.w, h = s.h;
    var scale = Math.min(1, maxDim / Math.max(w, h, 1));
    var tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    var cur = src, cw = w, ch = h, temp = null;
    while (cw / 2 >= tw && ch / 2 >= th && cw > 1 && ch > 1) {
      var nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
      var step = newCanvas(nw, nh), sctx = step.getContext('2d');
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      if (temp) release(temp);
      temp = step; cur = step; cw = nw; ch = nh;
    }
    var out = newCanvas(tw, th), octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(cur, 0, 0, cw, ch, 0, 0, tw, th);
    if (temp) release(temp);
    return out;
  }

  return {
    version: '2.0.0',
    rectifyImageData: rectifyImageData,
    rectify: rectify,
    outputSize: outputSize,
    estimateAspect: estimateAspect,
    rotate: rotate,
    rotateImageData: rotateImageData,
    downscale: downscale,
    downscaleImageData: downscaleImageData,
    resampleArea: resampleArea,
    _squareToQuad: squareToQuad,
    _mapUnit: mapUnit,
    _boxReduce: boxReduce
  };
});
