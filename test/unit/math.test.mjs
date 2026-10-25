import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load the browser script as-is (IIFE, assigns onto globalThis.Loupe).
const src = readFileSync(new URL('../../content/10-math.js', import.meta.url), 'utf8');
(0, eval)(src);
const M = globalThis.Loupe.math;

const EPS = 1e-9;
const O = { rate: 0.0032, sensitivity: 1, maxScale: 6 };

test('normalizeDelta: deltaMode 0/1/2 -> px', () => {
  assert.equal(M.normalizeDelta(-100, 0), -100);
  assert.equal(M.normalizeDelta(-3, 1), -48);
  assert.equal(M.normalizeDelta(-2, 2), -200);
});

test('baseFromRect: untransformed base = live rect minus our translation', () => {
  const rect = { left: 310, top: 140, width: 400, height: 300 };
  const b = M.baseFromRect(rect, 10, -20);
  assert.equal(b.x, 300);
  assert.equal(b.y, 160);
  assert.equal(b.width, 400);
  assert.equal(b.height, 300);
});

test('pointUnderCursor and toViewport are exact inverses', () => {
  const base = { x: 40, y: 60 };
  const p = M.pointUnderCursor({ x: 500, y: 300 }, base, 12, -8, 2.5);
  const q = M.toViewport(p, base, 12, -8, 2.5);
  assert.ok(Math.abs(q.x - 500) < EPS);
  assert.ok(Math.abs(q.y - 300) < EPS);
});

test('zoomStep anchors: pixel under the live (possibly moved) cursor stays under it', () => {
  const base = { x: 200, y: 90 };
  let st = { s: 1, x: 0, y: 0 };
  let cursor = { x: 400, y: 300 };

  // wheel deltas are negative = zoom in; the cursor moves between events
  const steps = [
    { mx: 0,   my: 0,    wheel: -120 },
    { mx: 60,  my: -40,  wheel: -40 },  // cursor moved since last event
    { mx: -80, my: -25,  wheel: -25 },
    { mx: 15,  my: 80,   wheel: 80 },   // zooming out while moving
    { mx: -200,my: -150, wheel: -300 }
  ];

  for (const ev of steps) {
    cursor = { x: cursor.x + ev.mx, y: cursor.y + ev.my }; // cursor moves as the user wheels
    // The media-local point currently under the LIVE cursor (pre-step transform):
    const p = M.pointUnderCursor(cursor, base, st.x, st.y, st.s);
    st = M.zoomStep(cursor, base, st.x, st.y, st.s, ev.wheel, O);

    // (1) zoomStep anchors on that exact live point:
    assert.ok(Math.abs(st.anchor.x - p.x) < EPS && Math.abs(st.anchor.y - p.y) < EPS,
      'anchor = point under the live cursor');
    // (2) the spec formula t' = c' - base - s'p holds for both axes:
    assert.ok(Math.abs(st.x - (cursor.x - base.x - st.s * p.x)) < EPS,
      't.x follows c\' - base - s\'p');
    assert.ok(Math.abs(st.y - (cursor.y - base.y - st.s * p.y)) < EPS,
      't.y follows c\' - base - s\'p');
    // (3) therefore that media point renders exactly at the cursor afterwards:
    const q = M.toViewport(p, base, st.x, st.y, st.s);
    assert.ok(Math.abs(q.x - cursor.x) < 1e-6 && Math.abs(q.y - cursor.y) < 1e-6,
      'point maps back onto the (moved) cursor');
  }
  assert.ok(st.s >= 1 && st.s <= O.maxScale, 'scale stays clamped');
});

test('zoomStep: stationary cursor -> pixel under cursor maps back onto it', () => {
  const base = { x: -120.5, y: 33 };
  const cursor = { x: 610.25, y: 480.5 };
  let st = { s: 1.4, x: 17, y: -22 };
  const p = M.pointUnderCursor(cursor, base, st.x, st.y, st.s);
  st = M.zoomStep(cursor, base, st.x, st.y, st.s, -95, O);
  const q = M.toViewport(p, base, st.x, st.y, st.s);
  assert.ok(Math.abs(q.x - cursor.x) < 1e-6);
  assert.ok(Math.abs(q.y - cursor.y) < 1e-6);
});

test('zoomStep: wheel up zooms in, wheel down zooms out, clamps at [1, maxScale]', () => {
  const base = { x: 0, y: 0 };
  const c = { x: 100, y: 100 };

  const in1 = M.zoomStep(c, base, 0, 0, 1, -100, O);
  assert.ok(in1.s > 1, 'wheel up zooms in');

  const out1 = M.zoomStep(c, base, 0, 0, in1.s, 100, O);
  assert.ok(out1.s < in1.s, 'wheel down zooms out');

  // Massive wheel-down -> never below 1x
  let st = { s: 2, x: 0, y: 0 };
  for (let i = 0; i < 50; i++) {
    st = M.zoomStep(c, base, st.x, st.y, st.s, 1000, O);
    assert.ok(st.s >= 1);
  }
  assert.equal(st.s, 1);

  // Massive wheel-up -> never above maxScale; finite (no exp overflow)
  st = { s: 1, x: 0, y: 0 };
  for (let i = 0; i < 50; i++) {
    st = M.zoomStep(c, base, st.x, st.y, st.s, -1e6, O);
  }
  assert.equal(st.s, 6);
  assert.ok(Number.isFinite(st.x) && Number.isFinite(st.y));
});

test('sensitivity and rate scale the growth rate', () => {
  const base = { x: 0, y: 0 };
  const c = { x: 10, y: 10 };
  const a = M.zoomStep(c, base, 0, 0, 1, -100, O).s;
  const b = M.zoomStep(c, base, 0, 0, 1, -100, { ...O, sensitivity: 2 }).s;
  const d = M.zoomStep(c, base, 0, 0, 1, -100, { ...O, rate: O.rate * 0.5 }).s;
  assert.ok(b > a);
  assert.ok(Math.abs(d - Math.sqrt(a)) < 1e-12, 'half rate => sqrt of growth factor');
});

test('pan translates exactly by the drag delta', () => {
  const t = M.pan(10, -5, 7, 13);
  assert.deepEqual(t, { x: 17, y: 8 });
});

test('clampAxis: media larger than viewport keeps margin px visible', () => {
  // size 1000, viewport 800, margin 80 -> pos in [80-1000, 800-80] = [-920, 720]
  assert.equal(M.clampAxis(-9999, 1000, 800, 80), -920);
  assert.equal(M.clampAxis(9999, 1000, 800, 80), 720);
  assert.equal(M.clampAxis(40, 1000, 800, 80), 40);
});

test('clampAxis: a media that fits can still hang off, never losing margin px', () => {
  // size 300, viewport 800, margin 80 -> pos in [80-300, 800-80] = [-220, 720]
  assert.equal(M.clampAxis(-5000, 300, 800, 80), -220);
  assert.equal(M.clampAxis(900, 300, 800, 80), 720);
  // A position the zoom anchor produced is legal and is never yanked back.
  assert.equal(M.clampAxis(-120, 300, 800, 80), -120);
  assert.equal(M.clampAxis(200, 300, 800, 80), 200);
});

test('clampPan: viewport overlap guarantee holds after any wild pan', () => {
  const base = { x: 100, y: 60, width: 500, height: 400 };
  const vp = { width: 1280, height: 800 };
  const MARGIN = 80;
  const wild = [
    { x: -99999, y: -99999 },
    { x: 99999, y: 99999 },
    { x: 0, y: 0 },
    { x: -700, y: -50 },
    { x: 123.4, y: -654.3 }
  ];
  for (const t of wild) {
    const c = M.clampPan(base, 3, t.x, t.y, vp, MARGIN);
    const left = base.x + c.x;
    const top = base.y + c.y;
    const w = base.width * 3;
    const h = base.height * 3;
    // At least MARGIN px of the media intersects the viewport on each axis.
    const visibleW = Math.min(left + w, vp.width) - Math.max(left, 0);
    const visibleH = Math.min(top + h, vp.height) - Math.max(top, 0);
    assert.ok(visibleW >= MARGIN - EPS, `visible width ${visibleW} >= ${MARGIN}`);
    assert.ok(visibleH >= MARGIN - EPS, `visible height ${visibleH} >= ${MARGIN}`);
  }
});

test('clampPan: small zoomed media never loses more than margin px', () => {
  const base = { x: 0, y: 0, width: 100, height: 80 };
  const vp = { width: 800, height: 600 };
  const c = M.clampPan(base, 2, -500, -500, vp, 80);
  assert.equal(base.x + c.x, 80 - 200);
  assert.equal(base.y + c.y, 80 - 160);
  const d = M.clampPan(base, 2, 9999, 9999, vp, 80);
  assert.equal(base.x + d.x, 800 - 80);
  assert.equal(base.y + d.y, 600 - 80);
});

test('cssTransform: exact production string format', () => {
  assert.equal(M.cssTransform(1.5, -2, 2), 'translate3d(1.5px, -2px, 0) scale(2)');
  assert.equal(M.cssTransform(0, 0, 1), 'translate3d(0px, 0px, 0) scale(1)');
});

test('property: 400 randomized zoom+cursor sequences keep 1e-9 anchor fidelity', () => {
  let seed = 42;
  const rnd = () => {
    // xorshift32 — deterministic
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  const base = { x: rnd() * 500, y: rnd() * 500 };

  for (let run = 0; run < 400; run++) {
    let st = { s: 1 + Math.abs(rnd()) * 5, x: rnd() * 300, y: rnd() * 300 };
    let c = { x: rnd() * 1400, y: rnd() * 900 };
    const dy = rnd() * 400; // mixed in/out

    const p = M.pointUnderCursor(c, base, st.x, st.y, st.s);
    const st2 = M.zoomStep(c, base, st.x, st.y, st.s, dy, O);

    // t' = c' - base - s'p  (the spec formula) must hold exactly:
    assert.ok(Math.abs(st2.x - (c.x - base.x - st2.s * p.x)) < EPS);
    assert.ok(Math.abs(st2.y - (c.y - base.y - st2.s * p.y)) < EPS);
    // and the point maps back onto the cursor
    const q = M.toViewport(p, base, st2.x, st2.y, st2.s);
    assert.ok(Math.abs(q.x - c.x) < 1e-6 && Math.abs(q.y - c.y) < 1e-6);
    assert.ok(st2.s >= 1 && st2.s <= O.maxScale);
  }
});