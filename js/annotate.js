/* DocScan — annotate (pen / highlighter / white-out / text), signature pad, and stamp placement. */
(function (root) {
  'use strict';
  var $ = UI.$, h = UI.h;
  var COLORS = ['#141414', '#1F4E9C', '#E23D2E', '#1E8E3E', '#FF7A00', '#FFE14D'];

  function coalesced(e) {
    var l = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    return l && l.length ? l : [e];
  }
  function rel(e, el, w, hh) {
    var r = el.getBoundingClientRect();
    return { x: (e.clientX - r.left) * w / r.width, y: (e.clientY - r.top) * hh / r.height };
  }

  /* ---------------- annotate ---------------- */
  function annotate(baseCanvas) {
    return new Promise(function (resolve) {
      var cv = $('#annot-canvas'), ctx = cv.getContext('2d');
      cv.width = baseCanvas.width; cv.height = baseCanvas.height;
      var ops = [], tool = 'pen', color = COLORS[0], cur = null, pid = null;
      var unit = Math.max(cv.width, cv.height) / 900;
      var sizes = { pen: 3, marker: 18, eraser: 22 };

      function drawOp(op) {
        ctx.save();
        if (op.t === 'text') {
          ctx.fillStyle = op.c; ctx.font = '800 ' + op.s + 'px Nunito, Arial, sans-serif'; ctx.textBaseline = 'top';
          op.text.split('\n').forEach(function (l, i) { ctx.fillText(l, op.x, op.y + i * op.s * 1.2); });
        } else {
          ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = op.s;
          if (op.t === 'marker') { ctx.globalAlpha = 0.38; ctx.globalCompositeOperation = 'multiply'; ctx.strokeStyle = op.c; ctx.lineCap = 'butt'; }
          else ctx.strokeStyle = op.t === 'eraser' ? '#ffffff' : op.c;
          ctx.beginPath();
          op.p.forEach(function (q, i) { if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
          if (op.p.length === 1) ctx.lineTo(op.p[0].x + 0.1, op.p[0].y);
          ctx.stroke();
        }
        ctx.restore();
      }
      function redraw() {
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
        ctx.drawImage(baseCanvas, 0, 0);
        ops.forEach(drawOp);
        if (cur) drawOp(cur);
      }
      redraw();

      var colorsRow = $('#annot-colors');
      colorsRow.innerHTML = '';
      COLORS.forEach(function (c, i) {
        var b = h('button', { class: 'swatch', style: 'background:' + c, 'aria-label': 'Cor', 'aria-pressed': i === 0 ? 'true' : 'false' });
        b.addEventListener('click', function () { color = c; UI.$$('.swatch', colorsRow).forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); });
        colorsRow.appendChild(b);
      });
      var range = h('input', { type: 'range', class: 'size-range', min: '1', max: '10', value: '3', 'aria-label': 'Espessura' });
      colorsRow.appendChild(range);
      var tools = UI.$$('[data-annot]');
      function setTool(t) {
        tool = t;
        tools.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.annot === t ? 'true' : 'false'); });
        if (t === 'marker' && color === COLORS[0]) color = COLORS[5];
        if (t === 'pen' && color === COLORS[5]) color = COLORS[0];
        UI.$$('.swatch', colorsRow).forEach(function (x, i) { x.setAttribute('aria-pressed', COLORS[i] === color ? 'true' : 'false'); });
      }
      tools.forEach(function (b) { b.onclick = function () { setTool(b.dataset.annot); }; });
      setTool('pen');

      function down(e) {
        if (pid !== null) return;
        var p = rel(e, cv, cv.width, cv.height);
        if (tool === 'text') {
          UI.prompt({ title: 'Texto', placeholder: 'Digite o texto', ok: 'Inserir' }).then(function (t) {
            if (t && t.trim()) { ops.push({ t: 'text', x: p.x, y: p.y, s: Math.round(unit * (10 + +range.value * 3)), c: color, text: t }); redraw(); }
          });
          return;
        }
        pid = e.pointerId;
        try { cv.setPointerCapture(pid); } catch (er) { /* ignore */ }
        cur = { t: tool, c: color, s: unit * sizes[tool] * (+range.value / 3), p: [p] };
        redraw();
      }
      function move(e) {
        if (e.pointerId !== pid || !cur) return;
        var pts = coalesced(e);
        pts.forEach(function (ev) { cur.p.push(rel(ev, cv, cv.width, cv.height)); });
        redraw();
      }
      function up(e) {
        if (e.pointerId !== pid) return;
        pid = null;
        if (cur) ops.push(cur);
        cur = null;
        redraw();
      }
      cv.onpointerdown = down; cv.onpointermove = move; cv.onpointerup = up; cv.onpointercancel = up;
      $('#annot-undo').onclick = function () { ops.pop(); redraw(); };

      function close(ok) {
        cv.onpointerdown = cv.onpointermove = cv.onpointerup = cv.onpointercancel = null;
        UI.onBack('annot', null);
        UI.back();
        if (!ok) return resolve(null);
        var out = document.createElement('canvas');
        out.width = cv.width; out.height = cv.height;
        out.getContext('2d').drawImage(cv, 0, 0);
        resolve(out);
      }
      $('#annot-ok').onclick = function () { close(true); };
      $('#annot-back').onclick = function () {
        if (!ops.length) return close(false);
        UI.confirm({ title: 'Descartar anotações?', ok: 'Descartar', danger: true }).then(function (y) { if (y) close(false); });
      };
      UI.onBack('annot', function () { $('#annot-back').onclick(); return false; });
      UI.go('annot');
    });
  }

  /* ---------------- signatures ---------------- */
  var SIG_KEY = 'docscan.signatures';
  function savedSigs() { try { return JSON.parse(localStorage.getItem(SIG_KEY) || '[]'); } catch (e) { return []; } }
  function storeSigs(list) { try { localStorage.setItem(SIG_KEY, JSON.stringify(list.slice(0, 6))); } catch (e) { UI.toast('Sem espaço para guardar a assinatura.', 'error'); } }
  function dataUrlToBlob(u) {
    var parts = u.split(','), bin = atob(parts[1]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: (parts[0].match(/:(.*?);/) || [])[1] || 'image/png' });
  }
  function trimCanvas(c) {
    var ctx = c.getContext('2d'), d = ctx.getImageData(0, 0, c.width, c.height).data;
    var x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (var y = 0; y < c.height; y++) for (var x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    var pad = 6, out = document.createElement('canvas');
    out.width = x1 - x0 + 1 + pad * 2; out.height = y1 - y0 + 1 + pad * 2;
    out.getContext('2d').drawImage(c, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }
  /* Photo of a signature/stamp on paper -> transparent PNG keeping only the ink. */
  function inkFromImage(blob, keepColor) {
    return Convert.loadImage(blob).then(function (img) {
      var c = Convert.canvasFrom(img, 1200), ctx = c.getContext('2d'), id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
      var hist = new Uint32Array(256), n = c.width * c.height, i;
      for (i = 0; i < d.length; i += 4) hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++;
      var sum = 0, sB = 0, wB = 0, best = 0, t = 128;
      for (i = 0; i < 256; i++) sum += i * hist[i];
      for (i = 0; i < 256; i++) {
        wB += hist[i]; if (!wB) continue;
        var wF = n - wB; if (!wF) break;
        sB += i * hist[i];
        var m = (sB / wB - (sum - sB) / wF), v = wB * wF * m * m;
        if (v > best) { best = v; t = i; }
      }
      for (i = 0; i < d.length; i += 4) {
        var L = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        var a = L >= t ? 0 : Math.min(255, (t - L) * 255 / Math.max(20, t * 0.5));
        if (!keepColor) { d[i] = 20; d[i + 1] = 20; d[i + 2] = 40; }
        d[i + 3] = a;
      }
      ctx.putImageData(id, 0, 0);
      var tr = trimCanvas(c) || c;
      return Convert.canvasBlob(tr, 'image/png');
    });
  }
  function signaturePad() {
    return new Promise(function (resolve) {
      var wrap = h('div');
      var list = h('div', { class: 'sig-list' });
      var sigs = savedSigs();
      if (sigs.length) {
        wrap.appendChild(h('p', { class: 'field-label', text: 'Assinaturas salvas (toque para usar)' }));
        sigs.forEach(function (u, idx) {
          var it = h('button', { class: 'sig-item', 'aria-label': 'Usar assinatura' }, '<img src="' + u + '" alt="">');
          it.addEventListener('click', function () { sh.close(dataUrlToBlob(u)); });
          it.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            UI.confirm({ title: 'Apagar esta assinatura?', ok: 'Apagar', danger: true }).then(function (y) {
              if (y) { sigs.splice(idx, 1); storeSigs(sigs); it.remove(); }
            });
          });
          list.appendChild(it);
        });
        wrap.appendChild(list);
      }
      wrap.appendChild(h('p', { class: 'field-label', text: 'Desenhe sua assinatura' }));
      var pad = h('canvas', { class: 'sigpad' });
      wrap.appendChild(pad);
      var row = h('div', { class: 'opt-inline', style: 'margin-top:10px' });
      var bClear = h('button', { class: 'btn btn--secondary' }, 'Limpar');
      var bPhoto = h('button', { class: 'btn btn--secondary' }, UI.icon('camera') + 'Foto');
      var bOk = h('button', { class: 'btn btn--primary' }, 'Usar');
      row.appendChild(bClear); row.appendChild(bPhoto); row.appendChild(bOk);
      wrap.appendChild(row);
      var sh = UI.sheet('Assinatura', wrap, function (v) { resolve(v || null); });

      var dpr = Math.min(3, window.devicePixelRatio || 1), pctx, drawing = false, last = null, inked = false, pid = null;
      setTimeout(function () {
        var r = pad.getBoundingClientRect();
        pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
        pctx = pad.getContext('2d');
        pctx.lineCap = 'round'; pctx.lineJoin = 'round'; pctx.strokeStyle = '#14142a';
      }, 50);
      function pt(e) { var r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr, p: e.pressure || 0.5 }; }
      pad.addEventListener('pointerdown', function (e) { if (pid !== null) return; pid = e.pointerId; drawing = true; last = pt(e); try { pad.setPointerCapture(pid); } catch (er) { /* ignore */ } });
      pad.addEventListener('pointermove', function (e) {
        if (!drawing || e.pointerId !== pid) return;
        coalesced(e).forEach(function (ev) {
          var p = pt(ev), d = Math.hypot(p.x - last.x, p.y - last.y);
          pctx.lineWidth = Math.max(1.5, Math.min(5.5, 4.5 - d / 12)) * dpr;
          pctx.beginPath(); pctx.moveTo(last.x, last.y); pctx.lineTo(p.x, p.y); pctx.stroke();
          last = p; inked = true;
        });
      });
      var end = function (e) { if (e.pointerId === pid) { drawing = false; pid = null; } };
      pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
      bClear.onclick = function () { pctx.clearRect(0, 0, pad.width, pad.height); inked = false; };
      bPhoto.onclick = function () {
        UI.pickFiles({ accept: 'image/*' }).then(function (f) {
          if (!f.length) return;
          return inkFromImage(f[0]).then(function (b) { return Convert.blobToDataURL(b).then(function (u) { sigs.unshift(u); storeSigs(sigs); sh.close(b); }); });
        }).catch(UI.fail);
      };
      bOk.onclick = function () {
        if (!inked) { UI.toast('Desenhe a assinatura primeiro.'); return; }
        var tr = trimCanvas(pad);
        if (!tr) return;
        var u = tr.toDataURL('image/png');
        sigs.unshift(u); storeSigs(sigs);
        sh.close(dataUrlToBlob(u));
      };
    });
  }
  function textStamp(text, color, px) {
    var c = document.createElement('canvas'), ctx = c.getContext('2d'), size = px || 64;
    ctx.font = '800 ' + size + 'px Nunito, Arial, sans-serif';
    var lines = String(text).split('\n'), w = Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; }));
    c.width = Math.ceil(w + 16); c.height = Math.ceil(lines.length * size * 1.2 + 12);
    ctx.font = '800 ' + size + 'px Nunito, Arial, sans-serif'; ctx.fillStyle = color || '#14142a'; ctx.textBaseline = 'top';
    lines.forEach(function (l, i) { ctx.fillText(l, 8, 6 + i * size * 1.2); });
    return Convert.canvasBlob(c, 'image/png');
  }

  /* ---------------- placement ---------------- */
  /* pages: [{blob(page image), aspect(h/w)}] -> Promise<[{page, png, x, y, w, h}] | null> */
  function place(pages, startWith) {
    return new Promise(function (resolve) {
      var idx = 0, stamps = [], host = $('#place-host'), pageEl = $('#place-page'), img = $('#place-img');
      function layout() {
        var p = pages[idx], r = host.getBoundingClientRect(), maxW = r.width - 24, maxH = r.height - 24;
        var w = maxW, hh = w * p.aspect;
        if (hh > maxH) { hh = maxH; w = hh / p.aspect; }
        pageEl.style.width = w + 'px'; pageEl.style.height = hh + 'px';
        img.src = Pages.url(p.blob);
        $('#place-num').textContent = (idx + 1) + ' / ' + pages.length;
        $('#place-prev').disabled = idx === 0; $('#place-next').disabled = idx === pages.length - 1;
        UI.$$('.stamp', pageEl).forEach(function (s) { s.remove(); });
        stamps.filter(function (s) { return s.page === idx; }).forEach(mount);
      }
      function mount(s) {
        var el = h('div', { class: 'stamp' }, '<img alt=""><span class="stamp__resize"></span><button class="stamp__del" aria-label="Remover">' + UI.icon('close') + '</button>');
        el.querySelector('img').src = Pages.url(s.png);
        function pos() { el.style.left = s.x * 100 + '%'; el.style.top = s.y * 100 + '%'; el.style.width = s.w * 100 + '%'; el.style.height = s.h * 100 + '%'; }
        pos();
        var mode = null, start = null, pid = null;
        el.addEventListener('pointerdown', function (e) {
          if (e.target.closest('.stamp__del')) return;
          e.preventDefault(); pid = e.pointerId;
          try { el.setPointerCapture(pid); } catch (er) { /* ignore */ }
          mode = e.target.classList.contains('stamp__resize') ? 'size' : 'move';
          start = { cx: e.clientX, cy: e.clientY, x: s.x, y: s.y, w: s.w, h: s.h };
        });
        el.addEventListener('pointermove', function (e) {
          if (e.pointerId !== pid || !mode) return;
          var r = pageEl.getBoundingClientRect(), dx = (e.clientX - start.cx) / r.width, dy = (e.clientY - start.cy) / r.height;
          if (mode === 'move') { s.x = Math.max(-s.w * 0.5, Math.min(1 - s.w * 0.5, start.x + dx)); s.y = Math.max(-s.h * 0.5, Math.min(1 - s.h * 0.5, start.y + dy)); }
          else {
            var nw = Math.max(0.05, Math.min(1, start.w + dx)), k = nw / start.w;
            s.w = nw; s.h = start.h * k;
          }
          pos();
        });
        var end = function (e) { if (e.pointerId === pid) { pid = null; mode = null; } };
        el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
        el.querySelector('.stamp__del').addEventListener('click', function () { stamps.splice(stamps.indexOf(s), 1); el.remove(); });
        pageEl.appendChild(el);
      }
      function add(png) {
        return Convert.loadImage(png).then(function (im) {
          var p = pages[idx], ar = (im.naturalHeight / im.naturalWidth) / p.aspect, w = 0.38, hh = w * ar;
          if (hh > 0.3) { hh = 0.3; w = hh / ar; }
          var s = { page: idx, png: png, x: 0.55 - w / 2, y: 0.78 - hh / 2, w: w, h: hh };
          stamps.push(s); mount(s);
        });
      }
      $('#place-prev').onclick = function () { if (idx > 0) { idx--; layout(); } };
      $('#place-next').onclick = function () { if (idx < pages.length - 1) { idx++; layout(); } };
      $('#place-add-sign').onclick = function () { signaturePad().then(function (b) { if (b) return add(b); }).catch(UI.fail); };
      $('#place-add-text').onclick = function () {
        UI.prompt({ title: 'Texto no documento', placeholder: 'Ex.: Nome completo', ok: 'Inserir' }).then(function (t) {
          if (t && t.trim()) return textStamp(t.trim(), '#14142a').then(add);
        }).catch(UI.fail);
      };
      $('#place-add-date').onclick = function () { textStamp(new Date().toLocaleDateString('pt-BR'), '#14142a').then(add).catch(UI.fail); };
      $('#place-add-img').onclick = function () {
        UI.pickFiles({ accept: 'image/*' }).then(function (f) {
          if (!f.length) return;
          return UI.choose('Como usar a imagem?', [
            { id: 'ink', label: 'Remover fundo branco', sub: 'ideal para carimbo ou assinatura em papel', icon: 'wand' },
            { id: 'raw', label: 'Usar a imagem como está', icon: 'x-image' },
          ]).then(function (c) {
            if (!c) return;
            return (c === 'ink' ? inkFromImage(f[0], true) : Convert.jpegFromBlob(f[0], 1200).then(function (r) { return r.blob; })).then(add);
          });
        }).catch(UI.fail);
      };
      function close(v) {
        UI.onBack('place', null);
        window.removeEventListener('resize', layout);
        UI.back();
        resolve(v);
      }
      $('#place-ok').onclick = function () {
        if (!stamps.length) { UI.toast('Adicione uma assinatura, texto ou carimbo.'); return; }
        close(stamps.slice());
      };
      $('#place-back').onclick = function () { close(null); };
      UI.onBack('place', function () { close(null); return false; });
      window.addEventListener('resize', layout);
      UI.go('place');
      setTimeout(function () {
        layout();
        if (startWith === 'sign') $('#place-add-sign').onclick();
      }, 30);
    });
  }

  /* Draws stamps onto page images (for app documents). */
  function burnStamps(blob, stamps) {
    return Convert.loadImage(blob).then(function (img) {
      var c = Convert.canvasFrom(img), ctx = c.getContext('2d');
      return stamps.reduce(function (p, s) {
        return p.then(function () { return Convert.loadImage(s.png); }).then(function (si) {
          ctx.drawImage(si, s.x * c.width, s.y * c.height, s.w * c.width, s.h * c.height);
        });
      }, Promise.resolve()).then(function () { return c; });
    });
  }

  root.Annot = { annotate: annotate, signaturePad: signaturePad, place: place, burnStamps: burnStamps, inkFromImage: inkFromImage, textStamp: textStamp };
})(window);
