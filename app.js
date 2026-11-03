(function () {
  'use strict';

  var T = window.Trunic;
  var NS = 'http://www.w3.org/2000/svg';
  var VIEWBOX = '0 0 ' + T.FRAME.w + ' ' + T.TOTAL_HEIGHT;
  var SEGMENT_IDS = T.INNER_SEGMENTS.concat(T.OUTER_SEGMENTS);

  // ---- state ---------------------------------------------------------------
  function blankGlyph() { return { inner: T.BAR_BIT, outer: 0, vowelFirst: false }; }

  var composer = blankGlyph();
  var word = [];
  var editIndex = null;

  // ---- helpers -------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function svgEl(tag, attrs, parent) {
    var node = document.createElementNS(NS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function isInner(id) { return T.INNER_SEGMENTS.indexOf(id) >= 0; }

  function segmentOn(glyph, id) {
    return isInner(id)
      ? (glyph.inner & T.bitOf(T.INNER_SEGMENTS, id)) !== 0
      : (glyph.outer & T.bitOf(T.OUTER_SEGMENTS, id)) !== 0;
  }

  function toggleSegment(glyph, id) {
    if (isInner(id)) glyph.inner ^= T.bitOf(T.INNER_SEGMENTS, id);
    else glyph.outer ^= T.bitOf(T.OUTER_SEGMENTS, id);
  }

  function drawShapes(segmentId, parent) {
    T.SEGMENTS[segmentId].shapes.forEach(function (s) {
      if (s.dot) {
        svgEl('circle', { cx: s.dot[0], cy: s.dot[1], r: s.dot[2], class: 'fill' }, parent);
        return;
      }
      var d = s.pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' ');
      svgEl('path', { d: d, 'stroke-width': s.width, 'stroke-linecap': s.cap, class: 'stroke' }, parent);
    });
  }

  function drawCircle(parent, cls) {
    var c = T.CIRCLE;
    return svgEl('circle', { cx: c.cx, cy: c.cy, r: c.r, 'stroke-width': c.width, class: cls }, parent);
  }

  // A static glyph. Its viewBox is the measured glyph frame, so slants that run
  // past x=0/30 are clipped exactly as in the chart and neighbouring bars join.
  function glyphSvg(glyph) {
    var svg = svgEl('svg', { viewBox: VIEWBOX, class: 'glyph', 'aria-hidden': 'true', focusable: 'false' });
    SEGMENT_IDS.forEach(function (id) {
      if (segmentOn(glyph, id)) drawShapes(id, svgEl('g', {}, svg));
    });
    if (glyph.vowelFirst) drawCircle(svg, 'ring');
    return svg;
  }

  function soundText(entry, hasPart) {
    if (!hasPart) return '—';
    if (!entry) return '?';
    return entry.spelling + '  /' + entry.ipa + '/';
  }

  // ---- composer ------------------------------------------------------------
  var segmentNodes = {};
  var ringNode, ringHit;

  function buildComposer() {
    var svg = $('composer-svg');
    svg.setAttribute('viewBox', VIEWBOX);

    // Faint guide of every possible segment.
    var guide = svgEl('g', { class: 'guide' }, svg);
    SEGMENT_IDS.forEach(function (id) { drawShapes(id, guide); });
    drawCircle(guide, 'ring');

    SEGMENT_IDS.forEach(function (id) {
      var g = svgEl('g', { class: 'seg' }, svg);
      drawShapes(id, g);
      segmentNodes[id] = g;
    });
    ringNode = drawCircle(svg, 'ring ring-on');

    // Tap targets sit on top, one invisible thick line per segment.
    SEGMENT_IDS.forEach(function (id) {
      var h = T.SEGMENTS[id].hit;
      var hit = svgEl('line', {
        x1: h[0], y1: h[1], x2: h[2], y2: h[3], class: 'hit',
        'stroke-width': 5.5, 'stroke-linecap': 'round',
        role: 'button', tabindex: '0', 'aria-label': T.SEGMENT_LABELS[id], 'aria-pressed': 'false',
        'data-seg': id
      }, svg);
      hit.addEventListener('click', function () { onSegment(id); });
      hit.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSegment(id); }
      });
    });

    ringHit = svgEl('circle', {
      cx: T.CIRCLE.cx, cy: T.CIRCLE.cy, r: 6.5, class: 'hit hit-fill',
      role: 'button', tabindex: '0', 'aria-label': 'Circle: vowel first', 'aria-pressed': 'false'
    }, svg);
    ringHit.addEventListener('click', toggleCircle);
    ringHit.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCircle(); }
    });
  }

  function onSegment(id) {
    toggleSegment(composer, id);
    renderComposer();
  }

  function toggleCircle() {
    composer.vowelFirst = !composer.vowelFirst;
    renderComposer();
  }

  function renderComposer() {
    SEGMENT_IDS.forEach(function (id) {
      var on = segmentOn(composer, id);
      segmentNodes[id].classList.toggle('on', on);
      document.querySelector('.hit[data-seg="' + id + '"]').setAttribute('aria-pressed', String(on));
    });
    ringNode.classList.toggle('on', composer.vowelFirst);
    ringHit.setAttribute('aria-pressed', String(composer.vowelFirst));
    $('btn-circle').setAttribute('aria-pressed', String(composer.vowelFirst));

    var d = T.decodeGlyph(composer);
    $('out-consonant').textContent = soundText(d.consonant, d.hasConsonant);
    $('out-vowel').textContent = soundText(d.vowel, d.hasVowel);
    $('out-spelling').textContent = d.empty ? ' ' : d.spelling;
    $('out-ipa').textContent = d.empty ? ' ' : '/' + d.ipa + '/';
    $('out-note').textContent = d.unknown ? 'These lines don’t match any sound on the chart.' : '';
    $('btn-add').disabled = d.empty;
    $('btn-add').textContent = editIndex === null ? 'Add to word' : 'Update glyph';
  }

  function loadComposer(glyph, index) {
    composer = { inner: glyph.inner, outer: glyph.outer, vowelFirst: glyph.vowelFirst };
    editIndex = index;
    renderComposer();
    renderWord();
  }

  // ---- word ----------------------------------------------------------------
  function renderWord() {
    var host = $('word-glyphs');
    host.textContent = '';
    word.forEach(function (glyph, i) {
      var d = T.decodeGlyph(glyph);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'word-glyph' + (i === editIndex ? ' editing' : '');
      b.setAttribute('aria-label', 'Edit glyph ' + (i + 1) + ': ' + (d.spelling || 'blank'));
      b.appendChild(glyphSvg(glyph));
      var cap = document.createElement('span');
      cap.className = 'cap' + (d.unknown ? ' unknown' : '');
      cap.textContent = d.spelling;
      b.appendChild(cap);
      b.addEventListener('click', function () { loadComposer(glyph, i); });
      host.appendChild(b);
    });

    var w = T.spellWord(word);
    $('word-spelling').textContent = w.spelling || ' ';
    $('word-ipa').textContent = w.ipa ? '/' + w.ipa + '/' : ' ';
    $('word-note').textContent = w.unknown ? 'Some glyphs don’t match a chart sound (shown as ?).' : '';
    $('word-empty').hidden = word.length > 0;
    $('btn-backspace').disabled = word.length === 0;
    $('btn-clear-word').disabled = word.length === 0;
  }

  function addGlyph() {
    if (T.decodeGlyph(composer).empty) return;
    var copy = { inner: composer.inner, outer: composer.outer, vowelFirst: composer.vowelFirst };
    if (editIndex === null) word.push(copy); else word[editIndex] = copy;
    editIndex = null;
    composer = blankGlyph();
    renderComposer();
    renderWord();
  }

  function removeLast() {
    if (!word.length) return;
    word.pop();
    if (editIndex !== null && editIndex >= word.length) editIndex = null;
    renderComposer();
    renderWord();
  }

  function clearWord() {
    word = [];
    editIndex = null;
    renderComposer();
    renderWord();
  }

  // ---- chart ---------------------------------------------------------------
  function buildChart() {
    function fill(hostId, entries) {
      var host = $(hostId);
      entries.forEach(function (entry) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-item';
        b.setAttribute('aria-label', entry.spelling + ', ' + entry.ipa + (entry.example ? ', as in ' + entry.example : ''));
        b.appendChild(glyphSvg(T.glyphFromEntry(entry)));
        var s = document.createElement('span');
        s.className = 'spell';
        s.textContent = entry.spelling;
        var p = document.createElement('span');
        p.className = 'ipa-small';
        p.textContent = '/' + entry.ipa + '/';
        b.appendChild(s);
        b.appendChild(p);
        if (entry.example) {
          var ex = document.createElement('span');
          ex.className = 'example';
          ex.textContent = entry.example;
          b.appendChild(ex);
        }
        b.addEventListener('click', function () {
          if (entry.kind === 'vowel') composer.outer = entry.outer;
          else composer.inner = entry.inner;
          renderComposer();
          $('composer-title').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        host.appendChild(b);
      });
    }
    fill('chart-vowels', T.VOWELS);
    fill('chart-consonants', T.CONSONANTS);
    $('vowel-count').textContent = '(' + T.VOWELS.length + ')';
    $('consonant-count').textContent = '(' + T.CONSONANTS.length + ')';
  }

  // ---- reading an image ------------------------------------------------------
  var MAX_SIDE = 2400;      // larger pictures are scaled down before reading
  var stream = null;

  function setStatus(text, isError) {
    var node = $('scan-status');
    node.textContent = text;
    node.classList.toggle('error', !!isError);
  }

  function showCanvas(width, height) {
    var scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    var canvas = $('scan-canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.hidden = false;
    return canvas;
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
      img.src = url;
    });
  }

  function renderReading(lines) {
    var host = $('scan-result');
    host.textContent = '';
    lines.forEach(function (line) {
      var box = document.createElement('div');
      box.className = 'scan-line';

      var english = document.createElement('p');
      english.className = 'scan-english';
      line.words.forEach(function (w, i) {
        if (i) english.appendChild(document.createTextNode(' '));
        var span = document.createElement('span');
        span.textContent = w.english || '?';
        if (!w.english) {
          span.className = 'unreadable';
          span.title = 'Some lines of this word match no sound on the chart.';
        } else if (w.cost > 0) {
          span.className = 'guess';
          span.title = 'Closest match for ' + w.spelling;
        } else if (w.alternatives.length) {
          span.className = 'alt';
          span.title = 'Sounds the same as: ' + w.alternatives.join(', ');
        }
        english.appendChild(span);
      });

      var phonetic = document.createElement('p');
      phonetic.className = 'scan-phonetic';
      phonetic.textContent = line.phonetic;

      box.appendChild(english);
      box.appendChild(phonetic);
      host.appendChild(box);
    });
  }

  // ---- upload and analyze ----------------------------------------------------
  // The server stores the still picture with these notes and the reading below,
  // and has Claude review the reading (see server.js).
  var lastReading = [];
  var lastEngine = {};      // how the engine read it: scale, threshold, tilt, glyph size

  function showAnalyze(visible) {
    $('analyze').hidden = !visible;
    $('analysis').hidden = true;
    $('analysis').textContent = '';
    $('analyze-status').textContent = '';
    $('analyze-status').classList.remove('error');
  }

  function setAnalyzeStatus(text, isError) {
    var node = $('analyze-status');
    node.textContent = text;
    node.classList.toggle('error', !!isError);
  }

  // The access code is remembered on this device after the server accepts it.
  var CODE_KEY = 'trunic-access-code';
  function rememberCode(code) {
    try { localStorage.setItem(CODE_KEY, code); } catch (e) { /* storage blocked: ask again next time */ }
  }
  function recallCode() {
    try { return localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; }
  }

  function canvasToBase64(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('The picture could not be encoded.')); return; }
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
        reader.onerror = function () { reject(new Error('The picture could not be encoded.')); };
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.92);
    });
  }

  function analyze() {
    var button = $('btn-analyze');
    button.disabled = true;
    $('analysis').hidden = true;
    setAnalyzeStatus('Uploading and analyzing…');
    canvasToBase64($('scan-canvas')).then(function (data) {
      return fetch('api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Access-Code': $('analyze-code').value.trim() },
        body: JSON.stringify({
          imageBase64: data,
          mediaType: 'image/jpeg',
          notes: $('analyze-notes').value,
          reading: lastReading,
          engine: lastEngine
        })
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          if (body.needsCode) $('analyze-code').focus();
          throw new Error(body.error || 'The server answered ' + res.status + '.');
        }
        return body;
      });
    }).then(function (body) {
      rememberCode($('analyze-code').value.trim());   // only a code the server accepted
      var out = $('analysis');
      out.textContent = body.analysis || '(Claude returned no text.)';
      out.hidden = false;
      setAnalyzeStatus('Saved as ' + body.id + '.');
    }).catch(function (e) {
      var offline = e instanceof TypeError;   // fetch rejects with TypeError when the server is unreachable
      setAnalyzeStatus(offline ? 'Could not reach the server. Start it with npm start.' : e.message, true);
    }).then(function () { button.disabled = false; });
  }

  // Read whatever is on the scan canvas.
  function readCanvas(canvas) {
    setStatus('Reading…');
    $('scan-result').textContent = '';
    lastReading = [];
    lastEngine = {};
    showAnalyze(true);
    // let the status paint before the (synchronous) recognition runs
    setTimeout(function () {
      try {
        var pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        var result = window.TrunicReader.read(pixels);
        var lines = result.lines;
        lastEngine = {
          imageWidth: canvas.width, imageHeight: canvas.height, factor: result.factor,
          method: result.reading.method, skewDegrees: result.reading.skew ? +(result.reading.skew * 180 / Math.PI).toFixed(2) : 0,
          glyphHeight: +(result.reading.glyphHeight || 0).toFixed(1), exactScore: +result.exact.toFixed(1)
        };
        lastReading = lines.map(function (l) {
          return {
            text: l.text,
            phonetic: l.phonetic,
            words: l.words.map(function (w) {
              return { english: w.english, spelling: w.spelling, cost: isFinite(w.cost) ? w.cost : null, alternatives: w.alternatives };
            })
          };
        });
        if (!lines.length) {
          setStatus('No Trunic words found. Try a straighter, sharper picture with dark lines on a plain background.', true);
          return;
        }
        renderReading(lines);
        var count = lines.reduce(function (n, l) { return n + l.words.length; }, 0);
        setStatus('Read ' + count + (count === 1 ? ' word' : ' words') + ' on ' + lines.length + (lines.length === 1 ? ' line.' : ' lines.'));
      } catch (e) {
        setStatus('Something went wrong reading that image: ' + e.message, true);
      }
    }, 0);
  }

  function readFile(file) {
    if (!file) return;
    setStatus('Loading…');
    loadImage(file).then(function (img) {
      var canvas = showCanvas(img.naturalWidth, img.naturalHeight);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      readCanvas(canvas);
    }, function (e) {
      setStatus(e.message, true);
    });
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    $('camera').srcObject = null;
    $('camera').hidden = true;
    $('btn-capture-cancel').hidden = true;
    $('btn-capture').textContent = 'Capture';
  }

  function takePhoto() {
    var video = $('camera');
    if (!video.videoWidth) { setStatus('The camera is still starting. Try again in a moment.'); return; }
    var canvas = showCanvas(video.videoWidth, video.videoHeight);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    stopCamera();
    readCanvas(canvas);
  }

  // Capture: open the camera, then the same button takes the picture. Without a
  // camera API (or permission) fall back to the phone's own camera picker.
  function onCapture() {
    if (stream) { takePhoto(); return; }
    stopLive();
    var media = navigator.mediaDevices;
    if (!media || !media.getUserMedia) { $('capture-input').click(); return; }
    setStatus('Starting the camera…');
    media.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }).then(function (s) {
      stream = s;
      var video = $('camera');
      video.srcObject = s;
      video.hidden = false;
      $('scan-canvas').hidden = true;
      $('scan-result').textContent = '';
      showAnalyze(false);
      $('btn-capture').textContent = 'Take photo';
      $('btn-capture-cancel').hidden = false;
      setStatus('Line the text up in the picture, then press Take photo.');
      return video.play();
    }).catch(function () {
      stopCamera();
      setStatus('The camera is not available here, so choose or take a picture instead.', true);
      $('capture-input').click();
    });
  }

  // ---- live camera -----------------------------------------------------------
  // A frame is grabbed twice a second and read in a web worker (live-worker.js), so
  // the page stays responsive; a frame is skipped while the previous one is still
  // being read. The English is drawn over each word on a canvas laid over the video,
  // and a frame that reads no words leaves the last good result on screen.
  var LIVE_INTERVAL_MS = 500;
  var LIVE_MAX_SIDE = 1280;
  var live = {
    stream: null, worker: null, timer: null, session: 0,
    pendingId: null, seq: 0,          // the frame the worker is reading, if any
    last: null, lastKey: '',          // last good result and the text it showed
    frame: null, frameCtx: null       // scratch canvas the video is copied to
  };

  function liveWorker() {
    if (!live.worker) {
      live.worker = new Worker('live-worker.js');
      live.worker.onmessage = onLiveResult;
      live.worker.onerror = function (e) {
        live.pendingId = null;
        setStatus('The live reader failed: ' + (e.message || 'could not start the worker') + '.', true);
      };
    }
    return live.worker;
  }

  function setLiveButtons(running) {
    $('btn-live-start').disabled = running;
    $('btn-live-stop').disabled = !running;
  }

  function stopLive() {
    live.session++;                    // replies for earlier frames are ignored from here on
    clearInterval(live.timer);
    live.timer = null;
    live.pendingId = null;
    if (live.stream) live.stream.getTracks().forEach(function (t) { t.stop(); });
    live.stream = null;
    $('live-video').srcObject = null;
    $('live-stage').hidden = true;
    var overlay = $('live-overlay');
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    setLiveButtons(false);
  }

  function grabFrame() {
    var video = $('live-video');
    if (live.pendingId !== null || !live.stream || document.hidden) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    var scale = Math.min(1, LIVE_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    var w = Math.max(1, Math.round(video.videoWidth * scale));
    var h = Math.max(1, Math.round(video.videoHeight * scale));
    if (!live.frame) live.frame = document.createElement('canvas');
    if (live.frame.width !== w || live.frame.height !== h || !live.frameCtx) {
      live.frame.width = w;
      live.frame.height = h;
      live.frameCtx = live.frame.getContext('2d', { willReadFrequently: true });
    }
    live.frameCtx.drawImage(video, 0, 0, w, h);
    var pixels = live.frameCtx.getImageData(0, 0, w, h);
    live.pendingId = ++live.seq;
    live.worker.postMessage({ id: live.pendingId, width: w, height: h, buffer: pixels.data.buffer }, [pixels.data.buffer]);
  }

  function onLiveResult(e) {
    var m = e.data;
    if (m.id !== live.pendingId) return;   // from before Stop, or not the frame being waited for
    live.pendingId = null;
    if (m.error) { setStatus('Could not read that frame: ' + m.error, true); return; }

    var good = m.result.words.length > 0;
    live.last = window.TrunicLive.keepGood(live.last, m.result);
    var overlay = $('live-overlay');
    window.TrunicLive.draw(overlay.getContext('2d'), live.last);

    if (good) {
      // aria-live text: only rewritten when the reading changes
      var key = m.result.lines.map(function (l) { return l.text + '|' + l.phonetic; }).join('\n');
      if (key !== live.lastKey) { live.lastKey = key; renderReading(m.result.lines); }
      var count = m.result.words.length;
      setStatus('Reading live: ' + count + (count === 1 ? ' word.' : ' words.'));
    } else if (live.last) {
      setStatus('No Trunic words in this frame. Showing the last good reading.');
    } else {
      setStatus('Looking for Trunic words…');
    }
  }

  function startLive() {
    var media = navigator.mediaDevices;
    if (!media || !media.getUserMedia) {
      setStatus('The live camera needs camera access, which this browser or page does not offer.', true);
      return;
    }
    try { liveWorker(); } catch (err) {
      setStatus('The live camera needs web workers, and one could not start: ' + err.message, true);
      return;
    }
    stopCamera();
    stopLive();
    var session = live.session;
    setLiveButtons(true);
    setStatus('Starting the camera…');
    media.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false }).then(function (s) {
      if (session !== live.session) { s.getTracks().forEach(function (t) { t.stop(); }); return null; }
      live.stream = s;
      live.last = null;
      live.lastKey = '';
      var video = $('live-video');
      video.srcObject = s;
      $('live-stage').hidden = false;
      $('scan-canvas').hidden = true;
      $('scan-result').textContent = '';
      showAnalyze(false);
      return video.play().then(function () {
        if (session !== live.session) return;
        setStatus('Looking for Trunic words…');
        live.timer = setInterval(grabFrame, LIVE_INTERVAL_MS);
      });
    }).catch(function () {
      if (session !== live.session) return;
      stopLive();
      setStatus('The camera is not available here. Allow camera access, or choose a picture instead.', true);
    });
  }

  // ---- wiring --------------------------------------------------------------
  $('image-input').addEventListener('change', function (e) {
    stopCamera();
    stopLive();
    readFile(e.target.files[0]);
    e.target.value = '';
  });
  $('btn-live-start').addEventListener('click', startLive);
  $('btn-live-stop').addEventListener('click', function () {
    stopLive();
    setStatus('Camera stopped.');
  });
  $('capture-input').addEventListener('change', function (e) {
    readFile(e.target.files[0]);
    e.target.value = '';
  });
  $('analyze-code').value = recallCode();
  $('btn-analyze').addEventListener('click', analyze);
  $('btn-capture').addEventListener('click', onCapture);
  $('btn-capture-cancel').addEventListener('click', function () {
    stopCamera();
    setStatus('');
  });
  window.addEventListener('pagehide', function () {
    stopCamera();
    stopLive();
    if (live.worker) live.worker.terminate();
  });

  $('btn-circle').addEventListener('click', toggleCircle);
  $('btn-clear-glyph').addEventListener('click', function () {
    composer = blankGlyph();
    editIndex = null;
    renderComposer();
    renderWord();
  });
  $('btn-add').addEventListener('click', addGlyph);
  $('btn-backspace').addEventListener('click', removeLast);
  $('btn-clear-word').addEventListener('click', clearWord);

  buildComposer();
  buildChart();
  renderComposer();
  renderWord();
})();
