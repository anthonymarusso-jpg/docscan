/* DocScan v2 — Cropper: flexible quad selector (4 corners + 4 edges, loupe, tweened updates).
   Cropper.create(container, {image, corners, onChange}) -> {getCorners, setCorners, isValid, relayout, destroy}
   Pure geometry lives in Cropper._geom (Node-testable). */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.Cropper = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  const EPS = 1e-9;
  const MIN_SLIDE_COS = 0.35;
  const FALLBACK_COLORS = { ink: '#141414', orange: '#FF7A00', cream: '#FFF3D6', red: '#E23D2E', blue: '#1F4E9C' };
  const DEFAULTS = {
    hitRadius: 44,
    padding: 22,
    loupeSize: 120,
    loupeZoom: 2.5,
    minArea: 0.02,
    animMs: 180,
    dragThreshold: 4,
    holdMs: 170,
    untangle: true,
  };
  const CORNER_R = 12.5;
  const PILL_LEN = 30;
  const PILL_THICK = 13;
  const MIN_EDGE_FOR_MID = 64;
  const LOUPE_MARGIN = 8;

  /* ------------------------------------------------------------------ geometry */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function copyPts(a) { return a.map((p) => ({ x: p.x, y: p.y })); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function fitRect(cw, ch, iw, ih, pad) {
    pad = pad > 0 ? Math.min(pad, cw / 4, ch / 4) : 0;
    const aw = cw - 2 * pad, ah = ch - 2 * pad;
    if (!(iw > 0 && ih > 0 && aw > 0 && ah > 0)) {
      return { x: Math.max(0, cw || 0) / 2, y: Math.max(0, ch || 0) / 2, w: 0, h: 0, scale: 0 };
    }
    const scale = Math.min(aw / iw, ah / ih);
    const w = iw * scale, h = ih * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w: w, h: h, scale: scale };
  }

  function normToScreen(p, fit) { return { x: fit.x + p.x * fit.w, y: fit.y + p.y * fit.h }; }
  function screenToNorm(p, fit) {
    return { x: fit.w > 0 ? (p.x - fit.x) / fit.w : 0, y: fit.h > 0 ? (p.y - fit.y) / fit.h : 0 };
  }
  function cornersToScreen(corners, fit) { return corners.map((p) => normToScreen(p, fit)); }
  function cornersToNorm(pts, fit, clampTo01) {
    return pts.map((p) => {
      const n = screenToNorm(p, fit);
      return clampTo01 ? { x: clamp(n.x, 0, 1), y: clamp(n.y, 0, 1) } : n;
    });
  }
  function fitBounds(fit) { return { x0: fit.x, y0: fit.y, x1: fit.x + fit.w, y1: fit.y + fit.h }; }
  function clampPoint(p, b) { return { x: clamp(p.x, b.x0, b.x1), y: clamp(p.y, b.y0, b.y1) }; }

  function midpoints(pts) {
    return [0, 1, 2, 3].map((i) => {
      const a = pts[i], b = pts[(i + 1) % 4];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    });
  }

  function segmentDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > EPS ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /* Edge i joins corner i and corner i+1 (0 top, 1 right, 2 bottom, 3 left).
     Returns {type:'corner'|'edge', index, dist} or null. Corners win when within `tie` px of a midpoint. */
  function nearestHandle(p, pts, opts) {
    opts = opts || {};
    const R = opts.hitRadius != null ? opts.hitRadius : DEFAULTS.hitRadius;
    const segR = opts.edgeHitRadius != null ? opts.edgeHitRadius : R * 0.65;
    const tie = opts.tie != null ? opts.tie : 8;
    const minEdge = opts.minEdgeLength || 0;
    let ci = -1, cd = Infinity, mi = -1, md = Infinity, si = -1, sd = Infinity;
    for (let i = 0; i < 4; i++) {
      const d = dist(p, pts[i]);
      if (d < cd) { cd = d; ci = i; }
    }
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      if (dist(a, b) < minEdge) continue;
      const d = Math.hypot(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2);
      if (d < md) { md = d; mi = i; }
      const s = segmentDistance(p, a, b);
      if (s < sd) { sd = s; si = i; }
    }
    const cornerHit = cd <= R, midHit = md <= R;
    if (cornerHit && (!midHit || cd <= md + tie)) return { type: 'corner', index: ci, dist: cd };
    if (midHit) return { type: 'edge', index: mi, dist: md };
    if (opts.segments !== false && sd <= segR) return { type: 'edge', index: si, dist: sd };
    return null;
  }

  function moveCorner(pts, i, delta, bounds) {
    const out = copyPts(pts);
    const p = { x: pts[i].x + delta.x, y: pts[i].y + delta.y };
    out[i] = bounds ? clampPoint(p, bounds) : p;
    return out;
  }

  /* Direction v along the adjacent edge (from -> p) scaled so that dot(v, n) = 1: moving the edge by d along
     its normal slides the endpoint along its neighbouring side. Falls back to the pure normal when that side
     is nearly parallel to the edge. */
  function slideDir(from, p, n) {
    const ux = p.x - from.x, uy = p.y - from.y, ul = Math.hypot(ux, uy);
    if (ul > EPS) {
      const c = (ux * n.x + uy * n.y) / ul;
      if (Math.abs(c) >= MIN_SLIDE_COS) return { x: ux / ul / c, y: uy / ul / c };
    }
    return { x: n.x, y: n.y };
  }

  function feasibleRange(points, dirs, b) {
    let lo = -Infinity, hi = Infinity;
    for (let k = 0; k < points.length; k++) {
      const p = points[k], v = dirs[k];
      if (Math.abs(v.x) > EPS) {
        const t0 = (b.x0 - p.x) / v.x, t1 = (b.x1 - p.x) / v.x;
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      }
      if (Math.abs(v.y) > EPS) {
        const t0 = (b.y0 - p.y) / v.y, t1 = (b.y1 - p.y) / v.y;
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      }
    }
    return lo <= hi ? { lo: lo, hi: hi } : { lo: 0, hi: 0 };
  }

  function moveEdge(pts, i, delta, bounds) {
    const ia = i, ib = (i + 1) % 4;
    const a = pts[ia], b = pts[ib];
    const out = copyPts(pts);
    const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
    if (len < EPS) {
      out[ia] = moveCorner(pts, ia, delta, bounds)[ia];
      out[ib] = moveCorner(pts, ib, delta, bounds)[ib];
      return out;
    }
    const n = { x: ey / len, y: -ex / len };
    let d = delta.x * n.x + delta.y * n.y;
    const va = slideDir(pts[(i + 3) % 4], a, n);
    const vb = slideDir(pts[(i + 2) % 4], b, n);
    if (bounds) {
      const r = feasibleRange([a, b], [va, vb], bounds);
      d = clamp(d, r.lo, r.hi);
    }
    out[ia] = { x: a.x + va.x * d, y: a.y + va.y * d };
    out[ib] = { x: b.x + vb.x * d, y: b.y + vb.y * d };
    if (bounds) { out[ia] = clampPoint(out[ia], bounds); out[ib] = clampPoint(out[ib], bounds); }
    return out;
  }

  function turn(o, a, b) { return (a.x - o.x) * (b.y - a.y) - (a.y - o.y) * (b.x - a.x); }

  function signedArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      s += p.x * q.y - q.x * p.y;
    }
    return s / 2;
  }

  /* Valid = convex, ordered TL,TR,BR,BL (clockwise on a y-down screen, so every turn is positive),
     no collinear/duplicate corners, area >= minArea (in the units of pts). */
  function isConvexQuad(pts, minArea) {
    if (!pts || pts.length !== 4) return false;
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return false;
    }
    for (let i = 0; i < 4; i++) {
      const o = pts[i], a = pts[(i + 1) % 4], b = pts[(i + 2) % 4];
      const l = dist(o, a) * dist(a, b);
      if (!(l > EPS) || turn(o, a, b) <= 1e-6 * l) return false;
    }
    return signedArea(pts) >= (minArea > 0 ? minArea : 0);
  }

  function angularOrder(pts) {
    let cx = 0, cy = 0;
    pts.forEach((p) => { cx += p.x / pts.length; cy += p.y / pts.length; });
    return pts
      .map((p, i) => ({ i: i, a: Math.atan2(p.y - cy, p.x - cx) }))
      .sort((u, v) => u.a - v.a)
      .map((e) => e.i);
  }

  function orderCorners(pts) {
    const ord = angularOrder(pts);
    let start = 0, best = Infinity;
    for (let k = 0; k < 4; k++) {
      const p = pts[ord[k]];
      if (p.x + p.y < best) { best = p.x + p.y; start = k; }
    }
    return [0, 1, 2, 3].map((k) => {
      const p = pts[ord[(start + k) % 4]];
      return { x: p.x, y: p.y };
    });
  }

  /* Relabel a tangled quad (bowtie / flipped) into a valid TL,TR,BR,BL order without moving any point.
     Picks the cyclic order closest to `ref` (the quad before the drag) so the page orientation is kept. */
  function untangle(pts, ref, minArea) {
    if (!pts || pts.length !== 4) return null;
    let out;
    if (ref && ref.length === 4) {
      const ord = angularOrder(pts);
      let bestR = 0, bestCost = Infinity;
      for (let r = 0; r < 4; r++) {
        let cost = 0;
        for (let k = 0; k < 4; k++) {
          const p = pts[ord[(r + k) % 4]], q = ref[k];
          cost += (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y);
        }
        if (cost < bestCost - EPS) { bestCost = cost; bestR = r; }
      }
      out = [0, 1, 2, 3].map((k) => {
        const p = pts[ord[(bestR + k) % 4]];
        return { x: p.x, y: p.y };
      });
    } else {
      out = orderCorners(pts);
    }
    return isConvexQuad(out, minArea) ? out : null;
  }

  function lerpCorners(a, b, t) {
    return a.map((p, i) => ({ x: p.x + (b[i].x - p.x) * t, y: p.y + (b[i].y - p.y) * t }));
  }
  function easeOutCubic(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function easeOutBack(t) {
    t = clamp(t, 0, 1);
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  /* Loupe centre (container px) kept clear of both the finger and the dragged handle:
     above them by default, otherwise beside them (the roomier side), last resort below. */
  function loupePlacement(touch, handle, size, box, opts) {
    opts = opts || {};
    const gap = opts.gap != null ? opts.gap : 28;
    const m = opts.margin != null ? opts.margin : LOUPE_MARGIN;
    const R = size / 2;
    const h = handle || touch;
    const kx0 = Math.min(touch.x, h.x), kx1 = Math.max(touch.x, h.x);
    const ky0 = Math.min(touch.y, h.y), ky1 = Math.max(touch.y, h.y);
    const minX = m + R, maxX = Math.max(minX, box.w - m - R);
    const minY = m + R, maxY = Math.max(minY, box.h - m - R);
    const sideY = clamp((ky0 + ky1) / 2 - R * 0.15, minY, maxY);
    const c = {
      above: { x: clamp(h.x, minX, maxX), y: ky0 - gap - R },
      left: { x: kx0 - gap - R, y: sideY },
      right: { x: kx1 + gap + R, y: sideY },
    };
    const fits = (s, extra) => {
      const q = c[s], e = extra || 0;
      return q.x >= minX - 0.5 && q.x <= maxX + 0.5 && q.y >= minY + e - 0.5 && q.y <= maxY + 0.5;
    };
    const pack = (s) => ({ x: c[s].x, y: c[s].y, side: s });
    const prefer = opts.prefer;
    if (prefer && c[prefer] && fits(prefer)) {
      if (prefer !== 'above' && fits('above', opts.hysteresis != null ? opts.hysteresis : 24)) return pack('above');
      return pack(prefer);
    }
    const sides = (box.w - kx1 > kx0) ? ['right', 'left'] : ['left', 'right'];
    const order = ['above'].concat(sides);
    for (let k = 0; k < order.length; k++) if (fits(order[k])) return pack(order[k]);
    return { x: clamp(h.x, minX, maxX), y: clamp(ky1 + gap + R, minY, maxY), side: 'below' };
  }

  /* Source rectangle (in full-res image px) shown by a loupe of `viewSize` css px at `zoom` x the on-screen
     scale, centred on `center`. `clip` is the part that lies inside the image, with its destination rect. */
  function loupeSource(center, viewSize, displayScale, zoom, iw, ih) {
    const k = displayScale * zoom;
    if (!(k > 0)) return { sx: 0, sy: 0, size: 0, k: 0, clip: null };
    const size = viewSize / k;
    const sx = center.x - size / 2, sy = center.y - size / 2;
    const ix0 = Math.max(0, sx), iy0 = Math.max(0, sy);
    const ix1 = Math.min(iw, sx + size), iy1 = Math.min(ih, sy + size);
    let clip = null;
    if (ix1 > ix0 && iy1 > iy0) {
      clip = {
        sx: ix0, sy: iy0, sw: ix1 - ix0, sh: iy1 - iy0,
        dx: (ix0 - sx) * k, dy: (iy0 - sy) * k, dw: (ix1 - ix0) * k, dh: (iy1 - iy0) * k,
      };
    }
    return { sx: sx, sy: sy, size: size, k: k, clip: clip };
  }

  function sanitizeCorners(c) {
    if (!c || c.length !== 4) return null;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = c[i];
      if (!p) return null;
      const x = Array.isArray(p) ? +p[0] : +p.x, y = Array.isArray(p) ? +p[1] : +p.y;
      if (!isFinite(x) || !isFinite(y)) return null;
      out.push({ x: clamp(x, 0, 1), y: clamp(y, 0, 1) });
    }
    return out;
  }

  function defaultCorners() {
    return [{ x: 0.07, y: 0.06 }, { x: 0.93, y: 0.06 }, { x: 0.93, y: 0.94 }, { x: 0.07, y: 0.94 }];
  }

  function sameCorners(a, b, eps) {
    eps = eps || 1e-7;
    for (let i = 0; i < 4; i++) {
      if (Math.abs(a[i].x - b[i].x) > eps || Math.abs(a[i].y - b[i].y) > eps) return false;
    }
    return true;
  }

  function sourceSize(img) {
    return {
      w: img ? (img.naturalWidth || img.videoWidth || img.width || 0) : 0,
      h: img ? (img.naturalHeight || img.videoHeight || img.height || 0) : 0,
    };
  }

  /* ------------------------------------------------------------------ drawing helpers */

  function quadPath(ctx, pts) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  function pillPath(ctx, len, thick) {
    const r = thick / 2, hl = len / 2 - r;
    ctx.moveTo(-hl, -r);
    ctx.lineTo(hl, -r);
    ctx.arc(hl, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(-hl, r);
    ctx.arc(-hl, 0, r, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath();
  }

  function circle(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  }

  /* ------------------------------------------------------------------ component */

  function create(container, options) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('Cropper.create: container inválido');
    }
    options = options || {};
    const image = options.image;
    if (!image) throw new TypeError('Cropper.create: image obrigatório');

    const doc = container.ownerDocument || root.document;
    const win = (doc && doc.defaultView) || root;
    const cfg = {};
    Object.keys(DEFAULTS).forEach((k) => { cfg[k] = options[k] != null ? options[k] : DEFAULTS[k]; });
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    const src = sourceSize(image);
    const nowMs = () => (win.performance && win.performance.now ? win.performance.now() : Date.now());
    const raf = win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (fn) => win.setTimeout(fn, 16);
    const caf = win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : (id) => win.clearTimeout(id);
    const motionQuery = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const reducedMotion = () => !!(motionQuery && motionQuery.matches);

    let corners = sanitizeCorners(options.corners) || defaultCorners();
    let shown = corners;
    let valid = isConvexQuad(corners, cfg.minArea);
    let size = { w: -1, h: -1 };
    let dpr = 1;
    let fit = fitRect(0, 0, src.w, src.h, 0);
    let colors = Object.assign({}, FALLBACK_COLORS);
    let pattern = null;
    let drag = null;
    let hover = null;
    let selected = { type: 'corner', index: 0 };
    let keyboardFocus = false;
    let tween = null;
    const anim = [0, 0, 0, 0, 0, 0, 0, 0];
    const lp = { visible: false, t: 0, x: 0, y: 0, side: null, placed: false };
    let rafId = 0, lastFrame = 0, holdTimer = 0, destroyed = false;
    let rect = { left: 0, top: 0 };

    const cs0 = win.getComputedStyle ? win.getComputedStyle(container) : null;
    const prevPosition = container.style.position;
    const patchedPosition = !!(cs0 && cs0.position === 'static');
    if (patchedPosition) container.style.position = 'relative';

    const wrap = doc.createElement('div');
    wrap.className = 'cropper';
    wrap.setAttribute('role', 'application');
    wrap.setAttribute('aria-label', 'Ajuste da borda da folha: arraste os cantos ou as laterais');
    wrap.tabIndex = 0;
    Object.assign(wrap.style, {
      position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', overflow: 'hidden',
      touchAction: 'none', userSelect: 'none', webkitUserSelect: 'none', webkitTouchCallout: 'none',
      outline: 'none', webkitTapHighlightColor: 'transparent',
    });
    const layerStyle = { position: 'absolute', left: '0', top: '0', display: 'block' };
    const imgCanvas = doc.createElement('canvas');
    imgCanvas.className = 'cropper-image';
    Object.assign(imgCanvas.style, layerStyle, { pointerEvents: 'none' });
    const overlay = doc.createElement('canvas');
    overlay.className = 'cropper-overlay';
    Object.assign(overlay.style, layerStyle, { touchAction: 'none' });
    const loupe = doc.createElement('canvas');
    loupe.className = 'cropper-loupe';
    loupe.setAttribute('aria-hidden', 'true');
    Object.assign(loupe.style, layerStyle, {
      display: 'none', pointerEvents: 'none', willChange: 'transform, opacity', transformOrigin: '50% 50%',
    });
    wrap.appendChild(imgCanvas);
    wrap.appendChild(overlay);
    wrap.appendChild(loupe);
    container.appendChild(wrap);

    const octx = overlay.getContext('2d');
    const lctx = loupe.getContext('2d');

    function readColors() {
      const cs = win.getComputedStyle ? win.getComputedStyle(container) : null;
      const out = {};
      Object.keys(FALLBACK_COLORS).forEach((k) => {
        const v = cs && cs.getPropertyValue ? String(cs.getPropertyValue('--' + k) || '').trim() : '';
        out[k] = v || FALLBACK_COLORS[k];
      });
      return out;
    }

    function sizeCanvas(c, w, h) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }

    function buildPattern() {
      pattern = null;
      const tile = doc.createElement('canvas');
      const s = Math.max(4, Math.round(7 * dpr));
      tile.width = s; tile.height = s;
      const t = tile.getContext('2d');
      if (!t) return;
      t.fillStyle = colors.cream;
      circle(t, s / 2, s / 2, 1.15 * dpr);
      t.fill();
      pattern = octx.createPattern ? octx.createPattern(tile, 'repeat') : null;
    }

    function drawImageLayer() {
      const ctx = imgCanvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, imgCanvas.width, imgCanvas.height);
      if (!(fit.w > 0)) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.ink;
      ctx.fillRect(fit.x + 4, fit.y + 4, fit.w, fit.h);
      let s = image, sw = src.w, sh = src.h;
      const tw = fit.w * dpr, th = fit.h * dpr;
      const temps = [];
      while (sw > tw * 2.2 && sh > th * 2.2) {
        const t = doc.createElement('canvas');
        t.width = Math.max(1, Math.round(sw / 2));
        t.height = Math.max(1, Math.round(sh / 2));
        const tc = t.getContext('2d');
        tc.imageSmoothingEnabled = true;
        tc.imageSmoothingQuality = 'high';
        tc.drawImage(s, 0, 0, sw, sh, 0, 0, t.width, t.height);
        temps.push(t);
        s = t; sw = t.width; sh = t.height;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(s, 0, 0, sw, sh, fit.x, fit.y, fit.w, fit.h);
      temps.forEach((t) => { t.width = 0; t.height = 0; });
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = colors.ink;
      ctx.strokeRect(fit.x - 1.25, fit.y - 1.25, fit.w + 2.5, fit.h + 2.5);
    }

    function layout(force) {
      if (destroyed) return;
      const w = wrap.clientWidth || 0, h = wrap.clientHeight || 0;
      const d = Math.min(3, Math.max(1, win.devicePixelRatio || 1));
      if (!force && w === size.w && h === size.h && d === dpr) return;
      if (drag) finishDrag(true);
      size = { w: w, h: h };
      dpr = d;
      colors = readColors();
      fit = fitRect(w, h, src.w, src.h, cfg.padding);
      if (w <= 0 || h <= 0) return;
      sizeCanvas(imgCanvas, w, h);
      sizeCanvas(overlay, w, h);
      const ls = cfg.loupeSize + LOUPE_MARGIN * 2;
      sizeCanvas(loupe, ls, ls);
      drawImageLayer();
      buildPattern();
      requestRender();
    }

    /* ---------- rendering */

    function requestRender() {
      if (!rafId && !destroyed) rafId = raf(render);
    }

    function displayCorners(now) {
      if (!tween) return corners;
      const t = (now - tween.t0) / tween.dur;
      if (t >= 1) { tween = null; return corners; }
      return lerpCorners(tween.from, tween.to, easeOutCubic(t));
    }

    function slotOf(h) { return h ? (h.type === 'corner' ? h.index : 4 + h.index) : -1; }

    function stepHandleAnims(dt) {
      const active = slotOf(drag), hov = slotOf(hover), sel = keyboardFocus ? slotOf(selected) : -1;
      const f = reducedMotion() ? 1 : 1 - Math.exp(-dt / 55);
      let moving = false;
      for (let s = 0; s < 8; s++) {
        const target = s === active ? 1 : (s === hov ? 0.5 : (s === sel ? 0.6 : 0));
        const v = anim[s] + (target - anim[s]) * f;
        anim[s] = Math.abs(target - v) < 0.01 ? target : v;
        if (anim[s] !== target) moving = true;
      }
      return moving;
    }

    function drawCorner(ctx, p, k) {
      const C = colors;
      const r = CORNER_R * (1 + 0.2 * k);
      if (k > 0) {
        ctx.globalAlpha = 0.32 * k;
        ctx.fillStyle = C.orange;
        circle(ctx, p.x, p.y, r + 11 * k);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = C.ink;
      circle(ctx, p.x + 2, p.y + 2.5, r);
      ctx.fill();
      circle(ctx, p.x, p.y, r);
      ctx.fill();
      ctx.fillStyle = valid ? C.orange : C.red;
      circle(ctx, p.x, p.y, r - 3);
      ctx.fill();
      ctx.fillStyle = C.cream;
      ctx.beginPath();
      ctx.ellipse(p.x - r * 0.3, p.y - r * 0.36, r * 0.3, r * 0.17, -0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.ink;
      circle(ctx, p.x, p.y, 2.2);
      ctx.fill();
    }

    function drawPill(ctx, a, b, k) {
      const C = colors;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s = 1 + 0.18 * k;
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
      ctx.scale(s, s);
      ctx.fillStyle = C.ink;
      ctx.save();
      ctx.translate(1.5, 2);
      ctx.beginPath(); pillPath(ctx, PILL_LEN, PILL_THICK); ctx.fill();
      ctx.restore();
      ctx.beginPath(); pillPath(ctx, PILL_LEN, PILL_THICK); ctx.fill();
      ctx.fillStyle = k > 0.75 ? (valid ? C.orange : C.red) : C.cream;
      ctx.beginPath(); pillPath(ctx, PILL_LEN - 5.5, PILL_THICK - 5.5); ctx.fill();
      ctx.restore();
    }

    function drawOverlay(pts) {
      const ctx = octx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (!pts || !(fit.w > 0)) return;
      const C = colors;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      ctx.beginPath();
      ctx.rect(fit.x, fit.y, fit.w, fit.h);
      quadPath(ctx, pts);
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = C.ink;
      ctx.fill('evenodd');
      if (pattern) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 0.09;
        ctx.fillStyle = pattern;
        ctx.fill('evenodd');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.globalAlpha = 1;

      if (!valid) {
        ctx.beginPath();
        quadPath(ctx, pts);
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = C.red;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      for (let i = 0; i < 4; i++) {
        const k = anim[4 + i];
        if (k <= 0) continue;
        const a = pts[i], b = pts[(i + 1) % 4];
        ctx.globalAlpha = 0.6 * k;
        ctx.strokeStyle = C.cream;
        ctx.lineWidth = 14;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.beginPath();
      quadPath(ctx, pts);
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = valid ? C.orange : C.red;
      ctx.lineWidth = 3.2;
      ctx.stroke();

      const top = slotOf(drag) >= 0 ? slotOf(drag) : slotOf(hover);
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) % 4];
        if (4 + i !== top && dist(a, b) >= MIN_EDGE_FOR_MID) drawPill(ctx, a, b, anim[4 + i]);
      }
      for (let i = 0; i < 4; i++) if (i !== top) drawCorner(ctx, pts[i], anim[i]);
      if (top >= 4) {
        const i = top - 4, a = pts[i], b = pts[(i + 1) % 4];
        if (dist(a, b) >= MIN_EDGE_FOR_MID) drawPill(ctx, a, b, anim[top]);
      } else if (top >= 0) {
        drawCorner(ctx, pts[top], anim[top]);
      }
    }

    function drawLoupe(index) {
      const ctx = lctx;
      const D = cfg.loupeSize, m = LOUPE_MARGIN, R = D / 2, cx = m + R, cy = m + R;
      const C = colors;
      const c = shown[index];
      const center = { x: c.x * src.w, y: c.y * src.h };
      const L = loupeSource(center, D, fit.scale, cfg.loupeZoom, src.w, src.h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, loupe.width, loupe.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      ctx.fillStyle = C.ink;
      circle(ctx, cx + 3.5, cy + 4, R - 1);
      ctx.fill();

      ctx.save();
      circle(ctx, cx, cy, R - 2);
      ctx.clip();
      ctx.fillStyle = C.ink;
      ctx.fillRect(m, m, D, D);
      if (L.clip) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const q = L.clip;
        ctx.drawImage(image, q.sx, q.sy, q.sw, q.sh, m + q.dx, m + q.dy, q.dw, q.dh);
      }
      const lpts = shown.map((p) => ({ x: m + (p.x * src.w - L.sx) * L.k, y: m + (p.y * src.h - L.sy) * L.k }));
      ctx.beginPath();
      ctx.rect(m, m, D, D);
      quadPath(ctx, lpts);
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = C.ink;
      ctx.fill('evenodd');
      ctx.globalAlpha = 1;
      ctx.beginPath();
      quadPath(ctx, lpts);
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.strokeStyle = valid ? C.orange : C.red;
      ctx.lineWidth = 2;
      ctx.stroke();

      const arm = (x0, y0, x1, y1) => { ctx.moveTo(cx + x0, cy + y0); ctx.lineTo(cx + x1, cy + y1); };
      ctx.beginPath();
      arm(-17, 0, -5, 0); arm(5, 0, 17, 0); arm(0, -17, 0, -5); arm(0, 5, 0, 17);
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 3.6;
      ctx.stroke();
      ctx.strokeStyle = C.cream;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      circle(ctx, cx, cy, 2.4);
      ctx.fillStyle = C.blue;
      ctx.fill();
      ctx.restore();

      circle(ctx, cx, cy, R - 2);
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 4;
      ctx.stroke();
      circle(ctx, cx, cy, R - 5.5);
      ctx.strokeStyle = C.cream;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, R - 12, Math.PI * 1.08, Math.PI * 1.38);
      ctx.strokeStyle = C.cream;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function stepLoupe(dt, pts) {
      const want = !!(drag && drag.type === 'corner' && drag.showLoupe && pts);
      const target = want ? 1 : 0;
      const reduced = reducedMotion();
      lp.t = reduced ? target : clamp(lp.t + (want ? dt / 140 : -dt / 90), 0, 1);
      if (lp.t <= 0) {
        if (lp.visible) {
          loupe.style.display = 'none';
          lp.visible = false; lp.placed = false; lp.side = null;
        }
        return false;
      }
      let moving = false;
      if (want) {
        const place = loupePlacement(drag.last, pts[drag.index], cfg.loupeSize, size, { prefer: lp.side });
        lp.side = place.side;
        if (!lp.placed || reduced) {
          lp.x = place.x; lp.y = place.y; lp.placed = true;
        } else {
          const f = 1 - Math.exp(-dt / 50);
          lp.x += (place.x - lp.x) * f;
          lp.y += (place.y - lp.y) * f;
          if (Math.abs(place.x - lp.x) < 0.3 && Math.abs(place.y - lp.y) < 0.3) { lp.x = place.x; lp.y = place.y; }
          else moving = true;
        }
        drawLoupe(drag.index);
      }
      if (!lp.visible) { loupe.style.display = 'block'; lp.visible = true; }
      const half = cfg.loupeSize / 2 + LOUPE_MARGIN;
      const s = reduced ? 1 : 0.55 + 0.45 * easeOutBack(lp.t);
      loupe.style.transform = 'translate3d(' + (lp.x - half).toFixed(2) + 'px,' + (lp.y - half).toFixed(2) + 'px,0) scale(' + s.toFixed(3) + ')';
      loupe.style.opacity = String(Math.min(1, lp.t * 1.6));
      return moving || lp.t !== target;
    }

    function render() {
      rafId = 0;
      if (destroyed) return;
      const now = nowMs();
      const dt = lastFrame ? clamp(now - lastFrame, 0, 64) : 16;
      lastFrame = now;
      const changed = drag ? applyDrag() : false;
      shown = displayCorners(now);
      let again = !!tween;
      const pts = fit.w > 0 ? cornersToScreen(shown, fit) : null;
      if (stepHandleAnims(dt)) again = true;
      drawOverlay(pts);
      if (stepLoupe(dt, pts)) again = true;
      if (changed) emit('drag');
      if (again) requestRender();
      else lastFrame = 0;
    }

    function emit(source) {
      if (!onChange) return;
      try {
        onChange(copyPts(corners), valid, { source: source });
      } catch (err) {
        if (win.console && win.console.error) win.console.error(err);
      }
    }

    /* ---------- interaction */

    function localPoint(e) { return { x: e.clientX - rect.left, y: e.clientY - rect.top }; }

    function pickAt(p) {
      return nearestHandle(p, cornersToScreen(shown, fit), {
        hitRadius: cfg.hitRadius, minEdgeLength: MIN_EDGE_FOR_MID,
      });
    }

    function applyDrag() {
      const d = { x: drag.last.x - drag.start.x, y: drag.last.y - drag.start.y };
      if (!drag.moved) {
        if (Math.hypot(d.x, d.y) < cfg.dragThreshold) return false;
        drag.moved = true;
        if (drag.type === 'corner') drag.showLoupe = true;
      }
      const b = fitBounds(fit);
      const next = drag.type === 'corner'
        ? moveCorner(drag.startPts, drag.index, d, b)
        : moveEdge(drag.startPts, drag.index, d, b);
      const n = cornersToNorm(next, fit, true);
      if (sameCorners(n, corners)) return false;
      corners = n;
      shown = n;
      valid = isConvexQuad(corners, cfg.minArea);
      return true;
    }

    function buzz(e) {
      const nav = win.navigator;
      if (!nav || typeof nav.vibrate !== 'function' || e.pointerType === 'mouse') return;
      if (nav.userActivation && !nav.userActivation.hasBeenActive) return;
      try { nav.vibrate(8); } catch (_) { /* unsupported */ }
    }

    function onPointerDown(e) {
      if (destroyed || drag) return;
      if (e.isPrimary === false) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!(fit.w > 0)) return;
      rect = wrap.getBoundingClientRect();
      if (tween) {
        corners = copyPts(shown);
        tween = null;
        valid = isConvexQuad(corners, cfg.minArea);
      }
      const p = localPoint(e);
      const h = pickAt(p);
      if (!h) return;
      if (e.cancelable !== false && e.preventDefault) e.preventDefault();
      try { overlay.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
      drag = {
        id: e.pointerId, type: h.type, index: h.index, start: p, last: p,
        startPts: cornersToScreen(corners, fit), startNorm: copyPts(corners), moved: false, showLoupe: false,
      };
      selected = { type: h.type, index: h.index };
      hover = null;
      overlay.style.cursor = 'grabbing';
      if (h.type === 'corner' && cfg.holdMs >= 0) {
        holdTimer = win.setTimeout(() => {
          holdTimer = 0;
          if (drag && drag.type === 'corner') { drag.showLoupe = true; requestRender(); }
        }, cfg.holdMs);
      }
      buzz(e);
      requestRender();
    }

    function onPointerMove(e) {
      if (destroyed) return;
      if (!drag) {
        if (e.pointerType !== 'mouse' || !(fit.w > 0)) return;
        rect = wrap.getBoundingClientRect();
        const h = pickAt(localPoint(e));
        if (slotOf(h) !== slotOf(hover)) {
          hover = h;
          overlay.style.cursor = h ? 'grab' : '';
          requestRender();
        }
        return;
      }
      if (e.pointerId !== drag.id) return;
      if (e.cancelable !== false && e.preventDefault) e.preventDefault();
      drag.last = localPoint(e);
      requestRender();
    }

    function onPointerEnd(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const cancelled = e.type !== 'pointerup';
      if (!cancelled) drag.last = localPoint(e);
      finishDrag(cancelled);
    }

    function onPointerLeave(e) {
      if (!drag && hover && e.pointerType === 'mouse') {
        hover = null;
        overlay.style.cursor = '';
        requestRender();
      }
    }

    function finishDrag(cancelled) {
      const d = drag;
      if (!d) return;
      const changed = !cancelled && applyDrag();
      if (holdTimer) { win.clearTimeout(holdTimer); holdTimer = 0; }
      drag = null;
      try { overlay.releasePointerCapture(d.id); } catch (_) { /* already released */ }
      overlay.style.cursor = '';
      let source = 'end';
      if (d.moved && !valid && cfg.untangle) {
        const fixed = untangle(corners, d.startNorm, cfg.minArea);
        if (fixed) {
          corners = fixed;
          shown = fixed;
          valid = true;
          source = 'untangle';
        }
      }
      if (changed || d.moved) emit(source);
      requestRender();
    }

    function onKeyDown(e) {
      if (!(fit.w > 0) || drag) return;
      const k = e.key;
      if (k >= '1' && k <= '4') {
        selected = { type: 'corner', index: +k - 1 };
        keyboardFocus = true;
        requestRender();
        e.preventDefault();
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const delta = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }[k];
      if (!delta) return;
      e.preventDefault();
      if (tween) { corners = copyPts(shown); tween = null; }
      keyboardFocus = true;
      const pts = cornersToScreen(corners, fit), b = fitBounds(fit);
      const next = selected.type === 'corner'
        ? moveCorner(pts, selected.index, delta, b)
        : moveEdge(pts, selected.index, delta, b);
      corners = cornersToNorm(next, fit, true);
      shown = corners;
      valid = isConvexQuad(corners, cfg.minArea);
      emit('key');
      requestRender();
    }

    function onFocus() { keyboardFocus = false; requestRender(); }
    function onBlur() { keyboardFocus = false; requestRender(); }
    function blockTouch(e) { if (e.cancelable) e.preventDefault(); }
    function onWinResize() { layout(false); }

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerEnd);
    overlay.addEventListener('pointercancel', onPointerEnd);
    overlay.addEventListener('lostpointercapture', onPointerEnd);
    overlay.addEventListener('pointerleave', onPointerLeave);
    wrap.addEventListener('touchstart', blockTouch, { passive: false });
    wrap.addEventListener('touchmove', blockTouch, { passive: false });
    wrap.addEventListener('keydown', onKeyDown);
    wrap.addEventListener('focus', onFocus);
    wrap.addEventListener('blur', onBlur);

    let ro = null;
    if (typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver(() => layout(false));
      ro.observe(wrap);
    }
    win.addEventListener('resize', onWinResize);
    win.addEventListener('orientationchange', onWinResize);

    layout(true);

    return {
      getCorners() { return copyPts(corners); },

      setCorners(next, opts) {
        if (destroyed) return false;
        const n = sanitizeCorners(next);
        if (!n) return false;
        if (drag) finishDrag(true);
        const animate = !!(opts && opts.animate) && cfg.animMs > 0 && !reducedMotion() && fit.w > 0;
        tween = animate ? { from: copyPts(shown), to: n, t0: nowMs(), dur: cfg.animMs } : null;
        corners = n;
        if (!animate) shown = n;
        valid = isConvexQuad(corners, cfg.minArea);
        emit('set');
        requestRender();
        return true;
      },

      isValid() { return valid; },

      relayout() { layout(true); },

      destroy() {
        if (destroyed) return;
        if (drag) finishDrag(true);
        destroyed = true;
        if (rafId) { caf(rafId); rafId = 0; }
        if (holdTimer) { win.clearTimeout(holdTimer); holdTimer = 0; }
        if (ro) { ro.disconnect(); ro = null; }
        win.removeEventListener('resize', onWinResize);
        win.removeEventListener('orientationchange', onWinResize);
        overlay.removeEventListener('pointerdown', onPointerDown);
        overlay.removeEventListener('pointermove', onPointerMove);
        overlay.removeEventListener('pointerup', onPointerEnd);
        overlay.removeEventListener('pointercancel', onPointerEnd);
        overlay.removeEventListener('lostpointercapture', onPointerEnd);
        overlay.removeEventListener('pointerleave', onPointerLeave);
        wrap.removeEventListener('touchstart', blockTouch, { passive: false });
        wrap.removeEventListener('touchmove', blockTouch, { passive: false });
        wrap.removeEventListener('keydown', onKeyDown);
        wrap.removeEventListener('focus', onFocus);
        wrap.removeEventListener('blur', onBlur);
        [imgCanvas, overlay, loupe].forEach((c) => { c.width = 0; c.height = 0; });
        pattern = null;
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (patchedPosition) container.style.position = prevPosition;
      },
    };
  }

  return {
    create: create,
    version: '2.0.0',
    _geom: {
      clamp: clamp,
      fitRect: fitRect,
      fitBounds: fitBounds,
      normToScreen: normToScreen,
      screenToNorm: screenToNorm,
      cornersToScreen: cornersToScreen,
      cornersToNorm: cornersToNorm,
      clampPoint: clampPoint,
      midpoints: midpoints,
      segmentDistance: segmentDistance,
      nearestHandle: nearestHandle,
      moveCorner: moveCorner,
      moveEdge: moveEdge,
      signedArea: signedArea,
      isConvexQuad: isConvexQuad,
      orderCorners: orderCorners,
      untangle: untangle,
      lerpCorners: lerpCorners,
      easeOutCubic: easeOutCubic,
      easeOutBack: easeOutBack,
      loupePlacement: loupePlacement,
      loupeSource: loupeSource,
      sanitizeCorners: sanitizeCorners,
      defaultCorners: defaultCorners,
    },
  };
});
