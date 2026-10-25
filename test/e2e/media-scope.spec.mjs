/*
 * Media-scope proof: the plan claims images, video, canvas, CSS background art,
 * open shadow roots and iframes all zoom. Background art is already covered by
 * the popup control test; this file proves the rest in extension-loaded
 * Chromium. Whole-page zoom paints a top-layer stand-in (so page chrome and
 * clips cannot interfere) while in-frame zoom transforms the live element; both
 * must leave the page's own media exactly as it was.
 */
import { test, expect } from '@playwright/test';
import { launch, startFixtureServer, readTransform, settle, styleState, counters } from './hooks.mjs';

let app;
let server;

const p = () => app.page;

test.beforeAll(async () => {
  server = await startFixtureServer();
  app = await launch();
});

test.afterAll(async () => {
  if (app) await app.close();
  if (server) await server.close();
});

test.beforeEach(async () => {
  await p().goto(server.url('stress-site.html'));
  await p().waitForFunction(() => !!window.__loupeCounters);
});

/* Scroll a target into view, park the pointer on its centre, and wheel. */
async function wheelOver(locator, notches = -110, count = 1) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('target has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await p().mouse.move(x, y);
  for (let i = 0; i < count; i++) {
    await p().mouse.wheel(0, notches);
    await p().waitForTimeout(35);
  }
  return { x, y };
}

function parseScale(raw) {
  const m = raw.match(/scale\(([-\d.e+]+)\)/);
  return m ? parseFloat(m[1]) : null;
}

test('video: the live <video> element zooms in place, then restores cleanly', async () => {
  const vid = p().locator('#vid');
  const media = await vid.evaluate((v) => ({
    videoWidth: v.videoWidth,
    hasStream: !!v.srcObject,
    tag: v.tagName
  }));
  expect(media.tag).toBe('VIDEO');
  expect(media.videoWidth, 'fixture video is genuinely decoding frames').toBeGreaterThan(0);
  expect(media.hasStream).toBe(true);

  await wheelOver(vid);
  const state = await settle(p(), '#vid');
  expect(state, 'a zoom session opened on the video').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.05);
  await expect(p().locator('[data-loupe-hud]')).toHaveCount(1);

  // The zoom is painted by a stand-in <video> in the top layer. A MediaStream has
  // no URL to re-request, so the same live stream is carried over.
  const shown = await p().evaluate(() => {
    const v = document.querySelector('[data-loupe-stage] video');
    if (!v) return null;
    return { transform: v.style.getPropertyValue('transform'), stream: !!v.srcObject, w: v.getBoundingClientRect().width };
  });
  expect(shown, 'the stand-in is a <video> of its own').not.toBeNull();
  expect(shown.transform, 'the stand-in carries the zoom').toContain('scale');
  expect(shown.stream, 'the live stream is carried over').toBe(true);
  expect(shown.w, 'scaled beyond the player box').toBeGreaterThan(360);

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#vid'), { timeout: 3000 }).toBeNull();
  expect((await styleState(p(), '#vid')).count, 'video inline styles fully restored').toBe(0);

  // The page's own player is never touched: same element, same stream, no transform.
  const after = await vid.evaluate((v) => ({
    connected: v.isConnected,
    hasStream: !!v.srcObject,
    transform: v.style.getPropertyValue('transform'),
    opacity: getComputedStyle(v).opacity
  }));
  expect(after.connected && after.hasStream, 'the page player is still live').toBe(true);
  expect(after.transform, 'the page player is never transformed').toBe('');
  expect(after.opacity, 'the page player paints again').toBe('1');
});

test('canvas: zooms, then releases the scroll at 1x with styles restored', async () => {
  const cv = p().locator('#cv');
  await wheelOver(cv, -110, 2);

  const state = await settle(p(), '#cv');
  expect(state, 'a zoom session opened on the canvas').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.05);

  for (let i = 0; i < 40; i++) {
    if ((await readTransform(p(), '#cv')) === null) break;
    await p().mouse.wheel(0, 90);
    await p().waitForTimeout(30);
  }
  expect(await readTransform(p(), '#cv'), 'zoom released at 1.0').toBeNull();
  expect((await styleState(p(), '#cv')).count, 'canvas inline styles restored').toBe(0);
});

test('open shadow root: media inside a component zooms and restores', async () => {
  await p().evaluate(() => {
    document.querySelector('#shadow-host').scrollIntoView({ block: 'center' });
  });
  const box = await p().evaluate(() => {
    const img = document.querySelector('#shadow-host').shadowRoot.querySelector('img');
    const r = img.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  expect(box.w).toBeGreaterThan(120);

  // The zoom paints a stand-in in the top layer, never the page's own element.
  const read = () =>
    p().evaluate(() => {
      const stage = document.querySelector('[data-loupe-stage]');
      const view = stage && stage.firstElementChild;
      return { raw: view ? view.style.getPropertyValue('transform') : '' };
    });

  /* This fixture image ships its own inline styles, so the invariant is exact
   * restore (identical inline property set), not "no inline styles at all". */
  const styled = () =>
    p().evaluate(() => {
      const img = document.querySelector('#shadow-host').shadowRoot.querySelector('img');
      const props = [];
      for (let i = 0; i < img.style.length; i++) {
        const name = img.style.item(i);
        props.push(`${name}=${img.style.getPropertyValue(name)}`);
      }
      return props.sort();
    });
  const before = await styled();

  await p().mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await p().mouse.wheel(0, -110);

  await expect
    .poll(async () => parseScale((await read()).raw), { timeout: 4000 })
    .toBeGreaterThan(1.05);
  expect((await read()).raw).toContain('scale');
  expect(
    await p().evaluate(() => document.querySelector('#shadow-host').shadowRoot.querySelector('img').style.getPropertyValue('transform')),
    'the page image is never transformed'
  ).toBe('');

  await p().keyboard.press('Escape');
  await expect
    .poll(async () => parseScale((await read()).raw), { timeout: 3000 })
    .toBeNull();

  expect(await styled(), 'inline styles exactly restored').toEqual(before);
  const leaked = await p().evaluate(() => {
    const img = document.querySelector('#shadow-host').shadowRoot.querySelector('img');
    return ['transform', 'translate', 'rotate', 'scale', 'zoom', 'transform-origin', 'will-change', 'user-select', 'position', 'z-index'].filter(
      (name) => img.style.getPropertyValue(name)
    );
  });
  expect(leaked, 'no zoom properties left behind').toEqual([]);
});

test('transparent click layer: the media underneath zooms (Instagram pattern)', async () => {
  const veil = p().locator('#veil');
  await veil.scrollIntoViewIfNeeded();
  const box = await veil.boundingBox();
  expect(box).not.toBeNull();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // The layer, not the image, is what the pointer actually hits.
  expect(await p().evaluate(({ x, y }) => document.elementFromPoint(x, y).id, at)).toBe('veil');

  await p().mouse.move(at.x, at.y);
  await p().mouse.wheel(0, -110);
  await p().waitForTimeout(80);
  await p().mouse.wheel(0, -110);

  const state = await settle(p(), '#veilImg');
  expect(state, 'the photo under the layer opened a session').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.05);
  // The zoom is a top-layer box, so the page's click layer cannot cover it...
  const stage = await p().evaluate(() => {
    const s = document.querySelector('[data-loupe-stage]');
    if (!s) return null;
    const r = s.firstElementChild.getBoundingClientRect();
    return { open: s.matches(':popover-open'), x: r.left, y: r.top, w: r.width, h: r.height };
  });
  expect(stage && stage.open, 'the zoom is above the layer in the top layer').toBe(true);
  expect(
    at.x >= stage.x && at.x <= stage.x + stage.w && at.y >= stage.y && at.y <= stage.y + stage.h,
    'the zoom covers the point'
  ).toBe(true);
  // ...and it never eats input: the transparent layer still owns the hit.
  expect(await p().evaluate(({ x, y }) => document.elementFromPoint(x, y).id, at), 'input still reaches the page').toBe('veil');

  // A small move inside the photo must not be read as "cursor left the media".
  await p().mouse.move(at.x + 14, at.y + 9);
  await p().waitForTimeout(250);
  const alive = await readTransform(p(), '#veilImg');
  expect(alive, 'session survives pointer movement over the layer').not.toBeNull();
  expect(alive.s).toBeGreaterThan(1.05);

  // Drag still pans through the layer.
  const before = await readTransform(p(), '#veilImg');
  await p().mouse.down();
  await p().mouse.move(at.x + 44, at.y + 39, { steps: 6 });
  await p().mouse.up();
  const dragged = await settle(p(), '#veilImg');
  expect(dragged, 'drag through the layer kept the session').not.toBeNull();
  expect(Math.abs(dragged.x - before.x), 'panned horizontally').toBeGreaterThan(10);

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#veilImg'), { timeout: 3000 }).toBeNull();
  expect((await styleState(p(), '#veilImg')).count, 'styles restored').toBe(0);
});

test('opaque scrim over media blocks the zoom (no zooming behind a dimmer)', async () => {
  const tile = p().locator('#scrim');
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await p().evaluate(({ x, y }) => document.elementFromPoint(x, y).id, at)).toBe('scrim');

  const before = await counters(p());
  await p().mouse.move(at.x, at.y);
  await p().mouse.wheel(0, -110);
  await p().waitForTimeout(300);

  expect(await readTransform(p(), '#scrimImg'), 'hidden media is not zoomed').toBeNull();
  expect(await p().locator('[data-loupe-hud]').count()).toBe(0);
  expect((await counters(p())).pageWheel, 'wheel is left to the page').toBeGreaterThan(before.pageWheel);
});

test('site chrome over media is covered by the zoomed media (Reels pattern)', async () => {
  const img = p().locator('#postImg');
  const rail = p().locator('#postUi');
  await rail.scrollIntoViewIfNeeded();
  const railBox = await rail.boundingBox();
  const at = { x: railBox.x + railBox.width / 2, y: railBox.y + railBox.height / 2 };
  const uiAt = (point) =>
    p().evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return 'none';
      if (hit.closest('#postUi')) return 'ui';
      return hit.id || hit.tagName;
    }, point);

  // Chrome sits in a sibling stacking context above the media's z-index:0 slot.
  expect(await uiAt(at)).toBe('ui');

  const imgBox = await img.boundingBox();
  await p().mouse.move(imgBox.x + imgBox.width * 0.4, imgBox.y + imgBox.height * 0.4);
  await p().mouse.wheel(0, -110);
  await p().mouse.wheel(0, -110);
  const state = await settle(p(), '#postImg');
  expect(state.s).toBeGreaterThan(1.05);

  const top = await p().evaluate(() => {
    const s = document.querySelector('[data-loupe-stage]');
    if (!s) return null;
    const r = s.firstElementChild.getBoundingClientRect();
    return { open: s.matches(':popover-open'), x: r.left, y: r.top, w: r.width, h: r.height };
  });
  expect(top && top.open, 'the zoom is a top-layer box above the chrome').toBe(true);
  expect(
    at.x >= top.x && at.x <= top.x + top.w && at.y >= top.y && at.y <= top.y + top.h,
    'the zoom covers the chrome area'
  ).toBe(true);
  expect(await uiAt(at), 'the chrome is still there, under the zoom, and still takes input').toBe('ui');

  // The chrome must not move: lifting is z-index only.
  const after = await rail.boundingBox();
  expect(Math.round(after.x)).toBe(Math.round(railBox.x));
  expect(Math.round(after.y)).toBe(Math.round(railBox.y));

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#postImg'), { timeout: 3000 }).toBeNull();
  expect(await uiAt(at), 'chrome is back on top').toBe('ui');
  // Assert declarations, not the attribute: Chromium can re-serialize an empty
  // style attribute after removeAttribute, which paints nothing either way.
  expect(
    await p().evaluate(() =>
      ['postShell', 'postMedia', 'postUi'].map((id) => {
        const n = document.getElementById(id);
        return { id, len: n.style.length, css: n.style.cssText };
      })
    ),
    'lifted stacking styles fully restored'
  ).toEqual([
    { id: 'postShell', len: 0, css: '' },
    { id: 'postMedia', len: 0, css: '' },
    { id: 'postUi', len: 0, css: '' }
  ]);
});

test('rapid bursts and a reload mid-zoom stay clean', async () => {
  const errors = [];
  p().on('pageerror', (err) => errors.push(String(err)));

  await wheelOver(p().locator('#vid'), -120, 15); // impatient scrolling
  await p().keyboard.press('Escape');
  await wheelOver(p().locator('#vid'), 90, 12); // wheel-down at 1x: ordinary scrolling

  await wheelOver(p().locator('#cv'), -110, 3);
  await p().reload(); // reload while a session is live
  await p().waitForFunction(() => !!window.__loupeCounters);

  await wheelOver(p().locator('#cv'), -110, 2);
  const state = await settle(p(), '#cv');
  expect(state, 'zoom still works after the reload').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.05);
  expect(errors, 'no page errors during the stress').toEqual([]);
});

test('MediaSource video (Instagram pattern): the zoom paints live frames, never a black box', async () => {
  // Instagram serves Reels through MSE: the element's src is a blob: object URL
  // owned by one MediaSource. Copying that URL into a second <video> is rejected
  // by the browser, which used to leave a black stand-in over a hidden player.
  await p().waitForFunction(() => window.__mseReady === true, null, { timeout: 20000 });
  const vid = p().locator('#mseVid');
  await expect.poll(() => vid.evaluate((v) => v.videoWidth), { timeout: 5000 }).toBeGreaterThan(0);

  await wheelOver(vid, -110, 2);
  const state = await settle(p(), '#mseVid');
  expect(state, 'the MSE video opened a session').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.05);

  // Sample the stand-in's own pixels: a rejected blob: URL paints nothing.
  const shown = await p().evaluate(() => {
    const stage = document.querySelector('[data-loupe-stage]');
    if (!stage) return { stage: false };
    const view = stage.firstElementChild;
    const k = document.createElement('canvas');
    k.width = 48;
    k.height = 32;
    const kx = k.getContext('2d');
    let lum = null;
    try {
      kx.drawImage(view, 0, 0, 48, 32);
      const d = kx.getImageData(0, 0, 48, 32).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      lum = Math.round(sum / (d.length / 4) / 3);
    } catch (e) {
      lum = 'throw:' + e.name;
    }
    const r = view.getBoundingClientRect();
    return {
      stage: true,
      tag: view.tagName,
      stream: !!view.srcObject,
      videoWidth: view.videoWidth || 0,
      readyState: view.readyState,
      w: Math.round(r.width),
      lum
    };
  });
  expect(shown.stage, 'whole-page mode still paints a stand-in').toBe(true);
  expect(shown.lum, `the stand-in has visible pixels: ${JSON.stringify(shown)}`).toBeGreaterThan(8);
  expect(shown.w, 'and it carries the zoom').toBeGreaterThan(420);
  // The page's own copy must be hidden while the stand-in shows it.
  expect(await vid.evaluate((v) => getComputedStyle(v).opacity)).toBe('0');
  // "Pause video while zoomed" defaults to off: playback must be untouched.
  expect(await vid.evaluate((v) => v.paused), 'the page video keeps playing while zoomed').toBe(false);

  // And the carried frames are live, not one frozen still.
  const at = () =>
    p().evaluate(() => {
      const v = document.querySelector('[data-loupe-stage] video');
      return v ? v.currentTime : null;
    });
  const t0 = await at();
  await p().waitForTimeout(450);
  const t1 = await at();
  if (t0 !== null) expect(t1, 'the stand-in is still playing').toBeGreaterThan(t0);

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#mseVid'), { timeout: 3000 }).toBeNull();
  const after = await vid.evaluate((v) => ({
    opacity: getComputedStyle(v).opacity,
    paused: v.paused,
    src: v.currentSrc.slice(0, 5)
  }));
  expect(after.opacity, 'the player paints again').toBe('1');
  expect(after.src, 'the page player is untouched').toBe('blob:');
});

test('a stand-in that cannot paint falls back to in-frame instead of a black screen', async () => {
  // A revoked blob: URL still paints the page's image but cannot be re-requested,
  // so the copy fails. The session must move into the real element rather than
  // hide it behind an empty stage.
  await p().waitForFunction(() => window.__revokedReady === true, null, { timeout: 20000 });
  // The fixture sets display/size inline, so the invariant is exact restore.
  const inline = () =>
    p().$eval('#revokedImg', (el) => {
      const out = [];
      for (let i = 0; i < el.style.length; i++) {
        const name = el.style.item(i);
        out.push(`${name}=${el.style.getPropertyValue(name)}`);
      }
      return out.sort();
    });
  const before = await inline();
  await wheelOver(p().locator('#revokedImg'), -110, 2);

  await expect
    .poll(
      async () =>
        p().evaluate(() => ({
          stage: !!document.querySelector('[data-loupe-stage]'),
          opacity: getComputedStyle(document.getElementById('revokedImg')).opacity,
          transform: document.getElementById('revokedImg').style.getPropertyValue('transform')
        })),
      { timeout: 5000 }
    )
    .toMatchObject({ stage: false, opacity: '1' });

  const state = await settle(p(), '#revokedImg');
  expect(state, 'the session survived the fallback').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.05);

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#revokedImg'), { timeout: 3000 }).toBeNull();
  expect(await inline(), 'inline styles exactly restored').toEqual(before);
});

test('a video whose re-request fails falls back to in-frame instead of a black stage', async () => {
  // Hotlink-protected players answer the copy with 403; the page's own element is
  // hidden for the session, so the zoom has to move into the element itself.
  await wheelOver(p().locator('#deadVid'), -110, 2);

  await expect
    .poll(
      async () =>
        p().evaluate(() => ({
          stage: !!document.querySelector('[data-loupe-stage]'),
          opacity: getComputedStyle(document.getElementById('deadVid')).opacity,
          transform: document.getElementById('deadVid').style.getPropertyValue('transform')
        })),
      { timeout: 6000 }
    )
    .toMatchObject({ stage: false, opacity: '1' });

  const state = await settle(p(), '#deadVid');
  expect(state, 'the session survived the fallback').not.toBeNull();
  expect(state.s).toBeGreaterThan(1.05);

  await p().keyboard.press('Escape');
  await expect.poll(async () => readTransform(p(), '#deadVid'), { timeout: 3000 }).toBeNull();
});

test('cross-origin iframe: the content script still reaches the frame', async () => {
  // Second server instance = different port = different origin, so the frame is
  // genuinely cross-origin even though it serves the same fixture file.
  const other = await startFixtureServer();
  try {
    await p().goto(server.url('stress-site.html?frame=' + encodeURIComponent(other.url('frame.html'))));
    await p().waitForFunction(() => !!window.__loupeCounters);

    // Bring the embed on-screen first: Chromium throttles rAF in an offscreen
    // frame, which stalls both Playwright's stability check and any smoothing.
    await p().evaluate(() => document.getElementById('frm').scrollIntoView({ block: 'center' }));
    const frame = p().frameLocator('#frm');
    const photo = frame.locator('#framePhoto');
    await photo.waitFor();
    await photo.scrollIntoViewIfNeeded();
    const box = await photo.boundingBox();
    expect(box, 'cross-origin frame image has a viewport box').not.toBeNull();

    const read = () =>
      photo.evaluate(() => {
        const stage = document.querySelector('[data-loupe-stage]');
        const view = stage && stage.firstElementChild;
        return { raw: view ? view.style.getPropertyValue('transform') : '' };
      });

    await p().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p().mouse.wheel(0, -110);

    await expect
      .poll(async () => parseScale((await read()).raw), { timeout: 4000 })
      .toBeGreaterThan(1.05);
    expect(await frame.locator('[data-loupe-hud]').count(), 'HUD mounts in the cross-origin frame').toBe(1);

    await p().keyboard.press('Escape');
    await expect
      .poll(async () => parseScale((await read()).raw), { timeout: 3000 })
      .toBeNull();
    expect(await photo.evaluate((el) => el.style.length), 'cross-origin frame media styles restored').toBe(0);
  } finally {
    await other.close();
  }
});

test('iframe: media inside a frame zooms (all_frames) and restores', async () => {
  const frame = p().frameLocator('#frm');
  const photo = frame.locator('#framePhoto');
  await photo.waitFor();

  const read = () =>
    photo.evaluate(() => {
      const stage = document.querySelector('[data-loupe-stage]');
      const view = stage && stage.firstElementChild;
      return { raw: view ? view.style.getPropertyValue('transform') : '' };
    });

  await photo.scrollIntoViewIfNeeded();
  const box = await photo.boundingBox();
  expect(box, 'frame image has a viewport box').not.toBeNull();
  await p().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p().mouse.wheel(0, -110);

  await expect
    .poll(async () => parseScale((await read()).raw), { timeout: 4000 })
    .toBeGreaterThan(1.05);
  expect(await frame.locator('[data-loupe-hud]').count(), 'HUD lives in the frame too').toBe(1);

  for (let i = 0; i < 40; i++) {
    if ((await read()).raw === '') break;
    await p().mouse.wheel(0, 90);
    await p().waitForTimeout(30);
  }
  await expect
    .poll(async () => parseScale((await read()).raw), { timeout: 3000 })
    .toBeNull();
  expect(await photo.evaluate((el) => el.style.length), 'frame media inline styles restored').toBe(0);
});