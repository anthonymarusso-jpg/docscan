/* DocScan — UI helpers: screens, toast, loader, dialogs, sheets, file picking, save/share. */
(function (root) {
  'use strict';
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  function icon(name, cls) {
    var file = name.indexOf('x-') === 0 ? 'assets/icons-extra.svg' : 'assets/icons.svg';
    var id = name.indexOf('x-') === 0 ? name : 'i-' + name;
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="' + file + '#' + id + '"/></svg>';
  }
  function h(tag, attrs, html) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    if (html != null) el.innerHTML = html;
    return el;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function oneShot(el, cls) {
    if (!el) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    el.addEventListener('animationend', function f() { el.classList.remove(cls); el.removeEventListener('animationend', f); });
  }

  /* ---------- screens with a back stack ---------- */
  var stack = ['home'], handlers = {};
  function show(name) {
    $$('.screen').forEach(function (s) { s.classList.toggle('is-active', s.id === 'screen-' + name); });
  }
  var UI = {
    $: $, $$: $$, h: h, icon: icon, esc: esc, oneShot: oneShot,
    current: function () { return stack[stack.length - 1]; },
    go: function (name, opts) {
      if (opts && opts.replace) stack[stack.length - 1] = name; else if (UI.current() !== name) stack.push(name);
      show(name);
      try { history.pushState({ s: stack.length }, ''); } catch (e) { /* ignore */ }
    },
    back: function () {
      var cur = UI.current();
      if (handlers[cur] && handlers[cur]() === false) return;
      if (stack.length > 1) stack.pop();
      show(UI.current());
    },
    home: function () { stack = ['home']; show('home'); },
    onBack: function (name, fn) { handlers[name] = fn; },
  };
  window.addEventListener('popstate', function () {
    if (closeTopOverlay()) { try { history.pushState({}, ''); } catch (e) { /* ignore */ } return; }
    if (stack.length > 1) UI.back();
  });

  /* ---------- toast ---------- */
  var toastTimer = 0;
  UI.toast = function (msg, kind, ms) {
    var el = $('#toast');
    el.className = 'toast-bubble' + (kind === 'ok' ? ' toast-bubble--ok' : kind === 'error' ? ' toast-bubble--error' : '');
    el.textContent = msg;
    void el.offsetWidth;
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-show'); }, ms || (kind === 'error' ? 4200 : 2400));
  };

  /* ---------- loader ---------- */
  var loaderDepth = 0;
  UI.loader = {
    show: function (text, sub, dark) {
      loaderDepth++;
      var el = $('#loader');
      el.classList.toggle('loader--dark', !!dark);
      $('#loader-text').textContent = text || 'Concentrando chakra…';
      $('#loader-sub').textContent = sub || '';
      $('#loader-bar').hidden = true;
      el.classList.add('is-show');
    },
    progress: function (p, sub) {
      var bar = $('#loader-bar');
      if (p != null && isFinite(p)) { bar.hidden = false; bar.firstElementChild.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%'; }
      if (sub != null) $('#loader-sub').textContent = sub;
    },
    hide: function (force) {
      loaderDepth = force ? 0 : Math.max(0, loaderDepth - 1);
      if (!loaderDepth) $('#loader').classList.remove('is-show');
    },
  };
  UI.busy = function (text, fn) {
    UI.loader.show(text);
    return new Promise(function (r) { setTimeout(r, 30); })
      .then(function () { return fn(function (p, sub) { UI.loader.progress(p, sub); }); })
      .then(function (v) { UI.loader.hide(); return v; }, function (e) { UI.loader.hide(); throw e; });
  };
  UI.fail = function (e) {
    console.error(e);
    UI.toast((e && e.message) || 'Algo deu errado.', 'error');
  };

  /* ---------- overlays ---------- */
  var overlays = [];
  function closeTopOverlay() {
    var o = overlays[overlays.length - 1];
    if (!o) return false;
    o.close(null);
    return true;
  }
  function overlay(inner, center, onClose) {
    var bd = h('div', { class: 'backdrop' + (center ? ' backdrop--center' : '') });
    bd.appendChild(inner);
    $('#overlays').appendChild(bd);
    void bd.offsetWidth;
    bd.classList.add('is-open');
    var o = {
      el: bd,
      close: function (v) {
        var i = overlays.indexOf(o);
        if (i < 0) return;
        overlays.splice(i, 1);
        bd.classList.remove('is-open');
        setTimeout(function () { bd.remove(); }, 260);
        if (onClose) onClose(v);
      },
    };
    bd.addEventListener('click', function (e) { if (e.target === bd) o.close(null); });
    overlays.push(o);
    return o;
  }
  UI.closeOverlays = function () { while (overlays.length) overlays[overlays.length - 1].close(null); };

  UI.confirm = function (o) {
    return new Promise(function (resolve) {
      var d = h('div', { class: 'dialog', role: 'alertdialog' },
        '<img class="dialog__art" src="assets/shuriken-metal.svg" alt=""><h3 class="dialog__title">' + esc(o.title) + '</h3>' +
        (o.text ? '<p class="dialog__text">' + esc(o.text) + '</p>' : '') +
        '<div class="dialog__actions"><button class="btn btn--secondary" data-v="0">' + esc(o.cancel || 'Cancelar') + '</button>' +
        '<button class="btn ' + (o.danger ? 'btn--danger' : 'btn--primary') + '" data-v="1">' + esc(o.ok || 'OK') + '</button></div>');
      var ov = overlay(d, true, function (v) { resolve(!!v); });
      $$('button', d).forEach(function (b) { b.addEventListener('click', function () { ov.close(b.dataset.v === '1'); }); });
    });
  };
  UI.alert = function (title, text) {
    return new Promise(function (resolve) {
      var d = h('div', { class: 'dialog', role: 'alertdialog' },
        '<img class="dialog__art" src="assets/shuriken-metal.svg" alt=""><h3 class="dialog__title">' + esc(title) + '</h3>' +
        '<p class="dialog__text">' + esc(text) + '</p><div class="dialog__actions"><button class="btn btn--primary">OK</button></div>');
      var ov = overlay(d, true, function () { resolve(); });
      $('button', d).addEventListener('click', function () { ov.close(true); });
    });
  };
  UI.prompt = function (o) {
    return new Promise(function (resolve) {
      var d = h('div', { class: 'dialog', role: 'dialog' },
        '<h3 class="dialog__title">' + esc(o.title) + '</h3>' + (o.text ? '<p class="dialog__text">' + esc(o.text) + '</p>' : '') +
        '<input class="field" type="' + (o.type || 'text') + '" ' + (o.type === 'password' ? 'autocomplete="new-password"' : '') + ' placeholder="' + esc(o.placeholder || '') + '">' +
        '<div class="dialog__actions" style="margin-top:12px"><button class="btn btn--secondary" data-v="0">Cancelar</button><button class="btn btn--primary" data-v="1">' + esc(o.ok || 'OK') + '</button></div>');
      var input = $('input', d);
      input.value = o.value || '';
      var ov = overlay(d, true, function (v) { resolve(v); });
      $$('button', d).forEach(function (b) {
        b.addEventListener('click', function () { ov.close(b.dataset.v === '1' ? input.value : null); });
      });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ov.close(input.value); });
      setTimeout(function () { input.focus(); if (input.select) input.select(); }, 60);
    });
  };
  /* Sheet with arbitrary content; returns {el, close}. */
  UI.sheet = function (title, bodyEl, onClose) {
    var s = h('div', { class: 'sheet', role: 'dialog' }, '<div class="sheet__grip"></div>' + (title ? '<h3 class="sheet__title">' + esc(title) + '</h3>' : ''));
    var body = h('div', { class: 'sheet__body' });
    if (bodyEl) body.appendChild(bodyEl);
    s.appendChild(body);
    var ov = overlay(s, false, onClose);
    return { el: s, body: body, close: ov.close };
  };
  UI.choose = function (title, options) {
    return new Promise(function (resolve) {
      var list = h('div', { class: 'choice-list' });
      var sh;
      options.forEach(function (o) {
        if (!o) return;
        var b = h('button', { class: 'choice' }, (o.icon ? icon(o.icon) : '') + '<span>' + esc(o.label) + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</span>');
        b.addEventListener('click', function () { sh.close(o.id); });
        list.appendChild(b);
      });
      sh = UI.sheet(title, list, function (v) { resolve(v); });
    });
  };

  /* ---------- files ---------- */
  UI.pickFiles = function (o) {
    o = o || {};
    return new Promise(function (resolve) {
      var input = h('input', { type: 'file', accept: o.accept || '*/*', style: 'position:fixed;left:-9999px;opacity:0' });
      if (o.multiple) input.multiple = true;
      if (o.capture) input.setAttribute('capture', o.capture);
      var done = false;
      input.addEventListener('change', function () {
        done = true;
        var files = Array.prototype.slice.call(input.files || []);
        input.remove();
        resolve(files);
      });
      window.addEventListener('focus', function onF() {
        window.removeEventListener('focus', onF);
        setTimeout(function () { if (!done) { input.remove(); resolve([]); } }, 1500);
      });
      document.body.appendChild(input);
      input.click();
    });
  };

  var MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    jpg: 'image/jpeg', png: 'image/png', zip: 'application/zip', txt: 'text/plain' };
  function asFile(blob, name) {
    var ext = (name.split('.').pop() || '').toLowerCase(), type = blob.type || MIME[ext] || 'application/octet-stream';
    try { return new File([blob], name, { type: type }); } catch (e) { blob.name = name; return blob; }
  }
  function download(blob, name) {
    var url = URL.createObjectURL(blob), a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  UI.canShareFiles = function (files) {
    try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: files })); } catch (e) { return false; }
  };
  /* files: [{blob, name}] -> share sheet (AirDrop, WhatsApp, Arquivos…) or download. */
  UI.share = function (files, title) {
    var fs = files.map(function (f) { return asFile(f.blob, f.name); });
    if (UI.canShareFiles(fs)) {
      return navigator.share({ files: fs, title: title || fs[0].name }).then(function () { return true; }, function (e) {
        if (e && e.name === 'AbortError') return false;
        fs.forEach(function (f) { download(f, f.name); });
        return true;
      });
    }
    fs.forEach(function (f) { download(f, f.name); });
    UI.toast(fs.length > 1 ? 'Arquivos baixados.' : 'Arquivo baixado.', 'ok');
    return Promise.resolve(true);
  };
  UI.download = function (blob, name) { download(asFile(blob, name), name); };
  UI.copyText = function (text) {
    var ok = function () { UI.toast('Texto copiado!', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(ok, fallback);
    return fallback();
    function fallback() {
      var ta = h('textarea', { style: 'position:fixed;left:-9999px' });
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { UI.toast('Não consegui copiar.', 'error'); }
      ta.remove();
    }
  };
  UI.prefersReducedMotion = function () { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); };

  root.UI = UI;
})(window);
