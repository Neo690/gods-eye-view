import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HUD_WINDOW_DRAG_MEDIA,
  HUD_WINDOW_DRAG_SPECS,
  HUD_WINDOW_DRAG_STORAGE_KEY,
  createHudWindowDrag,
} from './hudWindowDrag.js';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Just enough style object for `setProperty` and the CSS variable read-back. */
function fakeStyle() {
  const props = new Map();
  return {
    setProperty(name, value) {
      props.set(name, String(value));
    },
    getPropertyValue(name) {
      return props.get(name) ?? '';
    },
  };
}

/** An element whose box follows the offset the module writes. */
function fakeWindow({ left, top, width = 336, height = 116 }) {
  const style = fakeStyle();
  const listeners = new Map();
  const el = {
    style,
    dataset: {},
    getBoundingClientRect() {
      const dx = parseFloat(style.getPropertyValue('--hud-window-dx')) || 0;
      const dy = parseFloat(style.getPropertyValue('--hud-window-dy')) || 0;
      return {
        left: left + dx,
        top: top + dy,
        width,
        height,
        right: left + dx + width,
        bottom: top + dy + height,
      };
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    emit(type, event = {}) {
      listeners.get(type)?.({ currentTarget: el, ...event });
    },
    listeners,
  };
  return el;
}

function fakeDocument(windows, { width = 360, height = 720, mobile = true } = {}) {
  const docListeners = new Map();
  const hud = {
    querySelector: (selector) => windows[selector] ?? null,
  };
  const view = {
    innerWidth: width,
    innerHeight: height,
    matchMedia: () => ({
      matches: mobile,
      addEventListener() {},
      removeEventListener() {},
    }),
    addEventListener(type, handler) {
      docListeners.set(type, handler);
    },
    removeEventListener(type) {
      docListeners.delete(type);
    },
  };
  return {
    getElementById: (id) => (id === 'intel-hud' ? hud : null),
    addEventListener(type, handler) {
      docListeners.set(type, handler);
    },
    removeEventListener(type) {
      docListeners.delete(type);
    },
    defaultView: view,
    listeners: docListeners,
  };
}

function fakeStorage(initial) {
  const data = new Map(initial ? [[HUD_WINDOW_DRAG_STORAGE_KEY, JSON.stringify(initial)]] : []);
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    read: () => JSON.parse(data.get(HUD_WINDOW_DRAG_STORAGE_KEY) || '{}'),
    data,
  };
}

function offsetOf(el) {
  return {
    x: el.style.getPropertyValue('--hud-window-dx'),
    y: el.style.getPropertyValue('--hud-window-dy'),
  };
}

test('the two windows are the ones the phone shows', () => {
  assert.deepEqual(
    HUD_WINDOW_DRAG_SPECS.map((spec) => spec.id),
    ['top-left', 'bottom-left'],
  );
  assert.equal(HUD_WINDOW_DRAG_MEDIA, '(max-width: 720px)');
  // A renamed class would silently stop a window from being movable.
  const markup = readFileSync(path.join(ROOT, 'src/hud.js'), 'utf8');
  for (const spec of HUD_WINDOW_DRAG_SPECS)
    assert.match(markup, new RegExp(`hud-corner ${spec.selector.slice(1)}`));
});

test('the transform is the one thing the stylesheet carries', () => {
  const css = readStylesheet(path.join(ROOT, 'src/ui/styles/mobile-compact.css'));
  assert.match(css, /--hud-window-dx/);
  assert.match(css, /--hud-window-dy/);
  assert.match(css, /#intel-hud \.hud-top-left,[\s\S]{0,220}?touch-action:\s*none;/);
  assert.match(css, /#intel-hud \.hud-corner\[data-hud-dragging='true'\]/);
});

test('without a HUD there is nothing to drag', () => {
  assert.equal(createHudWindowDrag({ document: null }), null);
  assert.equal(
    createHudWindowDrag({ document: { getElementById: () => null } }),
    null,
  );
  assert.equal(
    createHudWindowDrag({
      document: { getElementById: () => ({ querySelector: () => null }) },
    }),
    null,
  );
});

test('a stored offset is put back where it was left', () => {
  const topLeft = fakeWindow({ left: 12, top: 54 });
  const doc = fakeDocument({ '.hud-top-left': topLeft });
  const storage = fakeStorage({ 'top-left': { x: 5, y: 40 } });
  const control = createHudWindowDrag({ document: doc, storage });
  assert.ok(control);
  assert.deepEqual(offsetOf(topLeft), { x: '5px', y: '40px' });
  assert.equal(topLeft.dataset.hudMoved, 'true');
  control.destroy();
});

test('a stored offset cannot park a window off the screen', () => {
  const bottomLeft = fakeWindow({ left: 76, top: 493, width: 208, height: 38 });
  const doc = fakeDocument({ '.hud-bottom-left': bottomLeft });
  const storage = fakeStorage({ 'bottom-left': { x: -400, y: 900 } });
  const control = createHudWindowDrag({ document: doc, storage });
  assert.deepEqual(offsetOf(bottomLeft), { x: '-72px', y: '185px' });
  assert.deepEqual(storage.read()['bottom-left'], { x: -72, y: 185 });
  control.destroy();
});

test('a desktop keeps its corner anchors, stored or not', () => {
  const topLeft = fakeWindow({ left: 36, top: 120 });
  const doc = fakeDocument({ '.hud-top-left': topLeft }, { mobile: false });
  const storage = fakeStorage({ 'top-left': { x: 30, y: 30 } });
  const control = createHudWindowDrag({ document: doc, storage });
  assert.deepEqual(offsetOf(topLeft), { x: '0px', y: '0px' });
  assert.equal(topLeft.dataset.hudMoved, 'false');
  assert.deepEqual(storage.read(), { 'top-left': { x: 30, y: 30 } });
  control.destroy();
});

test('a drag moves the window and the position survives the session', () => {
  const bottomLeft = fakeWindow({ left: 76, top: 447, width: 208, height: 38 });
  const doc = fakeDocument({ '.hud-bottom-left': bottomLeft });
  const storage = fakeStorage();
  const control = createHudWindowDrag({ document: doc, storage });

  bottomLeft.emit('pointerdown', { clientX: 100, clientY: 460, pointerType: 'touch', button: 0 });
  doc.listeners.get('pointermove')({ clientX: 130, clientY: 500, preventDefault() {} });
  assert.deepEqual(offsetOf(bottomLeft), { x: '30px', y: '40px' });
  assert.equal(bottomLeft.dataset.hudDragging, 'true');

  doc.listeners.get('pointerup')({ clientX: 130, clientY: 500 });
  assert.deepEqual(storage.read(), { 'bottom-left': { x: 30, y: 40 } });
  assert.equal(bottomLeft.dataset.hudDragging, undefined);
  control.destroy();
});

test('a press that does not travel is a tap, not a drag', () => {
  const topLeft = fakeWindow({ left: 12, top: 54 });
  const doc = fakeDocument({ '.hud-top-left': topLeft });
  const storage = fakeStorage();
  const control = createHudWindowDrag({ document: doc, storage });
  topLeft.emit('pointerdown', { clientX: 100, clientY: 80, pointerType: 'touch', button: 0 });
  doc.listeners.get('pointermove')({ clientX: 102, clientY: 81, preventDefault() {} });
  doc.listeners.get('pointerup')({ clientX: 102, clientY: 81 });
  assert.deepEqual(offsetOf(topLeft), { x: '0px', y: '0px' });
  assert.deepEqual(storage.read(), {});
  control.destroy();
});

test('a drag stops at the edge of the viewport', () => {
  const topLeft = fakeWindow({ left: 12, top: 54, width: 336, height: 116 });
  const doc = fakeDocument({ '.hud-top-left': topLeft });
  const control = createHudWindowDrag({ document: doc, storage: fakeStorage() });
  topLeft.emit('pointerdown', { clientX: 100, clientY: 80, pointerType: 'touch', button: 0 });
  doc.listeners.get('pointermove')({ clientX: 600, clientY: 900, preventDefault() {} });
  // 360 - 4 - 336 - 12 = 8 to the right, 720 - 4 - 116 - 54 = 546 down.
  assert.deepEqual(offsetOf(topLeft), { x: '8px', y: '546px' });
  control.destroy();
});

test('two taps in the same place put a window back', () => {
  const topLeft = fakeWindow({ left: 12, top: 54 });
  const doc = fakeDocument({ '.hud-top-left': topLeft });
  const storage = fakeStorage({ 'top-left': { x: 4, y: 20 } });
  const control = createHudWindowDrag({ document: doc, storage });
  assert.deepEqual(offsetOf(topLeft), { x: '4px', y: '20px' });
  for (let tap = 0; tap < 2; tap += 1) {
    topLeft.emit('pointerdown', { clientX: 120, clientY: 90, pointerType: 'touch', button: 0 });
    doc.listeners.get('pointerup')({ clientX: 120, clientY: 90 });
  }
  assert.deepEqual(offsetOf(topLeft), { x: '0px', y: '0px' });
  assert.deepEqual(storage.read(), {});
  control.destroy();
});

test('destroying the HUD lets go of every listener', () => {
  const topLeft = fakeWindow({ left: 12, top: 54 });
  const doc = fakeDocument({ '.hud-top-left': topLeft });
  const control = createHudWindowDrag({
    document: doc,
    storage: fakeStorage(),
  });
  control.destroy();
  assert.equal(topLeft.listeners.size, 0);
  assert.equal(doc.listeners.size, 0);
});
