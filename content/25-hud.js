/*
 * Loupe — in-page zoom readout.
 *
 * A small plate that tracks the cursor while a zoom session is live: current
 * scale plus the exit affordance. Lives in a closed shadow root so page CSS can
 * never reach into it, is mounted into the fullscreen element when one exists,
 * and is pointer-events:none throughout — it must never eat a click or a wheel.
 */
(function (root) {
  'use strict';
  var Loupe = (root.Loupe = root.Loupe || {});

  var CSS = [
    ':host{all:initial}',
    '.pill{',
    'display:flex;align-items:center;gap:8px;padding:6px 9px;',
    'background:rgba(12,15,18,.93);border:1px solid rgba(201,169,97,.45);',
    'border-radius:7px;box-shadow:0 8px 22px rgba(0,0,0,.45);',
    'font-family:"Bahnschrift","DIN Alternate","Segoe UI",sans-serif;',
    'color:#E9EDEE;line-height:1;white-space:nowrap;',
    '}',
    '.scale{font-size:12.5px;letter-spacing:.02em;font-variant-numeric:tabular-nums;',
    'font-weight:500;}',
    '.sep{width:1px;height:11px;background:rgba(198,210,214,.18);}',
    '.key{font:500 9.5px/1 "Bahnschrift","Segoe UI",sans-serif;color:#C9A961;',
    'border:1px solid rgba(201,169,97,.5);border-radius:3px;padding:3px 4px;',
    'letter-spacing:.06em;}'
  ].join('');

  var host = null;
  var shadow = null;
  var scaleNode = null;
  var hideTimer = 0;
  var lastText = '';

  function mount() {
    var doc = root.document;
    if (!doc || !doc.documentElement) return null;
    var parent = doc.fullscreenElement || doc.documentElement;
    host = doc.createElement('div');
    host.setAttribute('data-loupe-hud', '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = [
      'position:fixed',
      'inset:auto',
      'left:0',
      'top:0',
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent',
      'overflow:visible',
      'pointer-events:none',
      // Same ceiling as a frozen media element; the readout is always raised
      // after the zoom stage in the top layer, so it paints above the picture.
      'z-index:2147483647',
      'opacity:0',
      'font-size:0',
      'transform:translate3d(-100px,-100px,0)',
      'transition:opacity 90ms linear'
    ].join(';');
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="pill"><span class="scale">1.0\u00d7</span><span class="sep"></span><kbd class="key">esc</kbd></div>';
    scaleNode = shadow.querySelector('.scale');
    parent.appendChild(host);
    // Whole-page zoom lives in the browser's top layer, so the readout must be
    // there too; a plain z-index would put it under the picture it describes.
    if (typeof host.showPopover === 'function') {
      host.setAttribute('popover', 'manual');
      try {
        host.showPopover();
      } catch (_) {
        host.removeAttribute('popover');
      }
    }
    return host;
  }

  /* Move the readout above a stage created after it (top-layer order). */
  function raise() {
    if (!host || !host.hasAttribute('popover')) return;
    if (!host.matches || !host.matches(':popover-open')) return;
    try {
      host.hidePopover();
      host.showPopover();
    } catch (_) { /* not fatal */ }
  }

  function place(x, y) {
    if (!host) return;
    var r = host.getBoundingClientRect();
    var w = r.width || 86;
    var h = r.height || 27;
    var vw = root.innerWidth;
    var vh = root.innerHeight;
    var px = x + 16;
    var py = y + 18;
    if (px + w + 8 > vw) px = x - w - 14; // flip to the left near the right edge
    if (py + h + 8 > vh) py = y - h - 14; // flip above near the bottom edge
    px = Math.max(8, Math.min(px, vw - w - 8));
    py = Math.max(8, Math.min(py, vh - h - 8));
    host.style.transform = 'translate3d(' + Math.round(px) + 'px,' + Math.round(py) + 'px,0)';
  }

  function update(scale, x, y) {
    if (!host) mount();
    if (!host) return;
    if (hideTimer) {
      root.clearTimeout(hideTimer);
      hideTimer = 0;
    }
    host.dataset.scale = scale.toFixed(2);
    host.dataset.visible = 'true';
    var text = (scale < 10 ? scale.toFixed(1) : String(Math.round(scale))) + '\u00d7';
    if (text !== lastText && scaleNode) {
      scaleNode.textContent = text;
      lastText = text;
    }
    place(x, y);
    if (host.style.opacity !== '1') host.style.opacity = '1';
  }

  function hide() {
    if (!host) return;
    host.dataset.visible = 'false';
    host.style.opacity = '0';
    if (hideTimer) root.clearTimeout(hideTimer);
    hideTimer = root.setTimeout(function () {
      hideTimer = 0;
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
      shadow = null;
      scaleNode = null;
      lastText = '';
    }, 140);
  }

  Loupe.hud = {
    show: update,
    update: update,
    hide: hide,
    raise: raise
  };
})(globalThis);