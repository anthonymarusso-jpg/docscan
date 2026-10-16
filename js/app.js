/* DocScan — main controller: home, camera, crop, edit, document. */
(function (root) {
  'use strict';
  var $ = UI.$, $$ = UI.$$, h = UI.h, esc = UI.esc, C = Convert;

  function nowName(prefix) {
    var d = new Date();
    return (prefix || 'Scan') + ' ' + d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDate(ts) {
    var d = new Date(ts || Date.now());
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' · ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function newDoc(name) { return { id: DB.uid(), name: name || nowName(), createdAt: Date.now(), updatedAt: Date.now(), pages: [] }; }
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } }

  /* ======================= HOME ======================= */
  var homeTab = 'docs';
  function setTab(t) {
    homeTab = t;
    $$('[data-tab]').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.tab === t ? 'true' : 'false'); });
    $('#home-docs').hidden = t !== 'docs';
    $('#home-tools').hidden = t !== 'tools';
    if (t === 'tools' && !$('#home-tools').childElementCount) Tools.renderGrid($('#home-tools'), function (id) { Tools.open(id); });
  }
  function renderHome() {
    return DB.getAll().then(function (docs) {
      var q = ($('#home-search').value || '').trim().toLowerCase(), s = DB.settings();
      var list = docs.filter(function (d) { return !q || d.name.toLowerCase().indexOf(q) >= 0; });
      list.sort(s.sortBy === 'name' ? function (a, b) { return a.name.localeCompare(b.name, 'pt-BR'); } : function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      var grid = $('#doc-grid');
      grid.innerHTML = '';
      $('#home-empty').hidden = docs.length > 0;
      if (docs.length && !list.length) grid.appendChild(h('p', { class: 'hint-text', style: 'grid-column:1/-1;text-align:center;padding:20px' }, 'Nada encontrado para “' + esc(q) + '”.'));
      var keep = [];
      list.forEach(function (d) {
        var card = h('div', { class: 'scroll-card', role: 'button', tabindex: '0' },
          '<img class="scroll-card__thumb" alt=""><span class="scroll-card__tag">' + d.pages.length + ' pág</span>' +
          '<div class="scroll-card__body"><p class="scroll-card__name">' + esc(d.name) + '</p><p class="scroll-card__meta">' + fmtDate(d.updatedAt || d.createdAt) + '</p></div>' +
          '<button class="btn-icon btn-icon--sm scroll-card__menu" aria-label="Opções do documento">' + UI.icon('more') + '</button>');
        if (d.pages[0]) { card.querySelector('img').src = Pages.url(d.pages[0].filteredBlob); keep.push(d.pages[0].filteredBlob); }
        card.addEventListener('click', function (e) { if (!e.target.closest('.scroll-card__menu')) openDoc(d.id); });
        card.querySelector('.scroll-card__menu').addEventListener('click', function () { docMenu(d); });
        grid.appendChild(card);
      });
      Pages.releaseUrls(keep);
    });
  }
  function docMenu(d) {
    return UI.choose(d.name, [
      { id: 'open', label: 'Abrir', icon: 'pages' },
      { id: 'pdf', label: 'Enviar como PDF', icon: 'share' },
      { id: 'rename', label: 'Renomear', icon: 'pencil' },
      { id: 'dup', label: 'Duplicar', icon: 'x-copy' },
      { id: 'del', label: 'Apagar', icon: 'trash' },
    ]).then(function (a) {
      if (a === 'open') return openDoc(d.id);
      if (a === 'pdf') return sharePdf(d);
      if (a === 'rename') return UI.prompt({ title: 'Renomear', value: d.name, ok: 'Salvar' }).then(function (n) { if (n && n.trim()) { d.name = n.trim(); return DB.put(d).then(renderHome); } });
      if (a === 'dup') { var c = JSON.parse(JSON.stringify({ name: d.name })); var nd = newDoc(c.name + ' (cópia)'); nd.pages = d.pages.map(function (p) { var q = Object.assign({}, p); q.id = DB.uid(); return q; }); return DB.put(nd).then(renderHome); }
      if (a === 'del') return UI.confirm({ title: 'Apagar documento?', text: '“' + d.name + '” e suas ' + d.pages.length + ' página(s) vão sumir para sempre.', ok: 'Apagar', danger: true })
        .then(function (y) { if (y) return DB.remove(d.id).then(renderHome).then(function () { UI.toast('Documento apagado.'); }); });
    }).catch(UI.fail);
  }
  function settingsSheet() {
    var s = DB.settings(), wrap = h('div');
    wrap.innerHTML =
      '<label class="field-label" for="set-filter">Filtro padrão</label><select class="select" id="set-filter">' +
      Filters.LIST.map(function (f) { return '<option value="' + f.id + '">' + esc(f.label) + ' — ' + esc(f.sub) + '</option>'; }).join('') + '</select>' +
      '<label class="field-label" for="set-page">Tamanho do PDF</label><select class="select" id="set-page"><option value="a4">A4</option><option value="letter">Carta</option><option value="original">Tamanho da foto</option></select>' +
      '<label class="list-row"><span class="list-row__text"><span class="list-row__title">Começar em Lote</span><span class="list-row__sub">várias páginas seguidas, sem parar para recortar</span></span><input type="checkbox" class="switch" id="set-batch"></label>' +
      '<label class="list-row"><span class="list-row__text"><span class="list-row__title">Captura automática</span><span class="list-row__sub">tira a foto sozinho quando a folha fica parada</span></span><input type="checkbox" class="switch" id="set-auto"></label>' +
      '<p class="hint-text" id="set-storage"></p>' +
      '<p class="hint-text">Para usar como app: no Safari toque em Compartilhar → “Adicionar à Tela de Início”. Seus documentos ficam só neste aparelho.</p>';
    $('#set-filter', wrap).value = s.filter; $('#set-page', wrap).value = s.pageSize;
    $('#set-batch', wrap).checked = !!s.batch; $('#set-auto', wrap).checked = !!s.auto;
    ['#set-filter', '#set-page', '#set-batch', '#set-auto'].forEach(function (id) {
      $(id, wrap).addEventListener('change', function () {
        DB.saveSettings({ filter: $('#set-filter', wrap).value, pageSize: $('#set-page', wrap).value, batch: $('#set-batch', wrap).checked, auto: $('#set-auto', wrap).checked });
      });
    });
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) { $('#set-storage', wrap).textContent = 'Espaço usado: ' + (e.usage / 1048576).toFixed(1).replace('.', ',') + ' MB'; });
    }
    UI.sheet('Ajustes ninja', wrap);
  }

  /* ======================= CAMERA ======================= */
  var cam = null, session = null, qrTimer = 0, procQueue = Promise.resolve();

  function setMode(mode) {
    session.mode = mode;
    $$('#cam-modes [data-mode]').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false'); });
    $('#qr-frame').hidden = mode !== 'qr';
    $('#cam-overlay').style.visibility = mode === 'qr' ? 'hidden' : '';
    $('#cam-auto').hidden = mode === 'qr';
    $('#cam-shutter').disabled = mode === 'qr';
    stopQr();
    if (mode === 'qr') startQr();
    if (mode === 'idcard') { session.idParts = []; hint('warn', 'Frente do documento'); }
    else if (mode === 'qr') hint('found', 'Aponte para o QR code');
    else hint('search');
    if (mode !== 'single') DB.saveSettings({ batch: mode === 'batch' });
    else DB.saveSettings({ batch: false });
  }
  function hint(kind, text, p) {
    var el = $('#cam-hint');
    if (kind === 'search') { el.className = 'hint-bubble'; el.innerHTML = 'Procurando a folha<span class="hint-dots"><i></i><i></i><i></i></span>'; return; }
    if (kind === 'hold') { el.className = 'hint-bubble hint-bubble--hold'; el.innerHTML = '<span class="progress-ring" style="--p:' + (p || 0).toFixed(2) + '"></span>' + esc(text || 'Segure firme…'); return; }
    el.className = 'hint-bubble ' + (kind === 'found' ? 'hint-bubble--found' : kind === 'warn' ? 'hint-bubble--warn' : '');
    el.innerHTML = (kind === 'found' ? UI.icon('check', 'hint-bubble__icon') : kind === 'warn' ? UI.icon('x-id', 'hint-bubble__icon') : '') + esc(text);
  }
  function onStatus(s) {
    if (!session || session.mode === 'qr' || session.busyHint) return;
    if (session.mode === 'idcard') { hint('warn', session.idParts.length ? 'Agora o verso' : 'Frente do documento'); return; }
    if (!s.detected) hint('search');
    else if (cam && cam.autoCapture && s.stableProgress > 0.02) hint('hold', 'Segure firme…', s.stableProgress);
    else hint('found', 'Folha encontrada!');
  }
  function updateStack() {
    var n = session.pages, st = $('#cam-stack'), badge = $('#cam-count');
    st.classList.toggle('is-empty', !n);
    badge.textContent = n ? String(n) : '';
    $$('.thumb-stack__img', st).forEach(function (i) { i.remove(); });
    session.thumbs.slice(-3).forEach(function (b) { var im = h('img', { class: 'thumb-stack__img', alt: '' }); im.src = Pages.url(b); st.insertBefore(im, badge); });
  }
  function flyThumb(blob) {
    var st = $('#cam-stack'), from = $('#cam-video').getBoundingClientRect(), to = st.getBoundingClientRect();
    var w = from.width * 0.5, hh = from.height * 0.5, x = from.left + from.width * 0.25, y = from.top + from.height * 0.2;
    var im = h('img', { class: 'thumb-fly', alt: '', style: 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + hh + 'px;--fly-dx:' + ((to.left + to.width / 2) - (x + w / 2)) + 'px;--fly-dy:' + ((to.top + to.height / 2) - (y + hh / 2)) + 'px;--fly-scale:' + (to.width / w) });
    im.src = Pages.url(blob);
    document.body.appendChild(im);
    var done = function () { im.remove(); UI.oneShot($('#cam-count'), 'is-bump'); };
    im.addEventListener('animationend', done);
    setTimeout(done, 1200);
  }
  function captureFx() {
    UI.oneShot($('#cam-shutter'), 'is-spinning');
    UI.oneShot($('#cam-flash'), 'is-firing');
    UI.oneShot($('#cam-burst'), 'is-firing');
    vibrate(20);
  }

  function ensureSessionDoc() {
    if (session.doc) return Promise.resolve(session.doc);
    if (session.docId) return DB.get(session.docId).then(function (d) { session.doc = d || newDoc(); return session.doc; });
    session.doc = newDoc(session.mode === 'idcard' ? nowName('Documento') : nowName());
    return Promise.resolve(session.doc);
  }
  function savePageToSession(page) {
    return ensureSessionDoc().then(function (doc) {
      if (session.insertAt != null) doc.pages.splice(session.insertAt++, 0, page); else doc.pages.push(page);
      return DB.put(doc).then(function () {
        session.pages++; session.thumbs.push(page.filteredBlob);
        if (UI.current() === 'camera') { flyThumb(page.filteredBlob); updateStack(); }
        return page;
      });
    });
  }

  function openCamera(docId, mode, opts) {
    var s = DB.settings();
    session = { docId: docId || null, doc: null, mode: mode || (s.batch ? 'batch' : 'single'), pages: 0, thumbs: [], idParts: [], insertAt: opts && opts.insertAt != null ? opts.insertAt : null };
    $('#cam-nocam').hidden = true;
    UI.go('camera');
    setMode(session.mode);
    updateStack();
    var auto = $('#cam-auto');
    auto.setAttribute('aria-pressed', s.auto ? 'true' : 'false');
    if (!cam) {
      cam = CameraCtl.create({
        video: $('#cam-video'), overlay: $('#cam-overlay'), workerUrl: 'js/detect-worker.js', autoCapture: !!s.auto,
        onStatus: onStatus,
        onAutoCapture: function (shot) { if (session && (session.mode === 'single' || session.mode === 'batch' || session.mode === 'idcard')) handleShot(shot); },
      });
    } else cam.setAutoCapture(!!s.auto);
    cam.start().then(function () {
      $('#cam-torch').hidden = !cam.hasTorch;
      if (session.mode === 'qr') startQr();
    }, function (e) {
      var code = e && e.code;
      $('#cam-nocam').hidden = false;
      $('#nocam-title').textContent = code === 'DENIED' ? 'Câmera bloqueada' : 'Câmera ao vivo indisponível';
      $('#nocam-text').textContent = code === 'DENIED'
        ? 'Libere a câmera em Ajustes › Safari › Câmera, ou use a câmera do iPhone abaixo.'
        : code === 'INSECURE' ? 'A câmera ao vivo só funciona em endereço seguro (https). Use a câmera do iPhone: o app encontra a folha sozinho.'
          : 'Use a câmera do próprio iPhone: tire a foto e o app encontra a folha sozinho.';
    });
  }
  function closeCamera() {
    stopQr();
    if (cam) cam.stop();
    var s = session;
    procQueue.then(function () {
      if (s && s.doc && s.pages) openDoc(s.doc.id, true);
      else { UI.home(); renderHome(); }
    });
    if (s && s.pages) UI.loader.show('Guardando as páginas…');
    procQueue.then(function () { UI.loader.hide(); });
  }

  function handleShot(shot) {
    if (!session || !shot || !shot.canvas) return;
    captureFx();
    var mode = session.mode;
    if (mode === 'batch') {
      var canvas = shot.canvas, corners = shot.corners;
      procQueue = procQueue.then(function () {
        var d = corners ? Pages.detect(canvas, corners) : Pages.detect(canvas);
        return Pages.create(canvas, d && d.corners, DB.settings().filter).then(savePageToSession);
      }).catch(UI.fail);
      return;
    }
    if (mode === 'idcard') {
      var c2 = shot.canvas, k2 = shot.corners;
      session.busyHint = true;
      procQueue = procQueue.then(function () {
        var d = Pages.detect(c2, k2);
        var rect = Pages.rectify(c2, d && d.corners);
        return C.canvasBlob(rect, 'image/jpeg', 0.92);
      }).then(function (b) {
        session.idParts.push(b);
        session.busyHint = false;
        if (session.idParts.length < 2) { hint('warn', 'Agora o verso'); UI.toast('Frente ok! Vire o documento.', 'ok'); return; }
        UI.loader.show('Montando frente e verso…', '', true);
        return C.idCardPage(session.idParts[0], session.idParts[1]).then(function (jpg) {
          session.idParts = [];
          return Pages.blobToCanvas(jpg).then(function (cv) { return Pages.create(cv, null, 'original'); });
        }).then(savePageToSession).then(function () { UI.loader.hide(); UI.toast('Documento montado!', 'ok'); hint('warn', 'Frente do documento'); });
      }).catch(function (e) { session.busyHint = false; UI.loader.hide(); UI.fail(e); });
      return;
    }
    if (cam) cam.pause();
    UI.loader.show('Achando as bordas…', '', true);
    setTimeout(function () {
      var d = Pages.detect(shot.canvas, shot.corners);
      UI.loader.hide();
      cropFlow(shot.canvas, d ? d.corners : null, { fromCamera: true });
    }, 30);
  }

  /* crop -> edit -> save, used by single-shot capture and imports */
  function cropFlow(canvas, corners, o) {
    o = o || {};
    openCrop({
      canvas: canvas, corners: corners, queueLabel: o.queueLabel,
      onCancel: function () { if (o.fromCamera && cam) cam.resume(); if (o.onSkip) o.onSkip(); },
      onConfirm: function (k) {
        UI.busy('Endireitando a folha…', function () { return Pages.create(canvas, k, DB.settings().filter); }).then(function (page) {
          openEdit(page, {
            isNew: true,
            onSave: function (pg) {
              return savePageToSession(pg).then(function () {
                if (o.next) return o.next();
                if (o.fromCamera) { UI.go('camera', { replace: true }); stackToCamera(); if (cam) cam.resume(); UI.toast('Página ' + session.pages + ' guardada!', 'ok'); }
              });
            },
            onDiscard: function () { if (o.fromCamera) { stackToCamera(); if (cam) cam.resume(); } else if (o.onSkip) o.onSkip(); },
          });
        }).catch(UI.fail);
      },
    });
  }
  function stackToCamera() {
    while (UI.current() !== 'camera' && UI.current() !== 'home') UI.back();
    updateStack();
  }

  /* ---------- QR ---------- */
  function startQr() {
    stopQr();
    if (!cam || !cam.running) return;
    var v = $('#cam-video'), c = document.createElement('canvas'), busy = false;
    Libs.load('jsqr').then(function (jsQR) {
      qrTimer = setInterval(function () {
        if (busy || !v.videoWidth || UI.current() !== 'camera' || session.mode !== 'qr') return;
        busy = true;
        var s = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
        c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(v, 0, 0, c.width, c.height);
        var r = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
        busy = false;
        if (r && r.data) { stopQr(); vibrate(40); showQr(r.data); }
      }, 280);
    }).catch(UI.fail);
  }
  function stopQr() { if (qrTimer) { clearInterval(qrTimer); qrTimer = 0; } }
  function showQr(text) {
    var wrap = h('div'), isUrl = /^https?:\/\//i.test(text);
    wrap.appendChild(h('p', { class: 'qr-result', text: text }));
    var row = h('div', { class: 'opt-inline', style: 'margin-top:12px' });
    var cp = h('button', { class: 'btn btn--secondary' }, UI.icon('x-copy') + 'Copiar');
    cp.onclick = function () { UI.copyText(text); };
    row.appendChild(cp);
    if (isUrl) { var op = h('button', { class: 'btn btn--primary' }, 'Abrir link'); op.onclick = function () { window.open(text, '_blank', 'noopener'); }; row.appendChild(op); }
    wrap.appendChild(row);
    UI.sheet('QR code lido!', wrap, function () { if (session && session.mode === 'qr' && UI.current() === 'camera') startQr(); });
  }

  /* ---------- imports ---------- */
  function canvasesFromFiles(files) {
    return files.reduce(function (p, f) {
      return p.then(function (acc) {
        if (C.kindOf(f) === 'pdf') {
          return C.bytesOf(f).then(function (b) { return C.pdfPagesAsJpeg(b, { dpi: 160, quality: 0.88 }); })
            .then(function (pgs) { pgs.forEach(function (pg) { acc.push({ blob: pg.blob, flat: true }); }); return acc; });
        }
        if (C.kindOf(f) === 'image') acc.push({ blob: f });
        return acc;
      });
    }, Promise.resolve([]));
  }
  /* Photos go through detection; in batch mode they are saved straight away, otherwise one crop screen each. */
  function importFiles(files, batch) {
    if (!files.length) return Promise.resolve();
    return UI.busy('Lendo arquivos…', function () { return canvasesFromFiles(files); }).then(function (list) {
      if (!list.length) { UI.toast('Nenhuma imagem ou PDF reconhecido.', 'error'); return; }
      var flat = list.filter(function (x) { return x.flat; }), photos = list.filter(function (x) { return !x.flat; });
      var chain = Promise.resolve();
      if (flat.length) {
        chain = UI.busy('Importando páginas…', function (p) {
          return flat.reduce(function (q, x, i) {
            return q.then(function () {
              p(i / flat.length, 'Página ' + (i + 1) + ' de ' + flat.length);
              return savePageToSession({ id: DB.uid(), filter: 'original', rotation: 0, corners: null, sourceBlob: x.blob, rectifiedBlob: x.blob, filteredBlob: x.blob });
            });
          }, Promise.resolve());
        });
      }
      if (!photos.length) return chain;
      if (batch) {
        return chain.then(function () {
          return UI.busy('Escaneando fotos…', function (p) {
            return photos.reduce(function (q, x, i) {
              return q.then(function () {
                p(i / photos.length, 'Foto ' + (i + 1) + ' de ' + photos.length);
                return Pages.blobToCanvas(x.blob).then(function (cv) {
                  var d = Pages.detect(cv);
                  return Pages.create(cv, d && d.corners, DB.settings().filter);
                }).then(savePageToSession);
              });
            }, Promise.resolve());
          });
        });
      }
      return chain.then(function () {
        return new Promise(function (resolve) {
          var i = 0;
          function next() {
            if (i >= photos.length) { resolve(); return; }
            var x = photos[i++];
            UI.busy('Achando as bordas…', function () {
              return Pages.blobToCanvas(x.blob).then(function (cv) { return { cv: cv, d: Pages.detect(cv) }; });
            }).then(function (r) {
              cropFlow(r.cv, r.d && r.d.corners, { queueLabel: photos.length > 1 ? i + '/' + photos.length : '', next: next, onSkip: next });
            }).catch(function (e) { UI.fail(e); next(); });
          }
          next();
        });
      });
    });
  }
  function importIntoNewDoc(files) {
    if (!files.length) return;
    session = { docId: null, doc: null, mode: 'single', pages: 0, thumbs: [], idParts: [], insertAt: null };
    var batch = files.length > 3;
    var go = batch ? UI.choose(files.length + ' arquivos', [
      { id: 'auto', label: 'Escanear tudo automaticamente', sub: 'recorte e filtro automáticos', icon: 'wand' },
      { id: 'one', label: 'Ajustar uma por uma', sub: 'você confere o recorte de cada foto', icon: 'crop' },
    ]) : Promise.resolve('one');
    return go.then(function (c) {
      if (!c) return;
      return importFiles(files, c === 'auto').then(function () {
        if (session.doc && session.pages) openDoc(session.doc.id, true);
        else UI.home();
      });
    }).catch(UI.fail);
  }
  /* Results of tools (PDF/JPG) saved as a new document. */
  function importBlobs(files, name) {
    session = { docId: null, doc: newDoc(name || nowName('Documento')), mode: 'single', pages: 0, thumbs: [], idParts: [], insertAt: null };
    return UI.busy('Guardando no DocScan…', function () {
      return files.reduce(function (p, f) {
        return p.then(function () {
          if (/\.pdf$/i.test(f.name)) {
            return C.bytesOf(f.blob).then(function (b) { return C.pdfPagesAsJpeg(b, { dpi: 150, quality: 0.86 }); }).then(function (pgs) {
              return pgs.reduce(function (q, pg) { return q.then(function () { return savePageToSession({ id: DB.uid(), filter: 'original', rotation: 0, corners: null, sourceBlob: pg.blob, rectifiedBlob: pg.blob, filteredBlob: pg.blob }); }); }, Promise.resolve());
            });
          }
          return savePageToSession({ id: DB.uid(), filter: 'original', rotation: 0, corners: null, sourceBlob: f.blob, rectifiedBlob: f.blob, filteredBlob: f.blob });
        });
      }, Promise.resolve());
    }).then(function () { UI.toast('Guardado nos documentos!', 'ok'); openDoc(session.doc.id); });
  }

  /* ======================= CROP ======================= */
  var cropper = null;
  function openCrop(o) {
    var host = $('#crop-host');
    if (cropper) { cropper.destroy(); cropper = null; }
    host.innerHTML = '';
    $('#crop-queue').textContent = o.queueLabel || '';
    UI.go('crop');
    var initial = o.corners || Pages.defaultCorners();
    setTimeout(function () {
      cropper = Cropper.create(host, {
        image: o.canvas, corners: initial,
        onChange: function (c, valid) {
          var ok = $('#crop-ok');
          ok.disabled = !valid;
        },
      });
      if (!o.corners) UI.toast('Não achei a folha sozinho: ajuste os cantos.', null, 2600);
    }, 20);
    function leave() { if (cropper) { cropper.destroy(); cropper = null; } UI.onBack('crop', null); }
    $('#crop-auto').onclick = function () {
      var d = UI.busy('Procurando a folha…', function () { return Pages.detect(o.canvas); });
      d.then(function (r) {
        if (r && cropper) { cropper.setCorners(r.corners, { animate: true }); UI.toast('Folha encontrada!', 'ok'); }
        else UI.toast('Não encontrei a folha. Ajuste manualmente.', 'error');
      });
    };
    $('#crop-all').onclick = function () { if (cropper) cropper.setCorners(Pages.fullCorners(), { animate: true }); };
    $('#crop-retake').onclick = function () { leave(); UI.back(); if (o.onCancel) o.onCancel(); };
    $('#crop-back').onclick = $('#crop-retake').onclick;
    UI.onBack('crop', function () { leave(); if (o.onCancel) setTimeout(o.onCancel, 0); return true; });
    $('#crop-ok').onclick = function () {
      if (!cropper || !cropper.isValid()) { UI.toast('Os cantos formam uma figura inválida.', 'error'); return; }
      var k = cropper.getCorners();
      leave();
      o.onConfirm(k);
    };
    window.onresize = function () { if (cropper && UI.current() === 'crop') cropper.relayout(); };
  }

  /* ======================= EDIT (filters, rotate, annotate) ======================= */
  function openEdit(page, o) {
    o = o || {};
    var work = { filter: page.filter, rotation: page.rotation || 0, small: null, dirty: !!o.isNew, replaced: null };
    var canvas = $('#edit-canvas'), strip = $('#edit-filters'), token = 0;
    $('#edit-title').textContent = o.isNew ? 'Nova página' : 'Editar página';
    $('#edit-crop').disabled = !page.sourceBlob;
    function preview() {
      var my = ++token;
      setTimeout(function () {
        if (my !== token || !work.small) return;
        var f = work.replaced ? work.replaced : Pages.finish(work.small, work.filter, work.rotation);
        if (work.replaced && work.rotation) f = Warp.rotate(work.replaced, work.rotation / 90);
        canvas.width = f.width; canvas.height = f.height;
        canvas.getContext('2d').drawImage(f, 0, 0);
      }, 10);
    }
    function chips() {
      strip.innerHTML = '';
      var thumb = Warp.downscale(work.small, 180);
      Filters.LIST.forEach(function (f) {
        var b = h('button', { class: 'filter-chip', 'aria-pressed': f.id === work.filter ? 'true' : 'false' },
          '<canvas class="filter-chip__thumb"></canvas><span class="filter-chip__label">' + esc(f.label) + '</span><span class="filter-chip__sub">' + esc(f.sub) + '</span>');
        var tc = b.querySelector('canvas'), out = Filters.apply(thumb, f.id);
        tc.width = out.width; tc.height = out.height; tc.getContext('2d').drawImage(out, 0, 0);
        b.addEventListener('click', function () {
          if (work.replaced) { UI.toast('Esta página tem anotações: o filtro foi fixado.'); return; }
          work.filter = f.id; work.dirty = true;
          $$('.filter-chip', strip).forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
          preview();
        });
        strip.appendChild(b);
      });
    }
    UI.go('edit');
    UI.busy('Preparando…', function () {
      return Pages.blobToCanvas(page.rectifiedBlob, 1100).then(function (c) { work.small = c; });
    }).then(function () { chips(); preview(); }).catch(UI.fail);

    $('#edit-rotl').onclick = function () { work.rotation = (work.rotation + 270) % 360; work.dirty = true; preview(); };
    $('#edit-rotr').onclick = function () { work.rotation = (work.rotation + 90) % 360; work.dirty = true; preview(); };
    $('#edit-crop').onclick = function () {
      if (!page.sourceBlob) return;
      UI.busy('Abrindo a foto original…', function () { return Pages.blobToCanvas(page.sourceBlob); }).then(function (src) {
        openCrop({
          canvas: src, corners: page.corners || Pages.fullCorners(),
          onConfirm: function (k) {
            UI.busy('Endireitando a folha…', function () {
              page.filter = work.filter; page.rotation = work.rotation;
              return Pages.recrop(page, k).then(function () { return Pages.blobToCanvas(page.rectifiedBlob, 1100); });
            }).then(function (c) {
              UI.back();
              work.small = c; work.replaced = null; work.dirty = true; chips(); preview();
            }).catch(UI.fail);
          },
        });
      }).catch(UI.fail);
    };
    $('#edit-annot').onclick = function () {
      UI.busy('Abrindo…', function () {
        if (work.replaced) return Promise.resolve(work.replaced);
        return Pages.blobToCanvas(page.rectifiedBlob, 2200).then(function (full) { return Pages.finish(full, work.filter, 0); });
      }).then(function (base) {
        var rotated = work.rotation ? Warp.rotate(base, work.rotation / 90) : base;
        return Annot.annotate(rotated);
      }).then(function (res) {
        if (!res) return;
        work.replaced = res; work.rotation = 0; work.dirty = true;
        work.small = Warp.downscale(res, 1100);
        preview();
      }).catch(UI.fail);
    };
    function leave() { UI.onBack('edit', null); }
    function discard() {
      leave();
      UI.back();
      if (o.onDiscard) o.onDiscard();
    }
    $('#edit-back').onclick = function () {
      if (o.isNew) {
        UI.confirm({ title: 'Descartar esta página?', ok: 'Descartar', danger: true }).then(function (y) { if (y) discard(); });
      } else if (work.dirty) {
        UI.confirm({ title: 'Sair sem salvar?', text: 'As mudanças nesta página serão perdidas.', ok: 'Sair', danger: true }).then(function (y) { if (y) discard(); });
      } else discard();
    };
    UI.onBack('edit', function () { $('#edit-back').onclick(); return false; });
    $('#edit-save').onclick = function () {
      UI.busy('Salvando página…', function () {
        if (work.replaced) {
          return Pages.replaceImage(page, work.replaced);
        }
        if (!o.isNew && work.filter === page.filter && work.rotation === page.rotation && !work.dirty) return page;
        var needs = o.isNew ? (work.filter !== page.filter || work.rotation !== page.rotation) : true;
        page.filter = work.filter; page.rotation = work.rotation;
        return needs ? Pages.rerender(page) : page;
      }).then(function (pg) {
        leave();
        var r = o.onSave ? o.onSave(pg) : null;
        return Promise.resolve(r);
      }).catch(UI.fail);
    };
  }

  /* ======================= DOCUMENT ======================= */
  var curDoc = null;
  function openDoc(id, replace) {
    return DB.get(id).then(function (d) {
      if (!d) { UI.home(); return renderHome(); }
      curDoc = d;
      $('#doc-title').value = d.name;
      renderPages();
      if (replace) { UI.home(); UI.go('doc'); } else UI.go('doc');
    });
  }
  function renderPages() {
    var grid = $('#doc-pages'), d = curDoc;
    grid.innerHTML = '';
    d.pages.forEach(function (p, i) {
      var t = h('div', { class: 'page-tile' },
        '<span class="page-tile__num">' + (i + 1) + '</span><img class="page-tile__img" alt="Página ' + (i + 1) + '">' +
        '<div class="page-tile__actions"><button class="mini-btn" data-a="l" aria-label="Mover para a esquerda"' + (i === 0 ? ' disabled' : '') + '>' + UI.icon('arrow-left') + '</button>' +
        '<button class="mini-btn mini-btn--danger" data-a="d" aria-label="Apagar página">' + UI.icon('trash') + '</button>' +
        '<button class="mini-btn" data-a="r" aria-label="Mover para a direita"' + (i === d.pages.length - 1 ? ' disabled' : '') + '>' + UI.icon('arrow-right') + '</button></div>');
      t.querySelector('img').src = Pages.url(p.filteredBlob);
      t.querySelector('img').addEventListener('click', function () { editPage(i); });
      t.querySelector('.page-tile__actions').addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.a === 'l' && i > 0) { d.pages.splice(i - 1, 0, d.pages.splice(i, 1)[0]); saveDoc(); }
        else if (b.dataset.a === 'r' && i < d.pages.length - 1) { d.pages.splice(i + 1, 0, d.pages.splice(i, 1)[0]); saveDoc(); }
        else if (b.dataset.a === 'd') {
          UI.confirm({ title: 'Apagar a página ' + (i + 1) + '?', ok: 'Apagar', danger: true }).then(function (y) {
            if (!y) return;
            d.pages.splice(i, 1);
            if (!d.pages.length) return DB.remove(d.id).then(function () { UI.toast('Documento vazio apagado.'); UI.home(); renderHome(); });
            saveDoc();
          });
        }
      });
      grid.appendChild(t);
    });
    var add = h('button', { class: 'page-tile page-tile--add' }, UI.icon('plus') + 'Adicionar páginas');
    add.onclick = function () {
      UI.choose('Adicionar páginas', [
        { id: 'cam', label: 'Escanear com a câmera', icon: 'camera' },
        { id: 'files', label: 'Importar fotos ou PDF', icon: 'x-import' },
      ]).then(function (c) {
        if (c === 'cam') openCamera(d.id);
        else if (c === 'files') UI.pickFiles({ accept: 'image/*,application/pdf', multiple: true }).then(function (files) {
          if (!files.length) return;
          session = { docId: d.id, doc: d, mode: 'single', pages: 0, thumbs: [], idParts: [], insertAt: null };
          return importFiles(files, files.length > 3).then(function () { openDoc(d.id, true); });
        }).catch(UI.fail);
      });
    };
    grid.appendChild(add);
  }
  function saveDoc() { return DB.put(curDoc).then(renderPages); }
  function editPage(i) {
    var d = curDoc, page = d.pages[i];
    openEdit(Object.assign({}, page), {
      onSave: function (pg) { d.pages[i] = pg; return DB.put(d).then(function () { UI.back(); renderPages(); UI.toast('Página salva!', 'ok'); }); },
    });
  }
  function docPdf(d) {
    return C.itemsToPdf([Tools.docItem(d)], { pageSize: DB.settings().pageSize });
  }
  function sharePdf(d) {
    return UI.busy('Gerando PDF…', function () { return docPdf(d); }).then(function (b) {
      return UI.share([{ blob: new Blob([b], { type: 'application/pdf' }), name: C.baseName(d.name) + '.pdf' }], d.name);
    }).catch(UI.fail);
  }
  function signDoc() {
    var d = curDoc;
    return UI.busy('Preparando…', function () {
      return Promise.all(d.pages.map(function (p) { return C.loadImage(p.filteredBlob).then(function (im) { return { blob: p.filteredBlob, aspect: im.naturalHeight / im.naturalWidth }; }); }));
    }).then(function (pgs) { return Annot.place(pgs, 'sign'); }).then(function (stamps) {
      if (!stamps) return;
      return UI.busy('Assinando…', function () {
        var byPage = {};
        stamps.forEach(function (s) { (byPage[s.page] = byPage[s.page] || []).push(s); });
        return Object.keys(byPage).reduce(function (p, k) {
          return p.then(function () {
            var pg = d.pages[+k];
            return Annot.burnStamps(pg.filteredBlob, byPage[k]).then(function (cv) { return Pages.replaceImage(pg, cv); });
          });
        }, Promise.resolve()).then(function () { return DB.put(d); });
      }).then(function () { renderPages(); UI.toast('Documento assinado!', 'ok'); });
    }).catch(UI.fail);
  }

  /* ======================= wiring ======================= */
  function wire() {
    $$('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.tab); }); });
    $('#home-search').addEventListener('input', function () { renderHome(); });
    $('#home-sort').addEventListener('click', function () {
      UI.choose('Ordenar por', [{ id: 'date', label: 'Mais recentes', icon: 'x-sort' }, { id: 'name', label: 'Nome (A–Z)', icon: 'x-text' }]).then(function (v) { if (v) { DB.saveSettings({ sortBy: v }); renderHome(); } });
    });
    $('#home-settings').addEventListener('click', settingsSheet);
    $('#btn-scan').addEventListener('click', function () { openCamera(null); });
    $$('[data-quick]').forEach(function (b) {
      b.addEventListener('click', function () {
        var q = b.dataset.quick;
        if (q === 'import') UI.pickFiles({ accept: 'image/*,application/pdf', multiple: true }).then(importIntoNewDoc);
        else if (q === 'idcard') openCamera(null, 'idcard');
        else if (q === 'ocr') Tools.open('ocr');
        else if (q === 'qr') Tools.open('qr');
      });
    });

    $('#cam-close').addEventListener('click', closeCamera);
    $('#cam-stack').addEventListener('click', closeCamera);
    UI.onBack('camera', function () { closeCamera(); return false; });
    $('#cam-shutter').addEventListener('click', function () {
      if (!cam || !cam.running) { $('#nocam-native').click(); return; }
      var btn = $('#cam-shutter');
      btn.disabled = true;
      cam.capture().then(handleShot, UI.fail).then(function () { btn.disabled = session && session.mode === 'qr'; });
    });
    $('#cam-auto').addEventListener('click', function () {
      var on = $('#cam-auto').getAttribute('aria-pressed') !== 'true';
      $('#cam-auto').setAttribute('aria-pressed', on ? 'true' : 'false');
      if (cam) cam.setAutoCapture(on);
      DB.saveSettings({ auto: on });
      UI.toast(on ? 'Captura automática ligada: segure a folha parada.' : 'Captura automática desligada.');
    });
    $('#cam-torch').addEventListener('click', function () {
      var on = $('#cam-torch').getAttribute('aria-pressed') !== 'true';
      cam.setTorch(on).then(function (ok) {
        if (!ok) return;
        $('#cam-torch').setAttribute('aria-pressed', on ? 'true' : 'false');
        $('#cam-torch').innerHTML = UI.icon(on ? 'torch' : 'torch-off');
      });
    });
    $$('#cam-modes [data-mode]').forEach(function (b) { b.addEventListener('click', function () { setMode(b.dataset.mode); }); });
    function camFiles(files) {
      if (!files.length) return;
      if (session.mode === 'qr') return Tools.open('qr', files.map(C.fileItem));
      if (session.mode === 'idcard') {
        return Promise.all(files.slice(0, 2).map(function (f) { return Pages.blobToCanvas(f); })).then(function (cvs) {
          cvs.forEach(function (cv) { handleShot({ canvas: cv, corners: null }); });
        });
      }
      if (cam) cam.pause();
      importFiles(files, session.mode === 'batch').then(function () {
        if (UI.current() !== 'camera') stackToCamera();
        updateStack();
        if (cam) cam.resume();
      });
    }
    $('#cam-import').addEventListener('click', function () { UI.pickFiles({ accept: 'image/*,application/pdf', multiple: true }).then(camFiles); });
    $('#nocam-gallery').addEventListener('click', function () { UI.pickFiles({ accept: 'image/*,application/pdf', multiple: true }).then(camFiles); });
    $('#nocam-native').addEventListener('click', function () { UI.pickFiles({ accept: 'image/*', capture: 'environment' }).then(camFiles); });

    $('#doc-back').addEventListener('click', function () { UI.home(); renderHome(); });
    UI.onBack('doc', function () { UI.home(); renderHome(); return false; });
    $('#doc-title').addEventListener('change', function () {
      var n = $('#doc-title').value.trim();
      if (!n) { $('#doc-title').value = curDoc.name; return; }
      curDoc.name = n; DB.put(curDoc);
    });
    $('#doc-pdf').addEventListener('click', function () { sharePdf(curDoc); });
    $('#doc-share').addEventListener('click', function () {
      var d = curDoc;
      UI.choose('Enviar como', [
        { id: 'pdf', label: 'PDF', sub: 'um arquivo com todas as páginas', icon: 'pdf' },
        { id: 'jpg', label: 'Imagens JPG', sub: d.pages.length + ' imagem(ns), dá para salvar nas Fotos', icon: 'x-image' },
        { id: 'long', label: 'Imagem longa', sub: 'todas as páginas numa só imagem', icon: 'x-long' },
        { id: 'word', label: 'Word (.docx)', sub: 'texto editável', icon: 'x-word' },
      ]).then(function (c) {
        if (c === 'pdf') return sharePdf(d);
        if (c === 'jpg') return UI.share(d.pages.map(function (p, i) { return { blob: p.filteredBlob, name: C.baseName(d.name) + '-' + String(i + 1).padStart(2, '0') + '.jpg' }; }), d.name);
        if (c === 'long') return UI.busy('Juntando…', function () { return C.longImage(d.pages.map(function (p) { return p.filteredBlob; })); }).then(function (b) { return UI.share([{ blob: b, name: C.baseName(d.name) + '-longa.jpg' }]); });
        if (c === 'word') return Tools.open('word', [Tools.docItem(d)]);
      }).catch(UI.fail);
    });
    $('#doc-ocr').addEventListener('click', function () { Tools.open('ocr', [Tools.docItem(curDoc)]); $('#tool-run').click(); });
    $('#doc-sign').addEventListener('click', signDoc);
    $('#doc-tools').addEventListener('click', function () {
      var d = curDoc;
      UI.choose('Mais ferramentas', [
        { id: 'word', label: 'Para Word', icon: 'x-word' },
        { id: 'excel', label: 'Para Excel', icon: 'x-excel' },
        { id: 'ppt', label: 'Para PowerPoint', icon: 'x-ppt' },
        { id: 'watermark', label: "Marca d'água", icon: 'x-watermark' },
        { id: 'protect', label: 'Proteger com senha', icon: 'x-lock' },
        { id: 'pagenum', label: 'Numerar páginas', icon: 'x-number' },
        { id: 'merge', label: 'Juntar com outros arquivos', icon: 'x-merge' },
        { id: 'split', label: 'Dividir em arquivos', icon: 'x-split' },
        { id: 'longimg', label: 'Imagem longa', icon: 'x-long' },
        { id: 'annot', label: 'Anotar uma página', sub: 'caneta, marca-texto, borracha, texto', icon: 'pencil' },
      ]).then(function (id) {
        if (!id) return;
        if (id === 'annot') return d.pages.length === 1 ? editPage(0) : UI.toast('Toque na página que quer anotar e use “Anotar”.');
        Tools.open(id, [Tools.docItem(d)]);
      });
    });
    $('#doc-more').addEventListener('click', function () {
      docMenu(curDoc).then(function () { if (UI.current() === 'doc') DB.get(curDoc.id).then(function (d) { if (d) { curDoc = d; $('#doc-title').value = d.name; renderPages(); } }); });
    });
  }

  /* ======================= boot ======================= */
  function boot() {
    wire();
    setTab('docs');
    renderHome().catch(UI.fail);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* ignore */ });
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ });
    try { history.replaceState({ s: 1 }, ''); } catch (e) { /* ignore */ }
  }

  root.App = { openCamera: openCamera, openDoc: openDoc, importBlobs: importBlobs, importFiles: importIntoNewDoc, renderHome: renderHome };
  boot();
})(window);
