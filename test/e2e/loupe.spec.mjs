/*
 * Loupe end-to-end suite — real Chromium, extension loaded, real input events.
 * Covers exactly what the plan's verification pass promises:
 *   1. wheel-up zoom anchored at the cursor, incl. a cursor moved between notches
 *   2. wheel claiming: page-wheel counter frozen while zooming, climbing over small icons
 *   3. wheel-down release at exactly 1.0x, then scroll returns immediately
 *   4. clip-escape from the overflow:hidden card (+ restore)
 *   5. drag-pan 1:1 with trailing-click suppression (plain clicks still fire)
 *   6. exits (Esc / dblclick / cursor-leave) restore styles byte-clean
 *   7. size-guard negatives: icons and small images never claim the wheel
 *   8. regression: re-entering during an exit animation must continue the zoom
 *
 * Assertions read the ELEMENT's inline transform (page-visible behavior) rather
 * than content-script internals — isolated worlds aren't reachable from the page.
 */
import { test, expect } from '@playwright/test';
import {
  launch,
  startFixtureServer,
  readTransform,
  settle,
  styleState,
  counters,
  point,
  baseRect,
  zoomIn
} from './hooks.mjs';

let ctx;
let server;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ctx = await launch();
});

test.afterAll(async () => {
  if (ctx) await ctx.close();
  if (server) await server.close();
});

test.beforeEach(async () => {
  await ctx.page.goto(server.url('stress-site.html'));
  await ctx.page.waitForFunction(() => !!window.__loupeCounters);
  const stray = await readTransform(ctx.page, '#photo');
  expect(stray, 'fresh page must start with no zoom session').toBeNull();
});

const page = () => ctx.page;

/* Local helper: forward-map a media point into the viewport under a sampled state. */
const project = (base, st, p) => ({ x: base.x + st.x + st.s * p.x, y: base.y + st.y + st.s * p.y });

test('wheel-up zooms anchored at the cursor; anchor follows a moved cursor', async () => {
  const p = page();
  const base = await baseRect(p, '#photo');

  // ---- notch 1 at point A (cursor has NOT moved since hover) ----
  const A = await point(p, '#photo', 0.3, 0.35);
  const pA = { x: A.x - base.x, y: A.y - base.y }; // identity transform: p = c - base
  await p.mouse.move(A.x, A.y);
  await p.mouse.wheel(0, -110);
  const s1 = await settle(p, '#photo');

  expect(s1, 'wheel-up must create a zoom session').not.toBeNull();
  expect(s1.s).toBeGreaterThan(1.05); // zoomed in
  const qA = project(base, s1, pA);
  expect(Math.abs(qA.x - A.x), `x anchor drift ${qA.x - A.x}`).toBeLessThan(2);
  expect(Math.abs(qA.y - A.y), `y anchor drift ${qA.y - A.y}`).toBeLessThan(2);

  // ---- cursor MOVES across the image, then another notch ----
  const B = await point(p, '#photo', 0.78, 0.72);
  await p.mouse.move(B.x, B.y);
  const pB = { x: (B.x - base.x - s1.x) / s1.s, y: (B.y - base.y - s1.y) / s1.s };
  await p.mouse.wheel(0, -110);
  const s2 = await settle(p, '#photo');

  expect(s2.s, 'second notch zooms further').toBeGreaterThan(s1.s);
  const qB = project(base, s2, pB);
  expect(Math.abs(qB.x - B.x), `moved-cursor anchor drift x ${qB.x - B.x}`).toBeLessThan(2);
  expect(Math.abs(qB.y - B.y), `moved-cursor anchor drift y ${qB.y - B.y}`).toBeLessThan(2);
});

test('claims wheel while zooming: page-wheel counter frozen, page never scrolls', async () => {
  const p = page();
  await zoomIn(p, '#photo', 3);
  const before = await counters(p);
  const scrollBefore = await p.evaluate(() => window.scrollY);

  for (let i = 0; i < 6; i++) {
    await p.mouse.wheel(0, -60); // all claimed
    await p.waitForTimeout(30);
  }
  const after = await counters(p);
  expect(after.pageWheel, 'page-level wheel listener must not fire while zooming').toBe(before.pageWheel);
  expect(await p.evaluate(() => window.scrollY)).toBe(scrollBefore);
  expect(await readTransform(p, '#photo'), 'still zoomed').not.toBeNull();
});

test('wheel-down release at exactly 1.0x, then ordinary scrolling returns immediately', async () => {
  const p = page();
  await zoomIn(p, '#photo', 4);
  const b0 = (await counters(p)).pageWheel;

  // Wheel down — every event is claimed while the session lives.
  let claimed = 0;
  for (let i = 0; i < 40; i++) {
    if ((await readTransform(p, '#photo')) === null) break;
    await p.mouse.wheel(0, 90);
    claimed++;
    await p.waitForTimeout(35);
  }
  expect(claimed, 'zoomed out over multiple notches').toBeGreaterThan(0);

  const cleared = await styleState(p, '#photo');
  expect(await readTransform(p, '#photo'), 'session ended at 1.0').toBeNull();
  expect(cleared.count, 'all inline styles restored').toBe(0);

  // Claiming stopped the instant scale hit 1.0: no further interception...
  const afterLoop = await counters(p);
  expect(afterLoop.pageWheel, 'no sticky claim after release').toBe(b0);

  // ...so the very next wheel reaches the page untouched.
  await p.mouse.wheel(0, 120);
  expect((await counters(p)).pageWheel).toBe(b0 + 1);
  // Scrolling is committed by the compositor a frame or two after the event.
  await expect
    .poll(async () => p.evaluate(() => window.scrollY), { timeout: 2000 })
    .toBeGreaterThan(0);
});

test('clip-escape: the zoom escapes the overflow:hidden card without touching the page', async () => {
  const p = page();
  await zoomIn(p, '#photo', 3);

  const during = await p.evaluate(() => {
    const card = document.querySelector('.card');
    const stage = document.querySelector('[data-loupe-stage]');
    const view = stage && stage.firstElementChild;
    const c = card.getBoundingClientRect();
    const r = view.getBoundingClientRect();
    return {
      topLayer: !!(stage && stage.matches(':popover-open')),
      overflowX: getComputedStyle(card).overflowX,
      overflowY: getComputedStyle(card).overflowY,
      cardInline: card.style.length,
      photoOpacity: getComputedStyle(document.querySelector('#photo')).opacity,
      escapeRight: r.right - c.right,
      escapeLeft: c.left - r.left,
      escapeTop: c.top - r.top
    };
  });
  // A top-layer box is painted above the page and outside every ancestor clip, so
  // the card is left exactly as the site wrote it.
  expect(during.topLayer, 'the zoom is a top-layer box').toBe(true);
  expect(during.overflowX, 'the card keeps its own clipping').toBe('hidden');
  expect(during.overflowY).toBe('hidden');
  expect(during.cardInline, 'the card is never modified').toBe(0);
  expect(during.photoOpacity, 'the page copy is transparent while the stand-in shows').toBe('0');
  const escape = Math.max(during.escapeRight, during.escapeLeft, during.escapeTop);
  expect(escape, `zoomed image must exceed the card box by >100px (got ${escape})`).toBeGreaterThan(100);

  await p.keyboard.press('Escape');
  await expect.poll(async () => (await readTransform(p, '#photo')), { timeout: 3000 }).toBeNull();

  const after = await p.evaluate(() => {
    const card = document.querySelector('.card');
    const photo = document.querySelector('#photo');
    return {
      x: getComputedStyle(card).overflowX,
      len: card.style.length,
      stage: !!document.querySelector('[data-loupe-stage]'),
      photoLen: photo.style.length,
      photoOpacity: getComputedStyle(photo).opacity,
      marked: photo.hasAttribute('data-loupe-zoomed')
    };
  });
  expect(after.x, 'card overflow is the stylesheet value throughout').toBe('hidden');
  expect(after.len, 'no residual inline styles on the card').toBe(0);
  expect(after.stage, 'the stand-in is removed').toBe(false);
  expect(after.photoLen, 'the media keeps no inline styles').toBe(0);
  expect(after.photoOpacity, 'the media paints again').toBe('1');
  expect(after.marked).toBe(false);
});

test('drag-pan moves the media 1:1 and the trailing click is swallowed', async () => {
  const p = page();
  await zoomIn(p, '#photo', 3);
  const at = await point(p, '#photo', 0.5, 0.5);
  await p.mouse.move(at.x, at.y);
  const clicksBefore = (await counters(p)).clicks;
  const pre = await readTransform(p, '#photo');

  await p.mouse.down();
  await p.mouse.move(at.x + 70, at.y + 45, { steps: 5 });
  await p.mouse.up();
  await p.waitForTimeout(80); // rAF applies state; a settle() also works but follows smoothed frames

  const post = await settle(p, '#photo');
  const dx = post.x - pre.x;
  const dy = post.y - pre.y;
  expect(Math.abs(dx - 70), `pan dx ${dx}`).toBeLessThan(3);
  expect(Math.abs(dy - 45), `pan dy ${dy}`).toBeLessThan(3);

  // The click belonging to the pan gesture (down…up) dies on our document
  // capture listener — you never open the post just by dragging.
  await p.waitForTimeout(150);
  expect((await counters(p)).clicks, 'the pan gesture\u2019s own trailing click is swallowed').toBe(clicksBefore);

  // A later, independent click is ordinary interaction and still reaches the page.
  await p.mouse.click(at.x + 10, at.y + 10);
  await p.waitForTimeout(60);
  expect((await counters(p)).clicks, 'ordinary clicks still work').toBe(clicksBefore + 1);
});

for (const [name, exit] of [
  ['Esc', async (p, pt) => p.keyboard.press('Escape')],
  ['double-click', async (p, pt) => p.mouse.dblclick(pt.x, pt.y)],
  ['cursor leaves the media', async (p, pt) => p.mouse.move(24, p.viewportSize().height - 40)]
]) {
  test(`exit via ${name} restores styles cleanly`, async () => {
    const p = page();
    await zoomIn(p, '#photo', 3);
    expect(await readTransform(p, '#photo')).not.toBeNull();

    const pt = await point(p, '#photo', 0.5, 0.5);
    await p.mouse.move(pt.x, pt.y);
    await exit(p, pt);

    await expect
      .poll(async () => (await readTransform(p, '#photo')), { timeout: 4000 })
      .toBeNull();

    const photo = await styleState(p, '#photo');
    const card = await styleState(p, '.card');
    expect(photo.count, 'photo inline style fully restored').toBe(0);
    expect(photo.attr === null || photo.attr === '', 'photo style attribute clean').toBe(true);
    expect(card.count, 'card untouched/restored').toBe(0);

    const overflow = await p.evaluate(() => getComputedStyle(document.querySelector('.card')).overflowX);
    expect(overflow).toBe('hidden');
  });
}

test('size-guard negatives: wheel over small chrome never zooms and always scrolls', async () => {
  const p = page();

  for (const sel of ['.icon', 'img[width="64"]']) {
    const pt = await point(p, sel, 0.5, 0.5);
    const before = (await counters(p)).pageWheel;
    const scrollBefore = await p.evaluate(() => window.scrollY);
    await p.mouse.move(pt.x, pt.y);
    for (let i = 0; i < 3; i++) {
      await p.mouse.wheel(0, -100);
      await p.waitForTimeout(25);
    }
    const after = (await counters(p)).pageWheel;
    expect(after - before, `${sel} must pass the wheel through`).toBe(3);
    expect(await p.evaluate(() => window.scrollY), `${sel} wheel must scroll the page`).toBeGreaterThanOrEqual(scrollBefore);
    expect(await readTransform(p, sel), `${sel} must not be zoomed`).toBeNull();
  }

  // Negative scope: nothing anywhere in the document picked up a zoom transform.
  const anyZoomed = await p.evaluate(() =>
    Array.from(document.querySelectorAll('*')).some((el) => el.style.transform && el.style.transform !== 'none')
  );
  expect(anyZoomed, 'no element should hold an inline transform').toBe(false);
});

test('regression: re-entering during the exit animation continues the zoom, not reset', async () => {
  const p = page();
  const before = await zoomIn(p, '#photo', 2);
  expect(before.s).toBeGreaterThan(1.2);

  // A point inside the window but off the drawn picture. Whole-page zoom exits
  // when the pointer leaves the picture you can see, not the page footprint it
  // started from (after a pan those are not the same rectangle).
  const spot = await p.evaluate(() => {
    const view = document.querySelector('[data-loupe-stage]').firstElementChild;
    const r = view.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const below = Math.round(r.bottom) + 24;
    const above = Math.round(r.top) - 24;
    if (below < window.innerHeight - 4) return { x: cx, y: below, cx, cy };
    if (above > 4) return { x: cx, y: above, cx, cy };
    return null;
  });
  expect(spot, 'the zoom leaves room to move the pointer off it').not.toBeNull();

  await p.mouse.move(spot.x, spot.y, { steps: 3 }); // begins the animated exit
  await p.waitForTimeout(70); // exit in flight, not settled
  await p.mouse.move(spot.cx, spot.cy, { steps: 2 }); // back onto the picture
  await p.mouse.wheel(0, -90); // re-claim mid-exit

  const after = await settle(p, '#photo', 6000);
  expect(after, 'scrolling again during exit must revive the session, not reset it').not.toBeNull();
  expect(after.s, 'zoom progressed').toBeGreaterThan(1.2);
});