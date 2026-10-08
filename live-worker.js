/*
 * Recognition worker for the live camera: the page posts {id, width, height, buffer}
 * (RGBA pixels of one frame, transferred) and gets back {id, width, height, result}
 * (see TrunicLive.describe) or {id, error}. Keeps the page responsive while a
 * frame is read, and the dictionary index is built once, on the first frame.
 */
'use strict';

importScripts('trunic.js', 'words.js', 'recognize.js', 'english.js', 'live.js');

self.onmessage = function (e) {
  var m = e.data;
  try {
    var frame = { width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) };
    var reading = self.TrunicRecognize.recognize(frame);
    var translation = self.TrunicEnglish.translate(reading);
    self.postMessage({
      id: m.id,
      width: m.width,
      height: m.height,
      result: self.TrunicLive.describe(reading, translation, { width: m.width, height: m.height })
    });
  } catch (err) {
    self.postMessage({ id: m.id, error: err && err.message ? err.message : String(err) });
  }
};
