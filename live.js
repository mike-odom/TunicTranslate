/*
 * Live camera mode helpers.
 *
 * Plain script: `TrunicLive` in the browser and in the recognition worker
 * (live-worker.js), require('./live.js') in node.
 *
 *   describe(reading, translation, size)  turns one frame's recognition into plain
 *                                         data: where each word is and what it says.
 *   keepGood(previous, next)              a frame that reads no words keeps the last
 *                                         good result on screen.
 *   draw(ctx, result)                     paints the English words over the detected
 *                                         words, the phonetic spelling smaller underneath.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./trunic.js'));
  else root.TrunicLive = factory(root.Trunic);
})(typeof self !== 'undefined' ? self : this, function (Trunic) {
  'use strict';

  var BAR_CENTRE = Trunic.MEASURED.sample.barCentre;   // bar centre from the glyph top / glyph height

  var COLORS = { plate: 'rgba(20, 22, 28, 0.88)', english: '#ece6d6', phonetic: '#f2b441', unreadable: '#ff9d7a' };
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  /**
   * One frame's reading as structured-clone-safe data.
   * @param reading      TrunicRecognize.recognize() result
   * @param translation  TrunicEnglish.translate(reading), same lines and words
   * @param size         {width, height} of the frame that was read
   * @returns {{width:number, height:number, lines:Array, words:Array<{x0:number, x1:number,
   *   top:number, height:number, english:(string|null), phonetic:string}>}}
   *   Boxes are in frame pixels: x0..x1 is the word's bar, top..top+height its glyphs.
   *   `lines` is `translation` without the raw cells.
   */
  function describe(reading, translation, size) {
    var words = [];
    // A tilted frame was read after being straightened about its centre, so positions
    // are in that straightened frame; carry each word's bar centre back to the frame
    // the camera shows (the plate stays level, which is close for the tilts handled).
    var skew = reading.skew || 0, cos = Math.cos(skew), sin = Math.sin(skew);
    reading.lines.forEach(function (line, li) {
      line.words.forEach(function (w, wi) {
        var t = translation[li].words[wi];
        var x0 = w.x0, x1 = w.x1 + 1, barY = line.y;
        if (skew) {
          var dx = (x0 + x1) / 2 - size.width / 2, dy = line.y - size.height / 2;
          var cx = cos * dx + sin * dy + size.width / 2;
          barY = -sin * dx + cos * dy + size.height / 2;
          var half = (x1 - x0) / 2;
          x0 = cx - half;
          x1 = cx + half;
        }
        words.push({
          x0: x0,
          x1: x1,
          top: barY - BAR_CENTRE * (line.glyphHeight || reading.glyphHeight),
          height: line.glyphHeight || reading.glyphHeight,
          english: t.english,
          phonetic: t.spelling
        });
      });
    });
    return { width: size.width, height: size.height, lines: translation, words: words };
  }

  /** The new result when it found any words, otherwise the previous good one (or null). */
  function keepGood(previous, next) {
    return next && next.words && next.words.length ? next : (previous || null);
  }

  /** Text size, in px, for a word whose glyphs are `height` px tall (never below a legible 9px). */
  function englishSize(height) { return Math.max(9, height * 0.5); }

  /**
   * Paint a result onto the context's canvas, which takes the frame's size so that
   * frame pixels are canvas pixels. Each word gets a plate over its glyphs carrying
   * the English word, with the phonetic spelling at half the size beneath it.
   */
  function draw(ctx, result) {
    var canvas = ctx.canvas;
    if (result && (canvas.width !== result.width || canvas.height !== result.height)) {
      canvas.width = result.width;
      canvas.height = result.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!result) return;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    result.words.forEach(function (w) {
      var english = w.english || '?';
      var boxW = w.x1 - w.x0, cx = (w.x0 + w.x1) / 2, cy = w.top + w.height / 2;
      var size = englishSize(w.height);

      // Long words shrink a little (not below 60%) rather than spill over their neighbours.
      ctx.font = '700 ' + size + 'px ' + FONT;
      var natural = ctx.measureText(english).width;
      if (natural > boxW * 1.15) size *= Math.max(0.6, (boxW * 1.15) / natural);
      var small = Math.max(7, size * 0.5);

      ctx.font = '700 ' + size + 'px ' + FONT;
      var englishW = ctx.measureText(english).width;
      ctx.font = '600 ' + small + 'px ' + FONT;
      var phoneticW = ctx.measureText(w.phonetic).width;

      var pad = size * 0.2;
      var plateW = Math.max(boxW, englishW, phoneticW) + pad * 2;
      var plateH = size * 1.15 + small * 1.25 + pad;
      var englishY = cy - plateH / 2 + pad / 2 + size * 0.575;
      var phoneticY = englishY + size * 0.575 + small * 0.7;

      ctx.fillStyle = COLORS.plate;
      ctx.fillRect(cx - plateW / 2, cy - plateH / 2, plateW, plateH);

      ctx.font = '700 ' + size + 'px ' + FONT;
      ctx.fillStyle = w.english ? COLORS.english : COLORS.unreadable;
      ctx.fillText(english, cx, englishY);

      ctx.font = '600 ' + small + 'px ' + FONT;
      ctx.fillStyle = COLORS.phonetic;
      ctx.fillText(w.phonetic, cx, phoneticY);
    });
  }

  return { describe: describe, keepGood: keepGood, draw: draw, englishSize: englishSize };
});
