/*
 * Loupe — pure transform math.
 * No DOM access in this file: everything is unit-testable in Node (test/unit/math.test.mjs).
 *
 * Coordinate model
 * ----------------
 * Our inline transform is always:
 *     transform-origin: 0 0;   transform: translate3d(tx, ty, 0) scale(s)
 * so a media-local point p maps to viewport/screen coords q as:
 *     q = base + t + s * p
 * where `base` is the element's untransformed rect in viewport coords at the
 * moment the transform was created (base scrolls with the page).
 *
 * Cursor anchoring (the heart of the spec):
 *     p (under cursor)  = (c - base - t) / s
 *     t' (new translate)= c' - base - s' * p
 * This is the t' = c' - (s'/s)(c - t) form, with `base` folded in. Because the
 * caller re-derives base live from getBoundingClientRect() each wheel event
 * (see baseFromRect), page scroll between events self-corrects.
 */
(function (root) {
  'use strict';
  var Loupe = (root.Loupe = root.Loupe || {});

  var DEFAULT_RATE = 0.0032; // log-scale growth per wheel pixel (deltaY = 100 notch -> e^0.32 ≈ 1.38×)
  var LINE_HEIGHT = 16; // deltaMode 1 -> px (approximation)
  var PAGE_HEIGHT = 100; // deltaMode 2 -> px (approximation)

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* WheelEvent.deltaMode -> pixels. */
  function normalizeDelta(deltaY, deltaMode) {
    if (deltaMode === 1) return deltaY * LINE_HEIGHT;
    if (deltaMode === 2) return deltaY * PAGE_HEIGHT;
    return deltaY;
  }

  /*
   * Untransformed rect (viewport coords) derived from the LIVE bounding rect
   * minus our own translation. With `transform-origin: 0 0` and
   * `translate3d(...) scale(...)`, rect.left = base.x + tx regardless of scale,
   * so this is exact and drifts correctly with page scroll.
   */
  function baseFromRect(rect, tx, ty) {
    return {
      x: rect.left - tx,
      y: rect.top - ty,
      width: rect.width,
      height: rect.height
    };
  }

  /* Media-local point currently under viewport point c. */
  function pointUnderCursor(c, base, tx, ty, s) {
    return { x: (c.x - base.x - tx) / s, y: (c.y - base.y - ty) / s };
  }

  /* Translation that keeps local point p exactly under viewport point c at scale s. */
  function translateFor(c, base, s, p) {
    return { x: c.x - base.x - s * p.x, y: c.y - base.y - s * p.y };
  }

  /* Forward map: local point -> viewport coords (used by tests as the oracle). */
  function toViewport(p, base, tx, ty, s) {
    return { x: base.x + tx + s * p.x, y: base.y + ty + s * p.y };
  }

  /*
   * One zoom step. Anchor is taken from the CURRENTLY RENDERED state (tx, ty, s)
   * as read from the live rect, so the point under the cursor at this event
   * stays under it exactly after the step.
   *   dy < 0 (wheel up)  -> zoom in
   *   opts: { rate, sensitivity, maxScale }
   * Returns the new target state.
   */
  function zoomStep(c, base, tx, ty, s, dy, opts) {
    var rate = opts.rate != null ? opts.rate : DEFAULT_RATE;
    var k = rate * (opts.sensitivity != null ? opts.sensitivity : 1);
    var maxScale = opts.maxScale != null ? opts.maxScale : 6;
    var p = pointUnderCursor(c, base, tx, ty, s);
    var s2 = clamp(s * Math.exp(-k * dy), 1, maxScale);
    var t2 = translateFor(c, base, s2, p);
    return { s: s2, x: t2.x, y: t2.y, anchor: p };
  }

  /* Pan: pure translation delta (drag bypasses smoothing). */
  function pan(tx, ty, dx, dy) {
    return { x: tx + dx, y: ty + dy };
  }

  /*
   * Clamp an axis so the zoomed media keeps at least `margin` px of overlap with
   * the viewport: a mis-pan can never "lose" the image or park it fully offscreen.
   *   pos = viewport pos of the media's left/top edge (base + t along that axis)
   *   size = media size on screen (layout size * scale)
   *
   * One rule for every size: the image may hang off either edge, but `margin` px
   * of it always stays on screen. A two-branch rule ("small media stays fully
   * inside") used to yank the picture back to the middle on the first drag, when
   * the zoom anchor had legitimately parked a nearly-viewport-sized image with
   * its edge outside that band.
   */
  function clampAxis(pos, size, viewportSize, margin) {
    return clamp(pos, margin - size, viewportSize - margin);
  }

  /* Apply both axes to a translation given current base/scale. */
  function clampPan(base, s, tx, ty, viewport, margin) {
    var nx = clampAxis(base.x + tx, base.width * s, viewport.width, margin);
    var ny = clampAxis(base.y + ty, base.height * s, viewport.height, margin);
    return { x: nx - base.x, y: ny - base.y };
  }

  /* CSS value for the current state. */
  function cssTransform(tx, ty, s) {
    return 'translate3d(' + tx + 'px, ' + ty + 'px, 0) scale(' + s + ')';
  }

  Loupe.math = {
    DEFAULT_RATE: DEFAULT_RATE,
    clamp: clamp,
    normalizeDelta: normalizeDelta,
    baseFromRect: baseFromRect,
    pointUnderCursor: pointUnderCursor,
    translateFor: translateFor,
    toViewport: toViewport,
    zoomStep: zoomStep,
    pan: pan,
    clampAxis: clampAxis,
    clampPan: clampPan,
    cssTransform: cssTransform
  };
})(globalThis);