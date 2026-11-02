import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARC_LANDMARKS,
  decodeScrfdStride,
  intersectionOverUnion,
  keepBestFaces,
  scrfdAnchors,
  similarityTransform,
  unscaleFaces,
} from './detector.js';

test('the anchor grid squares with the tensor sizes the detector emits', () => {
  // det_500m at 640: 12800/3200/800 anchors per stride, with two per cell.
  assert.equal(scrfdAnchors(8, 640).length, 12800);
  assert.equal(scrfdAnchors(16, 640).length, 3200);
  assert.equal(scrfdAnchors(32, 640).length, 800);
  // x varies fastest, both anchors of a cell adjacent.
  const first = scrfdAnchors(16, 64);
  assert.deepEqual(first[0], [0, 0]);
  assert.deepEqual(first[1], [0, 0]);
  assert.deepEqual(first[2], [16, 0]);
  assert.deepEqual(first[3], [16, 0]);
});

test('a ltrb distance box decodes into frame detector coordinates', () => {
  const row = {
    scores: new Float32Array([0.9]),
    boxes: new Float32Array([1, 2, 3, 4]),
    kps: new Float32Array([-0.5, 0, 0.5, 0, 0, -0.5, 0, 0.5, 0, 0.25]),
    count: 1,
  };
  const [face] = decodeScrfdStride(row, 8, { threshold: 0.5, size: 64 });
  // Anchor [0,0]: l/t subtract, r/b add, distances scaled by the stride.
  assert.deepEqual(face.box, { x1: -8, y1: -16, x2: 24, y2: 32 });
  assert.deepEqual(face.landmarks[0], { x: -4, y: 0 });
  assert.ok(Math.abs(face.score - 0.9) < 1e-6, `score ${face.score}`);
});

test('a stride row below the threshold is dropped before any box work', () => {
  const row = {
    scores: new Float32Array([0.4]),
    boxes: new Float32Array([1, 1, 1, 1]),
    kps: new Float32Array(10),
    count: 1,
  };
  assert.equal(decodeScrfdStride(row, 8).length, 0);
});

test('iou of identical boxes is one, of disjoint boxes is zero', () => {
  const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
  assert.equal(intersectionOverUnion(a, a), 1);
  assert.equal(
    intersectionOverUnion(a, { x1: 100, y1: 100, x2: 200, y2: 200 }),
    0,
  );
});

test('three strides seeing one face leave one box', () => {
  const mk = (score, x1, y1, x2, y2) => ({
    score,
    box: { x1, y1, x2, y2 },
    landmarks: ARC_LANDMARKS.map(([x, y]) => ({ x: x + x1, y: y + y1 })),
  });
  const faces = [
    mk(0.72, 100, 100, 200, 200),
    mk(0.69, 102, 104, 202, 204),
    mk(0.58, 99, 101, 199, 201),
    mk(0.8, 400, 400, 460, 460),
  ];
  const kept = keepBestFaces(faces);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].score, 0.8);
  assert.equal(kept[1].score, 0.72);
});

test('a sliver of a box cannot enter the answer as a face', () => {
  const faces = [
    { score: 0.9, box: { x1: 0, y1: 0, x2: 5, y2: 5 }, landmarks: [] },
    { score: 0.8, box: { x1: 10, y1: 10, x2: 40, y2: 40 }, landmarks: [] },
  ];
  assert.equal(keepBestFaces(faces).length, 1);
});

test('detector coordinates come back through the letterbox', () => {
  const pose = { scale: 0.5, padX: 10, padY: 20 };
  const [[face]] = [unscaleFaces(
    [{ score: 1, box: { x1: 20, y1: 40, x2: 120, y2: 140 }, landmarks: [{ x: 30, y: 50 }] }],
    pose,
  )];
  assert.deepEqual(face.box, { x1: 20, y1: 40, x2: 220, y2: 240 });
  assert.deepEqual(face.landmarks[0], { x: 40, y: 60 });
});

test('the similarity warp sends detector landmarks onto the template', () => {
  // A synthetic face: template landmarks displaced, rotated 90° and scaled 2x.
  const points = ARC_LANDMARKS.map(([x, y]) => ({ x: 500 - 2 * y, y: 500 + 2 * x }));
  const t = similarityTransform(points, ARC_LANDMARKS);
  // Forward map one point: ax x + ay y + tx must equal its template x.
  const { x: lx, y: lyr } = points[0];
  const mappedX = t.ax * lx + t.ay * lyr + t.tx;
  const mappedY = t.bx * lx + t.by * lyr + t.ty;
  assert.ok(Math.abs(mappedX - ARC_LANDMARKS[0][0]) < 1e-6, `${mappedX}`);
  assert.ok(Math.abs(mappedY - ARC_LANDMARKS[0][1]) < 1e-6, `${mappedY}`);
});

test('the inverse map stays consistent with the forward one', () => {
  const points = ARC_LANDMARKS.map(([x, y]) => ({ x: 120 + 0.9 * x, y: 300 - 0.9 * y }));
  const t = similarityTransform(points, ARC_LANDMARKS);
  const determinant = t.ax * t.by - t.ay * t.bx;
  const { x: px, y: py } = points[2];
  // Forward then invert lands back on the point.
  const fx = t.ax * px + t.ay * py + t.tx;
  const fy = t.bx * px + t.by * py + t.ty;
  const sx = (t.by * (fx - t.tx) - t.ay * (fy - t.ty)) / determinant;
  const sy = (-t.bx * (fx - t.tx) + t.ax * (fy - t.ty)) / determinant;
  assert.ok(Math.abs(sx - px) < 1e-6, `${sx} vs ${px}`);
  assert.ok(Math.abs(sy - py) < 1e-6, `${sy} vs ${py}`);
});

test('degenerate landmarks degrade to an identity centre map, not NaN', () => {
  const allSame = ARC_LANDMARKS.map(() => ({ x: 5, y: 5 }));
  const t = similarityTransform(allSame, ARC_LANDMARKS);
  for (const key of ['ax', 'ay', 'bx', 'by', 'tx', 'ty'])
    assert.equal(Number.isFinite(t[key]), true, key);
});
