/*
 * Loupe — interaction engine.
 *
 * Contract (spec):
 *  - Capture-phase, non-passive document wheel listener. Events are claimed
 *    (preventDefault + stopPropagation) ONLY when zooming: wheel-up over a
 *    qualifying target (session activation), any wheel while a session is live
 *    and the cursor is still over that target, and the single step that lands
 *    exactly on 1.0 (released before any further wheel-down, so scrolling away
 *    is immediately free). Everything else passes through untouched.
 *  - Anchor follows the live cursor: the base rect is re-derived from
 *    getBoundingClientRect() on every claimed wheel event.
 *  - Left-button drag pans 1:1 (bypasses smoothing); the trailing click after a
 *    real drag (>3px) is swallowed once so you never open the post by accident.
 *  - Whole-page mode never touches the page's stacking or clipping: it builds a
 *    stand-in of the media inside a top-layer box (see pageStage), makes the
 *    page's own copy transparent, and transforms the stand-in. Whatever the site
 *    does — overflow clips, z-index gymnastics, transforms, top-layer dialogs —
 *    the zoom is painted above all of it.
 *  - In-frame mode freezes transform/translate/rotate/scale/zoom/transform-origin/
 *    will-change/user-select and clips the media to its own box.
 *  - Every exit path restores each touched element's inline state EXACTLY.
 *  - Exits: wheel-down to 1x, Esc, double-click, cursor leaves the media,
 *    target removed from DOM, hotkey toggle, tab hide/navigation.
 */
(function (root) {
  'use strict';
  var Loupe = root.Loupe;
  var math = Loupe.math;
  var targets = Loupe.targets;
  if (Loupe.engineLoaded) return;
  Loupe.engineLoaded = true;

  /* ---------------- settings ---------------- */

  // Settings are defined once in shared/settings.js so the popup and the engine
  // can never drift; the engine mirrors storage and reacts to live changes.
  var shared = Loupe.settings;
  var DEFAULTS = shared.DEFAULTS;
  var settings = Object.assign({}, DEFAULTS);

  function readSettings() {
    shared.get(function (v) {
      settings = v;
    });
    if (typeof root.chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'sync') return;
        for (var k in changes) if (k in settings) settings[k] = changes[k].newValue;
        if (settings.enabled === false || k === 'zoomMode') hardRestore();
        if (k === 'pauseVideo') applyVideoPause(); // freeze or release the live zoom immediately
        if (settings.hud === false && Loupe.hud) Loupe.hud.hide();
      });
    }
  }
  readSettings();

  function siteDisabled() {
    return settings.disabledSites.indexOf(root.location.hostname) !== -1;
  }

  /*
   * Held-input state for the custom activation mode. Modifiers ride on the event
   * itself; a plain key needs keydown/keyup tracking, and a mouse button is read
   * from the event's button mask with tracked presses as a fallback.
   */
  var heldKeys = Object.create(null);
  var heldButtons = 0;

  function clearHeld() {
    heldKeys = Object.create(null);
    heldButtons = 0;
  }

  function heldDown(e) {
    var spec = shared.parseHold(settings.holdInput);
    if (!spec) return false;
    if (spec.mod) return !!e[spec.mod + 'Key'];
    if (spec.mouse != null) {
      var bit = 1 << spec.mouse;
      return !!(e.buttons & bit) || !!(heldButtons & bit);
    }
    return heldKeys[spec.code] === true;
  }

  function wantZoom(e) {
    if (!settings.enabled || siteDisabled()) return false;
    if (settings.activation === 'alt') return !!e.altKey;
    if (settings.activation === 'hold') return heldDown(e);
    return true;
  }

  /* ---------------- session state ---------------- */

  var COPY_PROPS = [
    'transform',
    'translate',
    'rotate',
    'scale',
    'zoom',
    'transform-origin',
    'will-change',
    'user-select'
  ];

  var S = null; // { el, view, stage, kind, cur:{s,x,y}, tgt:{s,x,y}, base,
                //   frozen, escaped, raf, exiting, dragging, moved, ptrId,
                //   last, suppressClick, clickTimer }

  function freeze(el) {
    var frozen = [];
    for (var i = 0; i < COPY_PROPS.length; i++) {
      var prop = COPY_PROPS[i];
      frozen.push({
        prop: prop,
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop)
      });
    }
    el.style.setProperty('transform-origin', '0 0', 'important');
    el.style.setProperty('translate', 'none');
    el.style.setProperty('rotate', 'none');
    el.style.setProperty('scale', 'none');
    el.style.setProperty('zoom', '1');
    el.style.setProperty('user-select', 'none');
    el.style.setProperty('will-change', 'transform');
    // Inline without !important can lose to a site rule marked !important; force it.
    el.style.setProperty('transform', 'none', 'important');

    // Stacking lift so the zoomed media paints above later siblings/overlays.
    // Gate: only childless elements — flipping `position` on a container would
    // re-anchor its absolutely-positioned children mid-zoom.
    if (el.childElementCount === 0) {
      if (root.getComputedStyle(el).position === 'static') {
        frozen.push({ prop: 'position', value: el.style.getPropertyValue('position'), priority: el.style.getPropertyPriority('position') });
        el.style.setProperty('position', 'relative', 'important');
      }
      frozen.push({ prop: 'z-index', value: el.style.getPropertyValue('z-index'), priority: el.style.getPropertyPriority('z-index') });
      el.style.setProperty('z-index', '2147483647', 'important');
    }
    return frozen;
  }

  function clipRecord(node, prop) {
    return { prop: prop, value: node.style.getPropertyValue(prop), priority: node.style.getPropertyPriority(prop) };
  }

  /*
   * Frame mode ("In frame"): hold the zoom inside the media's own box, like a
   * loupe resting on a printed photo. The nearest ancestor whose box *is* the
   * media's box (within 2px) is the frame; if it does not already clip, give it
   * overflow:hidden for the session. Nothing is un-clipped and no stacking is
   * lifted, so neighbouring slides and page chrome are never revealed.
   */
  function frameClip(el) {
    var rect = el.getBoundingClientRect();
    var node = el;
    for (;;) {
      var parent = node.parentElement;
      if (!parent) {
        var rn = node.getRootNode ? node.getRootNode() : null;
        parent = rn && rn.host ? rn.host : null;
      }
      node = parent;
      if (!node || node === root.document.body || node === root.document.documentElement) break;
      var r = node.getBoundingClientRect();
      var tight =
        Math.abs(r.left - rect.left) <= 2 &&
        Math.abs(r.top - rect.top) <= 2 &&
        Math.abs(r.right - rect.right) <= 2 &&
        Math.abs(r.bottom - rect.bottom) <= 2;
      if (!tight) continue;
      var cs = root.getComputedStyle(node);
      var already =
        cs.overflowX !== 'visible' ||
        cs.overflowY !== 'visible' ||
        (cs.clipPath && cs.clipPath !== 'none') ||
        (cs.contain && cs.contain !== 'none' && /paint|strict/.test(cs.contain)) ||
        (cs.maskImage && cs.maskImage !== 'none');
      if (already) return null; // the frame holds the zoom on its own
      var group = { node: node, saved: [clipRecord(node, 'overflow')], clipped: true };
      node.style.setProperty('overflow', 'hidden', 'important');
      return group;
    }
    return null; // no matching frame: leave whatever clipping exists in charge
  }

  /* ---------------- page mode: a stand-in in the top layer ---------------- */

  /*
   * Whole-page mode used to un-clip and re-stack the page around the media, and
   * every site found a way to break it: an un-clipped track revealed a
   * carousel's neighbours, a wrapper that formed a stacking context with
   * z-index:auto trapped the media below the page's chrome, a fixed header or a
   * later sibling painted over it.
   *
   * So the zoom no longer happens in the page's paint order at all. The stand-in
   * lives in the browser's *top layer* (a manual popover): nothing on the page
   * can cover it (chrome, dialogs, sticky bars), nothing can clip it (overflow,
   * clip-path, masks, transformed ancestors), and page mutations drop to one
   * property — the original's opacity.
   *
   * The trade is that the media's pixels are reproduced rather than moved, so the
   * stand-in copies what makes the media look like itself: the same bitmap for an
   * <img>, the same live stream or frozen frame for a <video>, a drawn copy of a
   * <canvas>, and a copy of the panel (background plus content) for CSS art.
   */

  var STAGE_STYLE = {
    position: 'fixed',
    inset: '0',
    width: 'auto',
    height: 'auto',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    overflow: 'hidden',
    'pointer-events': 'none',
    'z-index': '2147483647',
    display: 'block',
    opacity: '1',
    visibility: 'visible',
    transform: 'none',
    transition: 'none',
    animation: 'none'
  };

  var PAINT_PROPS = ['object-fit', 'object-position', 'border-radius', 'filter', 'clip-path', 'image-rendering'];
  var BACKGROUND_PROPS = [
    'background-image',
    'background-size',
    'background-position',
    'background-repeat',
    'background-origin',
    'background-clip',
    'background-color',
    'border-radius',
    'filter',
    'clip-path',
    'overflow'
  ];
  var TEXT_PROPS = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform'];
  var CLONE_LIMIT = 120; // elements; above this the panel is reproduced by its background only

  function applyStyle(node, map) {
    for (var k in map) if (map.hasOwnProperty(k)) node.style.setProperty(k, map[k], 'important');
  }

  /* Copy computed declarations so the copy renders like the original. */
  function copyPaint(dst, src, props) {
    var cs = root.getComputedStyle(src);
    for (var i = 0; i < props.length; i++) {
      var v = cs.getPropertyValue(props[i]);
      if (v && v !== 'none' && v !== 'normal') dst.style.setProperty(props[i], v, 'important');
    }
  }

  /* Ids must not be duplicated into the document (site lookups, anchors). */
  function stripIds(node) {
    node.removeAttribute('id');
    var all = node.querySelectorAll('[id]');
    for (var i = 0; i < all.length; i++) all[i].removeAttribute('id');
  }

  /*
   * A frame copied onto a canvas. Used when no stream can be carried: the canvas
   * always paints the pixels the element is showing right now.
   */
  function frameShot(el) {
    var w = el.videoWidth;
    var h = el.videoHeight;
    if (!w || !h) return null;
    var shot = root.document.createElement('canvas');
    shot.width = w;
    shot.height = h;
    try {
      shot.getContext('2d').drawImage(el, 0, 0, w, h);
    } catch (_) {
      return null;
    }
    return shot;
  }

  function standIn(el, kind, rect) {
    var doc = root.document;
    var node;
    var captures = []; // streams we created; the page's own stream is never ours to stop

    if (kind === 'img') {
      node = doc.createElement('img');
      node.alt = '';
      node.draggable = false;
      node.decoding = 'async';
      if (el.crossOrigin) node.crossOrigin = el.crossOrigin;
      if (el.referrerPolicy) node.referrerPolicy = el.referrerPolicy;
      node.src = el.currentSrc || el.src;
      copyPaint(node, el, PAINT_PROPS);
    } else if (kind === 'video') {
      /*
       * A video has two ways to be carried over:
       *  - its stream (a camera, a canvas feed, or a MediaSource we capture),
       *  - its URL, re-requested by the stand-in.
       *
       * The URL is not always reusable. A MediaSource object URL (`blob:`) is
       * single-use: handing it to a second <video> makes the browser reject the
       * load, which painted a black box over a hidden player — exactly what
       * Instagram Reels did. Those are carried as decoded frames instead, and if
       * even that is unavailable, a single copied frame.
       */
      var stream = null;
      var blobFed = /^(blob:|mediastream:)/.test(el.currentSrc || el.src || '');
      if (el.srcObject) {
        // A camera/stream frame has no URL to re-request; share the stream.
        stream = el.srcObject;
      } else if (blobFed && typeof el.captureStream === 'function') {
        try {
          stream = el.captureStream();
        } catch (_) {
          stream = null;
        }
        if (stream && (!stream.getVideoTracks || !stream.getVideoTracks().length)) stream = null;
      }
      if (blobFed && !stream) {
        node = frameShot(el); // blob: source we cannot stream: freeze one frame
        if (!node) return null; // nothing paintable -> the caller zooms in place
      } else if (!stream && !el.currentSrc) {
        return null; // no source at all: let the caller zoom in place
      }

      if (!node) {
        node = doc.createElement('video');
        node.muted = true;
        node.playsInline = true;
        node.preload = 'auto';
        if (el.poster) node.poster = el.poster;
        if (stream) {
          node.srcObject = stream;
          if (!el.srcObject) captures.push(stream);
        } else {
          node.src = el.currentSrc;
          var at = el.currentTime || 0;
          node.addEventListener('loadedmetadata', function () {
            try { node.currentTime = at; } catch (_) { /* not seekable yet */ }
          }, { once: true });
        }
        var playing = node.play();
        if (playing && playing.catch) playing.catch(function () {});
      }
      copyPaint(node, el, PAINT_PROPS);
    } else if (kind === 'canvas') {
      node = doc.createElement('canvas');
      node.width = el.width || rect.width;
      node.height = el.height || rect.height;
      try {
        node.getContext('2d').drawImage(el, 0, 0);
      } catch (_) {
        return null; // no 2d context: let the caller fall back to in-place
      }
      copyPaint(node, el, ['border-radius', 'filter', 'clip-path']);
    } else {
      // CSS art. Reproduce the painted surface, and keep the panel's own content
      // (hero panels, product tiles) so text does not vanish mid-zoom.
      node = doc.createElement('div');
      copyPaint(node, el, BACKGROUND_PROPS);
      copyPaint(node, el, TEXT_PROPS);
      var inner = el.querySelectorAll('*').length;
      if (el.childElementCount > 0 && inner <= CLONE_LIMIT) {
        var copy = el.cloneNode(true);
        stripIds(copy);
        // A cloned <video> repeats the original's URL. When that URL is a
        // single-use MediaSource blob it would paint black inside the copy, so
        // carry the live frames across instead.
        var originals = el.querySelectorAll('video');
        var clones = copy.querySelectorAll('video');
        for (var c = 0; c < clones.length && c < originals.length; c++) {
          var origin = originals[c];
          var dup = clones[c];
          if (!/^blob:/.test(origin.currentSrc || origin.src || dup.src || '')) continue;
          var live = null;
          try {
            live = origin.captureStream();
          } catch (_) {
            live = null;
          }
          if (!live) continue;
          dup.removeAttribute('src');
          dup.muted = true;
          dup.playsInline = true;
          dup.srcObject = live;
          captures.push(live);
          var go = dup.play();
          if (go && go.catch) go.catch(function () {});
        }
        while (copy.firstChild) node.appendChild(copy.firstChild);
      }
    }
    return { node: node, captures: captures };
  }

  function pageStage(el, kind, rect) {
    var doc = root.document;
    if (!doc || !doc.documentElement) return null;

    var made;
    try {
      made = standIn(el, kind, rect);
    } catch (_) {
      return null;
    }
    if (!made) return null;
    var view = made.node;

    var host = doc.createElement('div');
    host.setAttribute('data-loupe-stage', '');
    host.setAttribute('aria-hidden', 'true');
    applyStyle(host, STAGE_STYLE);

    view.setAttribute('data-loupe-view', '');
    applyStyle(view, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: rect.width + 'px',
      height: rect.height + 'px',
      'min-width': '0',
      'min-height': '0',
      'max-width': 'none',
      'max-height': 'none',
      margin: '0',
      'box-sizing': 'border-box',
      'transform-origin': '0 0',
      transform: 'none',
      display: 'block',
      opacity: '1',
      visibility: 'visible',
      'pointer-events': 'none',
      'will-change': 'transform',
      transition: 'none',
      animation: 'none'
    });

    host.appendChild(view);

    // Top layer: above every page element and outside every ancestor clip. On a
    // browser without popovers the same box still works, just at z-index's mercy.
    var canPop = typeof host.showPopover === 'function';
    if (canPop) host.setAttribute('popover', 'manual');
    doc.documentElement.appendChild(host);
    if (canPop) {
      try {
        host.showPopover();
      } catch (_) {
        host.removeAttribute('popover');
      }
    }

    return {
      host: host,
      view: view,
      topLayer: host.hasAttribute('popover'),
      captures: made.captures || [],
      stop: null
    };
  }

  /*
   * A stand-in that paints nothing is worse than no stand-in: the page's own
   * media is hidden for the whole session, so a failed copy is a black screen.
   * Every stand-in whose pixels can be checked is watched, and a failure demotes
   * the live session to in-frame zoom — the real element keeps its pixels there.
   */
  function watchStage(stage, kind) {
    var view = stage.view;
    var timer = 0;
    var done = false;
    var bound = [];

    function on(target, type, fn) {
      target.addEventListener(type, fn);
      bound.push([target, type, fn]);
    }

    function unbind() {
      for (var i = 0; i < bound.length; i++) {
        try { bound[i][0].removeEventListener(bound[i][1], bound[i][2]); } catch (_) { /* gone */ }
      }
      bound = [];
    }

    function stop() {
      done = true;
      if (timer) root.clearTimeout(timer);
      timer = 0;
      unbind();
      var streams = stage.captures || [];
      for (var s = 0; s < streams.length; s++) {
        var tracks = streams[s].getTracks ? streams[s].getTracks() : [];
        for (var i = 0; i < tracks.length; i++) {
          try { tracks[i].stop(); } catch (_) { /* already ended */ }
        }
      }
      stage.captures = [];
    }

    function fail() {
      if (done) return;
      stop();
      if (S && S.stage === stage) demoteToFrame(stage);
    }

    function ok() {
      if (done) return;
      done = true;
      if (timer) root.clearTimeout(timer);
      timer = 0;
      unbind();
    }

    stage.stop = stop;

    if (kind === 'img') {
      var checkImg = function () {
        if (view.complete) (view.naturalWidth > 0 ? ok : fail)();
      };
      on(view, 'load', checkImg);
      on(view, 'error', fail);
      checkImg();
      if (!done) timer = root.setTimeout(fail, 2000);
      return;
    }

    if (kind === 'video') {
      if (view.tagName !== 'VIDEO') return ok(); // a copied frame is painted already
      on(view, 'error', fail);
      var deadline = Date.now() + 2500;
      (function poll() {
        if (done) return;
        if (view.videoWidth > 0 && view.readyState >= 2) return ok();
        if (Date.now() > deadline) return fail();
        timer = root.setTimeout(poll, 60);
      })();
    }
  }

  /*
   * Give up on the stand-in mid-session: put the page's element back, then zoom
   * it in place. The math is unchanged (the element has not moved), so the scale
   * and pan already on screen survive the switch.
   */
  function demoteToFrame(stage) {
    if (!S || S.stage !== stage || !S.el.isConnected) return;
    var s = S;
    if (s.stage.stop) s.stage.stop();
    removeNode(s.stage.host);
    restoreEscaped(s.escaped);
    s.escaped = [];
    if (s.el.hasAttribute('data-loupe-zoomed')) s.el.removeAttribute('data-loupe-zoomed');
    s.stage = null;
    s.view = s.el;
    s.frozen = freeze(s.el);
    var frame = frameClip(s.el);
    if (frame) s.escaped.push(frame);
    var r = s.el.getBoundingClientRect();
    s.base = { x: r.left, y: r.top, width: r.width, height: r.height };
    apply();
  }

  function removeNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function restoreEscaped(escaped) {
    if (!escaped) return;
    for (var i = escaped.length - 1; i >= 0; i--) {
      var group = escaped[i];
      for (var j = group.saved.length - 1; j >= 0; j--) {
        var f = group.saved[j];
        if (f.value) group.node.style.setProperty(f.prop, f.value, f.priority);
        else group.node.style.removeProperty(f.prop);
      }
      // Leave no empty style="" litter on nodes we only touched temporarily.
      if (group.node.style.length === 0) group.node.removeAttribute('style');
    }
  }

  function unfreeze(el, frozen) {
    if (!el || !frozen) return;
    for (var i = frozen.length - 1; i >= 0; i--) {
      var f = frozen[i];
      if (f.value) el.style.setProperty(f.prop, f.value, f.priority);
      else el.style.removeProperty(f.prop);
    }
    if (el.style.length === 0) el.removeAttribute('style');
  }

  /* ---------------- optional freeze of the zoomed video ---------------- */

  /*
   * "Pause video while zoomed" is OFF by default: Loupe never touches playback
   * unless the user asks it to. When it is on, the page's video (and the stand-in
   * carrying it) freezes for the duration of the zoom and resumes on exit — only
   * if Loupe is what paused it, so a video the page had already paused stays that
   * way and a pause the user presses themselves is never overridden.
   */
  function playSafe(v) {
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
  }

  function videoList() {
    if (!S) return [];
    var out = [];
    if (S.el && S.el.tagName === 'VIDEO') out.push(S.el);
    if (S.stage && S.view && S.view !== S.el && S.view.tagName === 'VIDEO') out.push(S.view);
    return out;
  }

  function applyVideoPause() {
    if (!S) return;
    if (settings.pauseVideo) {
      freezeVideo();
      return;
    }
    if (S.freezeTimer) root.clearTimeout(S.freezeTimer);
    S.freezeTimer = 0;
    resumePaused();
  }

  function freezeVideo() {
    if (!S) return;
    var vids = videoList();
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].paused || S.paused.indexOf(vids[i]) !== -1) continue;
      vids[i].pause();
      S.paused.push(vids[i]);
    }
  }

  /*
   * On activation the freeze waits for a stream-fed copy to show its first frame
   * (one requestVideoFrameCallback, deadline 700ms). Freezing the source before
   * the copy holds any pixel would freeze it on the black it started with — the
   * exact failure this option must not reintroduce. A copy loaded from its own
   * URL, or a video the page already paused, freezes at once.
   */
  function scheduleFreeze() {
    if (!S || !settings.pauseVideo) return;
    var src = S.el && S.el.tagName === 'VIDEO' ? S.el : null;
    var copy = S.stage && S.view && S.view !== S.el && S.view.tagName === 'VIDEO' ? S.view : null;
    if (!copy || !src || src.paused || typeof copy.requestVideoFrameCallback !== 'function') {
      freezeVideo();
      return;
    }
    var self = S;
    var done = false;
    function go() {
      if (done) return;
      done = true;
      if (S !== self) return; // the session ended while we waited
      if (self.freezeTimer) root.clearTimeout(self.freezeTimer);
      self.freezeTimer = 0;
      if (settings.pauseVideo) freezeVideo();
    }
    try {
      copy.requestVideoFrameCallback(function () { go(); });
    } catch (_) {
      freezeVideo();
      return;
    }
    self.freezeTimer = root.setTimeout(go, 700);
  }

  function resumePaused() {
    if (!S || !S.paused.length) return;
    for (var i = 0; i < S.paused.length; i++) {
      var v = S.paused[i];
      if (v.isConnected && v.paused) playSafe(v);
    }
    S.paused = [];
  }

  function activate(target, c) {
    var el = target.el;
    var rect = el.getBoundingClientRect(); // clean: nothing is transformed yet
    var frozen = [];
    var escaped = [];
    var stage = null;

    if (settings.zoomMode !== 'frame' && !(target.kind === 'video' && el.mediaKeys)) stage = pageStage(el, target.kind, rect);

    if (stage) {
      // The stand-in carries the pixels. The page's own element keeps its box
      // (opacity, unlike visibility, keeps it laid out AND hit-testable, which is
      // what tells the engine the cursor is still on the media) but paints nothing.
      escaped.push({ node: el, saved: [clipRecord(el, 'opacity')] });
      el.style.setProperty('opacity', '0', 'important');
      el.setAttribute('data-loupe-zoomed', '');
    } else {
      // In-frame, or a stand-in could not be built: hold the zoom inside the box.
      frozen = freeze(el);
      var frame = frameClip(el);
      if (frame) escaped.push(frame);
    }

    S = {
      el: el,
      view: stage ? stage.view : el,
      stage: stage,
      kind: target.kind,
      cx: c.x,
      cy: c.y,
      base: math.baseFromRect(rect, 0, 0),
      cur: { s: 1, x: 0, y: 0 },
      tgt: { s: 1, x: 0, y: 0 },
      frozen: frozen,
      escaped: escaped,
      raf: 0,
      exiting: false,
      dragging: false,
      moved: 0,
      ptrId: -1,
      last: null,
      suppressClick: false,
      clickTimer: 0,
      paused: [],
      freezeTimer: 0
    };

    // The readout is its own top-layer box; re-showing it puts it above the stage.
    if (stage && Loupe.hud && Loupe.hud.raise) Loupe.hud.raise();
    if (stage) watchStage(stage, target.kind);
    scheduleFreeze(); // only when "Pause video while zoomed" is on
    return S;
  }

  /*
   * Untransformed rect (viewport coords) for the live session. In page mode the
   * page's element is never transformed and the stand-in carries `base + t`, so
   * its rect IS the base; in-frame reads the transform back out of the rect.
   */
  function liveBase() {
    var r = S.el.getBoundingClientRect();
    if (S.stage) return { x: r.left, y: r.top, width: r.width, height: r.height };
    return math.baseFromRect(r, S.cur.x, S.cur.y);
  }

  function apply() {
    if (!S) return;
    if (S.stage) {
      S.view.style.setProperty(
        'transform',
        math.cssTransform(S.base.x + S.cur.x, S.base.y + S.cur.y, S.cur.s),
        'important'
      );
    } else {
      S.view.style.setProperty('transform', math.cssTransform(S.cur.x, S.cur.y, S.cur.s), 'important');
    }
  }

  function hardRestore() {
    if (!S) return;
    var s = S;
    S = null;
    if (s.raf) root.cancelAnimationFrame(s.raf);
    if (s.clickTimer) root.clearTimeout(s.clickTimer);
    if (s.freezeTimer) root.clearTimeout(s.freezeTimer);
    if (s.stage && s.stage.stop) s.stage.stop();
    removeNode(s.stage && s.stage.host);
    if (s.el.hasAttribute('data-loupe-zoomed')) s.el.removeAttribute('data-loupe-zoomed');
    restoreEscaped(s.escaped);
    unfreeze(s.el, s.frozen);
    // Hand playback back exactly as we found it: resume only what we paused.
    for (var i = 0; i < s.paused.length; i++) {
      var v = s.paused[i];
      if (v.isConnected && v.paused) playSafe(v);
    }
    s.paused = [];
    if (Loupe.hud) Loupe.hud.hide();
  }

  function beginExit(animated) {
    if (!S) return;
    if (!animated || !settings.smooth) {
      hardRestore();
      return;
    }
    S.exiting = true;
    S.tgt = { s: 1, x: 0, y: 0 };
    startLoop();
  }

  /* ---------------- smoothing loop ---------------- */

  var TAU = 0.045; // s — exponential approach time constant (~150ms to settle)
  var lastFrame = 0;

  function frame(now) {
    if (!S) return;
    S.raf = 0;

    if (!S.el.isConnected) {
      hardRestore();
      return;
    }

    var alpha = settings.smooth && !S.dragging
      ? 1 - Math.exp(-(now - (lastFrame || now - 16)) / 1000 / TAU)
      : 1; /* smoothing on (and not dragging); otherwise exact */
    lastFrame = now;
    if (alpha > 1) alpha = 1;

    var c = S.cur, t = S.tgt;
    c.s += (t.s - c.s) * alpha;
    c.x += (t.x - c.x) * alpha;
    c.y += (t.y - c.y) * alpha;

    // Micro-snap so a settled image is never left at 0.9999 (soft/subpixel-shifted).
    var settled =
      Math.abs(t.s - c.s) < 0.001 &&
      Math.abs(t.x - c.x) < 0.001 &&
      Math.abs(t.y - c.y) < 0.001;

    if (settled) {
      c.s = t.s;
      c.x = t.x;
      c.y = t.y;
    }

    apply();
    if (Loupe.hud) {
      if (settings.hud && S.cur.s > 1.001) Loupe.hud.update(S.cur.s, S.cx, S.cy);
      else Loupe.hud.hide();
    }

    if (settled && S.exiting) {
      hardRestore();
      return;
    }

    S.raf = root.requestAnimationFrame(frame);
  }

  function startLoop() {
    if (S && !S.raf) {
      lastFrame = 0;
      S.raf = root.requestAnimationFrame(frame);
    }
  }

  /* ---------------- wheel ---------------- */

  function zoomOpts() {
    return { rate: math.DEFAULT_RATE, sensitivity: settings.sensitivity, maxScale: settings.maxScale };
  }

  function claim(e) {
    if (e.cancelable) e.preventDefault();
    e.stopPropagation(); // capture@document: stops target- and bubble-phase site handlers
    e.__loupe = true;
  }

  /*
   * Is the pointer on the media for this session?
   *
   * Whole-page zoom paints above the page, so "on the media" means inside the
   * picture as drawn: a card, rail or badge that overlaps it can no longer take
   * the pointer away from a zoom the user is looking at (and after a pan, the
   * drawn picture may no longer sit over its own footprint at all).
   *
   * In-frame mode leaves the page in charge of paint order, so the event path is
   * used first, and the paint stack second — sites that cover media with a
   * transparent click layer (Instagram) only put the layer in the path.
   */
  function overMedia(e) {
    if (!S) return false;
    if (typeof e.clientX !== 'number') return false;
    if (S.stage) {
      var r = S.view.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }
    if (targets.pathFrom(e, S.el)) return true;
    return targets.under(S.el, e.clientX, e.clientY, document);
  }

  function onWheel(e) {
    if (e.__loupe) return;
    var path = e.composedPath();

    if (S) {
      if (!S.el.isConnected) {
        hardRestore();
        return;
      }
      var over = overMedia(e);
      if (!over || !wantZoom(e)) {
        // Cursor left the media (or activation released): animate out, DO NOT claim.
        beginExit(true);
        return;
      }
      if (S.dragging) {
        claim(e);
        return;
      }
      var dy = math.normalizeDelta(e.deltaY, e.deltaMode);
      if (dy === 0) return;
      if (!e.cancelable) return; // can't stop the page -> don't half-hijack the gesture
      claim(e);
      S.exiting = false; // a successful claim revives an exit-in-flight
      S.cx = e.clientX;
      S.cy = e.clientY;

      // Live re-derivation (scroll drift self-corrects here).
      var base = liveBase();
      S.base = base;
      var next = math.zoomStep({ x: e.clientX, y: e.clientY }, base, S.cur.x, S.cur.y, S.cur.s, dy, zoomOpts());

      if (next.s <= 1) {
        // Reaching exactly 1.0 ends the session BEFORE any further wheel-down,
        // so scrolling away is never sticky.
        S.tgt = { s: 1, x: 0, y: 0 };
        S.cur = { s: 1, x: 0, y: 0 };
        hardRestore();
        return;
      }

      S.tgt = { s: next.s, x: next.x, y: next.y };
      if (settings.smooth) {
        startLoop();
      } else {
        S.cur = { s: next.s, x: next.x, y: next.y };
        apply();
      }
      return;
    }

    /* --- no session: try to activate on wheel-up --- */
    if (e.deltaY >= 0) return; // wheel-down over media = normal scroll
    if (!e.cancelable) return;
    if (!wantZoom(e)) return;

    var target = targets.resolveTarget(path, {
      bgImages: settings.bgImages,
      point: { x: e.clientX, y: e.clientY },
      doc: document
    });
    if (!target) return;

    activate(target, { x: e.clientX, y: e.clientY });
    claim(e);

    // Read the base AFTER activating: the stand-in is placed from the clean rect.
    var b0 = liveBase();
    S.base = b0;
    var step = math.zoomStep({ x: e.clientX, y: e.clientY }, b0, 0, 0, 1, math.normalizeDelta(e.deltaY, e.deltaMode), zoomOpts());
    S.tgt = { s: step.s, x: step.x, y: step.y };
    if (settings.smooth) {
      startLoop();
    } else {
      S.cur = { s: step.s, x: step.x, y: step.y };
      apply();
    }
    if (settings.hud && Loupe.hud) Loupe.hud.show(S.tgt.s, S.cx, S.cy);
  }

  /* ---------------- pointer / drag ---------------- */

  function onPointerMove(e) {
    if (!S) return;
    if (S.dragging) {
      if (e.pointerId !== S.ptrId) return;
      var dx = e.clientX - S.last.x;
      var dy = e.clientY - S.last.y;
      S.last = { x: e.clientX, y: e.clientY };
      S.cx = e.clientX;
      S.cy = e.clientY;
      S.moved += Math.abs(dx) + Math.abs(dy);
      // Arm click suppression from the moment movement crosses the threshold,
      // re-arming its expiry on every subsequent move: suppression must not
      // depend on a later pointerup handoff.
      if (S.moved > 3) armClickSuppression();
      // Pan + clamp against the viewport with the CURRENT scale (live rect, exact base).
      var base = liveBase();
      S.base = base;
      var clamped = math.clampPan(
        base,
        S.cur.s,
        S.cur.x + dx,
        S.cur.y + dy,
        { width: root.innerWidth, height: root.innerHeight },
        80
      );
      S.cur.x = clamped.x;
      S.cur.y = clamped.y;
      S.tgt.x = clamped.x;
      S.tgt.y = clamped.y;
      apply();
      if (!S.raf) startLoop(); // keep the frame alive so disconnects get caught
      return;
    }
    S.cx = e.clientX;
    S.cy = e.clientY;
    // Idle session + cursor moved off the media -> start exit.
    if (!overMedia(e)) beginExit(true);
  }

  function onMouseDown(e) {
    if (!S || e.button !== 0) return;
    if (!overMedia(e)) return;
    // Block native image drag / text selection while zoomed. click still fires.
    e.preventDefault();
  }

  function onPointerDown(e) {
    if (!S || e.button !== 0) return;
    if (!overMedia(e) || S.cur.s <= 1) return;
    S.dragging = true;
    S.ptrId = e.pointerId;
    S.moved = 0;
    S.last = { x: e.clientX, y: e.clientY };
    try {
      S.el.setPointerCapture(e.pointerId);
    } catch (_) { /* not fatal */ }
    root.document.body && root.document.body.style.setProperty('cursor', 'grabbing');
    startLoop();
  }

  function armClickSuppression() {
    if (!S) return;
    S.suppressClick = true;
    if (S.clickTimer) root.clearTimeout(S.clickTimer);
    S.clickTimer = root.setTimeout(function () {
      if (S) {
        S.suppressClick = false;
        S.clickTimer = 0;
      }      }, 1000);
  }

  function onPointerUp(e) {
    if (!S || !S.dragging || e.pointerId !== S.ptrId) return;
    S.dragging = false;
    try {
      S.el.releasePointerCapture(S.ptrId);
    } catch (_) { /* not fatal */ }
    if (root.document.body) root.document.body.style.removeProperty('cursor');
    if (S.moved > 3) armClickSuppression();
    S.ptrId = -1;
  }

  function onClick(e) {
    if (!S || !S.suppressClick) return;
    S.suppressClick = false;
    if (S.clickTimer) root.clearTimeout(S.clickTimer);
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onDblClick(e) {
    if (!S) return;
    if (!overMedia(e)) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    hardRestore();
  }

  /* ---------------- keys / lifecycle ---------------- */

  /*
   * Escape is delivered to the document that owns focus, which is usually the
   * TOP page even when the media being zoomed lives in an iframe. A zoom in a
   * cross-origin child therefore never sees the key on its own, so every frame
   * that sees Escape also relays it to its descendants. The message can be
   * forged by page script; its only effect is ending a local zoom.
   */
  var EXIT_MSG = '__loupe_exit__';

  function relayExit() {
    var kids = root.frames;
    for (var i = 0; i < kids.length; i++) {
      try { kids[i].postMessage(EXIT_MSG, '*'); } catch (_) { /* detached frame */ }
    }
  }

  root.addEventListener('message', function (e) {
    if (e.data !== EXIT_MSG) return;
    if (S) hardRestore();
    relayExit(); /* nested frames, one hop each */
  });

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (S) {
        e.preventDefault();
        e.stopPropagation();
        hardRestore();
      }
      relayExit();
      return;
    }
    if (e.altKey && e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
      e.preventDefault();
      settings.enabled = !settings.enabled;
      if (typeof root.chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ enabled: settings.enabled });
      }
      if (!settings.enabled) hardRestore();
      // Toast/HUD feedback arrives with the popup pass.
    }
  }

  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('mousedown', onMouseDown, { capture: true, passive: false });
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  document.addEventListener('pointerup', onPointerUp, { capture: true });
  document.addEventListener('pointercancel', onPointerUp, { capture: true });
  document.addEventListener('click', onClick, { capture: true, passive: false });
  document.addEventListener('dblclick', onDblClick, { capture: true });
  document.addEventListener('keydown', onKeyDown, { capture: true });

  // Passive tracking only: holding a custom key must never block the page's own
  // typing or shortcuts, it just marks the key as down for wantZoom().
  root.addEventListener('keydown', function (e) { heldKeys[e.code] = true; }, { capture: true, passive: true });
  root.addEventListener('keyup', function (e) { delete heldKeys[e.code]; }, { capture: true, passive: true });
  root.addEventListener('mousedown', function (e) { heldButtons |= 1 << e.button; }, { capture: true, passive: true });
  root.addEventListener('mouseup', function (e) { heldButtons &= ~(1 << e.button); }, { capture: true, passive: true });

  root.addEventListener('pagehide', hardRestore);
  root.addEventListener('blur', function () {
    clearHeld(); // a key released while we were unfocused never reports keyup
    hardRestore();
  });

  /* ---------------- debug hook (read-only, used by QA/E2E) ---------------- */

  Loupe.debug = {
    settings: function () { return Object.assign({}, settings); },
    view: function () { return S ? S.view : null; },
    session: function () {
      return S ? { kind: S.kind, cur: Object.assign({}, S.cur), exiting: S.exiting, dragging: S.dragging } : null;
    },
    hardRestore: hardRestore
  };
})(globalThis);
