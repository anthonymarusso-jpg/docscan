/* DocScan — page processing shared by camera, editor and tools.
   page = {id, filter, rotation(0|90|180|270), corners(normalized|null), sourceBlob, rectifiedBlob, filteredBlob} */
(function (root) {
  'use strict';
  var MAX_SOURCE = 3000, MAX_PAGE = 2200;

  function wait() { return new Promise(function (r) { setTimeout(r, 16); }); }
  function blobToCanvas(blob, maxDim) {
    return Convert.loadImage(blob).then(function (img) { return Warp.downscale(img, maxDim || MAX_SOURCE); });
  }
  function fullCorners() { return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]; }
  function defaultCorners() { return [{ x: 0.06, y: 0.05 }, { x: 0.94, y: 0.05 }, { x: 0.94, y: 0.95 }, { x: 0.06, y: 0.95 }]; }

  /* Still-photo detection: coarse quad, then sub-pixel refit on a 1600px copy. */
  function detect(canvas, hint) {
    var res = hint && hint.length === 4 ? { corners: hint, confidence: 0.6 } : DocDetect.detectCanvas(canvas, { mode: 'still' });
    if (!res) return null;
    if (res.method === 'page') return res;
    try {
      var small = Warp.downscale(canvas, 1600), ctx = small.getContext('2d', { willReadFrequently: true });
      var refined = DocDetect.refine(ctx.getImageData(0, 0, small.width, small.height), res.corners);
      small.width = small.height = 1;
      return { corners: refined, confidence: res.confidence };
    } catch (e) { return res; }
  }
  function toPixels(corners, w, h) { return corners.map(function (p) { return { x: p.x * w, y: p.y * h }; }); }
  function isFull(c) { return c && c.every(function (p, i) { var f = fullCorners()[i]; return Math.abs(p.x - f.x) < 0.002 && Math.abs(p.y - f.y) < 0.002; }); }

  function rectify(srcCanvas, corners) {
    if (!corners || isFull(corners)) return Warp.downscale(srcCanvas, MAX_PAGE);
    return Warp.rectify(srcCanvas, toPixels(corners, srcCanvas.width, srcCanvas.height), { maxOutDim: MAX_PAGE });
  }
  function finish(rectified, filter, rotation) {
    var f = Filters.apply(rectified, filter || 'original');
    var turns = ((rotation || 0) / 90) | 0;
    if (turns % 4) { var r = Warp.rotate(f, turns); f.width = f.height = 1; f = r; }
    return f;
  }

  var Pages = {
    MAX_SOURCE: MAX_SOURCE,
    fullCorners: fullCorners,
    defaultCorners: defaultCorners,
    detect: detect,
    blobToCanvas: blobToCanvas,
    rectify: rectify,
    finish: finish,
    /* Builds a complete page from a source canvas. */
    create: function (srcCanvas, corners, filter, rotation) {
      var page = { id: DB.uid(), filter: filter || 'auto', rotation: rotation || 0, corners: corners || null };
      return wait().then(function () {
        var src = srcCanvas.width > MAX_SOURCE || srcCanvas.height > MAX_SOURCE ? Warp.downscale(srcCanvas, MAX_SOURCE) : srcCanvas;
        var rect = rectify(src, corners);
        var fin = finish(rect, page.filter, page.rotation);
        return Promise.all([
          Convert.canvasBlob(src, 'image/jpeg', 0.9),
          Convert.canvasBlob(rect, 'image/jpeg', 0.92),
          Convert.canvasBlob(fin, 'image/jpeg', 0.88),
        ]).then(function (b) {
          page.sourceBlob = b[0]; page.rectifiedBlob = b[1]; page.filteredBlob = b[2];
          rect.width = rect.height = 1; fin.width = fin.height = 1;
          return page;
        });
      });
    },
    /* Re-renders filteredBlob from rectifiedBlob (filter/rotation change). */
    rerender: function (page) {
      return blobToCanvas(page.rectifiedBlob, MAX_PAGE).then(function (rect) {
        var fin = finish(rect, page.filter, page.rotation);
        return Convert.canvasBlob(fin, 'image/jpeg', 0.88).then(function (b) { page.filteredBlob = b; fin.width = fin.height = 1; return page; });
      });
    },
    /* New corners on the stored source. */
    recrop: function (page, corners) {
      return blobToCanvas(page.sourceBlob, MAX_SOURCE).then(function (src) {
        var rect = rectify(src, corners);
        page.corners = corners;
        return Convert.canvasBlob(rect, 'image/jpeg', 0.92).then(function (b) {
          page.rectifiedBlob = b;
          var fin = finish(rect, page.filter, page.rotation);
          return Convert.canvasBlob(fin, 'image/jpeg', 0.88).then(function (fb) { page.filteredBlob = fb; return page; });
        });
      });
    },
    /* Replaces the page content with an edited (annotated) image; keeps it as the new base. */
    replaceImage: function (page, canvas) {
      return Promise.all([Convert.canvasBlob(canvas, 'image/jpeg', 0.92)]).then(function (b) {
        page.rectifiedBlob = b[0]; page.filteredBlob = b[0]; page.filter = 'original'; page.rotation = 0;
        return page;
      });
    },
  };

  /* Object-URL cache for thumbnails (revoked when the blob is no longer shown). */
  var urls = new Map();
  Pages.url = function (blob) {
    if (!blob) return '';
    var u = urls.get(blob);
    if (!u) { u = URL.createObjectURL(blob); urls.set(blob, u); }
    return u;
  };
  Pages.releaseUrls = function (keep) {
    urls.forEach(function (u, b) { if (!keep || keep.indexOf(b) < 0) { URL.revokeObjectURL(u); urls.delete(b); } });
  };

  root.Pages = Pages;
})(window);
