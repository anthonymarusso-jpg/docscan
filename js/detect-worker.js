importScripts('detect.js');
self.onmessage = function (e) {
  var m = e.data || {}, result = null;
  try {
    if (m.buffer && m.width > 0 && m.height > 0) {
      result = self.DocDetect.detect({ width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) }, m.opts || {});
    }
  } catch (err) { result = null; }
  if (m.buffer) self.postMessage({ id: m.id, result: result, buffer: m.buffer }, [m.buffer]);
  else self.postMessage({ id: m.id, result: result });
};
