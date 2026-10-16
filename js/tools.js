/* DocScan — CamScanner-style tools (convert / organize / edit / utilities) and the generic tool runner. */
(function (root) {
  'use strict';
  var $ = UI.$, h = UI.h, esc = UI.esc, C = Convert;

  var KIND_LABEL = { pdf: 'PDF', image: 'IMG', docx: 'DOC', sheet: 'XLS', md: 'MD', txt: 'TXT', appdoc: 'SCAN', pptx: 'PPT' };
  var ACCEPT = {
    pdf: 'application/pdf,.pdf', image: 'image/*',
    docx: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sheet: '.xlsx,.xls,.csv,.ods', md: '.md,.markdown,text/markdown', txt: '.txt,text/plain', pptx: '.pptx,.ppt',
  };
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function pdfBlob(bytes) { return new Blob([bytes], { type: 'application/pdf' }); }
  function stamp() { var d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0'); }

  /* ---------- helpers that turn the selected items into what a tool needs ---------- */
  function pageImages(items, onP) {
    var out = [];
    return items.reduce(function (p, it, k) {
      return p.then(function () {
        if (it.kind === 'appdoc') { it.doc.pages.forEach(function (pg) { out.push({ blob: pg.filteredBlob, src: it }); }); return; }
        if (it.kind === 'image') { out.push({ blob: it.blob, src: it }); return; }
        if (it.kind === 'pdf') {
          return C.bytesOf(it.blob).then(function (b) { return C.pdfPagesAsJpeg(b, { dpi: 150, quality: 0.85 }, function (q, m) { if (onP) onP((k + q) / items.length, m); }); })
            .then(function (pgs) { pgs.forEach(function (pg) { out.push({ blob: pg.blob, src: it, text: null }); }); });
        }
        return C.itemsToPdf([it], {}).then(function (b) { return C.pdfPagesAsJpeg(b, { dpi: 150 }); }).then(function (pgs) { pgs.forEach(function (pg) { out.push({ blob: pg.blob, src: it }); }); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }
  function asSinglePdf(items, onP) {
    if (items.length === 1 && items[0].kind === 'pdf') return C.bytesOf(items[0].blob);
    return C.itemsToPdf(items, { pageSize: DB.settings().pageSize }, onP);
  }
  function pdfPageCount(bytes) { return Libs.load('pdflib').then(function (L) { return L.PDFDocument.load(bytes, { ignoreEncryption: true }); }).then(function (d) { return d.getPageCount(); }); }
  function ensureUnlocked(bytes) {
    return Libs.load('pdflib').then(function (L) {
      return L.PDFDocument.load(bytes).then(function () { return bytes; }, function (e) {
        if (!/encrypt/i.test(String(e && e.message))) throw new Error('Não consegui ler este PDF.');
        UI.loader.hide(true);
        return UI.prompt({ title: 'PDF com senha', text: 'Digite a senha para abrir este PDF.', type: 'password', ok: 'Abrir' }).then(function (pw) {
          if (pw == null) throw new Error('Operação cancelada.');
          return UI.busy('Abrindo PDF…', function (p) { return C.rasterizePdf(bytes, { password: pw, dpi: 160, quality: 0.85 }, p); });
        });
      });
    });
  }
  function ocrItems(items, onP) {
    var res = [];
    return pageImages(items, onP).then(function (pgs) {
      return pgs.reduce(function (p, pg, i) {
        return p.then(function () {
          return C.ocrImage(pg.blob, function (q, m) { if (onP) onP((i + q) / pgs.length, m + ' (pág. ' + (i + 1) + '/' + pgs.length + ')'); });
        }).then(function (o) { res.push({ o: o, blob: pg.blob }); });
      }, Promise.resolve());
    }).then(function () { return res; });
  }
  function textPagesOf(items, onP) {
    // returns [{words, width, height, text?, imgBlob?}] for every page of every item (PDF text layer or OCR)
    var out = [];
    return items.reduce(function (p, it, k) {
      return p.then(function () {
        var sub = function (q, m) { if (onP) onP((k + q) / items.length, m); };
        if (it.kind === 'pdf') {
          return C.bytesOf(it.blob).then(ensureUnlocked).then(function (b) { return C.pdfTextPages(b, {}, sub); }).then(function (pgs) { out.push.apply(out, pgs); });
        }
        if (it.kind === 'md' || it.kind === 'txt' || it.kind === 'docx' || it.kind === 'sheet') {
          return C.documentToHtml(it).then(function (html) { out.push({ html: html }); });
        }
        return ocrItems([it], sub).then(function (rs) { rs.forEach(function (r) { out.push({ words: r.o.words, width: r.o.width, height: r.o.height, text: r.o.text, paragraphs: r.o.paragraphs, imgBlob: r.blob }); }); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* ---------- tool definitions ---------- */
  var TOOLS = [
    { id: 'word', group: 'Converter', name: 'Para Word', sub: 'PDF, foto ou Markdown em .docx editável', icon: 'x-word', color: 'blue',
      accept: ['pdf', 'image', 'appdoc', 'md', 'txt'], multi: true, run: 'Converter para Word',
      options: [{ id: 'images', type: 'check', label: 'Incluir a imagem de cada página', sub: 'mantém o visual original junto do texto', value: false }],
      exec: function (items, o, onP) {
        return textPagesOf(items, onP).then(function (pages) {
          var blocks = [];
          return pages.reduce(function (p, pg, i) {
            return p.then(function () {
              if (i) blocks.push({ type: 'break' });
              if (pg.html) { blocks.push.apply(blocks, C.htmlToBlocks(pg.html)); return; }
              var add = function () {
                var paras = C.linesToParagraphs(C.wordsToLines(pg.words || []));
                if (!paras.length && pg.text) paras = pg.text.split(/\n{2,}/).map(function (t) { return { type: 'p', text: t.replace(/\n/g, ' ') }; });
                if (!paras.length) paras = [{ type: 'p', text: '(nenhum texto encontrado nesta página)' }];
                blocks.push.apply(blocks, paras);
              };
              if (o.images && pg.imgBlob) return C.jpegFromBlob(pg.imgBlob, 1400, 0.8).then(function (r) { blocks.push({ type: 'img', blob: r.blob, w: r.w, h: r.h }); add(); });
              add();
            });
          }, Promise.resolve()).then(function () { return C.buildDocx(blocks); });
        }).then(function (b) { return { files: [{ blob: b, name: C.baseName(items[0].name) + '.docx' }] }; });
      } },
    { id: 'excel', group: 'Converter', name: 'Para Excel', sub: 'tabelas de fotos e PDFs em .xlsx', icon: 'x-excel', color: 'green',
      accept: ['pdf', 'image', 'appdoc'], multi: true, run: 'Converter para Excel',
      exec: function (items, o, onP) {
        return textPagesOf(items, onP).then(function (pages) {
          var sheets = pages.map(function (pg, i) { return { name: 'Página ' + (i + 1), rows: pg.html ? [] : C.wordsToTable(pg.words || []) }; });
          return C.buildXlsx(sheets);
        }).then(function (b) { return { files: [{ blob: b, name: C.baseName(items[0].name) + '.xlsx' }], note: 'As colunas são reconhecidas pela posição do texto. Confira a tabela no Excel.' }; });
      } },
    { id: 'ppt', group: 'Converter', name: 'Para PPT', sub: 'cada página vira um slide', icon: 'x-ppt', color: 'red',
      accept: ['pdf', 'image', 'appdoc'], multi: true, run: 'Converter para PowerPoint',
      options: [{ id: 'notes', type: 'check', label: 'Texto da página nas anotações do slide', sub: 'usa leitura de texto (mais lento)', value: false }],
      exec: function (items, o, onP) {
        var getText = o.notes ? textPagesOf(items, function (q, m) { onP(q * 0.6, m); }) : Promise.resolve(null);
        return getText.then(function (tp) {
          return pageImages(items, function (q, m) { onP(0.6 + q * 0.3, m); }).then(function (imgs) {
            return Promise.all(imgs.map(function (im) { return C.jpegFromBlob(im.blob, 1800, 0.85); })).then(function (rs) {
              return C.buildPptx(rs.map(function (r, i) {
                var t = tp && tp[i] ? (tp[i].text || C.linesToParagraphs(C.wordsToLines(tp[i].words || [])).map(function (p) { return p.text; }).join('\n\n')) : '';
                return { blob: r.blob, w: r.w, h: r.h, text: t };
              }));
            });
          });
        }).then(function (b) { return { files: [{ blob: b, name: C.baseName(items[0].name) + '.pptx' }] }; });
      } },
    { id: 'images', group: 'Converter', name: 'Para imagens', sub: 'páginas do PDF em JPG', icon: 'x-image', color: 'orange',
      accept: ['pdf'], multi: false, run: 'Converter para JPG',
      options: [{ id: 'dpi', type: 'select', label: 'Qualidade', value: '150', choices: [['110', 'Leve'], ['150', 'Normal'], ['220', 'Alta']] }],
      exec: function (items, o, onP) {
        return C.bytesOf(items[0].blob).then(ensureUnlocked).then(function (b) { return C.pdfPagesAsJpeg(b, { dpi: +o.dpi, quality: 0.88 }, onP); }).then(function (pgs) {
          var base = C.baseName(items[0].name);
          return { files: pgs.map(function (p, i) { return { blob: p.blob, name: base + '-' + String(i + 1).padStart(2, '0') + '.jpg' }; }), zipName: base + '-imagens.zip', images: true };
        });
      } },
    { id: 'pdf', group: 'Converter', name: 'Para PDF', sub: 'fotos, Word, Excel, Markdown e texto', icon: 'pdf', color: 'red',
      accept: ['image', 'appdoc', 'docx', 'sheet', 'md', 'txt', 'pdf', 'pptx'], multi: true, run: 'Criar PDF',
      options: [
        { id: 'pageSize', type: 'select', label: 'Tamanho da página (fotos)', value: 'a4', choices: [['a4', 'A4'], ['letter', 'Carta'], ['original', 'Tamanho da foto']] },
        { id: 'margin', type: 'select', label: 'Margem (fotos)', value: '0', choices: [['0', 'Sem margem'], ['18', 'Pequena'], ['36', 'Grande']] },
      ],
      exec: function (items, o, onP) {
        return C.itemsToPdf(items, { pageSize: o.pageSize, margin: +o.margin }, onP).then(function (b) { return { files: [{ blob: pdfBlob(b), name: C.baseName(items[0].name) + '.pdf' }] }; });
      } },
    { id: 'ocr', group: 'Converter', name: 'Extrair texto', sub: 'copie o texto de fotos e PDFs', icon: 'x-ocr', color: 'blue',
      accept: ['image', 'appdoc', 'pdf'], multi: true, run: 'Extrair texto',
      exec: function (items, o, onP) {
        return textPagesOf(items, onP).then(function (pages) {
          var text = pages.map(function (pg) {
            if (pg.text) return pg.text;
            return C.wordsToLines(pg.words || []).map(C.lineText).join('\n');
          }).join('\n\n— — —\n\n').trim();
          return { text: text, base: C.baseName(items[0].name) };
        });
      } },

    { id: 'merge', group: 'Organizar', name: 'Mesclar arquivos', sub: 'junte vários documentos em um PDF', icon: 'x-merge', color: 'orange',
      accept: ['pdf', 'image', 'appdoc', 'docx', 'sheet', 'md', 'txt'], multi: true, min: 2, run: 'Mesclar',
      exec: function (items, o, onP) {
        return C.itemsToPdf(items, { pageSize: DB.settings().pageSize }, onP).then(function (b) { return { files: [{ blob: pdfBlob(b), name: 'Mesclado-' + stamp() + '.pdf' }] }; });
      } },
    { id: 'extract', group: 'Organizar', name: 'Extrair páginas', sub: 'novo PDF só com as páginas escolhidas', icon: 'x-extract', color: 'metal',
      accept: ['pdf', 'appdoc', 'image'], multi: false, run: 'Escolher páginas',
      exec: function (items, o, onP) {
        return asSinglePdf(items, onP).then(ensureUnlocked).then(function (b) {
          return Pages_pick(b, 'select', 'Toque nas páginas para extrair').then(function (order) {
            if (!order) throw new Error('Operação cancelada.');
            return C.reorderPdf(b, order);
          });
        }).then(function (b) { return { files: [{ blob: pdfBlob(b), name: C.baseName(items[0].name) + '-paginas.pdf' }] }; });
      } },
    { id: 'organize', group: 'Organizar', name: 'Reordenar', sub: 'mova, gire ou exclua páginas', icon: 'x-sort', color: 'metal',
      accept: ['pdf', 'appdoc'], multi: false, run: 'Organizar páginas',
      exec: function (items, o, onP) {
        return asSinglePdf(items, onP).then(ensureUnlocked).then(function (b) {
          return Pages_pick(b, 'organize', 'Use as setas para mover, gire ou exclua').then(function (order) {
            if (!order) throw new Error('Operação cancelada.');
            return C.reorderPdf(b, order);
          });
        }).then(function (b) { return { files: [{ blob: pdfBlob(b), name: C.baseName(items[0].name) + '-organizado.pdf' }] }; });
      } },
    { id: 'split', group: 'Organizar', name: 'Dividir PDF', sub: 'separe em vários arquivos', icon: 'x-split', color: 'metal',
      accept: ['pdf', 'appdoc'], multi: false, run: 'Dividir',
      options: [
        { id: 'mode', type: 'select', label: 'Como dividir', value: 'each', choices: [['each', 'Uma página por arquivo'], ['ranges', 'Por intervalos']] },
        { id: 'ranges', type: 'text', label: 'Intervalos (ex.: 1-3, 4, 5-8)', value: '', showIf: { mode: 'ranges' } },
      ],
      exec: function (items, o, onP) {
        return asSinglePdf(items, onP).then(ensureUnlocked).then(function (b) {
          return pdfPageCount(b).then(function (n) {
            var groups = o.mode === 'ranges' ? C.parseRanges(o.ranges, n) : Array.from({ length: n }, function (_, i) { return [i]; });
            if (!groups.length) throw new Error('Informe intervalos válidos, por exemplo: 1-3, 4-6.');
            return C.splitPdf(b, groups).then(function (parts) {
              var base = C.baseName(items[0].name);
              return { files: parts.map(function (p, i) { return { blob: pdfBlob(p), name: base + '-parte' + (i + 1) + '.pdf' }; }), zipName: base + '-dividido.zip' };
            });
          });
        });
      } },

    { id: 'sign', group: 'Editar', name: 'Assinatura eletrônica', sub: 'assine, escreva e date seus PDFs', icon: 'x-sign', color: 'blue',
      accept: ['pdf', 'appdoc', 'image'], multi: false, run: 'Abrir para assinar',
      exec: function (items, o, onP) {
        return asSinglePdf(items, onP).then(ensureUnlocked).then(function (b) {
          return C.pdfPagesAsJpeg(b, { dpi: 110, quality: 0.8 }, onP).then(function (pgs) {
            UI.loader.hide(true);
            return Annot.place(pgs.map(function (p) { return { blob: p.blob, aspect: p.h / p.w }; }), 'sign').then(function (stamps) {
              if (!stamps) throw new Error('Operação cancelada.');
              UI.loader.show('Assinando…');
              return C.stampPdf(b, stamps);
            });
          });
        }).then(function (b) { return { files: [{ blob: pdfBlob(b), name: C.baseName(items[0].name) + '-assinado.pdf' }] }; });
      } },
    { id: 'watermark', group: 'Editar', name: "Marca d'água", sub: 'carimbe texto ou imagem nas páginas', icon: 'x-watermark', color: 'blue',
      accept: ['pdf', 'appdoc', 'image'], multi: true, run: "Aplicar marca d'água",
      options: [
        { id: 'kind', type: 'select', label: 'Tipo', value: 'text', choices: [['text', 'Texto'], ['image', 'Imagem (logo)']] },
        { id: 'text', type: 'text', label: 'Texto', value: 'CONFIDENCIAL', showIf: { kind: 'text' } },
        { id: 'image', type: 'file', label: 'Imagem da marca', accept: 'image/*', showIf: { kind: 'image' } },
        { id: 'color', type: 'select', label: 'Cor', value: '#E23D2E', choices: [['#E23D2E', 'Vermelho'], ['#1F4E9C', 'Azul'], ['#555555', 'Cinza'], ['#141414', 'Preto']], showIf: { kind: 'text' } },
        { id: 'opacity', type: 'select', label: 'Transparência', value: '0.18', choices: [['0.1', 'Bem suave'], ['0.18', 'Suave'], ['0.3', 'Média'], ['0.5', 'Forte']] },
        { id: 'layout', type: 'select', label: 'Disposição', value: 'diag', choices: [['diag', 'Diagonal no centro'], ['flat', 'Horizontal no centro'], ['tile', 'Repetida (mosaico)']] },
      ],
      exec: function (items, o, onP) {
        if (o.kind === 'image' && !o.image) return Promise.reject(new Error('Escolha a imagem da marca d\'água.'));
        return asSinglePdf(items, onP).then(ensureUnlocked).then(function (b) {
          var img = o.kind === 'image' ? (o.image.type === 'image/png' ? Promise.resolve(o.image) : C.jpegFromBlob(o.image, 1200).then(function (r) { return r.blob; })) : Promise.resolve(null);
          return img.then(function (im) {
            return C.watermarkPdf(b, { text: o.text, color: o.color, opacity: +o.opacity, diagonal: o.layout !== 'flat', tile: o.layout === 'tile', image: im });
          });
        }).then(function (b) { return { files: [{ blob: pdfBlob(b), name: C.baseName(items[0].name) + '-marca.pdf' }] }; });
      } },
    { id: 'pagenum', group: 'Editar', name: 'Numerar páginas', sub: 'adicione “1 / 10” no rodapé', icon: 'x-number', color: 'metal',
      accept: ['pdf', 'appdoc', 'image'], multi: true, run: 'Numerar',
      options: [
        { id: 'position', type: 'select', label: 'Posição', value: 'bottom-center', choices: [['bottom-center', 'Rodapé centro'], ['bottom-right', 'Rodapé direita'], ['top-right', 'Topo direita']] },
        { id: 'format', type: 'select', label: 'Formato', value: '{n} / {t}', choices: [['{n} / {t}', '1 / 10'], ['{n}', '1'], ['Página {n} de {t}', 'Página 1 de 10']] },
      ],
      exec: function (items, o, onP) {
        return asSinglePdf(items, onP).then(ensureUnlocked).then(function (b) { return C.pageNumbersPdf(b, o); })
          .then(function (b) { return { files: [{ blob: pdfBlob(b), name: C.baseName(items[0].name) + '-numerado.pdf' }] }; });
      } },
    { id: 'protect', group: 'Editar', name: 'Proteger com senha', sub: 'só abre com a senha', icon: 'x-lock', color: 'red',
      accept: ['pdf', 'appdoc', 'image'], multi: true, run: 'Proteger PDF',
      options: [{ id: 'pw', type: 'password', label: 'Senha', value: '' }, { id: 'pw2', type: 'password', label: 'Repita a senha', value: '' }],
      note: 'As páginas são gravadas como imagem dentro do PDF protegido.',
      exec: function (items, o, onP) {
        if (!o.pw || o.pw.length < 4) return Promise.reject(new Error('Use uma senha com pelo menos 4 caracteres.'));
        if (o.pw !== o.pw2) return Promise.reject(new Error('As senhas não conferem.'));
        return asSinglePdf(items, onP).then(ensureUnlocked).then(function (b) { return C.rasterizePdf(b, { encrypt: o.pw, dpi: 150, quality: 0.82 }, onP); })
          .then(function (b) { return { files: [{ blob: pdfBlob(b), name: C.baseName(items[0].name) + '-protegido.pdf' }] }; });
      } },
    { id: 'unlock', group: 'Editar', name: 'Remover senha', sub: 'tire a senha de um PDF seu', icon: 'x-unlock', color: 'metal',
      accept: ['pdf'], multi: false, run: 'Remover senha',
      options: [{ id: 'pw', type: 'password', label: 'Senha atual do PDF', value: '' }],
      exec: function (items, o, onP) {
        return C.bytesOf(items[0].blob).then(function (b) {
          return C.rasterizePdf(b, { password: o.pw, dpi: 160, quality: 0.85 }, onP).catch(function (e) {
            if (e.needPassword) throw new Error(e.wrongPassword ? 'Senha incorreta.' : 'Digite a senha do PDF.');
            throw e;
          });
        }).then(function (b) { return { files: [{ blob: pdfBlob(b), name: C.baseName(items[0].name) + '-sem-senha.pdf' }] }; });
      } },
    { id: 'compress', group: 'Editar', name: 'Comprimir PDF', sub: 'deixe o arquivo mais leve', icon: 'x-compress', color: 'green',
      accept: ['pdf'], multi: false, run: 'Comprimir',
      options: [{ id: 'level', type: 'select', label: 'Compressão', value: 'mid', choices: [['low', 'Leve (melhor qualidade)'], ['mid', 'Média (recomendado)'], ['high', 'Forte (menor arquivo)']] }],
      exec: function (items, o, onP) {
        var cfg = { low: { dpi: 150, quality: 0.78 }, mid: { dpi: 120, quality: 0.62 }, high: { dpi: 96, quality: 0.48 } }[o.level];
        return C.bytesOf(items[0].blob).then(ensureUnlocked).then(function (orig) {
          return C.rasterizePdf(orig, cfg, onP).then(function (b) {
            var before = items[0].blob.size, after = b.length;
            if (after >= before) return { files: [{ blob: items[0].blob, name: items[0].name }], note: 'Este PDF já está bem compacto: a compressão não reduziu o tamanho.' };
            return { files: [{ blob: pdfBlob(b), name: C.baseName(items[0].name) + '-comprimido.pdf' }], note: fmtSize(before) + ' → ' + fmtSize(after) + ' (−' + Math.round((1 - after / before) * 100) + '%)' };
          });
        });
      } },

    { id: 'idcard', group: 'Utilitários', name: 'RG / CNH / cartão', sub: 'frente e verso numa folha A4', icon: 'x-id', color: 'orange',
      accept: ['image'], multi: true, max: 2, run: 'Montar documento', special: 'idcard',
      note: 'Escolha 2 fotos: frente e verso. Ou use o modo RG/CNH da câmera.',
      exec: function (items, o, onP) {
        return Promise.all(items.slice(0, 2).map(function (it) {
          return Pages.blobToCanvas(it.blob).then(function (c) {
            var d = Pages.detect(c);
            return C.canvasBlob(Pages.rectify(c, d && d.corners), 'image/jpeg', 0.92);
          });
        })).then(function (bs) { return C.idCardPage(bs[0], bs[1]); }).then(function (jpg) {
          return C.itemsToPdf([{ name: 'id.jpg', kind: 'image', blob: jpg }], { pageSize: 'a4' }).then(function (pdf) {
            return { files: [{ blob: pdfBlob(pdf), name: 'Documento-' + stamp() + '.pdf' }, { blob: jpg, name: 'Documento-' + stamp() + '.jpg' }], images: false };
          });
        });
      } },
    { id: 'longimg', group: 'Utilitários', name: 'Imagem longa', sub: 'junte as páginas numa só imagem', icon: 'x-long', color: 'orange',
      accept: ['image', 'appdoc', 'pdf'], multi: true, run: 'Juntar imagens',
      exec: function (items, o, onP) {
        return pageImages(items, onP).then(function (imgs) { return C.longImage(imgs.map(function (i) { return i.blob; })); })
          .then(function (b) { return { files: [{ blob: b, name: C.baseName(items[0].name) + '-longa.jpg' }], images: true }; });
      } },
    { id: 'statement', group: 'Utilitários', name: 'Extrato bancário', sub: 'foto ou PDF do extrato em planilha', icon: 'x-excel', color: 'green', badge: 'beta',
      accept: ['pdf', 'image', 'appdoc'], multi: true, run: 'Gerar planilha',
      note: 'Lê as linhas do extrato e separa em colunas (data, descrição, valor). Confira os valores na planilha.',
      exec: function (items, o, onP) { return TOOL_BY_ID.excel.exec(items, o, onP); } },
    { id: 'qr', group: 'Utilitários', name: 'Ler QR code', sub: 'pela câmera ou por uma foto', icon: 'x-qr', color: 'metal', special: 'qr',
      accept: ['image'], multi: false, run: 'Ler QR code',
      exec: function (items) {
        return C.readQr(items[0].blob).then(function (t) {
          if (!t) throw new Error('Não encontrei um QR code nesta imagem.');
          return { qr: t };
        });
      } },
  ];
  var TOOL_BY_ID = {};
  TOOLS.forEach(function (t) { TOOL_BY_ID[t.id] = t; });
  var COLOR_CLASS = { blue: 'tool-card--blue', red: 'tool-card--red', metal: 'tool-card--metal', green: 'tool-card--blue', orange: '' };

  /* ---------- tools home grid ---------- */
  function renderGrid(container, onPick) {
    container.innerHTML = '';
    ['Converter', 'Organizar', 'Editar', 'Utilitários'].forEach(function (g) {
      var sec = h('div', { class: 'tool-group' }, '<h2 class="section-title">' + g + '</h2>');
      var grid = h('div', { class: 'tool-grid' });
      TOOLS.filter(function (t) { return t.group === g; }).forEach(function (t) {
        var card = h('button', { class: 'tool-card ' + (COLOR_CLASS[t.color] || '') },
          '<span class="tool-card__icon">' + UI.icon(t.icon) + '</span><span class="tool-card__name">' + esc(t.name) + '</span>' +
          '<span class="tool-card__sub">' + esc(t.sub) + '</span>' + (t.badge ? '<span class="tool-card__badge">' + esc(t.badge) + '</span>' : ''));
        if (t.color === 'green') card.querySelector('.tool-card__icon').style.background = '#1E8E3E';
        card.addEventListener('click', function () { onPick(t.id); });
        grid.appendChild(card);
      });
      sec.appendChild(grid);
      container.appendChild(sec);
    });
    container.appendChild(h('div', { style: 'height:110px' }));
  }

  /* ---------- page picker screen ---------- */
  function Pages_pick(bytes, mode, hint) {
    UI.loader.hide(true);
    return UI.busy('Carregando páginas…', function () { return C.pdfThumbs(bytes, 240); }).then(function (thumbs) {
      return pickFromThumbs(thumbs, mode, hint);
    }).then(function (order) {
      if (order) UI.loader.show('Montando o PDF…');
      return order;
    });
  }
  function pickFromThumbs(thumbs, mode, hint) {
    return new Promise(function (resolve) {
      var state = thumbs.map(function (b, i) { return { index: i, blob: b, rotate: 0, sel: mode === 'organize', removed: false }; });
      var grid = $('#picker-grid'), bar = $('#picker-bar');
      $('#picker-title').textContent = mode === 'organize' ? 'Organizar' : 'Escolher páginas';
      bar.innerHTML = '<p class="hint-text" style="width:100%;margin:0">' + esc(hint || '') + '</p>';
      if (mode === 'select') {
        var all = h('button', { class: 'btn btn--secondary btn--sm' }, 'Todas'), none = h('button', { class: 'btn btn--secondary btn--sm' }, 'Nenhuma');
        all.onclick = function () { state.forEach(function (s) { s.sel = true; }); draw(); };
        none.onclick = function () { state.forEach(function (s) { s.sel = false; }); draw(); };
        bar.appendChild(all); bar.appendChild(none);
      }
      function draw() {
        grid.innerHTML = '';
        state.forEach(function (s, pos) {
          var el = h('div', { class: 'pick' + (mode === 'select' && s.sel ? ' is-selected' : '') + (s.removed ? ' is-removed' : '') },
            '<img alt="Página ' + (s.index + 1) + '" style="transform:rotate(' + s.rotate + 'deg)">' +
            '<span class="pick__num">' + (mode === 'organize' ? pos + 1 : s.index + 1) + '</span>' +
            (mode === 'select' ? '<span class="pick__check">' + (s.sel ? UI.icon('check', 'ico--sm') : '') + '</span>' : ''));
          el.querySelector('img').src = Pages.url(s.blob);
          if (mode === 'select') el.addEventListener('click', function () { s.sel = !s.sel; draw(); });
          else {
            var tools = h('div', { class: 'pick__tools' },
              '<button data-a="l" aria-label="Mover para trás">' + UI.icon('arrow-left') + '</button>' +
              '<button data-a="r" aria-label="Girar">' + UI.icon('rotate-right') + '</button>' +
              '<button data-a="d" aria-label="' + (s.removed ? 'Restaurar' : 'Excluir') + '">' + UI.icon(s.removed ? 'plus' : 'trash') + '</button>' +
              '<button data-a="n" aria-label="Mover para frente">' + UI.icon('arrow-right') + '</button>');
            tools.addEventListener('click', function (e) {
              var b = e.target.closest('button');
              if (!b) return;
              var a = b.dataset.a;
              if (a === 'l' && pos > 0) { state.splice(pos - 1, 0, state.splice(pos, 1)[0]); }
              else if (a === 'n' && pos < state.length - 1) { state.splice(pos + 1, 0, state.splice(pos, 1)[0]); }
              else if (a === 'r') s.rotate = (s.rotate + 90) % 360;
              else if (a === 'd') s.removed = !s.removed;
              draw();
            });
            el.appendChild(tools);
          }
          grid.appendChild(el);
        });
      }
      draw();
      function close(v) { UI.onBack('picker', null); UI.back(); resolve(v); }
      $('#picker-ok').onclick = function () {
        var chosen = state.filter(function (s) { return mode === 'select' ? s.sel : !s.removed; });
        if (!chosen.length) { UI.toast('Escolha pelo menos uma página.'); return; }
        close(chosen.map(function (s) { return { index: s.index, rotate: s.rotate }; }));
      };
      $('#picker-back').onclick = function () { close(null); };
      UI.onBack('picker', function () { close(null); return false; });
      UI.go('picker');
    });
  }

  /* ---------- app-document chooser ---------- */
  function chooseAppDocs(multi) {
    return DB.getAll().then(function (docs) {
      docs = docs.filter(function (d) { return d.pages.length; }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      if (!docs.length) { UI.toast('Você ainda não tem documentos escaneados.'); return []; }
      return new Promise(function (resolve) {
        var wrap = h('div'), list = h('div', { class: 'doc-pick-list' }), picked = [];
        docs.forEach(function (d) {
          var b = h('button', { class: 'doc-pick' }, '<img alt=""><span>' + esc(d.name) + '<small>' + d.pages.length + ' pág. · ' + new Date(d.updatedAt || d.createdAt).toLocaleDateString('pt-BR') + '</small></span>');
          b.querySelector('img').src = Pages.url(d.pages[0].filteredBlob);
          b.addEventListener('click', function () {
            if (!multi) { sh.close([d]); return; }
            var i = picked.indexOf(d);
            if (i >= 0) picked.splice(i, 1); else picked.push(d);
            b.classList.toggle('is-selected', i < 0);
          });
          list.appendChild(b);
        });
        wrap.appendChild(list);
        if (multi) {
          var ok = h('button', { class: 'btn btn--primary btn--block', style: 'margin-top:12px' }, 'Adicionar');
          ok.onclick = function () { sh.close(picked.slice()); };
          wrap.appendChild(ok);
        }
        var sh = UI.sheet('Documentos do DocScan', wrap, function (v) { resolve(v || []); });
      });
    });
  }
  function docItem(d) { return { name: d.name, kind: 'appdoc', doc: d }; }

  /* ---------- runner ---------- */
  var cur = null;
  function open(id, preItems) {
    var t = TOOL_BY_ID[id];
    if (!t) return;
    if (t.special === 'qr' && !preItems) {
      return UI.choose('Ler QR code', [{ id: 'cam', label: 'Pela câmera', icon: 'camera' }, { id: 'photo', label: 'De uma foto', icon: 'gallery' }]).then(function (c) {
        if (c === 'cam') App.openCamera(null, 'qr');
        else if (c === 'photo') UI.pickFiles({ accept: 'image/*' }).then(function (f) { if (f.length) open('qr', f.map(C.fileItem)); });
      });
    }
    cur = { tool: t, items: (preItems || []).slice(), opts: {}, result: null };
    (t.options || []).forEach(function (o) { cur.opts[o.id] = o.value; });
    $('#tool-title').textContent = t.name;
    $('#tool-run').textContent = t.run || 'Converter';
    $('#tool-back').onclick = function () { UI.back(); };
    $('#tool-run').onclick = run;
    render();
    UI.go('tool');
    $('#tool-body').scrollTop = 0;
    if (cur.items.length && (t.id === 'qr')) run();
  }
  function accepts(t) { return t.accept.filter(function (k) { return k !== 'appdoc'; }).map(function (k) { return ACCEPT[k]; }).join(','); }
  function render() {
    var t = cur.tool, body = $('#tool-body');
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'tool-hero' }, '<span class="tool-card__icon"' + (t.color === 'green' ? ' style="background:#1E8E3E;color:#fff"' : t.color === 'blue' ? ' style="background:var(--blue-2);color:#fff"' : t.color === 'red' ? ' style="background:var(--red);color:#fff"' : t.color === 'metal' ? ' style="background:var(--metal)"' : '') + '>' + UI.icon(t.icon) + '</span><p>' + esc(t.sub) + (t.note ? '<br><span class="hint-text">' + esc(t.note) + '</span>' : '') + '</p>'));
    var src = h('div', { class: 'src-btns' });
    var bFiles = h('button', { class: 'btn btn--secondary' }, UI.icon('x-file') + 'Do celular');
    bFiles.onclick = function () {
      UI.pickFiles({ accept: accepts(t), multiple: !!t.multi }).then(function (files) {
        var its = files.map(C.fileItem).filter(function (it) {
          var ok = t.accept.indexOf(it.kind) >= 0;
          if (!ok) UI.toast('"' + it.name + '" não serve para esta ferramenta.', 'error');
          return ok;
        });
        addItems(its);
      });
    };
    src.appendChild(bFiles);
    if (t.accept.indexOf('appdoc') >= 0) {
      var bApp = h('button', { class: 'btn btn--secondary' }, UI.icon('pages') + 'Do DocScan');
      bApp.onclick = function () { chooseAppDocs(!!t.multi).then(function (ds) { addItems(ds.map(docItem)); }); };
      src.appendChild(bApp);
    } else src.style.gridTemplateColumns = '1fr';
    body.appendChild(src);

    var list = h('ul', { class: 'file-list' });
    cur.items.forEach(function (it, i) {
      var li = h('li', { class: 'file-row' }, '<span class="file-row__kind">' + (KIND_LABEL[it.kind] || '?') + '</span><span class="file-row__name">' + esc(it.name) +
        (it.kind === 'appdoc' ? ' · ' + it.doc.pages.length + ' pág.' : it.blob ? ' · ' + fmtSize(it.blob.size) : '') + '</span>');
      if (t.multi && cur.items.length > 1) {
        var up = h('button', { class: 'mini-btn', 'aria-label': 'Subir' }, UI.icon('arrow-left'));
        up.style.transform = 'rotate(90deg)'; up.disabled = i === 0;
        up.onclick = function () { cur.items.splice(i - 1, 0, cur.items.splice(i, 1)[0]); render(); };
        li.appendChild(up);
      }
      var del = h('button', { class: 'mini-btn mini-btn--danger', 'aria-label': 'Remover' }, UI.icon('close'));
      del.onclick = function () { cur.items.splice(i, 1); cur.result = null; render(); };
      li.appendChild(del);
      list.appendChild(li);
    });
    if (!cur.items.length) list.appendChild(h('li', { class: 'hint-text', style: 'text-align:center;padding:10px' }, 'Nenhum arquivo escolhido ainda.'));
    body.appendChild(list);

    if (t.options && t.options.length) {
      var opts = h('div', { class: 'opts' });
      t.options.forEach(function (o) {
        if (o.showIf && Object.keys(o.showIf).some(function (k) { return cur.opts[k] !== o.showIf[k]; })) return;
        if (o.type === 'check') {
          var lab = h('label', { class: 'list-row' }, '<span class="list-row__text"><span class="list-row__title">' + esc(o.label) + '</span>' + (o.sub ? '<span class="list-row__sub">' + esc(o.sub) + '</span>' : '') + '</span>');
          var cb = h('input', { type: 'checkbox', class: 'switch' });
          cb.checked = !!cur.opts[o.id];
          cb.onchange = function () { cur.opts[o.id] = cb.checked; };
          lab.appendChild(cb); opts.appendChild(lab); return;
        }
        opts.appendChild(h('label', { class: 'field-label', for: 'opt-' + o.id, text: o.label }));
        var el;
        if (o.type === 'select') {
          el = h('select', { class: 'select', id: 'opt-' + o.id });
          o.choices.forEach(function (c) { var op = h('option', { value: c[0], text: c[1] }); el.appendChild(op); });
          el.value = cur.opts[o.id];
          el.onchange = function () { cur.opts[o.id] = el.value; if (t.options.some(function (x) { return x.showIf; })) render(); };
        } else if (o.type === 'file') {
          el = h('button', { class: 'btn btn--secondary btn--block', id: 'opt-' + o.id }, UI.icon('x-image') + (cur.opts[o.id] ? esc(cur.opts[o.id].name) : 'Escolher imagem'));
          el.onclick = function () { UI.pickFiles({ accept: o.accept }).then(function (f) { if (f.length) { cur.opts[o.id] = f[0]; render(); } }); };
        } else {
          el = h('input', { class: 'field', id: 'opt-' + o.id, type: o.type === 'password' ? 'password' : 'text', autocomplete: o.type === 'password' ? 'new-password' : 'off' });
          el.value = cur.opts[o.id] || '';
          el.oninput = function () { cur.opts[o.id] = el.value; };
        }
        opts.appendChild(el);
      });
      body.appendChild(opts);
    }
    if (cur.result) body.appendChild(renderResult(cur.result));
    $('#tool-runbar').hidden = false;
  }
  function addItems(its) {
    if (!its.length) return;
    var t = cur.tool;
    if (!t.multi) cur.items = [its[0]];
    else cur.items = cur.items.concat(its).slice(0, t.max || 60);
    cur.result = null;
    render();
  }
  function run() {
    var t = cur.tool;
    if (!cur.items.length) { UI.toast('Escolha um arquivo primeiro.'); return; }
    if (t.min && cur.items.length < t.min) { UI.toast('Escolha pelo menos ' + t.min + ' arquivos.'); return; }
    if (t.special === 'idcard' && cur.items.length < 1) return;
    UI.loader.show('Concentrando chakra…', t.name);
    var onP = function (p, sub) { UI.loader.progress(p, sub); };
    setTimeout(function () {
      Promise.resolve().then(function () { return t.exec(cur.items, cur.opts, onP); }).then(function (res) {
        UI.loader.hide(true);
        cur.result = res;
        UI.go('tool');
        render();
        var r = $('#tool-result');
        if (r) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
        UI.toast('Pronto!', 'ok');
      }, function (e) {
        UI.loader.hide(true);
        if (UI.current() !== 'tool') UI.go('tool');
        if (e && e.message === 'Operação cancelada.') return;
        UI.fail(e);
      });
    }, 40);
  }
  function renderResult(res) {
    var box = h('div', { class: 'result', id: 'tool-result' }), p = h('div', { class: 'u-panel' });
    box.appendChild(p);
    if (res.qr != null) {
      var isUrl = /^https?:\/\//i.test(res.qr);
      p.innerHTML = '<h3>QR code lido!</h3><p class="qr-result"></p><div class="opt-inline"></div>';
      p.querySelector('.qr-result').textContent = res.qr;
      var row = p.querySelector('.opt-inline');
      var cp = h('button', { class: 'btn btn--secondary' }, UI.icon('x-copy') + 'Copiar');
      cp.onclick = function () { UI.copyText(res.qr); };
      row.appendChild(cp);
      if (isUrl) {
        var op = h('button', { class: 'btn btn--primary' }, 'Abrir link');
        op.onclick = function () { UI.confirm({ title: 'Abrir este link?', text: res.qr, ok: 'Abrir' }).then(function (y) { if (y) window.open(res.qr, '_blank', 'noopener'); }); };
        row.appendChild(op);
      }
      return box;
    }
    if (res.text != null) {
      p.innerHTML = '<h3>Texto extraído</h3><textarea class="ocr-text" aria-label="Texto extraído"></textarea><div class="opt-inline"></div>';
      var ta = p.querySelector('textarea');
      ta.value = res.text || '';
      if (!res.text) ta.placeholder = 'Nenhum texto encontrado.';
      var r2 = p.querySelector('.opt-inline');
      var bc = h('button', { class: 'btn btn--secondary' }, UI.icon('x-copy') + 'Copiar');
      bc.onclick = function () { UI.copyText(ta.value); };
      var bt = h('button', { class: 'btn btn--secondary' }, UI.icon('share') + '.txt');
      bt.onclick = function () { UI.share([{ blob: new Blob([ta.value], { type: 'text/plain' }), name: res.base + '.txt' }]); };
      var bw = h('button', { class: 'btn btn--primary' }, UI.icon('x-word') + 'Word');
      bw.onclick = function () {
        UI.busy('Gerando Word…', function () {
          return C.buildDocx(ta.value.split(/\n{2,}/).map(function (t) { return { type: 'p', text: t.replace(/\n/g, ' ') }; }));
        }).then(function (b) { return UI.share([{ blob: b, name: res.base + '.docx' }]); }).catch(UI.fail);
      };
      r2.appendChild(bc); r2.appendChild(bt); r2.appendChild(bw);
      return box;
    }
    var files = res.files || [], total = files.reduce(function (s, f) { return s + (f.blob.size || 0); }, 0);
    p.innerHTML = '<h3>Pronto!</h3><p class="hint-text">' + (files.length > 1 ? files.length + ' arquivos · ' : esc(files[0].name) + ' · ') + fmtSize(total) + (res.note ? '<br>' + esc(res.note) : '') + '</p><div class="opt-inline"></div>';
    var row2 = p.querySelector('.opt-inline');
    var share = h('button', { class: 'btn btn--primary' }, UI.icon('share') + (res.images ? 'Salvar / enviar' : 'Enviar'));
    share.onclick = function () { UI.share(files).catch(UI.fail); };
    row2.appendChild(share);
    var dl = h('button', { class: 'btn btn--secondary' }, UI.icon('download') + (files.length > 1 ? 'ZIP' : 'Baixar'));
    dl.onclick = function () {
      if (files.length === 1) return UI.download(files[0].blob, files[0].name);
      UI.busy('Compactando…', function () { return C.zipFiles(files); }).then(function (z) { UI.download(z, res.zipName || 'arquivos.zip'); }).catch(UI.fail);
    };
    row2.appendChild(dl);
    var importable = files.filter(function (f) { return /\.(pdf|jpe?g)$/i.test(f.name); });
    if (importable.length && files.length <= 3) {
      var imp = h('button', { class: 'btn btn--secondary btn--block', style: 'margin-top:8px' }, UI.icon('pages') + 'Guardar no DocScan');
      imp.onclick = function () { App.importBlobs(importable.slice(0, 1), C.baseName(importable[0].name)).catch(UI.fail); };
      p.appendChild(imp);
    }
    return box;
  }

  root.Tools = { list: TOOLS, byId: TOOL_BY_ID, renderGrid: renderGrid, open: open, pickFromThumbs: pickFromThumbs, chooseAppDocs: chooseAppDocs, docItem: docItem };
})(window);
