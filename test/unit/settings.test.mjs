import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load the browser script as-is (IIFE, assigns onto globalThis.Loupe).
const src = readFileSync(new URL('../../shared/settings.js', import.meta.url), 'utf8');
(0, eval)(src);
const S = globalThis.Loupe.settings;

test('defaults: wheel activation, with Shift as the custom held input', () => {
  assert.equal(S.DEFAULTS.activation, 'wheel');
  assert.equal(S.DEFAULTS.holdInput, 'key:ShiftLeft');
  assert.ok(S.KEYS.includes('holdInput'), 'the held input is a real, persisted key');
  assert.deepEqual(S.parseHold(S.DEFAULTS.holdInput), { mod: 'shift' });
});

test('parseHold: modifiers match as state, other keys by code, mouse by button', () => {
  assert.deepEqual(S.parseHold('key:ShiftLeft'), { mod: 'shift' });
  assert.deepEqual(S.parseHold('key:ShiftRight'), { mod: 'shift' });
  assert.deepEqual(S.parseHold('key:ControlRight'), { mod: 'control' });
  assert.deepEqual(S.parseHold('key:AltLeft'), { mod: 'alt' });
  assert.deepEqual(S.parseHold('key:MetaLeft'), { mod: 'meta' });
  assert.deepEqual(S.parseHold('key:KeyG'), { code: 'KeyG' });
  assert.deepEqual(S.parseHold('mouse:0'), { mouse: 0 });
  assert.deepEqual(S.parseHold('mouse:1'), { mouse: 1 });
});

test('parseHold: junk is rejected instead of half-honoured', () => {
  for (const bad of ['', 'nope', 'key:', 'mouse:', 'pad:1', 'mouse:9', 'mouse:x', null, undefined]) {
    assert.equal(S.parseHold(bad), null, `must reject ${String(bad)}`);
  }
});

test('pauseVideo: playback is only touched when the user asks for it', () => {
  assert.equal(
    S.DEFAULTS.pauseVideo,
    false,
    'the default must keep today\'s behaviour: zooming never stops a video'
  );
  assert.ok(S.KEYS.includes('pauseVideo'), 'pause-while-zoomed is a real, persisted key');
});

test('holdLabel: names what you actually press', () => {
  assert.equal(S.holdLabel('key:ShiftLeft'), 'Shift');
  assert.equal(S.holdLabel('key:ControlRight'), 'Ctrl');
  assert.equal(S.holdLabel('key:AltLeft'), 'Alt');
  assert.equal(S.holdLabel('key:MetaRight'), 'Cmd');
  assert.equal(S.holdLabel('key:KeyG'), 'G');
  assert.equal(S.holdLabel('key:Digit4'), '4');
  assert.equal(S.holdLabel('key:Space'), 'Space');
  assert.equal(S.holdLabel('key:F5'), 'F5');
  assert.equal(S.holdLabel('key:ArrowUp'), '\u2191');
  assert.equal(S.holdLabel('mouse:0'), 'Left mouse');
  assert.equal(S.holdLabel('mouse:1'), 'Middle mouse');
  assert.equal(S.holdLabel('mouse:2'), 'Right mouse');
  assert.equal(S.holdLabel(''), 'Not set');
});
