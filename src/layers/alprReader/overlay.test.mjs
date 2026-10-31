import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLATE_BOX_CLASS,
  PLATE_LABEL_CLASS,
  containFrame,
  createPlateOverlay,
  plateRects,
} from './overlay.js';

/** One answer, shaped like the server's: a frame and boxes in its pixels. */
const answer = {
  frame: { width: 640, height: 360 },
  plates: [{ text: 'AB-123-CD', confidence: 0.97, box: { x1: 100, y1: 50, x2: 200, y2: 100 } }],
};

test('containFrame is object-fit: contain as arithmetic', () => {
  // Same ratio: the frame fills the box, no offset.
  assert.deepEqual(containFrame({ width: 640, height: 360 }, { width: 320, height: 180 }), {
    scale: 0.5,
    left: 0,
    top: 0,
    width: 320,
    height: 180,
  });
  // A squarer frame in a 16:9 box is pillarboxed.
  const pillars = containFrame({ width: 352, height: 288 }, { width: 320, height: 180 });
  assert.equal(pillars.scale, 0.625);
  assert.equal(pillars.width, 220);
  assert.equal(pillars.left, 50);
  assert.equal(pillars.top, 0);
  // A wider frame is letterboxed instead.
  const letterbox = containFrame({ width: 640, height: 200 }, { width: 320, height: 180 });
  assert.equal(letterbox.scale, 0.5);
  assert.equal(letterbox.height, 100);
  assert.equal(letterbox.top, 40);
  // Nothing to draw from: no fit, rather than a made-up one.
  assert.equal(containFrame({ width: 0, height: 360 }, { width: 320, height: 180 }), null);
  assert.equal(containFrame({ width: 640, height: 360 }, { width: 0, height: 0 }), null);
  assert.equal(containFrame(null, { width: 320, height: 180 }), null);
});

test('plateRects maps a box through the frame it was read in', () => {
  const [rect] = plateRects(answer, { width: 320, height: 180 });
  assert.equal(rect.text, 'AB-123-CD');
  assert.equal(rect.left, 50);
  assert.equal(rect.top, 25);
  assert.equal(rect.width, 50);
  assert.equal(rect.height, 25);
  assert.equal(rect.outside, true);
});

test('plateRects keeps the letterbox offset of a frame that does not fill the box', () => {
  // 320x120 in a 320x180 box: 30 px of letterbox above the picture.
  const [rect] = plateRects(
    {
      frame: { width: 320, height: 120 },
      plates: [{ text: 'X1', box: { x1: 10, y1: 10, x2: 20, y2: 20 } }],
    },
    { width: 320, height: 180 },
  );
  assert.equal(rect.left, 10);
  assert.equal(rect.top, 40);
  assert.equal(rect.width, 10);
  assert.equal(rect.height, 10);
});

test('a plate against the top of the frame labels inside the box', () => {
  const [rect] = plateRects(
    {
      frame: { width: 320, height: 180 },
      plates: [{ text: 'AB1234', box: { x1: 0, y1: 0, x2: 40, y2: 12 } }],
    },
    { width: 320, height: 180 },
  );
  // There is no room for a label above it, so it goes inside.
  assert.equal(rect.top, 0);
  assert.equal(rect.outside, false);
});

test('answers without a usable frame or box draw nothing', () => {
  assert.deepEqual(plateRects({ plates: [] }, { width: 320, height: 180 }), []);
  assert.deepEqual(plateRects(answer, { width: 0, height: 0 }), []);
  assert.deepEqual(
    plateRects(
      { frame: { width: 640, height: 360 }, plates: [{ text: 'AB1234' }] },
      { width: 320, height: 180 },
    ),
    [],
  );
  assert.deepEqual(
    plateRects(
      {
        frame: { width: 640, height: 360 },
        plates: [{ text: 'AB1234', box: { x1: 10, y1: 10, x2: 10, y2: 30 } }],
      },
      { width: 320, height: 180 },
    ),
    [],
  );
});

/** The panel's own elements, as the overlay measures them. */
function fakeElement(tagName, rect = { left: 0, top: 0, width: 0, height: 0 }) {
  const node = {
    tagName,
    children: [],
    style: {},
    id: '',
    className: '',
    hidden: false,
    attributes: {},
    rect,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    append(child) {
      this.children.push(child);
      child.parent = this;
      // A child laid out by its parent shares its origin: the overlay is
      // inset 0 inside the frame, so the test gives it the frame's rect.
      if (!child.rect.width && !child.rect.height) child.rect = this.rect;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      return child;
    },
    remove() {
      this.parent?.removeChild(this);
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return this.rect;
    },
    get firstChild() {
      return this.children[0] || null;
    },
  };
  return node;
}

function fakePanel({ withHost = true } = {}) {
  const wrap = fakeElement('div', { left: 10, top: 20, width: 320, height: 180 });
  const img = fakeElement('img', { left: 10, top: 20, width: 320, height: 180 });
  const document = {
    createElement: (tagName) => fakeElement(tagName),
    getElementById: (id) => {
      if (id === 'cctv-frame-wrap') return withHost ? wrap : null;
      if (id === 'cctv-frame') return img;
      return null;
    },
  };
  return { document, wrap, img };
}

test('a read mounts its boxes in the CCTV frame', () => {
  const { document, wrap } = fakePanel();
  const overlay = createPlateOverlay({ documentRef: document });
  overlay.show(answer);

  assert.equal(wrap.children.length, 1);
  const layer = wrap.children[0];
  assert.equal(layer.id, 'cctv-plate-overlay');
  assert.equal(layer.attributes['aria-hidden'], 'true');
  assert.equal(layer.children.length, 1);

  const box = layer.children[0];
  assert.equal(box.className, PLATE_BOX_CLASS);
  assert.equal(box.style.left, '50px');
  assert.equal(box.style.top, '25px');
  assert.equal(box.style.width, '50px');
  assert.equal(box.style.height, '25px');
  assert.equal(box.children[0].className, PLATE_LABEL_CLASS);
  assert.equal(box.children[0].textContent, 'AB-123-CD');

  overlay.destroy();
});

test('clearing takes the boxes off the picture', () => {
  const { document, wrap } = fakePanel();
  const overlay = createPlateOverlay({ documentRef: document });
  overlay.show(answer);
  assert.equal(wrap.children.length, 1);
  overlay.clear();
  assert.equal(wrap.children.length, 0);
  overlay.destroy();
});

test('an answer without plates leaves no empty frame layer', () => {
  const { document, wrap } = fakePanel();
  const overlay = createPlateOverlay({ documentRef: document });
  overlay.show({ frame: { width: 640, height: 360 }, plates: [] });
  assert.equal(wrap.children.length, 1);
  assert.equal(wrap.children[0].children.length, 0);
  // The host is what keeps the layer honest: without one, nothing is drawn.
  const absent = createPlateOverlay({ documentRef: fakePanel({ withHost: false }).document });
  assert.doesNotThrow(() =>
    absent.show({ frame: { width: 10, height: 10 }, plates: [{ text: 'A1', box: {} }] }),
  );
  overlay.destroy();
  absent.destroy();
});

test('a page with no document gets a no-op overlay', () => {
  const overlay = createPlateOverlay({ documentRef: null });
  assert.doesNotThrow(() => overlay.show(answer));
  assert.doesNotThrow(() => overlay.clear());
  assert.doesNotThrow(() => overlay.destroy());
});
