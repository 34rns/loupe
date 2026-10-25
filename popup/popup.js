/*
 * Loupe popup.
 * Every control writes to chrome.storage.sync and the engine reacts live. There
 * is no preview surface in the panel: the page itself is the preview, so the
 * panel only holds settings.
 */
(function () {
  'use strict';

  var Loupe = window.Loupe;
  var DEFAULTS = Loupe.settings.DEFAULTS;
  var hasChrome = Loupe.settings.hasStorage();
  var state = Object.assign({}, DEFAULTS);

  function $(sel) {
    return document.querySelector(sel);
  }

  function fmtScale(n) {
    return (Math.round(n * 10) / 10).toFixed(1) + '\u00d7';
  }

  function fmtFactor(n) {
    return n.toFixed(2).replace(/0$/, '') + '\u00d7';
  }

  var ui = {
    master: $('#master'),
    masterState: $('#masterState'),
    sensitivity: $('#sensitivity'),
    sensitivityVal: $('#sensitivityVal'),
    maxScale: $('#maxScale'),
    maxScaleVal: $('#maxScaleVal'),
    smooth: $('#smooth'),
    bgImages: $('#bgImages'),
    pauseVideo: $('#pauseVideo'),
    hud: $('#hud'),
    holdRow: $('#holdRow'),
    holdPick: $('#holdPick'),
    siteToggle: $('#siteToggle'),
    siteHost: $('#siteHost'),
    reset: $('#reset'),
    ver: $('#ver')
  };

  function persist(patch) {
    Loupe.settings.set(patch);
  }

  function render(s) {
    ui.master.checked = !!s.enabled;
    ui.masterState.textContent = s.enabled ? 'On' : 'Off';
    ui.masterState.classList.toggle('off', !s.enabled);

    ui.sensitivity.value = String(s.sensitivity);
    ui.sensitivityVal.textContent = fmtFactor(s.sensitivity);

    ui.maxScale.value = String(s.maxScale);
    ui.maxScaleVal.textContent = fmtScale(s.maxScale);

    ui.smooth.checked = !!s.smooth;
    ui.bgImages.checked = !!s.bgImages;
    ui.pauseVideo.checked = !!s.pauseVideo;
    ui.hud.checked = !!s.hud;

    Array.prototype.forEach.call(document.querySelectorAll('[data-activation]'), function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-activation') === s.activation));
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-zoom-mode]'), function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-zoom-mode') === s.zoomMode));
    });

    // The held input only means something in the custom mode.
    ui.holdRow.hidden = s.activation !== 'hold';
    if (!capturing) ui.holdPick.textContent = Loupe.settings.holdLabel(s.holdInput);
  }

  /* ---------- control wiring ---------- */

  ui.master.addEventListener('change', function () {
    state.enabled = ui.master.checked;
    render(state);
    persist({ enabled: state.enabled });
  });

  ui.sensitivity.addEventListener('input', function () {
    state.sensitivity = parseFloat(ui.sensitivity.value);
    ui.sensitivityVal.textContent = fmtFactor(state.sensitivity);
    persist({ sensitivity: state.sensitivity });
  });

  ui.maxScale.addEventListener('input', function () {
    state.maxScale = parseFloat(ui.maxScale.value);
    ui.maxScaleVal.textContent = fmtScale(state.maxScale);
    persist({ maxScale: state.maxScale });
  });

  [['smooth', ui.smooth], ['bgImages', ui.bgImages], ['pauseVideo', ui.pauseVideo], ['hud', ui.hud]].forEach(function (pair) {
    pair[1].addEventListener('change', function () {
      state[pair[0]] = pair[1].checked;
      persist({ [pair[0]]: pair[1].checked });
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-activation]'), function (b) {
    b.addEventListener('click', function () {
      if (capturing) stopCapture();
      state.activation = b.getAttribute('data-activation');
      render(state);
      persist({ activation: state.activation });
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-zoom-mode]'), function (b) {
    b.addEventListener('click', function () {
      state.zoomMode = b.getAttribute('data-zoom-mode');
      render(state);
      persist({ zoomMode: state.zoomMode });
    });
  });

  /* ---------- held input picker ---------- */

  var capturing = false;

  function onCaptureKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopCapture();
      return;
    }
    if (!e.code) return;
    choose('key:' + e.code);
  }

  function onCaptureMouse(e) {
    // A left click outside the chip is how you back out, not a choice.
    if (e.button === 0 && !ui.holdPick.contains(e.target)) {
      stopCapture();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    choose('mouse:' + e.button);
  }

  function onCaptureMenu(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function choose(value) {
    state.holdInput = value;
    persist({ holdInput: value });
    stopCapture();
  }

  function startCapture() {
    capturing = true;
    ui.holdPick.dataset.capturing = '';
    ui.holdPick.textContent = 'Press a key\u2026';
    ui.holdPick.title = 'Press the key or mouse button to hold \u2014 Esc cancels';
    document.addEventListener('keydown', onCaptureKey, true);
    document.addEventListener('mousedown', onCaptureMouse, true);
    document.addEventListener('contextmenu', onCaptureMenu, true);
  }

  function stopCapture() {
    if (!capturing) return;
    capturing = false;
    delete ui.holdPick.dataset.capturing;
    ui.holdPick.title = 'Click, then press the key or mouse button you want to hold';
    document.removeEventListener('keydown', onCaptureKey, true);
    document.removeEventListener('mousedown', onCaptureMouse, true);
    document.removeEventListener('contextmenu', onCaptureMenu, true);
    ui.holdPick.textContent = Loupe.settings.holdLabel(state.holdInput);
  }

  ui.holdPick.title = 'Click, then press the key or mouse button you want to hold';
  ui.holdPick.addEventListener('click', function () {
    if (!capturing) startCapture();
  });
  ui.holdPick.addEventListener('blur', function () {
    if (capturing) stopCapture();
  });

  /* ---------- site row ---------- */

  function setSite(hostname) {
    if (!hostname) {
      ui.siteHost.textContent = 'Not available here';
      ui.siteToggle.checked = false;
      ui.siteToggle.disabled = true;
      delete ui.siteToggle.dataset.host;
      return;
    }
    ui.siteHost.textContent = hostname;
    ui.siteHost.title = hostname;
    ui.siteToggle.disabled = false;
    ui.siteToggle.dataset.host = hostname;
    ui.siteToggle.checked = state.disabledSites.indexOf(hostname) === -1;
  }

  function askSite() {
    if (!hasChrome || !chrome.tabs) {
      setSite(null);
      return;
    }
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || tab.id == null) {
        setSite(null);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'loupe:where' }, function (res) {
        var err = chrome.runtime.lastError;
        if (err || !res || !res.hostname) {
          setSite(null);
          return;
        }
        setSite(res.hostname);
      });
    });
  }

  ui.siteToggle.addEventListener('change', function () {
    var host = ui.siteToggle.dataset.host;
    if (!host) return;
    var list = state.disabledSites.slice();
    var i = list.indexOf(host);
    if (ui.siteToggle.checked && i !== -1) list.splice(i, 1);
    if (!ui.siteToggle.checked && i === -1) list.push(host);
    state.disabledSites = list;
    persist({ disabledSites: list });
  });

  /* ---------- reset ---------- */

  ui.reset.addEventListener('click', function () {
    if (capturing) stopCapture();
    state = Object.assign({}, DEFAULTS);
    persist(DEFAULTS);
    render(state);
    askSite();
  });

  /* ---------- boot ---------- */

  if (hasChrome && chrome.runtime && chrome.runtime.getManifest) {
    try {
      ui.ver.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (_) {
      /* preview only */
    }
  }

  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  Array.prototype.forEach.call(document.querySelectorAll('[data-activation="alt"] .seg-label'), function (node) {
    node.textContent = isMac ? 'Hold \u2325' : 'Hold Alt';
  });

  Loupe.settings.get(function (s) {
    state = s;
    render(state);
    askSite();
  });
})();
