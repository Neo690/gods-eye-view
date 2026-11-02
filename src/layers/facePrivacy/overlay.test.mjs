import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFaceOverlay,
  faceRects,
  FACE_BLUR_CLASS,
  FACE_OVERLAY_ID,
} from './overlay.js';

const FRAME = { width: 800, height: 400 };
const VIEWPORT = { width: 400, height: 200 };
const ANSWER = {
  frame: FRAME,
  faces: [
    { score: 0.9, box: { x1: 100, y1: 50, x2: 200, y2: 150 } },
    { score: 0.6, box: { x1: 600, y1: 0, x2: 700, y2: 100 } },
  ],
};

test('a face box lands where the frame lands in the viewport', () => {
  const rects = faceRects(ANSWER, VIEWPORT);
  assert.equal(rects.length, 2);
  // contain: scale = min(400/800, 200/400) = 0.5, no spare room on either axis
  assert.deepEqual(rects[0], { left: 50, top: 25, width: 50, height: 50 });
  assert.deepEqual(rects[1], { left: 300, top: 0, width: 50, height: 50 });
});

test('a face without a usable box is counted but never blurred', () => {
  const rects = faceRects(
    { frame: FRAME, faces: [ANSWER.faces[0], { score: 0.9, box: {} }] },
    VIEWPORT,
  );
  assert.equal(rects.length, 1);
});

test('no answer with an unusable frame means no made-up rectangles', () => {
  assert.deepEqual(faceRects({ frame: {}, faces: ANSWER.faces }, VIEWPORT), []);
  assert.deepEqual(faceRects(null, VIEWPORT), []);
});

test('the overlay mounts into the CCTV wrap and blurs the faces', () => {
  const dom = stubDom();
  const overlay = createFaceOverlay({
    documentRef: dom,
    ResizeObserverImpl: null,
  });
  overlay.show({ cameraId: 'cam-1', ...ANSWER });
  const mounted = dom.by(FACE_OVERLAY_ID);
  assert.ok(mounted, 'the blur mounts into the CCTV frame wrap');
  assert.equal(mounted.getAttribute('aria-hidden'), 'true');
  const blurs = mounted.children.filter(
    (child) => child.className === FACE_BLUR_CLASS,
  );
  assert.equal(blurs.length, 2);
  assert.equal(blurs[0].style.left, '50px');
  assert.equal(blurs[0].style.top, '25px');
});

test('a second empty answer leaves no blur behind, not a stale blur', () => {
  const dom = stubDom();
  const overlay = createFaceOverlay({
    documentRef: dom,
    ResizeObserverImpl: null,
  });
  overlay.show({ cameraId: 'cam-1', ...ANSWER });
  assert.ok(dom.by(FACE_OVERLAY_ID));
  overlay.show({ cameraId: 'cam-1', frame: FRAME, faces: [] });
  const mounted = dom.by(FACE_OVERLAY_ID);
  const blurs = mounted.children.filter(
    (child) => child.className === FACE_BLUR_CLASS,
  );
  assert.equal(blurs.length, 0, 'an empty face answer draws nothing');
});

test('clear takes the blur off the picture', () => {
  const dom = stubDom();
  const overlay = createFaceOverlay({
    documentRef: dom,
    ResizeObserverImpl: null,
  });
  overlay.show({ cameraId: 'cam-1', ...ANSWER });
  assert.ok(dom.by(FACE_OVERLAY_ID));
  overlay.clear();
  assert.equal(dom.by(FACE_OVERLAY_ID), null);
});

test('a build without the CCTV panel is a no-op, not a throw', () => {
  const overlay = createFaceOverlay({
    documentRef: null,
    ResizeObserverImpl: null,
  });
  assert.doesNotThrow(() => overlay.show({ faces: [] }));
  assert.doesNotThrow(() => overlay.clear());
  assert.doesNotThrow(() => overlay.destroy());
});

test('destroy forgets the answer and stops re-drawing', () => {
  const dom = stubDom();
  const overlay = createFaceOverlay({
    documentRef: dom,
    ResizeObserverImpl: null,
  });
  overlay.show({ cameraId: 'cam-1', ...ANSWER });
  overlay.destroy();
  assert.equal(dom.by(FACE_OVERLAY_ID), null);
  overlay.show({ cameraId: 'cam-1', ...ANSWER });
  assert.equal(dom.by(FACE_OVERLAY_ID), null);
});

/**
 * A minimal document: the CCTV frame media reports the displayed still's
 * size (the frame contained, so half scale in the tests); `cctv-frame-wrap`
 * is the host the overlay mounts into.
 */
function stubDom() {
  /** Appended-and-not-yet-removed overlay elements, by id. */
  const attached = new Map();
  const create = (size) => {
    const children = [];
    let attrs = {};
    let rect = { left: 0, top: 0, width: size.width, height: size.height };
    const el = {
      id: '',
      className: '',
      hidden: false,
      style: {},
      children,
      getBoundingClientRect: () => ({ ...rect }),
      append(child) {
        children.push(child);
        if (child.id) attached.set(child.id, child);
      },
      removeChild(child) {
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
      },
      get firstChild() {
        return children[0] ?? null;
      },
      remove() {
        children.length = 0;
        if (el.id) attached.delete(el.id);
      },
      addEventListener() {},
      removeEventListener() {},
      getAttribute: (name) => attrs[name] ?? null,
      setAttribute: (name, value) => {
        attrs = { ...attrs, [name]: value };
      },
    };
    return el;
  };
  const media = create({ width: 400, height: 200 });
  const wrap = create({ width: 400, height: 200 });
  return {
    by: (id) => attached.get(id) ?? null,
    createElement: () => create({ width: 0, height: 0 }),
    getElementById: (id) =>
      id === 'cctv-frame-wrap' ? wrap : id === 'cctv-frame' ? media : null,
  };
}
