/* DocScan — IndexedDB storage (compatible with v1: db 'docscan' v1, store 'documents', keyPath 'id')
   plus small settings in localStorage. */
(function (root) {
  'use strict';
  var DB_NAME = 'docscan', DB_VERSION = 1, STORE = 'documents';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }
  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), store = t.objectStore(STORE), out;
        var r = fn(store);
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Transação cancelada')); };
      });
    });
  }
  function normalizePage(p) {
    if (!p) return p;
    if (p.rotation == null) p.rotation = 0;
    if (!p.filter) p.filter = 'auto';
    if (p.corners === undefined) p.corners = null;
    return p;
  }
  function normalizeDoc(d) {
    if (!d) return d;
    d.pages = (d.pages || []).map(normalizePage);
    if (!d.name) d.name = 'Sem título';
    if (!d.folder) d.folder = '';
    return d;
  }

  var DB = {
    getAll: function () { return tx('readonly', function (s) { return s.getAll(); }).then(function (a) { return (a || []).map(normalizeDoc); }); },
    get: function (id) { return tx('readonly', function (s) { return s.get(id); }).then(normalizeDoc); },
    put: function (doc) { doc.updatedAt = Date.now(); return tx('readwrite', function (s) { s.put(doc); }); },
    remove: function (id) { return tx('readwrite', function (s) { s.delete(id); }); },
    uid: function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
  };

  var SKEY = 'docscan.settings.v2';
  var DEFAULTS = { filter: 'auto', batch: false, auto: true, pageSize: 'a4', quality: 0.86, sortBy: 'date' };
  DB.settings = function () {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(SKEY) || '{}') || {}; } catch (e) { s = {}; }
    for (var k in DEFAULTS) if (s[k] === undefined) s[k] = DEFAULTS[k];
    return s;
  };
  DB.saveSettings = function (patch) {
    var s = DB.settings();
    for (var k in patch) s[k] = patch[k];
    try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
    return s;
  };
  DB.getBlob = function (key) {
    try {
      var v = localStorage.getItem('docscan.blob.' + key);
      if (!v) return null;
      var parts = v.split(','), mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png', bin = atob(parts[1]);
      var u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new Blob([u], { type: mime });
    } catch (e) { return null; }
  };
  DB.setDataUrl = function (key, dataUrl) {
    try { if (dataUrl) localStorage.setItem('docscan.blob.' + key, dataUrl); else localStorage.removeItem('docscan.blob.' + key); return true; }
    catch (e) { return false; }
  };

  root.DB = DB;
})(window);
