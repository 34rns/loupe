/*
 * Loupe — media target resolution.
 * Called only at wheel time (with the event's composedPath()), so
 * getBoundingClientRect / getComputedStyle pressure stays off the pointermove hot path.
 * companionPath() walks open shadow roots for pointermove containment checks.
 */
(function (root) {
  'use strict';
  var Loupe = (root.Loupe = root.Loupe || {});

  var MIN_MEDIA = 120; // px — img/video/canvas: min width AND height
  var MIN_BG_W = 200; // px — background-image surfaces get a bigger guard:
  var MIN_BG_H = 120; //      they are more often chunks of page chrome.

  function isMediaEl(el) {
    var t = el.tagName;
    return t === 'IMG' || t === 'VIDEO' || t === 'CANVAS';
  }

  function resourceReady(el) {
    if (el.tagName === 'IMG') return el.complete && el.naturalWidth > 0;
    if (el.tagName === 'CANVAS') return el.width > 0 && el.height > 0;
    return true; // <video>: transform the live element regardless of readyState
  }

  function hasRealBg(el) {
    var bg = root.getComputedStyle(el).backgroundImage;
    return typeof bg === 'string' && bg !== 'none' && bg.indexOf('url(') !== -1;
  }

  function sizeOk(rect, minW, minH) {
    return rect.width >= minW && rect.height >= minH;
  }

  /* One element -> a usable target, or null. */
  function match(el, opts) {
    if (!el || el.nodeType !== 1 || typeof el.getBoundingClientRect !== 'function') return null;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (isMediaEl(el)) {
      if (sizeOk(rect, MIN_MEDIA, MIN_MEDIA) && resourceReady(el)) {
        return { el: el, kind: el.tagName.toLowerCase(), rect: rect };
      }
      return null;
    }
    if (opts.bgImages && sizeOk(rect, MIN_BG_W, MIN_BG_H) && hasRealBg(el)) {
      return { el: el, kind: 'bg', rect: rect };
    }
    return null;
  }

  /*
   * Sites commonly cover their photos with a transparent click layer (Instagram
   * does exactly this: a plain div above every <img>), so the wheel's path holds
   * only divs and the photo is invisible to a path walk. Such a layer does not
   * hide the media, though; an opaque one does, and zooming behind a modal or a
   * dark scrim would be wrong. Transparent = nothing painted over the media.
   */
  function coverTransparent(el) {
    if (!el || el.nodeType !== 1) return true;
    var cs = root.getComputedStyle(el);
    if (!cs) return true;
    if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return true;
    if (cs.backgroundImage !== 'none') return false;
    if (cs.backdropFilter && cs.backdropFilter !== 'none') return false;
    var bg = cs.backgroundColor || '';
    if (bg === 'transparent' || bg === '') return true;
    var m = /rgba?\(([^)]+)\)/.exec(bg);
    if (!m) return false;
    var parts = m[1].split(/[\s,\/]+/);
    return parts.length < 4 ? true : parseFloat(parts[3]) < 0.2;
  }

  /*
   * Walk the wheel event's composedPath() innermost->outermost and return the
   * first element that qualifies as a zoom target (or null -> leave the event alone).
   * Order matters: a >=120px image wins over a background panel ancestor; a small
   * icon image is skipped and the walk continues outward (its parent may zoom).
   *
   * When the walk finds nothing and a pointer point was supplied, fall back to the
   * paint-order stack at that point, which still contains media underneath a
   * transparent overlay.
   */
  function resolveTarget(path, opts) {
    for (var i = 0; i < path.length; i++) {
      var hit = match(path[i], opts);
      if (hit) return hit;
    }
    if (!opts || !opts.point || !opts.doc || typeof opts.doc.elementsFromPoint !== 'function') return null;
    var stack = opts.doc.elementsFromPoint(opts.point.x, opts.point.y) || [];
    for (var j = 0; j < stack.length; j++) {
      var t = match(stack[j], opts);
      if (!t) continue;
      for (var k = 0; k < j; k++) if (!coverTransparent(stack[k])) return null;
      return t;
    }
    return null;
  }

  /*
   * Is this specific element under the pointer? Used while a session is live:
   * composedPath() may hold only the site's overlay, so fall back to the paint
   * stack. The cheap rect gate runs first so moving off the media stays cheap.
   */
  function under(el, x, y, doc) {
    if (!el || !doc) return false;
    var r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    if (typeof doc.elementsFromPoint !== 'function') return true;
    var stack = doc.elementsFromPoint(x, y) || [];
    var i = stack.indexOf(el);
    if (i < 0) return false;
    for (var j = 0; j < i; j++) if (!coverTransparent(stack[j])) return false;
    return true;
  }

  /* composedPath() relative to a node, crossing open shadow boundaries. */
  function pathFrom(e, node) {
    if (typeof e.composedPath === 'function') {
      var path = e.composedPath();
      for (var i = 0; i < path.length; i++) if (path[i] === node) return path;
      return null;
    }
    return node.contains ? (node === e.target || node.contains(e.target) ? [node] : null) : null;
  }

  Loupe.targets = {
    MIN_MEDIA: MIN_MEDIA,
    MIN_BG_W: MIN_BG_W,
    MIN_BG_H: MIN_BG_H,
    isMediaEl: isMediaEl,
    resourceReady: resourceReady,
    hasRealBg: hasRealBg,
    coverTransparent: coverTransparent,
    resolveTarget: resolveTarget,
    under: under,
    pathFrom: pathFrom
  };
})(globalThis);