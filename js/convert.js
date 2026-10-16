/* DocScan — conversion engine. Everything runs on the phone; heavy libraries are loaded on demand by Libs.
   An "item" is {name, kind: 'pdf'|'image'|'docx'|'sheet'|'md'|'txt'|'appdoc', blob?, doc?}. */
(function (root) {
  'use strict';
  var PAGE = { a4: [595.28, 841.89], letter: [612, 792] };
  var A4_CSS_W = 794, A4_CSS_H = 1123;

  /* ---------------- small helpers ---------------- */
  function baseName(name) { return String(name || 'documento').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'documento'; }
  function kindOf(file) {
    var n = (file.name || '').toLowerCase(), t = file.type || '';
    if (t === 'application/pdf' || /\.pdf$/.test(n)) return 'pdf';
    if (/^image\//.test(t) || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/.test(n)) return 'image';
    if (/\.docx$/.test(n) || t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
    if (/\.(xlsx|xls|ods|csv)$/.test(n) || /spreadsheet|ms-excel|text\/csv/.test(t)) return 'sheet';
    if (/\.(md|markdown)$/.test(n) || t === 'text/markdown') return 'md';
    if (/\.txt$/.test(n) || t === 'text/plain') return 'txt';
    if (/\.(pptx?|key)$/.test(n)) return 'pptx';
    return 'unknown';
  }
  function fileItem(file) { return { name: file.name, kind: kindOf(file), blob: file }; }
  function bytesOf(blob) { return blob.arrayBuffer ? blob.arrayBuffer().then(function (b) { return new Uint8Array(b); }) : new Response(blob).arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
  function textOf(blob) { return blob.text ? blob.text() : new Response(blob).text(); }
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Não consegui abrir a imagem "' + (blob.name || '') + '".')); };
      img.src = url;
    });
  }
  function canvasFrom(src, maxDim) {
    var w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
    var s = Math.min(1, (maxDim || 1e9) / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function canvasBlob(c, type, q) {
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Falha ao gerar imagem.')); }, type || 'image/jpeg', q == null ? 0.88 : q);
    });
  }
  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); }; fr.onerror = reject; fr.readAsDataURL(blob);
    });
  }
  function jpegFromBlob(blob, maxDim, q) {
    return loadImage(blob).then(function (img) { var c = canvasFrom(img, maxDim || 2600); return canvasBlob(c, 'image/jpeg', q || 0.88).then(function (b) { return { blob: b, w: c.width, h: c.height }; }); });
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function xmlEsc(s) { return esc(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ---------------- pdf.js ---------------- */
  function openPdf(bytes, password) {
    return Libs.load('pdfjs').then(function (pdfjs) {
      return pdfjs.getDocument({ data: bytes.slice(), password: password || undefined, isEvalSupported: false }).promise;
    }).catch(function (e) {
      if (e && e.name === 'PasswordException') {
        var err = new Error(e.code === 2 ? 'Senha incorreta.' : 'Este PDF tem senha.');
        err.needPassword = true; err.wrongPassword = e.code === 2;
        throw err;
      }
      throw e && e.message && /PDF|Invalid/i.test(e.message) ? new Error('Arquivo PDF inválido ou corrompido.') : e;
    });
  }
  function renderPage(pdf, n, scale) {
    return pdf.getPage(n).then(function (page) {
      var vp = page.getViewport({ scale: scale || 1.5 });
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        var base = page.getViewport({ scale: 1 });
        page.cleanup();
        return { canvas: c, wPt: base.width, hPt: base.height };
      });
    });
  }
  function scaleForWidth(pdf, n, px) {
    return pdf.getPage(n).then(function (p) { return px / p.getViewport({ scale: 1 }).width; });
  }
  function pdfThumbs(bytes, width, password) {
    return openPdf(bytes, password).then(function (pdf) {
      var out = [], i = 1;
      function next() {
        if (i > pdf.numPages) { pdf.destroy(); return out; }
        var n = i++;
        return scaleForWidth(pdf, n, width || 220).then(function (s) { return renderPage(pdf, n, s); })
          .then(function (r) { return canvasBlob(r.canvas, 'image/jpeg', 0.75); })
          .then(function (b) { out.push(b); return next(); });
      }
      return next();
    });
  }
  function pdfPagesAsJpeg(bytes, opts, onProgress) {
    opts = opts || {};
    return openPdf(bytes, opts.password).then(function (pdf) {
      var out = [], i = 1;
      function next() {
        if (i > pdf.numPages) { pdf.destroy(); return out; }
        var n = i++;
        if (onProgress) onProgress((n - 1) / pdf.numPages, 'Página ' + n + ' de ' + pdf.numPages);
        return renderPage(pdf, n, (opts.dpi || 150) / 72).then(function (r) {
          return canvasBlob(r.canvas, 'image/jpeg', opts.quality || 0.85).then(function (b) {
            out.push({ blob: b, w: r.canvas.width, h: r.canvas.height, wPt: r.wPt, hPt: r.hPt });
            r.canvas.width = r.canvas.height = 1;
            return next();
          });
        });
      }
      return next();
    });
  }

  /* ---------------- PDF building (pdf-lib) ---------------- */
  function placeImage(page, img, opts) {
    var sz = page.getSize(), m = opts.margin || 0;
    var s = Math.min((sz.width - 2 * m) / img.width, (sz.height - 2 * m) / img.height);
    var w = img.width * s, h = img.height * s;
    page.drawImage(img, { x: (sz.width - w) / 2, y: (sz.height - h) / 2, width: w, height: h });
  }
  function addImagePage(doc, jpg, wpx, hpx, opts) {
    return doc.embedJpg(jpg).then(function (img) {
      var size = opts.pageSize || 'a4', pw, ph;
      if (size === 'original') { pw = 595.28; ph = 595.28 * hpx / wpx; }
      else {
        var p = PAGE[size] || PAGE.a4;
        var land = wpx > hpx * 1.08;
        pw = land ? p[1] : p[0]; ph = land ? p[0] : p[1];
      }
      var page = doc.addPage([pw, ph]);
      placeImage(page, img, { margin: size === 'original' ? 0 : (opts.margin || 0) });
    });
  }
  function appDocImages(doc) { return (doc.pages || []).map(function (p) { return p.filteredBlob; }).filter(Boolean); }

  /* Converts any list of items into ONE pdf (Uint8Array). */
  function itemsToPdf(items, opts, onProgress) {
    opts = opts || {};
    return Libs.load('pdflib').then(function (L) {
      return L.PDFDocument.create().then(function (out) {
        var i = 0;
        function step() {
          if (i >= items.length) return out.save();
          var it = items[i++];
          if (onProgress) onProgress((i - 1) / items.length, 'Preparando ' + it.name);
          return itemToPdfPages(L, out, it, opts, onProgress).then(step);
        }
        return step();
      });
    });
  }
  function itemToPdfPages(L, out, it, opts, onProgress) {
    if (it.kind === 'pdf') {
      return bytesOf(it.blob).then(function (b) {
        return L.PDFDocument.load(b).catch(function (e) {
          if (/encrypt/i.test(String(e && e.message))) throw new Error('"' + it.name + '" tem senha. Use "Remover senha" antes.');
          throw new Error('Não consegui ler "' + it.name + '".');
        });
      }).then(function (src) {
        return out.copyPages(src, src.getPageIndices()).then(function (pages) { pages.forEach(function (p) { out.addPage(p); }); });
      });
    }
    if (it.kind === 'image' || it.kind === 'appdoc') {
      var blobs = it.kind === 'image' ? [it.blob] : appDocImages(it.doc);
      var j = 0;
      var next = function () {
        if (j >= blobs.length) return Promise.resolve();
        var b = blobs[j++];
        return jpegFromBlob(b, opts.maxDim || 2600, opts.quality || 0.86).then(function (r) {
          return bytesOf(r.blob).then(function (jb) { return addImagePage(out, jb, r.w, r.h, opts); });
        }).then(next);
      };
      return next();
    }
    return documentToCanvases(it, onProgress).then(function (canvases) {
      var j = 0;
      var next = function () {
        if (j >= canvases.length) return Promise.resolve();
        var c = canvases[j++];
        return canvasBlob(c, 'image/jpeg', 0.9).then(bytesOf).then(function (jb) {
          return out.embedJpg(jb).then(function (img) {
            var page = out.addPage(PAGE.a4);
            page.drawImage(img, { x: 0, y: 0, width: PAGE.a4[0], height: PAGE.a4[1] });
          });
        }).then(next);
      };
      return next();
    });
  }

  /* ---------------- Office / text documents -> HTML -> page canvases ---------------- */
  var DOC_CSS = 'body,.dsdoc{font-family:Calibri,Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#111}' +
    '.dsdoc h1{font-size:26px;margin:.6em 0 .3em}.dsdoc h2{font-size:21px;margin:.6em 0 .3em}.dsdoc h3{font-size:17px}' +
    '.dsdoc p{margin:0 0 .6em}.dsdoc table{border-collapse:collapse;width:100%;font-size:12px;margin:.5em 0}' +
    '.dsdoc td,.dsdoc th{border:1px solid #888;padding:3px 5px;vertical-align:top}.dsdoc th{background:#eee}' +
    '.dsdoc img{max-width:100%}.dsdoc pre{white-space:pre-wrap;font-family:Consolas,monospace;font-size:13px}' +
    '.dsdoc code{background:#f2f2f2;padding:0 3px}.dsdoc blockquote{border-left:4px solid #ccc;margin:0;padding-left:12px;color:#444}';
  function documentToHtml(it) {
    if (it.kind === 'docx') {
      return Promise.all([Libs.load('mammoth'), bytesOf(it.blob)]).then(function (r) {
        return r[0].convertToHtml({ arrayBuffer: r[1].buffer }).then(function (res) { return res.value; });
      });
    }
    if (it.kind === 'sheet') {
      return Promise.all([Libs.load('xlsx'), bytesOf(it.blob)]).then(function (r) {
        var X = r[0], wb = X.read(r[1], { type: 'array' });
        return wb.SheetNames.map(function (n) {
          var html = X.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' });
          return '<h2>' + esc(n) + '</h2>' + html.replace(/<\/?(html|body|head)[^>]*>/gi, '');
        }).join('');
      });
    }
    if (it.kind === 'md') {
      return Promise.all([Libs.load('marked'), textOf(it.blob)]).then(function (r) { return r[0].parse(r[1], { mangle: false, headerIds: false }); });
    }
    if (it.kind === 'txt') return textOf(it.blob).then(function (t) { return '<pre>' + esc(t) + '</pre>'; });
    if (it.kind === 'pptx') return Promise.reject(new Error('PowerPoint para PDF não funciona no celular sem servidor. Exporte o PPT como PDF no PowerPoint/Keynote.'));
    return Promise.reject(new Error('Formato não suportado: ' + it.name));
  }
  function sanitizeHtml(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach(function (n) { n.remove(); });
    tpl.content.querySelectorAll('*').forEach(function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
      });
    });
    return tpl.innerHTML;
  }
  function htmlToCanvases(html) {
    return Libs.load('html2canvas').then(function (h2c) {
      var host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + A4_CSS_W + 'px;background:#fff;z-index:-1';
      host.innerHTML = '<style>' + DOC_CSS + '</style><div class="dsdoc" style="padding:57px 60px;box-sizing:border-box;width:' + A4_CSS_W + 'px">' + sanitizeHtml(html) + '</div>';
      document.body.appendChild(host);
      var inner = host.querySelector('.dsdoc');
      return tick().then(function () {
        var total = Math.max(A4_CSS_H, inner.scrollHeight);
        var pages = Math.ceil(total / A4_CSS_H);
        inner.style.minHeight = (pages * A4_CSS_H) + 'px';
        return h2c(inner, { scale: 1.6, backgroundColor: '#ffffff', logging: false, useCORS: true, windowWidth: A4_CSS_W });
      }).then(function (big) {
        host.remove();
        var out = [], pageH = Math.round(big.width * A4_CSS_H / A4_CSS_W);
        for (var y = 0; y < big.height - 4; y += pageH) {
          var c = document.createElement('canvas');
          c.width = big.width; c.height = pageH;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(big, 0, y, big.width, Math.min(pageH, big.height - y), 0, 0, big.width, Math.min(pageH, big.height - y));
          out.push(c);
        }
        big.width = big.height = 1;
        return out;
      }, function (e) { host.remove(); throw e; });
    });
  }
  function documentToCanvases(it) { return documentToHtml(it).then(htmlToCanvases); }

  /* ---------------- OCR (Tesseract) ---------------- */
  var ocrWorker = null, ocrLogger = null;
  function getOcr() {
    if (ocrWorker) return ocrWorker;
    ocrWorker = Libs.load('tesseract').then(function (T) {
      return T.createWorker('por', 1, { logger: function (m) { if (ocrLogger) ocrLogger(m); } });
    }).catch(function (e) { ocrWorker = null; throw e; });
    return ocrWorker;
  }
  function ocrImage(src, onProgress) {
    var input = src instanceof Blob ? loadImage(src).then(function (img) { return canvasFrom(img, 2600); }) : Promise.resolve(src);
    return input.then(function (canvas) {
      ocrLogger = function (m) {
        if (!onProgress) return;
        if (m.status === 'recognizing text') onProgress(m.progress, 'Lendo o texto…');
        else if (/loading|initializ/.test(m.status)) onProgress(0, 'Preparando leitura de texto (só na 1ª vez)…');
      };
      return getOcr().then(function (w) { return w.recognize(canvas); }).then(function (r) {
        ocrLogger = null;
        var d = r.data;
        return {
          text: (d.text || '').replace(/\n{3,}/g, '\n\n').trim(),
          words: (d.words || []).filter(function (w) { return w.confidence > 25 && w.text.trim(); }).map(function (w) {
            return { text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 };
          }),
          paragraphs: (d.paragraphs || []).map(function (p) { return p.text.replace(/\s*\n\s*/g, ' ').trim(); }).filter(Boolean),
          width: canvas.width, height: canvas.height,
        };
      });
    });
  }

  /* ---------------- text from PDFs ---------------- */
  function pdfTextPages(bytes, opts, onProgress) {
    opts = opts || {};
    return openPdf(bytes, opts.password).then(function (pdf) {
      var out = [], i = 1;
      function next() {
        if (i > pdf.numPages) { pdf.destroy(); return out; }
        var n = i++;
        if (onProgress) onProgress((n - 1) / pdf.numPages, 'Lendo página ' + n + ' de ' + pdf.numPages);
        return pdf.getPage(n).then(function (page) {
          var vp = page.getViewport({ scale: 1 });
          return page.getTextContent().then(function (tc) {
            var words = tc.items.filter(function (t) { return t.str && t.str.trim(); }).map(function (t) {
              var x = t.transform[4], yb = t.transform[5], h = Math.abs(t.transform[3]) || t.height || 10;
              return { text: t.str, x0: x, x1: x + (t.width || t.str.length * h * 0.5), y0: vp.height - yb - h, y1: vp.height - yb };
            });
            var chars = words.reduce(function (s, w) { return s + w.text.length; }, 0);
            if (chars >= 15 || opts.noOcr) return { words: words, width: vp.width, height: vp.height, ocr: false };
            return renderPage(pdf, n, 2.2).then(function (r) {
              return ocrImage(r.canvas, function (p, msg) { if (onProgress) onProgress((n - 1 + p) / pdf.numPages, msg + ' (pág. ' + n + ')'); });
            }).then(function (o) { return { words: o.words, width: o.width, height: o.height, ocr: true, text: o.text, paragraphs: o.paragraphs }; });
          });
        }).then(function (p) { out.push(p); return next(); });
      }
      return next();
    });
  }

  /* Groups positioned words into lines, then into a table (columns found from gaps shared by many lines). */
  function wordsToLines(words) {
    var ws = words.slice().sort(function (a, b) { return (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2; });
    var lines = [];
    ws.forEach(function (w) {
      var cy = (w.y0 + w.y1) / 2, h = Math.max(1, w.y1 - w.y0), L = lines[lines.length - 1];
      if (L && Math.abs(cy - L.cy) < Math.max(h, L.h) * 0.55) { L.words.push(w); L.cy = (L.cy * (L.words.length - 1) + cy) / L.words.length; L.h = Math.max(L.h, h); }
      else lines.push({ cy: cy, h: h, words: [w] });
    });
    lines.forEach(function (L) { L.words.sort(function (a, b) { return a.x0 - b.x0; }); });
    return lines;
  }
  function lineText(L) {
    var s = '', prev = null;
    L.words.forEach(function (w) {
      if (prev) s += (w.x0 - prev.x1 > L.h * 0.15 || !/[-/]$/.test(prev.text)) ? ' ' : '';
      s += w.text; prev = w;
    });
    return s.replace(/\s+/g, ' ').trim();
  }
  function linesToParagraphs(lines) {
    var paras = [], cur = null, prev = null;
    lines.forEach(function (L) {
      var t = lineText(L);
      if (!t) return;
      var gap = prev ? L.cy - prev.cy : 0;
      var big = L.h > 0 && prev && L.h > prev.h * 1.35;
      if (!cur || gap > Math.max(L.h, prev.h) * 1.75 || big || (prev && prev.h > L.h * 1.35)) {
        cur = { text: t, size: L.h }; paras.push(cur);
      } else cur.text += (/-$/.test(cur.text) ? '' : ' ') + t;
      prev = L;
    });
    var sizes = paras.map(function (p) { return p.size; }).sort(function (a, b) { return a - b; });
    var body = sizes[Math.floor(sizes.length / 2)] || 10;
    return paras.map(function (p) { return { type: p.size > body * 1.45 && p.text.length < 120 ? 'h' : 'p', text: p.text }; });
  }
  function wordsToTable(words) {
    var lines = wordsToLines(words);
    if (!lines.length) return [];
    var hAvg = lines.reduce(function (s, L) { return s + L.h; }, 0) / lines.length;
    lines.forEach(function (L) {
      var cells = [], cur = null;
      L.words.forEach(function (w) {
        if (cur && w.x0 - cur.x1 < hAvg * 1.1) { cur.text += ' ' + w.text; cur.x1 = w.x1; }
        else { cur = { text: w.text, x0: w.x0, x1: w.x1 }; cells.push(cur); }
      });
      L.cells = cells;
    });
    var starts = [];
    lines.forEach(function (L) { L.cells.forEach(function (c) { starts.push(c.x0); }); });
    starts.sort(function (a, b) { return a - b; });
    var cols = [];
    starts.forEach(function (x) {
      var c = cols[cols.length - 1];
      if (c && x - c.max < hAvg * 1.5) { c.max = x; c.n++; } else cols.push({ min: x, max: x, n: 1 });
    });
    var minN = Math.max(1, Math.floor(lines.length * 0.15));
    var anchors = cols.filter(function (c) { return c.n >= minN; }).map(function (c) { return c.min; });
    if (!anchors.length) anchors = [starts[0]];
    return lines.map(function (L) {
      var row = new Array(anchors.length).fill('');
      L.cells.forEach(function (c) {
        var k = 0;
        for (var a = 0; a < anchors.length; a++) if (c.x0 >= anchors[a] - hAvg * 0.8) k = a;
        row[k] = row[k] ? row[k] + ' ' + c.text : c.text;
      });
      return row.map(numberish);
    });
  }
  function numberish(s) {
    var t = s.trim();
    if (/^-?R?\$?\s?-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(t) || /^-?\d+(,\d+)?$/.test(t)) {
      var n = parseFloat(t.replace(/R\$|\s/g, '').replace(/\./g, '').replace(',', '.'));
      if (isFinite(n)) return n;
    }
    return t;
  }

  /* ---------------- DOCX writer (minimal OOXML) ---------------- */
  function buildDocx(blocks) {
    return Libs.load('jszip').then(function (JSZip) {
      var zip = new JSZip(), body = '', rels = '', media = [], imgN = 0;
      function run(text, bold) {
        return '<w:r>' + (bold ? '<w:rPr><w:b/></w:rPr>' : '') + '<w:t xml:space="preserve">' + xmlEsc(text) + '</w:t></w:r>';
      }
      var chain = Promise.resolve();
      blocks.forEach(function (b) {
        chain = chain.then(function () {
          if (b.type === 'h') body += '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' + run(b.text) + '</w:p>';
          else if (b.type === 'h2') body += '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>' + run(b.text) + '</w:p>';
          else if (b.type === 'li') body += '<w:p><w:pPr><w:ind w:left="360" w:hanging="240"/></w:pPr>' + run('• ' + b.text) + '</w:p>';
          else if (b.type === 'break') body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
          else if (b.type === 'table') {
            var cols = Math.max.apply(null, b.rows.map(function (r) { return r.length; }).concat([1]));
            body += '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
              ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (s) { return '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="888888"/>'; }).join('') +
              '</w:tblBorders></w:tblPr><w:tblGrid>' + new Array(cols + 1).join('<w:gridCol/>') + '</w:tblGrid>' +
              b.rows.map(function (r) {
                var cells = '';
                for (var c = 0; c < cols; c++) cells += '<w:tc><w:p>' + run(r[c] == null ? '' : String(r[c])) + '</w:p></w:tc>';
                return '<w:tr>' + cells + '</w:tr>';
              }).join('') + '</w:tbl><w:p/>';
          } else if (b.type === 'img') {
            return bytesOf(b.blob).then(function (bytes) {
              imgN++;
              var id = 'rIdImg' + imgN, maxW = 5900000, emuW = Math.min(maxW, Math.round(b.w * 9525)), emuH = Math.round(emuW * b.h / b.w);
              if (emuH > 8200000) { emuW = Math.round(emuW * 8200000 / emuH); emuH = 8200000; }
              media.push({ name: 'image' + imgN + '.jpeg', bytes: bytes });
              rels += '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + imgN + '.jpeg"/>';
              body += '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + emuW + '" cy="' + emuH + '"/>' +
                '<wp:docPr id="' + imgN + '" name="Imagem ' + imgN + '"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
                '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
                '<pic:nvPicPr><pic:cNvPr id="' + imgN + '" name="image' + imgN + '.jpeg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + id + '"/>' +
                '<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + emuW + '" cy="' + emuH + '"/></a:xfrm>' +
                '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
            });
          } else body += '<w:p>' + run(b.text || '') + '</w:p>';
        });
      });
      return chain.then(function () {
        zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
          '<Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
        zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
        zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' + rels + '</Relationships>');
        zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>' +
          '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
          '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
          '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
          '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>' +
          '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>');
        zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>' +
          (body || '<w:p/>') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>');
        media.forEach(function (m) { zip.file('word/media/' + m.name, m.bytes); });
        return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      });
    });
  }
  function htmlToBlocks(html) {
    var tpl = document.createElement('template'), out = [];
    tpl.innerHTML = sanitizeHtml(html);
    (function walk(node) {
      Array.prototype.forEach.call(node.childNodes, function (n) {
        if (n.nodeType === 3) { var t = n.textContent.trim(); if (t) out.push({ type: 'p', text: t }); return; }
        if (n.nodeType !== 1) return;
        var tag = n.tagName.toLowerCase(), text = n.textContent.replace(/\s+/g, ' ').trim();
        if (/^h1$/.test(tag)) out.push({ type: 'h', text: text });
        else if (/^h[2-6]$/.test(tag)) out.push({ type: 'h2', text: text });
        else if (tag === 'li') out.push({ type: 'li', text: text });
        else if (tag === 'table') out.push({ type: 'table', rows: Array.prototype.map.call(n.querySelectorAll('tr'), function (tr) { return Array.prototype.map.call(tr.children, function (td) { return td.textContent.trim(); }); }) });
        else if (tag === 'pre') n.textContent.split('\n').forEach(function (l) { out.push({ type: 'p', text: l }); });
        else if (/^(p|blockquote)$/.test(tag)) { if (text) out.push({ type: 'p', text: text }); }
        else walk(n);
      });
    })(tpl.content);
    return out;
  }

  /* ---------------- XLSX / PPTX writers ---------------- */
  function buildXlsx(sheets) {
    return Libs.load('xlsx').then(function (X) {
      var wb = X.utils.book_new();
      sheets.forEach(function (s, i) {
        var ws = X.utils.aoa_to_sheet(s.rows.length ? s.rows : [['(sem texto encontrado)']]);
        var widths = [];
        s.rows.forEach(function (r) { r.forEach(function (v, c) { widths[c] = Math.min(60, Math.max(widths[c] || 8, String(v).length + 2)); }); });
        ws['!cols'] = widths.map(function (w) { return { wch: w }; });
        X.utils.book_append_sheet(wb, ws, (s.name || 'Página ' + (i + 1)).slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
      });
      var buf = X.write(wb, { bookType: 'xlsx', type: 'array' });
      return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  }
  function buildPptx(slides) {
    return Libs.load('pptx').then(function (P) {
      var pptx = new P(), first = slides[0] || { w: 16, h: 9 };
      var aspect = first.h / first.w, W = aspect > 1 ? 7.5 : 10, H = W * aspect;
      pptx.defineLayout({ name: 'DOCSCAN', width: W, height: H });
      pptx.layout = 'DOCSCAN';
      pptx.title = 'DocScan';
      var chain = Promise.resolve();
      slides.forEach(function (s) {
        chain = chain.then(function () { return blobToDataURL(s.blob); }).then(function (data) {
          var sl = pptx.addSlide(), a = s.h / s.w, w = W, h = W * a;
          if (h > H) { h = H; w = H / a; }
          sl.addImage({ data: data, x: (W - w) / 2, y: (H - h) / 2, w: w, h: h });
          if (s.text) sl.addNotes(s.text);
        });
      });
      return chain.then(function () { return pptx.write({ outputType: 'blob' }); });
    });
  }

  /* ---------------- PDF page operations (pdf-lib) ---------------- */
  function loadPdfLib(bytes) {
    return Libs.load('pdflib').then(function (L) {
      return L.PDFDocument.load(bytes).then(function (doc) { return { L: L, doc: doc }; }, function (e) {
        if (/encrypt/i.test(String(e && e.message))) { var err = new Error('Este PDF tem senha. Use "Remover senha" primeiro.'); err.needPassword = true; throw err; }
        throw new Error('Não consegui ler este PDF.');
      });
    });
  }
  /* order: [{index, rotate}] -> new pdf containing just those pages in that order */
  function reorderPdf(bytes, order) {
    return loadPdfLib(bytes).then(function (r) {
      return r.L.PDFDocument.create().then(function (out) {
        return out.copyPages(r.doc, order.map(function (o) { return o.index; })).then(function (pages) {
          pages.forEach(function (p, i) {
            var add = order[i].rotate || 0;
            if (add) p.setRotation(r.L.degrees(((p.getRotation().angle || 0) + add + 360) % 360));
            out.addPage(p);
          });
          return out.save();
        });
      });
    });
  }
  function splitPdf(bytes, groups) {
    var jobs = groups.map(function (g) { return function () { return reorderPdf(bytes, g.map(function (i) { return { index: i }; })); }; });
    var out = [];
    return jobs.reduce(function (p, j) { return p.then(j).then(function (b) { out.push(b); }); }, Promise.resolve()).then(function () { return out; });
  }
  function parseRanges(spec, n) {
    var groups = [];
    String(spec || '').split(/[;,]/).forEach(function (part) {
      var m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!m) return;
      var a = Math.max(1, +m[1]), b = Math.min(n, m[2] ? +m[2] : a);
      if (a > b) return;
      var g = [];
      for (var i = a; i <= b; i++) g.push(i - 1);
      groups.push(g);
    });
    return groups;
  }
  function hexRgb(L, hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '') ? parseInt(RegExp.$1, 16) : 0x888888;
    return L.rgb(((m >> 16) & 255) / 255, ((m >> 8) & 255) / 255, (m & 255) / 255);
  }
  function watermarkPdf(bytes, o) {
    return loadPdfLib(bytes).then(function (r) {
      var L = r.L, doc = r.doc;
      var prep = o.image ? bytesOf(o.image).then(function (b) { return (o.image.type === 'image/png' ? doc.embedPng(b) : doc.embedJpg(b)); }) : doc.embedFont(L.StandardFonts.HelveticaBold);
      return prep.then(function (res) {
        doc.getPages().forEach(function (page) {
          var sz = page.getSize(), op = o.opacity == null ? 0.18 : o.opacity;
          if (o.image) {
            var s = Math.min(sz.width, sz.height) * (o.scale || 0.5) / Math.max(res.width, res.height);
            var w = res.width * s, h = res.height * s;
            if (o.tile) {
              for (var y = 0; y < sz.height; y += h * 1.8) for (var x = 0; x < sz.width; x += w * 1.8) page.drawImage(res, { x: x, y: y, width: w, height: h, opacity: op });
            } else page.drawImage(res, { x: (sz.width - w) / 2, y: (sz.height - h) / 2, width: w, height: h, opacity: op });
            return;
          }
          var text = safeWinAnsi(o.text || 'CONFIDENCIAL'), size = o.size || Math.min(sz.width, sz.height) / Math.max(6, text.length * 0.62);
          var tw = res.widthOfTextAtSize(text, size), ang = o.diagonal === false ? 0 : 45, rad = ang * Math.PI / 180;
          var draw = function (cx, cy) {
            page.drawText(text, {
              x: cx - (tw / 2) * Math.cos(rad) + (size / 3) * Math.sin(rad), y: cy - (tw / 2) * Math.sin(rad) - (size / 3) * Math.cos(rad),
              size: size, font: res, color: hexRgb(L, o.color), opacity: op, rotate: L.degrees(ang),
            });
          };
          if (o.tile) {
            var stepX = tw * 0.9 + 40, stepY = size * 4;
            for (var yy = stepY / 2; yy < sz.height + stepY; yy += stepY) for (var xx = 0; xx < sz.width + stepX; xx += stepX) draw(xx, yy);
          } else draw(sz.width / 2, sz.height / 2);
        });
        return doc.save();
      });
    });
  }
  function safeWinAnsi(s) {
    return String(s).replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
  }
  function pageNumbersPdf(bytes, o) {
    return loadPdfLib(bytes).then(function (r) {
      var L = r.L, doc = r.doc;
      return doc.embedFont(L.StandardFonts.Helvetica).then(function (font) {
        var pages = doc.getPages(), n = pages.length;
        pages.forEach(function (page, i) {
          var sz = page.getSize(), text = (o.format || '{n} / {t}').replace('{n}', i + 1).replace('{t}', n), size = 10;
          var tw = font.widthOfTextAtSize(text, size), pos = o.position || 'bottom-center';
          var x = pos.indexOf('right') >= 0 ? sz.width - tw - 28 : pos.indexOf('left') >= 0 ? 28 : (sz.width - tw) / 2;
          var y = pos.indexOf('top') === 0 ? sz.height - 24 : 18;
          page.drawText(text, { x: x, y: y, size: size, font: font, color: L.rgb(0.25, 0.25, 0.25) });
        });
        return doc.save();
      });
    });
  }
  /* stamps: [{page, png(Blob), x, y, w, h}] in normalized page coords (top-left origin) */
  function stampPdf(bytes, stamps) {
    return loadPdfLib(bytes).then(function (r) {
      var doc = r.doc, pages = doc.getPages();
      return stamps.reduce(function (p, s) {
        return p.then(function () { return bytesOf(s.png); }).then(function (b) { return s.png.type === 'image/jpeg' ? doc.embedJpg(b) : doc.embedPng(b); }).then(function (img) {
          var page = pages[s.page];
          if (!page) return;
          var sz = page.getSize(), rot = ((Math.round((page.getRotation().angle || 0) / 90) * 90) % 360 + 360) % 360;
          var W = rot % 180 ? sz.height : sz.width, H = rot % 180 ? sz.width : sz.height;
          var vx = s.x * W, vy = s.y * H, w = s.w * W, h = s.h * H;
          // visual (top-left origin, as the viewer shows the rotated page) -> PDF user space (pdf.js convention)
          var toUser = function (x, y) {
            if (rot === 90) return { x: y, y: x };
            if (rot === 180) return { x: sz.width - x, y: y };
            if (rot === 270) return { x: sz.width - y, y: sz.height - x };
            return { x: x, y: sz.height - y };
          };
          var a = toUser(vx, vy + h);
          page.drawImage(img, { x: a.x, y: a.y, width: w, height: h, rotate: r.L.degrees(rot) });
        });
      }, Promise.resolve()).then(function () { return doc.save(); });
    });
  }

  /* Re-renders every page to JPEG (compress / unlock / protect). */
  function rasterizePdf(bytes, o, onProgress) {
    o = o || {};
    return pdfPagesAsJpeg(bytes, { dpi: o.dpi || 130, quality: o.quality || 0.7, password: o.password }, onProgress).then(function (pages) {
      if (o.encrypt) {
        return Libs.load('jspdf').then(function (J) {
          var pdf = null;
          return pages.reduce(function (p, pg) {
            return p.then(function () { return bytesOf(pg.blob); }).then(function (b) {
              var size = [pg.wPt, pg.hPt], orient = pg.wPt > pg.hPt ? 'l' : 'p';
              if (!pdf) pdf = new J.jsPDF({ unit: 'pt', format: size, orientation: orient, encryption: { userPassword: o.encrypt, ownerPassword: o.encrypt + '#owner', userPermissions: ['print', 'copy'] } });
              else pdf.addPage(size, orient);
              pdf.addImage(b, 'JPEG', 0, 0, pg.wPt, pg.hPt, undefined, 'NONE');
            });
          }, Promise.resolve()).then(function () { return new Uint8Array(pdf.output('arraybuffer')); });
        });
      }
      return Libs.load('pdflib').then(function (L) {
        return L.PDFDocument.create().then(function (out) {
          return pages.reduce(function (p, pg) {
            return p.then(function () { return bytesOf(pg.blob); }).then(function (b) { return out.embedJpg(b); }).then(function (img) {
              var page = out.addPage([pg.wPt, pg.hPt]);
              page.drawImage(img, { x: 0, y: 0, width: pg.wPt, height: pg.hPt });
            });
          }, Promise.resolve()).then(function () { return out.save(); });
        });
      });
    });
  }

  /* ---------------- images ---------------- */
  function longImage(blobs, o) {
    o = o || {};
    return Promise.all(blobs.map(loadImage)).then(function (imgs) {
      var W = Math.min(1400, Math.max.apply(null, imgs.map(function (i) { return i.naturalWidth; }))), gap = o.gap == null ? 16 : o.gap;
      var hs = imgs.map(function (i) { return Math.round(i.naturalHeight * W / i.naturalWidth); });
      var H = hs.reduce(function (a, b) { return a + b; }, 0) + gap * (imgs.length - 1);
      var scale = Math.min(1, 16000 / H);
      var c = document.createElement('canvas');
      c.width = Math.round(W * scale); c.height = Math.round(H * scale);
      var ctx = c.getContext('2d'), y = 0;
      ctx.fillStyle = o.background || '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
      imgs.forEach(function (img, i) { ctx.drawImage(img, 0, y * scale, W * scale, hs[i] * scale); y += hs[i] + gap; });
      return canvasBlob(c, 'image/jpeg', 0.9);
    });
  }
  /* ID card: front and back at real ID-1 size (85.6 x 54 mm) on an A4 page. */
  function idCardPage(front, back) {
    return Promise.all([front, back].filter(Boolean).map(loadImage)).then(function (imgs) {
      var dpi = 200, mm = dpi / 25.4, W = Math.round(210 * mm), H = Math.round(297 * mm);
      var c = document.createElement('canvas');
      c.width = W; c.height = H;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      var cw = 85.6 * mm, ch = 54 * mm, x = (W - cw) / 2, ys = imgs.length === 2 ? [H * 0.22, H * 0.55] : [H * 0.35];
      imgs.forEach(function (img, i) {
        var land = img.naturalWidth >= img.naturalHeight, w = land ? cw : ch, h = land ? ch : cw;
        ctx.drawImage(img, (W - w) / 2, ys[i], w, h);
      });
      return canvasBlob(c, 'image/jpeg', 0.92);
    });
  }
  function readQr(blob) {
    return Promise.all([Libs.load('jsqr'), loadImage(blob)]).then(function (r) {
      var jsQR = r[0], tries = [1600, 900, 2400];
      for (var i = 0; i < tries.length; i++) {
        var c = canvasFrom(r[1], tries[i]), d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        var res = jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
        if (res && res.data) return res.data;
      }
      return null;
    });
  }

  /* ---------------- zip ---------------- */
  function zipFiles(files) {
    return Libs.load('jszip').then(function (JSZip) {
      var z = new JSZip();
      files.forEach(function (f) { z.file(f.name, f.blob); });
      return z.generateAsync({ type: 'blob' });
    });
  }

  root.Convert = {
    PAGE: PAGE, kindOf: kindOf, fileItem: fileItem, baseName: baseName, bytesOf: bytesOf, loadImage: loadImage,
    canvasFrom: canvasFrom, canvasBlob: canvasBlob, jpegFromBlob: jpegFromBlob, blobToDataURL: blobToDataURL,
    openPdf: openPdf, renderPage: renderPage, pdfThumbs: pdfThumbs, pdfPagesAsJpeg: pdfPagesAsJpeg,
    itemsToPdf: itemsToPdf, documentToHtml: documentToHtml, htmlToCanvases: htmlToCanvases, htmlToBlocks: htmlToBlocks,
    ocrImage: ocrImage, pdfTextPages: pdfTextPages, wordsToLines: wordsToLines, lineText: lineText,
    linesToParagraphs: linesToParagraphs, wordsToTable: wordsToTable,
    buildDocx: buildDocx, buildXlsx: buildXlsx, buildPptx: buildPptx,
    reorderPdf: reorderPdf, splitPdf: splitPdf, parseRanges: parseRanges, watermarkPdf: watermarkPdf,
    pageNumbersPdf: pageNumbersPdf, stampPdf: stampPdf, rasterizePdf: rasterizePdf,
    longImage: longImage, idCardPage: idCardPage, readQr: readQr, zipFiles: zipFiles, esc: esc,
  };
})(window);
