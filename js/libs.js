/* Lazy loader for the heavy third-party libraries (only downloaded when a tool needs them; then cached by the
   service worker so they keep working offline). */
(function (root) {
  'use strict';
  var CDN = {
    jspdf: { url: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', get: function () { return root.jspdf; } },
    pdflib: { url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js', get: function () { return root.PDFLib; } },
    pdfjs: {
      url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      get: function () { return root.pdfjsLib; },
      init: function (lib) { lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; },
    },
    tesseract: { url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', get: function () { return root.Tesseract; } },
    jszip: { url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', get: function () { return root.JSZip; } },
    xlsx: { url: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', get: function () { return root.XLSX; } },
    pptx: { url: 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js', get: function () { return root.PptxGenJS; } },
    mammoth: { url: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js', get: function () { return root.mammoth; } },
    html2canvas: { url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', get: function () { return root.html2canvas; } },
    marked: { url: 'https://cdnjs.cloudflare.com/ajax/libs/marked/4.3.0/marked.min.js', get: function () { return root.marked; } },
    jsqr: { url: 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js', get: function () { return root.jsQR; } },
  };
  var pending = {};

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { resolve(); };
      s.onerror = function () { s.remove(); reject(new Error('offline')); };
      document.head.appendChild(s);
    });
  }

  function load(name) {
    var def = CDN[name];
    if (!def) return Promise.reject(new Error('Biblioteca desconhecida: ' + name));
    var ready = def.get();
    if (ready) return Promise.resolve(ready);
    if (!pending[name]) {
      pending[name] = loadScript(def.url).then(function () {
        var lib = def.get();
        if (!lib) throw new Error('falhou');
        if (def.init) def.init(lib);
        return lib;
      }).catch(function (e) {
        delete pending[name];
        var err = new Error('Não consegui baixar um componente necessário. Conecte-se à internet uma vez para usar esta ferramenta.');
        err.cause = e;
        throw err;
      });
    }
    return pending[name];
  }

  root.Libs = {
    load: load,
    loadAll: function (names) { return Promise.all(names.map(load)); },
    urls: function () { return Object.keys(CDN).map(function (k) { return CDN[k].url; }); },
  };
})(window);
