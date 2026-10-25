/*
 * Zoom-area proof: the popup's "Zoom area" control has two real behaviours.
 *
 *   In frame   — the magnification is clipped to the media's own box, like a
 *                loupe resting on the page: neighbours and chrome never move.
 *   Whole page — the media grows past its frame toward the window edges. It is
 *                painted in the browser's top layer, so no page element (fixed
 *                headers, sticky bars, later siblings, dialogs) can cover it and
 *                no ancestor clip/stacking context can cut it. The page itself is
 *                left alone: the only change it sees is the media's opacity.
 *
 * Both are driven through the popup's own storage-backed control (the same
 * write the toolbar panel performs), never a test-only hook.
 */
import { test, expect } from '@playwright/test';
import { launch, startFixtureServer, extensionId, readTransform, settle, point } from './hooks.mjs';

let app;
let server;
let popup;

const p = () => app.page;

test.beforeAll(async () => {
  server = await startFixtureServer();
  app = await launch();
  const id = await extensionId(app.context);
  popup = await app.context.newPage();
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
});

test.afterAll(async () => {
  if (app) await app.close();
  if (server) await server.close();
});

async function setMode(mode) {
  await popup.evaluate((m) => new Promise((res) => window.Loupe.settings.set({ zoomMode: m }, res)), mode);
}

async function openFixture() {
  await p().goto(server.url('stress-site.html'));
  await p().waitForFunction(() => !!window.__loupeCounters);
}

const box = (sel) =>
  p().$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });

const visibility = (sel) => p().$eval(sel, (el) => getComputedStyle(el).visibility);
const opacity = (sel) => p().$eval(sel, (el) => getComputedStyle(el).opacity);
const inlineStyle = (sel) => p().$eval(sel, (el) => ({ len: el.style.length, css: el.style.cssText }));

function mediaAt(x, y) {
  return p().evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit ? hit.id || hit.tagName : 'none';
    },
    { x, y }
  );
}

/*
 * The whole-page zoom is a top-layer box: `:popover-open` is the browser's own
 * statement that it paints above every page element — the one assertion that
 * covers fixed bars, later siblings, transformed wrappers and dialogs at once.
 */
const stageState = () =>
  p().evaluate(() => {
    const stage = document.querySelector('[data-loupe-stage]');
    if (!stage) return null;
    const view = stage.firstElementChild;
    const r = view.getBoundingClientRect();
    const hud = document.querySelector('[data-loupe-hud]');
    const kids = Array.from(document.documentElement.children);
    return {
      open: stage.matches(':popover-open'),
      pointer: getComputedStyle(stage).pointerEvents,
      view: { x: r.left, y: r.top, w: r.width, h: r.height },
      hudAbove: !hud || kids.indexOf(hud) > kids.indexOf(stage),
      hudOpen: !hud || hud.matches(':popover-open')
    };
  });

const covers = (r, pt) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;

/* Bring the target on screen, then wheel up over its centre. */
async function wheelOver(sel, count = 2) {
  const target = p().locator(sel);
  await target.scrollIntoViewIfNeeded();
  const at = await point(p(), sel, 0.5, 0.5);
  await p().mouse.move(at.x, at.y);
  for (let i = 0; i < count; i++) {
    await p().mouse.wheel(0, -110);
    await p().waitForTimeout(35);
  }
  return at;
}

test('whole page: zooming a carousel slide never parks its neighbours beside it', async () => {
  await setMode('page');
  await openFixture();
  await p().locator('#slideImg').scrollIntoViewIfNeeded();

  const track = await box('#track');
  expect(Math.round(track.w), 'the clipping track is exactly one slide wide').toBe(420);

  await wheelOver('#slideImg', 2);
  const state = await settle(p(), '#slideImg');
  expect(state, 'a session opened on the slide').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.05);

  const stage = await stageState();
  expect(stage, 'the zoom is painted by a stand-in stage').not.toBeNull();
  expect(stage.open, 'the stage is in the top layer').toBe(true);
  expect(stage.pointer, 'the stage never takes a click or a wheel').toBe('none');
  expect(stage.hudAbove, 'the readout is raised above the stage').toBe(true);
  expect(stage.hudOpen, 'the readout is a top-layer box too').toBe(true);

  // The zoom genuinely reaches past the one-slide track...
  expect(stage.view.w, 'the zoom is wider than the track').toBeGreaterThan(track.w * 1.3);

  // ...and the page was not re-arranged to allow it: nothing un-clipped, no
  // neighbour hidden, no stacking lifted, no carousel chrome touched.
  expect(await inlineStyle('#track'), 'the track is never un-clipped').toEqual({ len: 0, css: '' });
  expect(await inlineStyle('#slide2'), 'neighbours are never hidden').toEqual({ len: 0, css: '' });
  expect(await inlineStyle('#next'), 'carousel chrome is untouched').toEqual({ len: 0, css: '' });
  expect(await visibility('#slide2'), 'the next slide keeps its own styles').toBe('visible');
  expect(await opacity('#slideImg'), 'the page copy is transparent; the stand-in is what you see').toBe('0');

  // The other slides stay clipped by their own track, so none of them appears
  // beside the zoom.
  expect(await mediaAt(track.x + track.w + 120, track.y + track.h / 2), 'no slide paints beside the zoom').not.toBe('slideImg2');

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#slideImg'), { timeout: 3000 }).toBeNull();
  expect(await p().evaluate(() => !!document.querySelector('[data-loupe-stage]')), 'the stage is removed').toBe(false);
  expect(await visibility('#slide2'), 'neighbours were never hidden').toBe('visible');
  expect(await inlineStyle('#slideImg'), 'the slide is exactly as it was').toEqual({ len: 0, css: '' });
  expect(await opacity('#slideImg'), 'the slide paints again').toBe('1');
});

test('whole page: no page chrome can cover the zoom (fixed bar, stacking trap, later overlay)', async () => {
  await setMode('page');
  await openFixture();

  // Park the media just under the fixed 44px bar so three of the reported
  // failures sit over it at once: a fixed bar (z-index 9999), a wrapper that
  // forms a stacking context with z-index:auto, and a later sibling painted
  // opaque white at z-index 6.
  await p().evaluate(() => {
    const img = document.getElementById('hostileImg');
    window.scrollBy(0, img.getBoundingClientRect().top - 14);
  });
  const img = await box('#hostileImg');
  const cover = await box('#coverCard');
  const barPoint = { x: Math.round(img.x + img.w / 2), y: 20 };
  const coverPoint = { x: Math.round(cover.x + 40), y: Math.round(cover.y + 20) };

  expect(await mediaAt(barPoint.x, barPoint.y), 'the fixed bar paints over the media').toBe('stickybar');
  expect(await mediaAt(coverPoint.x, coverPoint.y), 'a later sibling paints over the media').toBe('coverCard');

  const at = { x: img.x + img.w / 2, y: img.y + 120 }; // clear strip between bar and overlay
  await p().mouse.move(at.x, at.y);
  for (let i = 0; i < 3; i++) {
    await p().mouse.wheel(0, -110);
    await p().waitForTimeout(35);
  }
  const state = await settle(p(), '#hostileImg');
  expect(state.s, 'a session opened on the hostile media').toBeGreaterThan(1.4);

  const stage = await stageState();
  expect(stage.open, 'the zoom is a top-layer box: above every page element').toBe(true);
  expect(covers(stage.view, barPoint), "the zoom reaches into the fixed bar's strip").toBe(true);
  expect(covers(stage.view, coverPoint), 'and over the later sibling overlay').toBe(true);

  // Nothing was lifted or hidden to achieve this, and the page keeps its own
  // hit-testing: the chrome is still there, under the zoom, and still clickable.
  expect(await mediaAt(barPoint.x, barPoint.y), 'the bar still owns its pixels').toBe('stickybar');
  expect(await mediaAt(coverPoint.x, coverPoint.y)).toBe('coverCard');
  // Moving onto a part of the page that the zoom covers must not end the zoom:
  // the picture you can see is what holds the session, not the chrome under it.
  await p().mouse.move(coverPoint.x, coverPoint.y, { steps: 4 });
  await p().waitForTimeout(300);
  expect(await readTransform(p(), '#hostileImg'), 'the session survives moving over covered chrome').not.toBeNull();

  expect(await inlineStyle('#stickybar')).toEqual({ len: 0, css: '' });
  expect(await inlineStyle('#trapwrap'), 'the stacking wrapper is untouched').toEqual({ len: 0, css: '' });
  expect(await inlineStyle('#coverCard'), 'the overlay is untouched').toEqual({ len: 0, css: '' });
  expect(await opacity('#hostileImg'), 'the page copy is made transparent').toBe('0');

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#hostileImg'), { timeout: 3000 }).toBeNull();
  expect(await p().evaluate(() => !!document.querySelector('[data-loupe-stage]'))).toBe(false);
  expect(await inlineStyle('#hostileImg'), 'nothing is left on the media').toEqual({ len: 0, css: '' });
  expect(await opacity('#hostileImg')).toBe('1');
});

test('in frame: the photo is clipped to its slide and the carousel never moves', async () => {
  await setMode('frame');
  await openFixture();
  await p().locator('#slideImg').scrollIntoViewIfNeeded();

  const frame = await box('#slide1');
  const at = await p().$eval('#slideImg', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await p().mouse.move(at.x, at.y);
  for (let i = 0; i < 3; i++) {
    await p().mouse.wheel(0, -110);
    await p().waitForTimeout(35);
  }
  const state = await settle(p(), '#slideImg');
  expect(state, 'in-frame zoom still opens a session').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.2);
  await expect(p().locator('[data-loupe-hud]')).toHaveCount(1);
  expect(await p().evaluate(() => !!document.querySelector('[data-loupe-stage]')), 'no stand-in in this mode').toBe(false);

  // The transformed photo genuinely reaches past its frame...
  const live = await box('#slideImg');
  expect(live.w, 'the media is scaled beyond its frame').toBeGreaterThan(frame.w * 1.1);

  // ...but cannot paint one pixel outside it.
  const outside = { x: frame.x + frame.w + 60, y: frame.y + frame.h / 2 };
  expect(live.x + live.w, 'the escape point really is covered by the scaled media').toBeGreaterThan(outside.x);
  expect(await mediaAt(outside.x, outside.y), 'no paint outside the frame').not.toBe('slideImg');
  expect(await mediaAt(frame.x + frame.w / 2, frame.y + frame.h / 2), 'the zoom is painted inside the frame').toBe('slideImg');

  // Nothing was un-clipped, nothing was hidden, no stacking was touched.
  expect(await inlineStyle('#track'), 'the clipping track is untouched').toEqual({ len: 0, css: '' });
  expect(await visibility('#slide2'), 'the neighbour is never hidden in this mode').toBe('visible');

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#slideImg'), { timeout: 3000 }).toBeNull();
  expect(await inlineStyle('#slide1'), 'the frame clipping is removed again').toEqual({ len: 0, css: '' });
  expect(await inlineStyle('#slideImg'), 'media styles fully restored').toEqual({ len: 0, css: '' });
  expect(await visibility('#slide2')).toBe('visible');
});

test('in frame: a frame that does not clip gets clipping for the session only', async () => {
  await setMode('frame');
  await openFixture();
  await p().locator('#tightImg').scrollIntoViewIfNeeded();

  const frame = await box('#tightFrame');
  expect(await p().$eval('#tightFrame', (el) => getComputedStyle(el).overflow), 'this frame starts unclipped').toBe('visible');

  await wheelOver('#tightImg', 3);
  const state = await settle(p(), '#tightImg');
  expect(state.s).toBeGreaterThan(1.2);
  expect(await p().$eval('#tightFrame', (el) => getComputedStyle(el).overflow), 'the frame holds the zoom').toBe('hidden');

  const live = await box('#tightImg');
  expect(live.w).toBeGreaterThan(frame.w * 1.1);
  const outside = { x: frame.x + frame.w + 50, y: frame.y + frame.h / 2 };
  expect(live.x + live.w).toBeGreaterThan(outside.x);
  expect(await mediaAt(outside.x, outside.y), 'the zoom stops at the frame edge').not.toBe('tightImg');
  expect(await mediaAt(frame.x + frame.w / 2, frame.y + frame.h / 2)).toBe('tightImg');

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#tightImg'), { timeout: 3000 }).toBeNull();
  expect(await inlineStyle('#tightFrame'), 'the added clipping is gone').toEqual({ len: 0, css: '' });
  expect(await p().$eval('#tightFrame', (el) => getComputedStyle(el).overflow), 'frame clipping is back to the page default').toBe('visible');
});

test('the popup control persists the mode and follows a reset', async () => {
  await popup.evaluate(() => new Promise((res) => window.Loupe.settings.set(window.Loupe.settings.DEFAULTS, res)));
  await popup.reload();
  await expect(popup.locator('h1')).toHaveText('Loupe');

  await expect(popup.locator('[data-zoom-mode="page"]'), 'whole page is the default').toHaveAttribute('aria-checked', 'true');
  await expect(popup.locator('[data-zoom-mode="frame"]')).toHaveAttribute('aria-checked', 'false');

  await popup.locator('[data-zoom-mode="frame"]').click();
  await expect(popup.locator('[data-zoom-mode="frame"]')).toHaveAttribute('aria-checked', 'true');
  await expect(popup.locator('[data-zoom-mode="page"]')).toHaveAttribute('aria-checked', 'false');
  expect(await popup.evaluate(() => new Promise((res) => chrome.storage.sync.get('zoomMode', res)))).toEqual({ zoomMode: 'frame' });

  await popup.reload();
  await expect(popup.locator('[data-zoom-mode="frame"]'), 'the choice survives a reload').toHaveAttribute('aria-checked', 'true');

  await popup.locator('#reset').click();
  await expect(popup.locator('[data-zoom-mode="page"]'), 'reset returns to whole page').toHaveAttribute('aria-checked', 'true');
});

test('switching the mode mid-zoom ends the session and restores the page', async () => {
  await setMode('page');
  await openFixture();
  await wheelOver('#slideImg', 2);
  expect(await readTransform(p(), '#slideImg')).not.toBeNull();
  expect(await stageState()).not.toBeNull();
  expect(await opacity('#slideImg')).toBe('0');

  await setMode('frame'); // a real storage change; the content script reacts live

  await expect.poll(async () => readTransform(p(), '#slideImg'), { timeout: 3000 }).toBeNull();
  expect(await p().evaluate(() => !!document.querySelector('[data-loupe-stage]')), 'the stand-in is gone').toBe(false);
  expect(await opacity('#slideImg'), 'the page copy paints again').toBe('1');
  expect(await inlineStyle('#track')).toEqual({ len: 0, css: '' });
  await expect(p().locator('[data-loupe-hud]')).toHaveCount(0); // the pill fades out, then unmounts
});
