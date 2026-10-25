/*
 * Loupe popup + HUD end-to-end suite (real Chromium, extension loaded).
 *
 * The popup is opened as a normal tab at chrome-extension://<id>/popup/popup.html
 * so the DOM is inspectable; it runs in a real extension context, so every
 * control writes chrome.storage.sync exactly like it does from the toolbar.
 * The fixture tab is the one the engine acts on.
 */
import { test, expect } from '@playwright/test';
import {
  launch,
  startFixtureServer,
  extensionId,
  readTransform,
  settle,
  counters,
  point
} from './hooks.mjs';

let app;
let server;
let popup;
let popupUrl;

const fixture = () => app.page;

test.beforeAll(async () => {
  server = await startFixtureServer();
  app = await launch();
  const id = await extensionId(app.context);
  popupUrl = `chrome-extension://${id}/popup/popup.html`;
  popup = await app.context.newPage();
  await popup.goto(popupUrl);
});

test.afterAll(async () => {
  if (app) await app.close();
  if (server) await server.close();
});

/* Reset persisted settings through the extension's own storage API. */
async function resetSettings() {
  await popup.evaluate(() => new Promise((res) => window.Loupe.settings.set(window.Loupe.settings.DEFAULTS, res)));
}

async function stored(keys) {
  return popup.evaluate((k) => new Promise((res) => chrome.storage.sync.get(k, res)), keys);
}

async function openFixture() {
  await fixture().goto(server.url('stress-site.html'));
  await fixture().waitForFunction(() => !!window.__loupeCounters);
}

async function wheelOver(sel, notches = -110, count = 1) {
  const at = await point(fixture(), sel, 0.5, 0.5);
  await fixture().mouse.move(at.x, at.y);
  for (let i = 0; i < count; i++) {
    await fixture().mouse.wheel(0, notches);
    await fixture().waitForTimeout(35);
  }
  return at;
}

test.beforeEach(async () => {
  await resetSettings();
  await popup.reload();
  await expect(popup.locator('h1')).toHaveText('Loupe');
});

test('popup loads from the manifest with real, storage-backed controls only', async () => {
  expect(popupUrl).toContain('chrome-extension://');
  expect(await popup.title()).toBe('Loupe');

  const info = await popup.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('[data-setting]')).map((el) => ({
      name: el.dataset.setting,
      tag: el.tagName,
      type: el.type || null
    }));
    return {
      controls,
      activations: Array.from(document.querySelectorAll('[data-activation]')).map((b) => b.dataset.activation),
      keys: window.Loupe.settings.KEYS,
      siteToggle: !!document.querySelector('#siteToggle'),
      reset: !!document.querySelector('#reset'),
      preview: !!document.querySelector('#lens, #art, #readout, .caption'),
      holdRow: !!document.querySelector('#holdRow'),
      holdHidden: document.querySelector('#holdRow').hidden,
      holdLabel: document.querySelector('#holdPick').textContent.trim(),
      version: document.querySelector('#ver').textContent
    };
  });

  const names = info.controls.map((c) => c.name).sort();
  expect(names).toEqual(['bgImages', 'enabled', 'hud', 'maxScale', 'pauseVideo', 'sensitivity', 'smooth']);
  for (const c of info.controls) {
    expect(c.tag, `${c.name} is a real input`).toBe('INPUT');
    expect(['checkbox', 'range']).toContain(c.type);
  }
  // No control is decorative: every exposed key is a real settings key.
  expect(names.every((n) => info.keys.includes(n))).toBe(true);
  expect(info.activations.sort()).toEqual(['alt', 'hold', 'wheel']);
  expect(info.siteToggle).toBe(true);
  expect(info.reset).toBe(true);
  expect(info.preview, 'the panel carries no scrolling test area').toBe(false);
  expect(info.holdRow, 'the held-input row exists').toBe(true);
  expect(info.holdHidden, 'it is hidden until the custom mode is chosen').toBe(true);
  expect(info.holdLabel, 'Shift is the default held input').toBe('Shift');
  expect(info.keys, 'the held input is a real settings key').toContain('holdInput');
  expect(info.version).toMatch(/^v?0\.1\.0$/);
});

test('changes persist to storage and survive a popup reload', async () => {
  await popup.locator('#sensitivity').focus();
  for (let i = 0; i < 4; i++) await popup.keyboard.press('ArrowRight'); // 1.0 -> 1.2
  await expect(popup.locator('#sensitivityVal')).toHaveText('1.2×');
  expect((await stored('sensitivity')).sensitivity).toBeCloseTo(1.2, 5);

  await popup.reload();
  await expect(popup.locator('#sensitivityVal')).toHaveText('1.2×');
  await expect(popup.locator('#sensitivity')).toHaveValue('1.2');
});

test('max zoom from the popup clamps the engine, and the HUD reports it live', async () => {
  await popup.locator('#sensitivity').focus(); // avoid accidental arrow keys later
  await popup.locator('#maxScale').focus();
  for (let i = 0; i < 8; i++) await popup.keyboard.press('ArrowLeft'); // 6.0 -> 2.0
  await expect(popup.locator('#maxScaleVal')).toHaveText('2.0×');
  expect((await stored('maxScale')).maxScale).toBe(2);

  await openFixture();
  await wheelOver('#photo', -110, 8);
  const state = await settle(fixture(), '#photo');
  expect(state.s, 'engine respects the popup ceiling').toBeLessThanOrEqual(2.02);
  expect(state.s).toBeGreaterThan(1.9);

  const hud = fixture().locator('[data-loupe-hud]');
  await expect(hud).toHaveCount(1);
  const hudState = await fixture().$eval('[data-loupe-hud]', (el) => ({
    scale: Number(el.dataset.scale),
    pe: getComputedStyle(el).pointerEvents,
    z: getComputedStyle(el).zIndex
  }));
  expect(hudState.scale).toBeCloseTo(state.s, 1);
  expect(hudState.pe, 'HUD never intercepts pointer input').toBe('none');
  // ...and it is never painted under the picture it describes: the zoom lives in
  // the top layer, and the readout is raised into it afterwards, so it wins
  // outright rather than tying on a z-index ceiling.
  expect(hudState.z).toBe('2147483647');
  const layers = await fixture().evaluate(() => {
    const hud = document.querySelector('[data-loupe-hud]');
    const stage = document.querySelector('[data-loupe-stage]');
    const kids = Array.from(document.documentElement.children);
    return {
      last: document.documentElement.lastElementChild === hud,
      hudOpen: hud.matches(':popover-open'),
      stageOpen: stage.matches(':popover-open'),
      hudAboveStage: kids.indexOf(hud) > kids.indexOf(stage)
    };
  });
  expect(layers).toEqual({ last: true, hudOpen: true, stageOpen: true, hudAboveStage: true });

  // Live: another notch changes the readout, still pinned to the cursor area.
  await wheelOver('#photo', -60, 1);
  const after = await fixture().$eval('[data-loupe-hud]', (el) => Number(el.dataset.scale));
  expect(after).toBeGreaterThanOrEqual(1.9);

  await fixture().keyboard.press('Escape');
  await expect(fixture().locator('[data-loupe-hud]')).toHaveCount(0, { timeout: 3000 });
  await expect.poll(async () => readTransform(fixture(), '#photo'), { timeout: 3000 }).toBeNull();
});

test('the HUD control turns the readout off and back on', async () => {
  await popup.locator('#hud').click();
  expect((await stored('hud')).hud).toBe(false);

  await openFixture();
  await wheelOver('#photo', -110, 3);
  expect(await readTransform(fixture(), '#photo'), 'zoom still works without the HUD').not.toBeNull();
  expect(await fixture().locator('[data-loupe-hud]').count()).toBe(0);

  await fixture().keyboard.press('Escape');
  await popup.locator('#hud').click();
  await wheelOver('#photo', -110, 2);
  await expect(fixture().locator('[data-loupe-hud]')).toHaveCount(1);
});

test('the master switch stops the engine and lets the page scroll', async () => {
  await popup.locator('#master').click();
  expect((await stored('enabled')).enabled).toBe(false);

  await openFixture();
  const before = await counters(fixture());
  await wheelOver('#photo', -110, 3);
  expect(await readTransform(fixture(), '#photo')).toBeNull();
  expect((await counters(fixture())).pageWheel).toBeGreaterThan(before.pageWheel);
});

test('background art zooms when enabled and is left alone when disabled', async () => {
  await openFixture();
  await wheelOver('#bgpanel', -110, 2);
  const on = await settle(fixture(), '#bgpanel');
  expect(on, 'background-image surfaces zoom when the control is on').not.toBeNull();
  expect(on.s).toBeGreaterThan(1.05);
  await fixture().keyboard.press('Escape');
  await expect.poll(async () => readTransform(fixture(), '#bgpanel'), { timeout: 3000 }).toBeNull();

  await popup.locator('#bgImages').click();
  expect((await stored('bgImages')).bgImages).toBe(false);
  const before = await counters(fixture());
  await wheelOver('#bgpanel', -110, 2);
  expect(await readTransform(fixture(), '#bgpanel')).toBeNull();
  expect((await counters(fixture())).pageWheel).toBeGreaterThan(before.pageWheel);
});

test('smooth motion off applies the zoom in the event, not over frames', async () => {
  await popup.locator('#smooth').click();
  expect((await stored('smooth')).smooth).toBe(false);

  await openFixture();
  const at = await point(fixture(), '#photo', 0.5, 0.5);
  await fixture().mouse.move(at.x, at.y);
  await fixture().mouse.wheel(0, -110);
  // No settling wait: with smoothing off the target is applied synchronously.
  const immediate = await readTransform(fixture(), '#photo');
  expect(immediate).not.toBeNull();
  expect(immediate.s).toBeGreaterThan(1.2);
});

test('activation "Hold Alt" makes plain wheel scroll and Alt+wheel zoom', async () => {
  await popup.locator('[data-activation="alt"]').click();
  await expect(popup.locator('[data-activation="alt"]')).toHaveAttribute('aria-checked', 'true');
  expect((await stored('activation')).activation).toBe('alt');

  await openFixture();
  const before = await counters(fixture());
  await wheelOver('#photo', -110, 2);
  expect(await readTransform(fixture(), '#photo'), 'plain wheel must not zoom').toBeNull();
  expect((await counters(fixture())).pageWheel).toBeGreaterThan(before.pageWheel);

  await fixture().keyboard.down('Alt');
  await wheelOver('#photo', -110, 2);
  await fixture().keyboard.up('Alt');
  const zoomed = await settle(fixture(), '#photo');
  expect(zoomed, 'Alt+wheel zooms in this mode').not.toBeNull();
  expect(zoomed.s).toBeGreaterThan(1.05);
});

test('custom hold: pick a key, then hold it to zoom', async () => {
  await popup.locator('[data-activation="hold"]').click();
  await expect(popup.locator('[data-activation="hold"]')).toHaveAttribute('aria-checked', 'true');
  expect((await stored('activation')).activation).toBe('hold');
  await expect(popup.locator('#holdRow'), 'choosing the custom mode reveals the picker').toBeVisible();
  await expect(popup.locator('#holdPick')).toHaveText('Shift');

  // Click the chip, then press the key you want to hold.
  await popup.locator('#holdPick').click();
  await expect(popup.locator('#holdPick'), 'the chip waits for a press').toHaveText(/Press/);
  await popup.keyboard.press('g');
  await expect(popup.locator('#holdPick'), 'the chip names the chosen key').toHaveText('G');
  expect(await stored('holdInput')).toEqual({ holdInput: 'key:KeyG' });

  await openFixture();
  const before = await counters(fixture());
  await wheelOver('#photo', -110, 2);
  expect(await readTransform(fixture(), '#photo'), 'plain wheel must not zoom').toBeNull();
  expect((await counters(fixture())).pageWheel).toBeGreaterThan(before.pageWheel);

  await fixture().keyboard.down('g');
  await wheelOver('#photo', -110, 2);
  await fixture().keyboard.up('g');
  const zoomed = await settle(fixture(), '#photo');
  expect(zoomed, 'held key + wheel zooms').not.toBeNull();
  expect(zoomed.s).toBeGreaterThan(1.05);
});

test('custom hold: a mouse button can be the held input', async () => {
  await popup.locator('[data-activation="hold"]').click();
  await popup.locator('#holdPick').click();
  await expect(popup.locator('#holdPick')).toHaveText(/Press/);

  const chip = await popup.locator('#holdPick').boundingBox();
  await popup.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await popup.mouse.down({ button: 'middle' });
  await popup.mouse.up({ button: 'middle' });
  await expect(popup.locator('#holdPick'), 'the chip names the chosen button').toHaveText('Middle mouse');
  expect(await stored('holdInput')).toEqual({ holdInput: 'mouse:1' });

  await openFixture();
  const at = await point(fixture(), '#photo', 0.5, 0.5);
  await fixture().mouse.move(at.x, at.y);
  await fixture().mouse.down({ button: 'middle' });
  await fixture().mouse.wheel(0, -110);
  await fixture().mouse.wheel(0, -110);
  const zoomed = await settle(fixture(), '#photo');
  await fixture().mouse.up({ button: 'middle' });
  expect(zoomed, 'middle-held wheel zooms').not.toBeNull();
  expect(zoomed.s).toBeGreaterThan(1.05);
});

test('"Pause video while zoomed" freezes playback only when it is on', async () => {
  // Default (off): Loupe must not touch playback — the regression guard.
  await openFixture();
  const vid = fixture().locator('#vid');
  await fixture().waitForFunction(() => !document.getElementById('vid').paused);
  await fixture().locator('#vid').scrollIntoViewIfNeeded();
  await wheelOver('#vid', -110, 2);
  const live = await settle(fixture(), '#vid');
  expect(live, 'the video zooms with the control off').not.toBeNull();
  expect(await vid.evaluate((v) => v.paused), 'default leaves playback alone').toBe(false);
  await fixture().keyboard.press('Escape');
  await expect.poll(async () => readTransform(fixture(), '#vid'), { timeout: 3000 }).toBeNull();

  // On: the video freezes for the session and plays again when the zoom ends.
  await popup.locator('#pauseVideo').click();
  expect((await stored('pauseVideo')).pauseVideo, 'the choice is persisted').toBe(true);

  await openFixture();
  await fixture().waitForFunction(() => !document.getElementById('vid').paused);
  await fixture().locator('#vid').scrollIntoViewIfNeeded();
  await wheelOver('#vid', -110, 2);
  expect(await settle(fixture(), '#vid'), 'the video still zooms when paused').not.toBeNull();
  await expect.poll(() => vid.evaluate((v) => v.paused), { timeout: 2000 }).toBe(true);
  // The stand-in follows: what you see is frozen, not live frames.
  expect(
    await fixture().evaluate(() => {
      const v = document.querySelector('[data-loupe-stage] video');
      return v ? v.paused : null;
    }),
    'the zoomed copy is frozen too'
  ).not.toBe(false);
  await fixture().keyboard.press('Escape');
  await expect.poll(async () => readTransform(fixture(), '#vid'), { timeout: 3000 }).toBeNull();
  await expect.poll(() => vid.evaluate((v) => v.paused), { timeout: 3000 }).toBe(false);

  // Live: flipping the switch mid-zoom applies immediately, both ways.
  await fixture().locator('#vid').scrollIntoViewIfNeeded();
  await wheelOver('#vid', -110, 2);
  await settle(fixture(), '#vid');
  await popup.locator('#pauseVideo').click();
  expect((await stored('pauseVideo')).pauseVideo).toBe(false);
  await expect.poll(() => vid.evaluate((v) => v.paused), { timeout: 2000 }).toBe(false);
  await popup.locator('#pauseVideo').click();
  await expect.poll(() => vid.evaluate((v) => v.paused), { timeout: 2000 }).toBe(true);
  await fixture().keyboard.press('Escape');
  await expect.poll(() => vid.evaluate((v) => v.paused), { timeout: 3000 }).toBe(false);
});

test('pausing applies to a streaming (MediaSource) video without losing the page zoom', async () => {
  // The risky combination: freeze the source while the stand-in is carried by a
  // capture stream. The top-layer copy must still paint, not demote to in-frame.
  await popup.locator('#pauseVideo').click();
  expect((await stored('pauseVideo')).pauseVideo).toBe(true);

  await openFixture();
  await fixture().waitForFunction(() => window.__mseReady === true, null, { timeout: 20000 });
  const vid = fixture().locator('#mseVid');
  await vid.scrollIntoViewIfNeeded();
  await expect.poll(() => vid.evaluate((v) => v.videoWidth), { timeout: 5000 }).toBeGreaterThan(0);
  await wheelOver('#mseVid', -110, 2);
  const state = await settle(fixture(), '#mseVid');
  expect(state, 'the streaming video zooms').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.05);

  await expect.poll(() => vid.evaluate((v) => v.paused), { timeout: 2000 }).toBe(true);
  const shown = await fixture().evaluate(() => {
    const stage = document.querySelector('[data-loupe-stage]');
    if (!stage) return { stage: false };
    const v = stage.querySelector('video');
    const k = document.createElement('canvas');
    k.width = 40;
    k.height = 30;
    const kx = k.getContext('2d');
    let lum = null;
    try {
      kx.drawImage(v, 0, 0, 40, 30);
      const d = kx.getImageData(0, 0, 40, 30).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      lum = Math.round(sum / (d.length / 4) / 3);
    } catch (e) {
      lum = 'throw:' + e.name;
    }
    return { stage: true, paused: v.paused, videoWidth: v.videoWidth, lum };
  });
  expect(shown.stage, 'the page-mode stand-in is still in charge').toBe(true);
  expect(shown.lum, `frozen but painted: ${JSON.stringify(shown)}`).toBeGreaterThan(8);
  expect(shown.paused, 'the frozen copy does not keep playing').not.toBe(false);

  await fixture().keyboard.press('Escape');
  await expect.poll(async () => readTransform(fixture(), '#mseVid'), { timeout: 3000 }).toBeNull();
  await expect.poll(() => vid.evaluate((v) => v.paused), { timeout: 3000 }).toBe(false);
});

test('the site switch governs the current origin live', async () => {
  await openFixture();
  await fixture().bringToFront();
  await popup.reload();
  await expect(popup.locator('#siteHost')).toHaveText('127.0.0.1', { timeout: 8000 });

  await popup.evaluate(() => document.querySelector('#siteToggle').click());
  await expect
    .poll(async () => (await stored('disabledSites')).disabledSites)
    .toContain('127.0.0.1');

  await wheelOver('#photo', -110, 2);
  expect(await readTransform(fixture(), '#photo'), 'disabled site must not zoom').toBeNull();

  await popup.evaluate(() => document.querySelector('#siteToggle').click());
  await expect
    .poll(async () => (await stored('disabledSites')).disabledSites)
    .not.toContain('127.0.0.1');

  await wheelOver('#photo', -110, 2);
  expect(await readTransform(fixture(), '#photo'), 're-enabled site zooms again').not.toBeNull();
});