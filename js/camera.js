/* DocScan v2 — CameraCtl: live viewfinder, document outline tracking and auto-capture.
   Browser: window.CameraCtl. Node: module.exports (pure helpers in _math / _Stability). */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.CameraCtl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const hasOwn = Object.prototype.hasOwnProperty;
  function noop() {}
  function assign(target) {
    for (let i = 1; i < arguments.length; i++) {
      const src = arguments[i];
      if (!src) continue;
      for (const k in src) if (hasOwn.call(src, k) && src[k] !== undefined) target[k] = src[k];
    }
    return target;
  }
  function logError(e) {
    if (root && root.console && root.console.error) root.console.error(e);
  }

  /* ------------------------------------------------------------------ math */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function copyCorners(c) { return c.map((p) => ({ x: +p.x, y: +p.y })); }

  // object-fit: cover with centered object-position: screen = src * scale + (dx, dy)
  function coverTransform(srcW, srcH, boxW, boxH) {
    if (!(srcW > 0 && srcH > 0 && boxW > 0 && boxH > 0)) return { scale: 0, dx: 0, dy: 0, drawW: 0, drawH: 0 };
    const scale = Math.max(boxW / srcW, boxH / srcH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    return { scale, dx: (boxW - drawW) / 2, dy: (boxH - drawH) / 2, drawW, drawH };
  }

  function mapNormToBox(points, srcW, srcH, boxW, boxH) {
    const tf = coverTransform(srcW, srcH, boxW, boxH);
    return points.map((p) => ({ x: tf.dx + p.x * tf.drawW, y: tf.dy + p.y * tf.drawH }));
  }

  function mapBoxToNorm(points, srcW, srcH, boxW, boxH) {
    const tf = coverTransform(srcW, srcH, boxW, boxH);
    if (!tf.scale) return points.map(() => ({ x: 0, y: 0 }));
    return points.map((p) => ({ x: (p.x - tf.dx) / tf.drawW, y: (p.y - tf.dy) / tf.drawH }));
  }

  function visibleRect(srcW, srcH, boxW, boxH) {
    const tf = coverTransform(srcW, srcH, boxW, boxH);
    if (!tf.scale) return { x0: 0, y0: 0, x1: 1, y1: 1 };
    return { x0: -tf.dx / tf.drawW, y0: -tf.dy / tf.drawH, x1: (boxW - tf.dx) / tf.drawW, y1: (boxH - tf.dy) / tf.drawH };
  }

  function downscaleSize(w, h, maxDim) {
    const s = Math.min(1, maxDim / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  // distance between normalized points, measured in pixels of a frame with this aspect, as a fraction of its diagonal
  function pointDist(a, b, aspect) {
    const asp = aspect > 0 ? aspect : 1;
    const dx = (a.x - b.x) * asp;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy) / Math.sqrt(asp * asp + 1);
  }

  function maxCornerDist(A, B, aspect) {
    let m = 0;
    for (let i = 0; i < 4; i++) m = Math.max(m, pointDist(A[i], B[i], aspect));
    return m;
  }

  function meanCornerDist(A, B, aspect) {
    let s = 0;
    for (let i = 0; i < 4; i++) s += pointDist(A[i], B[i], aspect);
    return s / 4;
  }

  function alignCyclic(corners, ref, aspect) {
    let best = 0;
    let bestCost = Infinity;
    for (let r = 0; r < 4; r++) {
      let cost = 0;
      for (let i = 0; i < 4; i++) {
        const d = pointDist(corners[(i + r) % 4], ref[i], aspect);
        cost += d * d;
      }
      if (cost < bestCost - 1e-12) { bestCost = cost; best = r; }
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = corners[(i + best) % 4];
      out.push({ x: p.x, y: p.y });
    }
    return out;
  }

  // y points down, so ascending atan2 walks clockwise on screen: TL, TR, BR, BL
  function orderCorners(points) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < 4; i++) { cx += points[i].x; cy += points[i].y; }
    cx /= 4; cy /= 4;
    const pts = points.slice(0, 4).map((p) => ({ x: p.x, y: p.y, a: Math.atan2(p.y - cy, p.x - cx) }));
    pts.sort((p, q) => p.a - q.a);
    let start = 0;
    let best = Infinity;
    for (let i = 0; i < 4; i++) {
      const s = pts[i].x + pts[i].y;
      if (s < best) { best = s; start = i; }
    }
    const out = [];
    for (let k = 0; k < 4; k++) {
      const p = pts[(start + k) % 4];
      out.push({ x: p.x, y: p.y });
    }
    return out;
  }

  function quadArea(c) {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  function isConvexQuad(c) {
    if (!c || c.length !== 4) return false;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      const d = c[(i + 2) % 4];
      const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
      if (!isFinite(cross) || Math.abs(cross) < 1e-12) return false;
      const s = cross > 0 ? 1 : -1;
      if (!sign) sign = s;
      else if (s !== sign) return false;
    }
    return quadArea(c) > 1e-6;
  }

  function validCorners(c) {
    if (!c || c.length !== 4) return false;
    for (let i = 0; i < 4; i++) {
      const p = c[i];
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return false;
    }
    return isConvexQuad(c);
  }

  function perimeter(P) {
    let s = 0;
    for (let i = 0; i < P.length; i++) {
      const a = P[i];
      const b = P[(i + 1) % P.length];
      s += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return s;
  }

  // exact step of a critically damped spring: e(t) = (e0 + (v0 + w*e0) t) e^(-w t)
  function springStep(x, v, target, omega, dt) {
    const e = x - target;
    const k = Math.exp(-omega * dt);
    const c = v + omega * e;
    return [target + (e + c * dt) * k, (v - omega * c * dt) * k];
  }

  function smoothingAlpha(dt, tau) {
    return tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  }

  // constant-rate step toward target: a full 0..1 transition takes exactly durS seconds
  function approach(cur, target, dt, durS) {
    if (!(durS > 0)) return target;
    const step = dt / durS;
    return cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
  }

  function smoothstep(t) {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function computeInterval(avgMs, onMain, o) {
    o = o || {};
    const base = o.baseInterval || 110;
    const maxI = o.maxInterval || 650;
    const ms = avgMs > 0 ? avgMs : 0;
    const want = onMain ? ms * (o.mainLoadFactor || 4) : ms + (o.workerGap || 40);
    return Math.round(clamp(Math.max(base, want), base, maxI));
  }

  // gray at half resolution (2x2 mean), then two box passes of radius 2 (~tent of 17 source px at 320)
  function blurredGray(img) {
    const W = img.width;
    const H = img.height;
    const d = img.data;
    const f = W >= 16 && H >= 16 ? 2 : 1;
    const w = Math.max(1, Math.floor(W / f));
    const h = Math.max(1, Math.floor(H / f));
    let g = new Float32Array(w * h);
    const norm = 1 / (f * f);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = 0; dy < f; dy++) {
          let i = ((y * f + dy) * W + x * f) * 4;
          for (let dx = 0; dx < f; dx++, i += 4) s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        }
        g[y * w + x] = s * norm;
      }
    }
    const r = 2;
    const tmp = new Float32Array(w * h);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let s = 0;
        for (let x = -r; x <= r; x++) s += g[row + clamp(x, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          tmp[row + x] = s / (2 * r + 1);
          s += g[row + Math.min(w - 1, x + r + 1)] - g[row + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          g[y * w + x] = s / (2 * r + 1);
          s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
      }
    }
    return { g, w, h };
  }

  function grayBilinear(g, w, h, x, y) {
    const fx = clamp(x - 0.5, 0, w - 1);
    const fy = clamp(y - 0.5, 0, h - 1);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0;
    const y1 = y0 + 1 < h ? y0 + 1 : y0;
    const ax = fx - x0;
    const ay = fy - y0;
    const a = g[y0 * w + x0];
    const b = g[y0 * w + x1];
    const c = g[y1 * w + x0];
    const e = g[y1 * w + x1];
    return (a + (b - a) * ax) * (1 - ay) + (c + (e - c) * ax) * ay;
  }

  // grid x grid luminance means sampled inside the quad (bilinear in quad space), normalized to zero mean /
  // unit spread so exposure changes do not count as a different page. Sampling a blurred copy keeps text lines
  // and cell borders from aliasing: on real frames this cut same-page jitter ~8x while page changes stayed large.
  function quadSignature(img, corners, grid, sub) {
    grid = grid || 8;
    sub = sub || 6;
    const bg = blurredGray(img);
    const w = bg.w;
    const h = bg.h;
    const g = bg.g;
    const c = corners;
    const n = grid * grid;
    const out = new Float32Array(n);
    const inset = 0.06;
    const span = 1 - 2 * inset;
    let mean = 0;
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        let sum = 0;
        for (let sy = 0; sy < sub; sy++) {
          const v = inset + span * (gy + (sy + 0.5) / sub) / grid;
          for (let sx = 0; sx < sub; sx++) {
            const u = inset + span * (gx + (sx + 0.5) / sub) / grid;
            const w0 = (1 - u) * (1 - v);
            const w1 = u * (1 - v);
            const w2 = u * v;
            const w3 = (1 - u) * v;
            const x = w0 * c[0].x + w1 * c[1].x + w2 * c[2].x + w3 * c[3].x;
            const y = w0 * c[0].y + w1 * c[1].y + w2 * c[2].y + w3 * c[3].y;
            sum += grayBilinear(g, w, h, x * w, y * h);
          }
        }
        const m = sum / (sub * sub);
        out[gy * grid + gx] = m;
        mean += m;
      }
    }
    mean /= n;
    let varSum = 0;
    for (let i = 0; i < n; i++) varSum += (out[i] - mean) * (out[i] - mean);
    const sd = Math.max(6, Math.sqrt(varSum / n));
    for (let i = 0; i < n; i++) out[i] = (out[i] - mean) / sd;
    return out;
  }

  function signatureDistance(a, b) {
    if (!a || !b || a.length !== b.length || !a.length) return Infinity;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  function parseColor(str, fallback) {
    if (Array.isArray(str) && str.length >= 3) return [str[0], str[1], str[2]];
    const s = typeof str === 'string' ? str.trim() : '';
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      let hx = m[1];
      if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
      return [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (m) return [+m[1], +m[2], +m[3]];
    return fallback;
  }

  function mixRgb(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }

  function rgba(c, a) {
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (Math.round(a * 1000) / 1000) + ')';
  }

  /* ------------------------------------------------------------- stability */

  const STABILITY_DEFAULTS = {
    aspect: 4 / 3,
    stableThresh: 0.015,
    stableMs: 900,
    autoMs: 1200,
    cooldownMs: 1500,
    lostMs: 400,
    outlierThresh: 0.12,
    confirmThresh: 0.06,
    rearmThresh: 0.08,
    sigThresh: 0.22,
    sigFrames: 2,
    minAutoConfidence: 0.2,
    autoCapture: false,
  };

  function Stability(opts) {
    this.o = assign({}, STABILITY_DEFAULTS, opts);
    this.autoCapture = !!this.o.autoCapture;
    this.reset();
  }

  Stability.DEFAULTS = STABILITY_DEFAULTS;

  Stability.prototype.reset = function () {
    this.shot = null;
    this.needsChange = false;
    this.sigHits = 0;
    this.cooldownUntil = -Infinity;
    this.armedAt = -Infinity;
    this.wasArmed = false;
    this.resetTrack();
  };

  Stability.prototype.resetTrack = function () {
    this.target = null;
    this.lastSeen = -Infinity;
    this.conf = 0;
    this.cand = null;
    this.stillStart = 0;
    this.anchor = null;
    this.anchorN = 0;
  };

  Stability.prototype.setAspect = function (aspect) {
    if (!(aspect > 0) || Math.abs(aspect - this.o.aspect) <= 1e-3) return false;
    this.o.aspect = aspect;
    this.resetTrack();
    this.shot = null;
    this.needsChange = false;
    return true;
  };

  Stability.prototype.setAutoCapture = function (on, t) {
    on = !!on;
    if (on && !this.autoCapture && typeof t === 'number') this.armedAt = t;
    this.autoCapture = on;
  };

  Stability.prototype.noteCapture = function (t, sig) {
    this.shot = { t, corners: this.target ? copyCorners(this.target) : null, sig: sig || null };
    this.needsChange = !!this.target;
    this.sigHits = 0;
    this.cooldownUntil = t + this.o.cooldownMs;
    this.wasArmed = false;
  };

  // the still window keeps, per corner, the bounding box of every position seen since it started
  // (minX, maxX, minY, maxY); "still" means no corner's box grew beyond stableThresh of the diagonal
  Stability.prototype._restartStill = function (c, t) {
    this.stillStart = t;
    const a = [];
    for (let i = 0; i < 4; i++) a.push(c[i].x, c[i].x, c[i].y, c[i].y);
    this.anchor = a;
    this.anchorN = 1;
  };

  Stability.prototype._extendStill = function (c) {
    const a = this.anchor;
    const asp = this.o.aspect;
    const next = a.slice();
    let spread = 0;
    for (let i = 0; i < 4; i++) {
      const k = 4 * i;
      if (c[i].x < next[k]) next[k] = c[i].x;
      if (c[i].x > next[k + 1]) next[k + 1] = c[i].x;
      if (c[i].y < next[k + 2]) next[k + 2] = c[i].y;
      if (c[i].y > next[k + 3]) next[k + 3] = c[i].y;
      const s = pointDist({ x: next[k], y: next[k + 2] }, { x: next[k + 1], y: next[k + 3] }, asp);
      if (s > spread) spread = s;
    }
    if (spread > this.o.stableThresh) return false;
    this.anchor = next;
    this.anchorN++;
    return true;
  };

  Stability.prototype.update = function (corners, t, info) {
    const o = this.o;
    const a = o.aspect;
    info = info || {};
    const conf = typeof info.confidence === 'number' && isFinite(info.confidence) ? clamp(info.confidence, 0, 1) : 1;
    let event = 'none';

    if (validCorners(corners)) {
      const raw = copyCorners(corners);
      const cand = this.cand && t - this.cand.t <= o.lostMs ? this.cand : null;
      if (!this.target) {
        if (cand) {
          const al = alignCyclic(raw, cand.corners, a);
          if (maxCornerDist(al, cand.corners, a) <= o.confirmThresh) {
            this.target = al;
            this.cand = null;
            this.lastSeen = t;
            this.conf = (cand.conf + conf) / 2;
            this._restartStill(al, t);
            event = 'start';
          }
        }
        if (event === 'none') {
          this.cand = { corners: raw, t, conf };
          event = 'candidate';
        }
      } else {
        const al = alignCyclic(raw, this.target, a);
        const d = maxCornerDist(al, this.target, a);
        if (d > o.outlierThresh) {
          const confirmed = cand && maxCornerDist(alignCyclic(al, cand.corners, a), cand.corners, a) <= o.confirmThresh;
          if (confirmed) {
            this.target = al;
            this.cand = null;
            this.lastSeen = t;
            this.conf = conf;
            this._restartStill(al, t);
            event = 'jump';
          } else {
            this.cand = { corners: al, t, conf };
            event = 'outlier';
          }
        } else {
          // small moves are mostly detector jitter (strong smoothing); larger ones follow quickly
          const k = 0.35 + 0.55 * clamp((d - 0.004) / 0.04, 0, 1);
          for (let i = 0; i < 4; i++) {
            this.target[i].x += (al[i].x - this.target[i].x) * k;
            this.target[i].y += (al[i].y - this.target[i].y) * k;
          }
          this.lastSeen = t;
          this.cand = null;
          this.conf = this.conf * 0.6 + conf * 0.4;
          if (!this.anchorN || !this._extendStill(al)) this._restartStill(al, t);
          event = 'track';
        }
      }
    }

    if (this.target && t - this.lastSeen > o.lostMs) {
      const keep = this.cand;
      this.resetTrack();
      this.cand = keep;
      if (this.shot) this.needsChange = false;
      event = 'lost';
    }
    if (!this.target && this.cand && t - this.cand.t > o.lostMs) this.cand = null;

    if (this.needsChange && this.target && this.shot) {
      const sc = this.shot.corners;
      if (sc && maxCornerDist(alignCyclic(this.target, sc, a), sc, a) > o.rearmThresh) this.needsChange = false;
      else if (info.sig && this.shot.sig) {
        this.sigHits = signatureDistance(info.sig, this.shot.sig) > o.sigThresh ? this.sigHits + 1 : 0;
        if (this.sigHits >= o.sigFrames) this.needsChange = false;
      }
    }

    const armed = !this.needsChange && t >= this.cooldownUntil;
    if (armed && !this.wasArmed) this.armedAt = t;
    this.wasArmed = armed;

    const detected = !!this.target;
    const stillFor = detected && this.anchorN ? t - this.stillStart : 0;
    const stable = detected && stillFor >= o.stableMs;
    let progress = 0;
    if (detected) {
      if (this.autoCapture) progress = armed ? clamp((t - Math.max(this.stillStart, this.armedAt)) / o.autoMs, 0, 1) : 0;
      else progress = clamp(stillFor / o.stableMs, 0, 1);
    }

    let fire = false;
    if (this.autoCapture && armed && detected && event === 'track' && progress >= 1 && this.conf >= o.minAutoConfidence) {
      fire = true;
      this.noteCapture(t, info.sig);
    }

    return {
      detected,
      stable,
      stableProgress: progress,
      confidence: detected ? this.conf : 0,
      armed,
      fire,
      event,
      corners: detected ? copyCorners(this.target) : null,
    };
  };

  /* ------------------------------------------------------------ controller */

  const CONTROLLER_DEFAULTS = {
    liveMaxDim: 320,
    baseInterval: 110,
    maxInterval: 650,
    mainLoadFactor: 4,
    workerGap: 40,
    minGapMs: 8,
    workerTimeoutMs: 2500,
    workerFirstTimeoutMs: 6000,
    fadeMs: 400,
    fadeInMs: 140,
    fadeOutMs: 280,
    colorMs: 220,
    springOmega: 22,
    maxCaptureDim: 3000,
    startTimeoutMs: 8000,
    idealWidth: 1920,
    idealHeight: 1440,
  };

  const ERROR_MESSAGES = {
    NO_CAMERA: 'Nenhuma câmera disponível.',
    DENIED: 'Permissão da câmera negada.',
    INSECURE: 'A câmera ao vivo precisa de uma conexão segura (HTTPS).',
    NOT_READY: 'A câmera ainda não está pronta.',
  };

  function camError(code, cause) {
    const e = new Error(ERROR_MESSAGES[code] || code);
    e.name = 'CameraError';
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }

  function makeEnv(over) {
    const g = root || {};
    const env = {
      now: () => (g.performance && g.performance.now ? g.performance.now() : Date.now()),
      setTimeout: (f, ms) => g.setTimeout(f, ms),
      clearTimeout: (id) => g.clearTimeout(id),
      requestAnimationFrame: (f) => (g.requestAnimationFrame ? g.requestAnimationFrame(f) : g.setTimeout(() => f(env.now()), 16)),
      cancelAnimationFrame: (id) => (g.cancelAnimationFrame ? g.cancelAnimationFrame(id) : g.clearTimeout(id)),
      document: g.document,
      navigator: g.navigator,
      Worker: g.Worker,
      isSecureContext: g.isSecureContext,
      devicePixelRatio: () => g.devicePixelRatio || 1,
      getComputedStyle: g.getComputedStyle ? (el) => g.getComputedStyle(el) : null,
      matchMedia: g.matchMedia ? (q) => g.matchMedia(q) : null,
      createCanvas: (w, h) => {
        const c = env.document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      },
      detector: () => g.DocDetect,
    };
    return assign(env, over);
  }

  function stopStream(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    stream.getTracks().forEach((tr) => { try { tr.stop(); } catch (e) { /* already stopped */ } });
  }

  function create(opts) {
    opts = opts || {};
    const video = opts.video;
    const overlay = opts.overlay || null;
    if (!video) throw new TypeError('CameraCtl.create: "video" é obrigatório');
    const env = makeEnv(opts._env);
    const cfg = assign({}, CONTROLLER_DEFAULTS, opts);
    const stabOpts = {};
    for (const k in STABILITY_DEFAULTS) if (opts[k] !== undefined) stabOpts[k] = opts[k];
    stabOpts.autoCapture = !!opts.autoCapture;
    const tracker = new Stability(stabOpts);

    const st = {
      token: 0,
      starting: null,
      running: false,
      paused: false,
      stream: null,
      ownStream: false,
      track: null,
      restarting: false,
      hasTorch: false,
      torchOn: false,
      autoCapture: !!opts.autoCapture,
      worker: null,
      workerFailed: false,
      workerReplies: 0,
      workerErrors: 0,
      mode: 'none',
      inFlight: false,
      pending: null,
      reqId: 0,
      timer: 0,
      raf: 0,
      avgMs: 0,
      intervalMs: cfg.baseInterval,
      frames: 0,
      work: null,
      wctx: null,
      octx: null,
      lastSig: null,
      status: { detected: false, stable: false, stableProgress: 0, confidence: 0, armed: false, autoCapture: !!opts.autoCapture },
      statusKey: '',
      statusT: 0,
      colors: null,
      reducedMotion: false,
      listening: false,
    };

    const disp = {
      pts: null,
      vel: [0, 0, 0, 0, 0, 0, 0, 0],
      opacity: 0,
      stableMix: 0,
      stableOn: false,
      progress: 0,
      pulseT: -1e9,
      flashT: -1e9,
      lastT: 0,
      cssW: 0,
      cssH: 0,
      dpr: 0,
      vw: 0,
      vh: 0,
      dirty: true,
    };

    function isHidden() { return !!(env.document && env.document.hidden); }
    function active() { return st.running && !st.paused && !isHidden(); }

    function setMode(m) { st.mode = m; }

    function mainDetector() {
      const D = opts.detector || env.detector();
      return D && typeof D.detect === 'function' ? D : null;
    }

    /* ---------------- status */

    function emitStatus(s) {
      const out = {
        detected: !!s.detected,
        stable: !!s.stable,
        stableProgress: Math.round(clamp(s.stableProgress || 0, 0, 1) * 100) / 100,
        confidence: Math.round(clamp(s.confidence || 0, 0, 1) * 100) / 100,
        armed: !!s.armed,
        autoCapture: st.autoCapture,
      };
      st.status = out;
      const key = [out.detected, out.stable, out.stableProgress, out.confidence, out.armed, out.autoCapture].join('|');
      if (key === st.statusKey) return;
      st.statusKey = key;
      if (typeof opts.onStatus === 'function') {
        try { opts.onStatus(assign({}, out)); } catch (e) { logError(e); }
      }
    }

    function emitIdle() {
      emitStatus({ detected: false, stable: false, stableProgress: 0, confidence: 0, armed: false });
    }

    /* ---------------- detection loop */

    function schedule(delay) {
      if (st.timer) { env.clearTimeout(st.timer); st.timer = 0; }
      if (!active()) return;
      st.timer = env.setTimeout(tick, Math.max(0, delay));
    }

    function halt() {
      if (st.timer) { env.clearTimeout(st.timer); st.timer = 0; }
      if (st.raf) { env.cancelAnimationFrame(st.raf); st.raf = 0; }
      if (st.pending) { env.clearTimeout(st.pending.watchdog); st.pending = null; }
      st.inFlight = false;
    }

    function ensureWorker() {
      if (st.worker) return true;
      if (st.workerFailed || !opts.workerUrl || typeof env.Worker !== 'function') return false;
      try {
        st.worker = new env.Worker(opts.workerUrl);
      } catch (e) {
        st.worker = null;
        st.workerFailed = true;
        return false;
      }
      st.workerReplies = 0;
      st.workerErrors = 0;
      st.worker.onmessage = onWorkerMessage;
      st.worker.onerror = (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        workerFail(ev);
      };
      st.worker.onmessageerror = (ev) => workerFail(ev);
      setMode('worker');
      return true;
    }

    function workerFail(reason) {
      if (st.worker) {
        try { st.worker.terminate(); } catch (e) { /* ignore */ }
      }
      st.worker = null;
      st.workerFailed = true;
      if (st.pending) { env.clearTimeout(st.pending.watchdog); st.pending = null; }
      st.inFlight = false;
      setMode(mainDetector() ? 'main' : 'none');
      if (root && root.console && root.console.warn) {
        root.console.warn('[CameraCtl] worker de detecção indisponível; usando a thread principal.', reason && (reason.message || reason.type || reason));
      }
      schedule(0);
    }

    function onWorkerMessage(ev) {
      const m = (ev && ev.data) || {};
      const p = st.pending;
      if (!p || m.id !== p.id) return;
      env.clearTimeout(p.watchdog);
      st.pending = null;
      st.inFlight = false;
      st.workerReplies++;
      if (!active()) return;
      if (m.error) {
        st.workerErrors++;
        if (st.workerErrors >= 3) { workerFail(m.error); return; }
      } else {
        st.workerErrors = 0;
      }
      onResult(m.result || null, p.t0, env.now() - p.t0, p.sig, false, false);
    }

    function tick() {
      st.timer = 0;
      if (!active() || st.inFlight) return;
      const vw = video.videoWidth | 0;
      const vh = video.videoHeight | 0;
      if (!vw || !vh || (typeof video.readyState === 'number' && video.readyState < 2)) { schedule(80); return; }
      const useWorker = ensureWorker();
      const det = useWorker ? null : mainDetector();
      if (!useWorker && !det) {
        setMode('none');
        onResult(null, env.now(), 0, null, true, true);
        return;
      }
      if (tracker.setAspect(vw / vh)) resetDisplay();
      const size = downscaleSize(vw, vh, cfg.liveMaxDim);
      let img;
      try {
        if (!st.work) {
          st.work = env.createCanvas(size.w, size.h);
          st.wctx = st.work.getContext('2d', { willReadFrequently: true }) || st.work.getContext('2d');
        }
        if (st.work.width !== size.w || st.work.height !== size.h) {
          st.work.width = size.w;
          st.work.height = size.h;
        }
        st.wctx.drawImage(video, 0, 0, size.w, size.h);
        img = st.wctx.getImageData(0, 0, size.w, size.h);
      } catch (e) {
        schedule(250);
        return;
      }
      const sig = tracker.target ? quadSignature(img, orderCorners(tracker.target)) : null;
      const t0 = env.now();
      st.frames++;
      if (useWorker) {
        const id = ++st.reqId;
        const timeout = st.workerReplies ? cfg.workerTimeoutMs : cfg.workerFirstTimeoutMs;
        st.inFlight = true;
        st.pending = { id, t0, sig, watchdog: env.setTimeout(() => workerFail(new Error('timeout')), timeout) };
        try {
          const buffer = img.data.buffer;
          st.worker.postMessage({ id, width: size.w, height: size.h, buffer, opts: { mode: 'live', maxDim: cfg.liveMaxDim } }, [buffer]);
        } catch (e) {
          workerFail(e);
        }
        return;
      }
      setMode('main');
      let res = null;
      try {
        res = det.detect(img, { mode: 'live', maxDim: cfg.liveMaxDim });
      } catch (e) {
        res = null;
      }
      onResult(res, t0, env.now() - t0, sig, true, false);
    }

    function onResult(res, t0, ms, sig, onMain, idle) {
      if (!idle) st.avgMs = st.avgMs ? st.avgMs * 0.8 + ms * 0.2 : ms;
      const t = env.now();
      const corners = res && res.corners ? res.corners : null;
      const s = tracker.update(corners, t, { confidence: res ? res.confidence : undefined, sig });
      if (sig) st.lastSig = sig;
      st.statusT = t;
      emitStatus(s);
      wakeRender();
      if (s.fire && st.autoCapture) {
        disp.flashT = t;
        captureFrame(true)
          .then((shot) => { if (typeof opts.onAutoCapture === 'function') opts.onAutoCapture(shot); })
          .catch(logError);
      }
      st.intervalMs = idle ? 400 : computeInterval(st.avgMs, onMain, cfg);
      schedule(Math.max(cfg.minGapMs, t0 + st.intervalMs - t));
    }

    /* ---------------- overlay rendering */

    function resetDisplay() {
      disp.pts = null;
      disp.vel = [0, 0, 0, 0, 0, 0, 0, 0];
      disp.opacity = 0;
      disp.stableMix = 0;
      disp.stableOn = false;
      disp.progress = 0;
      disp.lastT = 0;
      disp.dirty = true;
    }

    function clearOverlay() {
      if (!overlay || !st.octx) return;
      st.octx.setTransform(1, 0, 0, 1, 0, 0);
      st.octx.clearRect(0, 0, overlay.width, overlay.height);
    }

    function readColors() {
      const fb = { ink: [20, 20, 20], orange: [255, 122, 0], blue: [31, 78, 156], cream: [255, 243, 214] };
      let cs = null;
      try { cs = overlay && env.getComputedStyle ? env.getComputedStyle(overlay) : null; } catch (e) { cs = null; }
      const pick = (name, def) => parseColor(cs && cs.getPropertyValue ? cs.getPropertyValue(name) : '', def);
      const user = opts.colors || {};
      st.colors = {
        ink: parseColor(user.ink, pick('--ink', fb.ink)),
        orange: parseColor(user.orange, pick('--orange', fb.orange)),
        blue: parseColor(user.blue, pick('--blue', fb.blue)),
        cream: parseColor(user.cream, pick('--cream', fb.cream)),
      };
      try {
        st.reducedMotion = !!(env.matchMedia && env.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) {
        st.reducedMotion = false;
      }
    }

    function syncOverlaySize() {
      const w = overlay.clientWidth || 0;
      const h = overlay.clientHeight || 0;
      const dpr = Math.min(3, env.devicePixelRatio() || 1);
      const vw = video.videoWidth | 0;
      const vh = video.videoHeight | 0;
      let changed = false;
      if (w !== disp.cssW || h !== disp.cssH || dpr !== disp.dpr) {
        disp.cssW = w;
        disp.cssH = h;
        disp.dpr = dpr;
        overlay.width = Math.max(1, Math.round(w * dpr));
        overlay.height = Math.max(1, Math.round(h * dpr));
        changed = true;
      }
      if (vw !== disp.vw || vh !== disp.vh) {
        disp.vw = vw;
        disp.vh = vh;
        changed = true;
      }
      return changed;
    }

    function wakeRender() {
      if (overlay && !st.raf && active()) st.raf = env.requestAnimationFrame(render);
    }

    function render() {
      st.raf = 0;
      if (!active() || !overlay) return;
      if (!st.octx) st.octx = overlay.getContext('2d');
      const t = env.now();
      const dt = disp.lastT ? clamp((t - disp.lastT) / 1000, 0, 0.1) : 1 / 60;
      disp.lastT = t;

      const tgt = tracker.target;
      const fresh = !!tgt && t - tracker.lastSeen <= cfg.fadeMs;
      const want = fresh ? 1 : 0;
      const prevOpacity = disp.opacity;
      disp.opacity = approach(disp.opacity, want, dt, (want > disp.opacity ? cfg.fadeInMs : cfg.fadeOutMs) / 1000);

      let moving = false;
      if (tgt) {
        const T = disp.pts ? alignCyclic(tgt, disp.pts, tracker.o.aspect) : tgt;
        if (!disp.pts || prevOpacity < 0.08) {
          disp.pts = copyCorners(T);
          disp.vel = [0, 0, 0, 0, 0, 0, 0, 0];
          moving = true;
        } else {
          for (let i = 0; i < 4; i++) {
            const sx = springStep(disp.pts[i].x, disp.vel[2 * i], T[i].x, cfg.springOmega, dt);
            const sy = springStep(disp.pts[i].y, disp.vel[2 * i + 1], T[i].y, cfg.springOmega, dt);
            disp.pts[i].x = sx[0];
            disp.vel[2 * i] = sx[1];
            disp.pts[i].y = sy[0];
            disp.vel[2 * i + 1] = sy[1];
            if (Math.abs(sx[0] - T[i].x) > 2e-4 || Math.abs(sy[0] - T[i].y) > 2e-4 ||
                Math.abs(sx[1]) > 2e-3 || Math.abs(sy[1]) > 2e-3) moving = true;
          }
        }
      }

      const stable = fresh && !!st.status.stable;
      if (stable && !disp.stableOn) disp.pulseT = t;
      disp.stableOn = stable;
      const mixWant = stable ? 1 : 0;
      disp.stableMix = approach(disp.stableMix, mixWant, dt, cfg.colorMs / 1000);

      let progWant = 0;
      const s = st.status;
      if (fresh && st.autoCapture && s.armed && s.stableProgress > 0) {
        const rate = 1 / tracker.o.autoMs;
        const ahead = Math.min(t - st.statusT, st.intervalMs * 1.5);
        progWant = Math.min(1, s.stableProgress + Math.max(0, ahead) * rate);
      }
      const progPrev = disp.progress;
      if (progWant >= disp.progress) disp.progress = progWant;
      else disp.progress += (progWant - disp.progress) * smoothingAlpha(dt, 0.08);
      if (disp.progress < 0.003) disp.progress = 0;

      const anims = !st.reducedMotion && (t - disp.pulseT < 460 || t - disp.flashT < 340);
      const animating = moving || disp.opacity !== prevOpacity || disp.opacity !== want ||
        disp.stableMix !== mixWant || Math.abs(disp.progress - progPrev) > 1e-4 || anims;

      if (syncOverlaySize() || animating || disp.dirty) {
        draw(t);
        disp.dirty = false;
      }
      if (want > 0 || disp.opacity > 0 || animating) st.raf = env.requestAnimationFrame(render);
    }

    function tracePath(ctx, P) {
      ctx.beginPath();
      ctx.moveTo(P[0].x, P[0].y);
      for (let i = 1; i < P.length; i++) ctx.lineTo(P[i].x, P[i].y);
      ctx.closePath();
    }

    function draw(t) {
      const ctx = st.octx;
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const vw = video.videoWidth | 0;
      const vh = video.videoHeight | 0;
      if (!disp.pts || disp.opacity <= 0.004 || !vw || !vh || !disp.cssW || !disp.cssH) return;
      if (!st.colors) readColors();
      const C = st.colors;
      const m = smoothstep(disp.stableMix);
      const P = mapNormToBox(disp.pts, vw, vh, disp.cssW, disp.cssH);
      const lineCol = mixRgb(C.orange, C.blue, m);

      ctx.setTransform(disp.dpr, 0, 0, disp.dpr, 0, 0);
      ctx.globalAlpha = disp.opacity;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      tracePath(ctx, P);
      ctx.fillStyle = rgba(lineCol, 0.16 + 0.06 * m);
      ctx.fill();
      if (m > 0.02) {
        ctx.lineWidth = 18;
        ctx.strokeStyle = rgba(C.blue, 0.3 * m);
        ctx.stroke();
      }
      ctx.lineWidth = 9;
      ctx.strokeStyle = rgba(C.ink, 1);
      ctx.stroke();
      ctx.lineWidth = 4;
      ctx.strokeStyle = rgba(lineCol, 1);
      ctx.stroke();

      if (disp.progress > 0.004 && typeof ctx.setLineDash === 'function') {
        const per = perimeter(P);
        ctx.setLineDash([per * disp.progress, per + 2]);
        ctx.lineDashOffset = 0;
        ctx.lineWidth = 4;
        ctx.strokeStyle = rgba(C.cream, 1);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (!st.reducedMotion) {
        const kf = (t - disp.flashT) / 340;
        if (kf >= 0 && kf < 1) {
          tracePath(ctx, P);
          ctx.fillStyle = rgba([255, 255, 255], 0.6 * (1 - kf));
          ctx.fill();
        }
      }

      for (let i = 0; i < 4; i++) {
        const p = P[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9.5, 0, Math.PI * 2);
        ctx.fillStyle = rgba(C.ink, 1);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = rgba(lineCol, 1);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x - 2, p.y - 2, 2, 0, Math.PI * 2);
        ctx.fillStyle = rgba(C.cream, 0.95);
        ctx.fill();
      }

      if (!st.reducedMotion) {
        const kp = (t - disp.pulseT) / 460;
        if (kp >= 0 && kp < 1) {
          ctx.lineWidth = 3 * (1 - kp) + 0.5;
          ctx.strokeStyle = rgba(C.blue, 1 - kp);
          for (let i = 0; i < 4; i++) {
            ctx.beginPath();
            ctx.arc(P[i].x, P[i].y, 10 + 20 * kp, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    /* ---------------- camera stream */

    function classifyError(err) {
      const name = (err && err.name) || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'DENIED';
      if (name === 'SecurityError') return env.isSecureContext === false ? 'INSECURE' : 'DENIED';
      return 'NO_CAMERA';
    }

    function acquireStream() {
      const nav = env.navigator;
      const md = nav && nav.mediaDevices;
      const secure = env.isSecureContext !== false;
      if (!secure) return Promise.reject(camError('INSECURE'));
      if (!md || typeof md.getUserMedia !== 'function') return Promise.reject(camError('NO_CAMERA'));
      const gum = (c) => {
        try { return Promise.resolve(md.getUserMedia(c)); } catch (e) { return Promise.reject(e); }
      };
      const ideal = {
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: cfg.idealWidth }, height: { ideal: cfg.idealHeight } },
      };
      return gum(ideal).catch((e1) => {
        const code = classifyError(e1);
        if (code !== 'NO_CAMERA') throw camError(code, e1);
        return gum({ audio: false, video: { facingMode: { ideal: 'environment' } } })
          .catch(() => gum({ audio: false, video: true }))
          .catch((e2) => { throw camError(classifyError(e2), e2); });
      });
    }

    function playVideo() {
      try {
        const p = video.play && video.play();
        if (p && typeof p.catch === 'function') p.catch(noop);
      } catch (e) { /* autoplay refused: the next user gesture or resume() retries */ }
    }

    function prepVideo() {
      if (video.setAttribute) {
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.setAttribute('muted', '');
        video.setAttribute('autoplay', '');
      }
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
    }

    function waitForVideo(token) {
      return new Promise((resolve, reject) => {
        const t0 = env.now();
        const evts = ['loadedmetadata', 'loadeddata', 'resize', 'playing'];
        let timer = 0;
        let lastPlay = t0;
        const cleanup = () => {
          if (timer) env.clearTimeout(timer);
          timer = 0;
          if (video.removeEventListener) evts.forEach((e) => video.removeEventListener(e, onEvt));
        };
        const check = () => {
          timer = 0;
          if (token !== st.token) { cleanup(); resolve(false); return; }
          if ((video.videoWidth | 0) > 0 && (video.videoHeight | 0) > 0) { cleanup(); resolve(true); return; }
          const now = env.now();
          if (now - t0 > cfg.startTimeoutMs) { cleanup(); reject(camError('NO_CAMERA')); return; }
          if (video.paused && now - lastPlay > 500) { lastPlay = now; playVideo(); }
          timer = env.setTimeout(check, 50);
        };
        function onEvt() {
          if (timer) env.clearTimeout(timer);
          check();
        }
        if (video.addEventListener) evts.forEach((e) => video.addEventListener(e, onEvt));
        check();
      });
    }

    function setupTrack(stream) {
      const track = stream && typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks()[0] : null;
      st.track = track || null;
      st.hasTorch = false;
      st.torchOn = false;
      if (!track) return;
      let caps = null;
      try { caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null; } catch (e) { caps = null; }
      st.hasTorch = !!(caps && caps.torch);
      if (caps && Array.isArray(caps.focusMode) && caps.focusMode.indexOf('continuous') !== -1 && track.applyConstraints) {
        try {
          const r = track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
          if (r && r.catch) r.catch(noop);
        } catch (e) { /* optional */ }
      }
      if (track.addEventListener) track.addEventListener('ended', onTrackEnded);
    }

    function detachTrack() {
      if (st.track && st.track.removeEventListener) st.track.removeEventListener('ended', onTrackEnded);
      st.track = null;
    }

    function onTrackEnded() {
      if (!st.running || isHidden()) return;
      restartStream();
    }

    function restartStream() {
      if (!st.running || !st.ownStream || st.restarting) return;
      st.restarting = true;
      const token = st.token;
      acquireStream().then((stream) => {
        st.restarting = false;
        if (token !== st.token || !st.running) { stopStream(stream); return; }
        detachTrack();
        stopStream(st.stream);
        st.stream = stream;
        video.srcObject = stream;
        playVideo();
        setupTrack(stream);
        tracker.resetTrack();
        resetDisplay();
        schedule(100);
      }, (err) => {
        st.restarting = false;
        if (typeof opts.onError === 'function') {
          try { opts.onError(err); } catch (e) { logError(e); }
        }
      });
    }

    function onVisibility() {
      if (!st.running) return;
      if (isHidden()) {
        halt();
        return;
      }
      if (st.paused) return;
      playVideo();
      if (st.ownStream && st.track && st.track.readyState === 'ended') restartStream();
      tracker.resetTrack();
      resetDisplay();
      clearOverlay();
      schedule(60);
      wakeRender();
    }

    function listen() {
      if (st.listening || !env.document || !env.document.addEventListener) return;
      env.document.addEventListener('visibilitychange', onVisibility);
      st.listening = true;
    }

    function unlisten() {
      if (!st.listening) return;
      env.document.removeEventListener('visibilitychange', onVisibility);
      st.listening = false;
    }

    function info() {
      return { width: video.videoWidth | 0, height: video.videoHeight | 0, hasTorch: st.hasTorch, mode: st.mode };
    }

    function start() {
      if (st.running) return Promise.resolve(info());
      if (st.starting) return st.starting;
      const token = ++st.token;
      const injected = opts.stream || null;
      const p = (injected ? Promise.resolve(injected) : acquireStream()).then((stream) => {
        if (token !== st.token) {
          if (!injected) stopStream(stream);
          return null;
        }
        st.stream = stream;
        st.ownStream = !injected;
        prepVideo();
        video.srcObject = stream;
        playVideo();
        return waitForVideo(token).then((ok) => {
          if (!ok || token !== st.token) return null;
          setupTrack(stream);
          st.running = true;
          st.paused = false;
          st.workerFailed = false;
          st.frames = 0;
          st.avgMs = 0;
          tracker.reset();
          tracker.setAutoCapture(st.autoCapture, env.now());
          resetDisplay();
          readColors();
          listen();
          emitIdle();
          schedule(0);
          wakeRender();
          return info();
        }, (err) => {
          if (token === st.token) {
            if (st.ownStream) stopStream(stream);
            if (video.srcObject === stream) video.srcObject = null;
            st.stream = null;
          }
          throw err;
        });
      });
      st.starting = p;
      const done = () => { if (st.starting === p) st.starting = null; };
      p.then(done, done);
      return p;
    }

    function stop() {
      st.token++;
      st.starting = null;
      const was = st.running;
      st.running = false;
      st.paused = false;
      halt();
      if (st.worker) {
        try { st.worker.terminate(); } catch (e) { /* ignore */ }
        st.worker = null;
      }
      setMode('none');
      unlisten();
      detachTrack();
      if (st.stream) {
        if (st.ownStream) stopStream(st.stream);
        if (video.srcObject === st.stream) video.srcObject = null;
      }
      st.stream = null;
      st.hasTorch = false;
      st.torchOn = false;
      tracker.reset();
      resetDisplay();
      clearOverlay();
      if (was) emitIdle();
    }

    function pause() {
      if (!st.running || st.paused) return;
      st.paused = true;
      halt();
      tracker.resetTrack();
      resetDisplay();
      clearOverlay();
      emitIdle();
    }

    function resume() {
      if (!st.running || !st.paused) return;
      st.paused = false;
      playVideo();
      readColors();
      schedule(0);
      wakeRender();
    }

    function captureFrame(isAuto) {
      const vw = video.videoWidth | 0;
      const vh = video.videoHeight | 0;
      if (!vw || !vh || !st.stream) return Promise.reject(camError('NOT_READY'));
      const t = env.now();
      const tgt = tracker.target;
      const fresh = !!tgt && t - tracker.lastSeen <= tracker.o.lostMs;
      const corners = fresh ? orderCorners(tgt).map((p) => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) })) : null;
      const confidence = fresh ? Math.round(tracker.conf * 100) / 100 : 0;
      const size = downscaleSize(vw, vh, cfg.maxCaptureDim);
      let canvas;
      try {
        canvas = env.createCanvas(size.w, size.h);
        canvas.getContext('2d').drawImage(video, 0, 0, size.w, size.h);
      } catch (e) {
        return Promise.reject(camError('NOT_READY', e));
      }
      if (!isAuto) {
        tracker.noteCapture(t, st.lastSig);
        disp.flashT = t;
        wakeRender();
      }
      return Promise.resolve({ canvas, corners, confidence, auto: !!isAuto, width: size.w, height: size.h });
    }

    function setAutoCapture(on) {
      on = !!on;
      st.autoCapture = on;
      tracker.setAutoCapture(on, env.now());
      st.status = assign({}, st.status, { autoCapture: on });
    }

    function setTorch(on) {
      const track = st.track;
      if (!track || !st.hasTorch || typeof track.applyConstraints !== 'function') return Promise.resolve(false);
      return Promise.resolve()
        .then(() => track.applyConstraints({ advanced: [{ torch: !!on }] }))
        .then(() => { st.torchOn = !!on; return true; }, () => false);
    }

    return {
      start,
      stop,
      pause,
      resume,
      capture: () => captureFrame(false),
      setAutoCapture,
      setTorch,
      get autoCapture() { return st.autoCapture; },
      get hasTorch() { return st.hasTorch; },
      get torch() { return st.torchOn; },
      get running() { return st.running; },
      get paused() { return st.paused; },
      get mode() { return st.mode; },
      get status() { return assign({}, st.status); },
      get stats() {
        return {
          mode: st.mode,
          detectMs: Math.round(st.avgMs * 10) / 10,
          intervalMs: st.intervalMs,
          frames: st.frames,
          inFlight: st.inFlight,
        };
      },
      _tracker: tracker,
    };
  }

  return {
    create,
    DEFAULTS: assign({}, CONTROLLER_DEFAULTS, STABILITY_DEFAULTS),
    _math: {
      clamp,
      lerp,
      coverTransform,
      mapNormToBox,
      mapBoxToNorm,
      visibleRect,
      downscaleSize,
      pointDist,
      maxCornerDist,
      meanCornerDist,
      alignCyclic,
      orderCorners,
      quadArea,
      isConvexQuad,
      perimeter,
      springStep,
      smoothingAlpha,
      approach,
      smoothstep,
      computeInterval,
      quadSignature,
      signatureDistance,
      parseColor,
      mixRgb,
    },
    _Stability: Stability,
    _camError: camError,
  };
});
