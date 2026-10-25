/*
 * Loupe — shared settings contract.
 * Loaded by the popup AND by the content scripts, so the defaults and the
 * storage keys are defined exactly once. No DOM access; safe to unit-test.
 */
(function (root) {
  'use strict';
  var Loupe = (root.Loupe = root.Loupe || {});

  var DEFAULTS = {
    enabled: true,
    activation: 'wheel', // 'wheel' = scroll over media; 'alt' = scroll while holding Alt; 'hold' = scroll while holding holdInput
    holdInput: 'key:ShiftLeft', // what 'hold' waits for: 'key:<KeyboardEvent.code>' or 'mouse:<button>'
    zoomMode: 'page', // 'page' = the zoom grows past the media's frame; 'frame' = clipped to the media's own box
    sensitivity: 1, // multiplier over math.DEFAULT_RATE, 0.25–2
    maxScale: 6, // 1.5–8
    smooth: true,
    bgImages: true,
    pauseVideo: false, // true = freeze the video while it is zoomed, resume it when the zoom ends
    hdUpgrade: true, // reserved: sharp-source swap lands in a later pass (not exposed in UI)
    hud: true,
    disabledSites: [] // hostnames where Loupe stays out of the way
  };

  var KEYS = Object.keys(DEFAULTS);

  /*
   * Held-input spec, used by the engine to gate zooming and by the panel to
   * name the choice. A modifier is stored as its physical key but matched as a
   * state flag, so either Shift key works.
   */
  var MODS = {
    ShiftLeft: 'shift',
    ShiftRight: 'shift',
    ControlLeft: 'control',
    ControlRight: 'control',
    AltLeft: 'alt',
    AltRight: 'alt',
    MetaLeft: 'meta',
    MetaRight: 'meta',
    OSLeft: 'meta',
    OSRight: 'meta'
  };

  var MOUSE_LABELS = ['Left mouse', 'Middle mouse', 'Right mouse', 'Back mouse', 'Forward mouse'];
  var KEY_LABELS = {
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Escape: 'Esc',
    CapsLock: 'Caps',
    ArrowUp: '\u2191',
    ArrowDown: '\u2193',
    ArrowLeft: '\u2190',
    ArrowRight: '\u2192',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    Home: 'Home',
    End: 'End',
    Insert: 'Insert',
    Delete: 'Del',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`'
  };

  function parseHold(value) {
    var raw = String(value || '');
    var sep = raw.indexOf(':');
    if (sep < 1) return null;
    var kind = raw.slice(0, sep);
    var key = raw.slice(sep + 1);
    if (!key) return null;
    if (kind === 'mouse') {
      var button = parseInt(key, 10);
      if (isNaN(button) || button < 0 || button > 4) return null;
      return { mouse: button };
    }
    if (kind !== 'key') return null;
    if (MODS[key]) return { mod: MODS[key] };
    return { code: key };
  }

  function holdLabel(value) {
    var spec = parseHold(value);
    if (!spec) return 'Not set';
    if (spec.mouse != null) return MOUSE_LABELS[spec.mouse];
    if (spec.mod) return { shift: 'Shift', control: 'Ctrl', alt: 'Alt', meta: 'Cmd' }[spec.mod];
    var code = spec.code;
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return 'Num ' + code.slice(6);
    if (/^F[0-9]{1,2}$/.test(code)) return code;
    return KEY_LABELS[code] || code;
  }

  function hasStorage() {
    return typeof root.chrome !== 'undefined' && root.chrome.storage && root.chrome.storage.sync;
  }

  function get(cb) {
    if (!hasStorage()) {
      cb(Object.assign({}, DEFAULTS));
      return;
    }
    root.chrome.storage.sync.get(DEFAULTS, function (v) {
      cb(Object.assign({}, DEFAULTS, v || {}));
    });
  }

  function set(patch, cb) {
    if (!hasStorage()) {
      if (cb) cb();
      return;
    }
    root.chrome.storage.sync.set(patch, cb || function () {});
  }

  Loupe.settings = {
    DEFAULTS: DEFAULTS,
    KEYS: KEYS,
    hasStorage: hasStorage,
    get: get,
    set: set,
    parseHold: parseHold,
    holdLabel: holdLabel
  };
})(globalThis);