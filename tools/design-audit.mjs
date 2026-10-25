/*
 * Design QA — renders the popup and the icon sheet outside the extension shell
 * (chrome.storage absent, so the popup falls back to in-memory defaults) and
 * reports layout, overflow, target sizes and contrast numbers. Screenshots land
 * in .artifacts/ for pixel analysis.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '.artifacts');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8899';

mkdirSync(OUT, { recursive: true });

function lum(hex) {
  const v = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = c.map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 358, height: 620 } });
await page.goto(`${BASE}/popup/popup.html`);
await page.waitForTimeout(200);

const audit = await page.evaluate(() => {
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  };
  const doc = document.documentElement;
  const rows = [...document.querySelectorAll('.row')].map((row) => {
    const label = row.querySelector('.lbl');
    const ctrl = row.querySelector('input, .seg, .host');
    return {
      label: label ? label.textContent.trim() : '',
      rowH: r(row).h,
      ctrl: ctrl ? { tag: ctrl.tagName, ...r(ctrl) } : null
    };
  });
  const offenders = [...document.querySelectorAll('body *')]
    .filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && (b.right > 358.5 || b.left < -0.5);
    })
    .map((el) => el.className || el.tagName);

  return {
    body: r(document.body),
    scrollW: doc.scrollWidth,
    scrollH: doc.scrollHeight,
    rows,
    offenders,
    fonts: {
      bahnschrift: document.fonts.check('12px "Bahnschrift"'),
      segoe: document.fonts.check('12px "Segoe UI"')
    },
    switchBox: r(document.querySelector('#smooth')),
    labelColor: getComputedStyle(document.querySelector('.lbl')).color,
    rowColor: getComputedStyle(document.body).backgroundColor
  };
});

// focus ring present on a switch and a range thumb target
await page.locator('#smooth').focus();
const focus = await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector('#smooth'));
  return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor };
});

// Shoot the popup at its real height (the panel is as tall as its content, and
// Chrome caps the window at 600px — this keeps the shot free of blank padding).
await page.setViewportSize({ width: 358, height: Math.ceil(audit.body.h) });
await page.waitForTimeout(120);
await page.screenshot({ path: path.join(OUT, 'popup.png') });

// custom activation opens the held-input row: shoot that state separately
await page.locator('[data-activation="hold"]').click();
await page.waitForTimeout(80);
const holdRow = await page.evaluate(() => {
  const row = document.querySelector('#holdRow');
  const pick = document.querySelector('#holdPick');
  const b = pick.getBoundingClientRect();
  return {
    visible: !row.hidden && b.width > 0,
    label: pick.textContent.trim(),
    width: Math.round(b.width),
    height: Math.round(b.height),
    bodyH: Math.round(document.body.getBoundingClientRect().height)
  };
});
await page.setViewportSize({ width: 358, height: 620 });
await page.screenshot({ path: path.join(OUT, 'popup-hold.png'), fullPage: true });

// icon sheet on light and dark plates
const sheet = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;font:12px system-ui;display:flex;flex-direction:column;gap:0}
  .strip{display:flex;align-items:center;gap:18px;padding:14px 18px}
  .light{background:#f4f4f2;color:#111}
  .dark{background:#0c0f12;color:#eee}
  .pair{display:flex;align-items:flex-end;gap:6px}
  .pair img{image-rendering:auto}
  .tag{opacity:.55;font-size:10px;width:26px}
</style>
<div class="strip light" id="light"></div>
<div class="strip dark" id="dark"></div>
<script>
  const sizes=[16,32,48,128];
  for (const plate of ['light','dark']) {
    const host=document.getElementById(plate);
    for (const s of sizes) {
      const pair=document.createElement('div'); pair.className='pair';
      const tag=document.createElement('span'); tag.className='tag'; tag.textContent=s;
      const img=document.createElement('img'); img.src='/icons/icon'+s+'.png'; img.width=s; img.height=s;
      pair.append(tag,img); host.append(pair);
    }
  }
</script>`;
await page.setViewportSize({ width: 460, height: 420 });
await page.setContent(sheet);
await page.waitForTimeout(300);
const sheetBox = await page.evaluate(() => {
  const r = document.body.getBoundingClientRect();
  return { x: 0, y: 0, width: Math.ceil(r.width), height: Math.ceil(r.height) };
});
await page.screenshot({
  path: path.join(OUT, 'icons.png'),
  clip: { x: sheetBox.x, y: sheetBox.y, width: sheetBox.width, height: sheetBox.height }
});

const report = {
  audit,
  focus,
  contrast: {
    inkOnGraphite: ratio('#E9EDEE', '#0C0F12').toFixed(2),
    dimOnGraphite: ratio('#8B979D', '#0C0F12').toFixed(2),
    brassOnGraphite: ratio('#C9A961', '#0C0F12').toFixed(2),
    labelOnGraphite: ratio('#D3DADD', '#0C0F12').toFixed(2)
  }
};
writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify(report, null, 2));

report.hold = holdRow;
const c = report.contrast;
console.log(`held-input row: ${JSON.stringify(holdRow)}`);
console.log(`popup ${audit.body.w}x${audit.body.h}  document ${audit.scrollW}x${audit.scrollH}  (Chrome popup cap: 600h)`);
console.log(`rows: ${audit.rows.length}  tallest row ${Math.max(...audit.rows.map((r) => r.rowH))}px`);
console.log(`overflowing elements: ${audit.offenders.length ? audit.offenders.join(', ') : 'none'}`);
console.log(`fonts  bahnschrift=${audit.fonts.bahnschrift}  segoe=${audit.fonts.segoe}`);
console.log(`focus ring: ${focus.outlineStyle} ${focus.outlineWidth} ${focus.outlineColor}`);
console.log(`contrast  ink ${c.inkOnGraphite}  labels ${c.labelOnGraphite}  dim ${c.dimOnGraphite}  brass ${c.brassOnGraphite}`);

await browser.close();
