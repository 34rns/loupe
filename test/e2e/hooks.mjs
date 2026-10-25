/*
 * E2E hooks: fixture HTTP server + Chromium launched with the extension packed
 * into a persistent context (extension content scripts only run in persistent
 * contexts headed or new-headless; HEADED=1 forces a visible window).
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT_PATH = path.resolve(HERE, '..', '..'); // loupe/ root (manifest.json lives here)
const FIXTURE_DIR = path.resolve(HERE, '..', 'fixtures');

export async function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(FIXTURE_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    url: (p) => `http://127.0.0.1:${port}/${p}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // channel 'chromium' = full Chromium in the new headless mode, which unlike
    // the headless shell supports --load-extension. HEADED=1 shows the window.
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`
    ]
  });
  const page = context.pages()[0] || (await context.newPage());
  return { context, page, userDataDir, close: () => context.close() };
}

/*
 * Resolve the unpacked extension's id from the browser itself: chrome://extensions
 * exposes developerPrivate, which lists the loaded token with its real id. This
 * avoids guessing the path hash (which Chromium does not expose while running).
 */
export async function extensionId(context) {
  const scratch = await context.newPage();
  try {
    await scratch.goto('chrome://extensions');
    return await scratch.evaluate(
      () =>
        new Promise((resolve, reject) => {
          if (!globalThis.chrome || !chrome.developerPrivate || !chrome.developerPrivate.getExtensionsInfo) {
            reject(new Error('developerPrivate is unavailable'));
            return;
          }
          chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, (items) => {
            const hit = items.find((i) => i.name === 'Loupe' && i.location === 'UNPACKED');
            if (hit) resolve(hit.id);
            else reject(new Error('Loupe not found among loaded extensions'));
          });
        })
    );
  } finally {
    await scratch.close();
  }
}

/* ---------------- page-side helpers ---------------- */

/*
 * Read the session's inline transform (null when no session owns the element).
 * Whole-page zoom paints into a top-layer stand-in and marks the page's own
 * element with data-loupe-zoomed, so the transform lives on the stand-in.
 */
export async function readTransform(page, sel) {
  return page.$eval(sel, (el) => {
    let node = el;
    let ox = 0;
    let oy = 0;
    if (el.hasAttribute('data-loupe-zoomed')) {
      const stage = document.querySelector('[data-loupe-stage]');
      node = stage && stage.firstElementChild;
      if (!node) return null;
      // The stand-in sits at the viewport origin, so its translate folds in the
      // media's own position. Report translation relative to the media, exactly
      // like the in-frame transform, so callers can share one model.
      const base = el.getBoundingClientRect();
      ox = base.left;
      oy = base.top;
    }
    const raw = node.style.getPropertyValue('transform');
    if (!raw) return null;
    const m = raw.match(
      /translate3d\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px,\s*0(?:px)?\)\s*scale\((-?[\d.e+-]+)\)/
    );
    if (!m) return { raw };
    return { raw, x: parseFloat(m[1]) - ox, y: parseFloat(m[2]) - oy, s: parseFloat(m[3]), len: node.style.length };
  });
}
/* Wait until the inline transform stops changing (smoothing settled). */
export async function settle(page, sel, ms = 5000) {
  const deadline = Date.now() + ms;
  let prev = null;
  let same = 0;
  while (Date.now() < deadline) {
    const cur = JSON.stringify(await readTransform(page, sel));
    if (cur === prev) {
      if (++same >= 4) return cur === 'null' ? null : JSON.parse(cur);
    } else {
      same = 0;
    }
    prev = cur;
    await page.waitForTimeout(60);
  }
  throw new Error(`settle() timed out on ${sel}: last=${prev}`);
}

/* Inline style properties plus the raw style attribute, for restore checks. */
export async function styleState(page, sel) {
  return page.$eval(sel, (el) => ({
    count: el.style.length,
    props: Array.from({ length: el.style.length }, (_, i) => `${el.style.item(i)}=${el.style.getPropertyValue(el.style.item(i))}`),
    attr: el.getAttribute('style')
  }));
}

export async function counters(page) {
  return page.evaluate(() => ({ ...window.__loupeCounters }));
}

/* Viewport point at a fractional position of a selector's box. */
export async function point(page, sel, fx, fy) {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

/* Untransformed base rect, captured before any zoom. */
export async function baseRect(page, sel) {
  return page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

/* Wheel-up until the target is zoomed, then wait for smoothing to settle. */
export async function zoomIn(page, sel, notches = 2, opts = {}) {
  const at = opts.at || (await point(page, sel, 0.5, 0.5));
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, -110);
    await page.waitForTimeout(40);
  }
  return settle(page, sel);
}