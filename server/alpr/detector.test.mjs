import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeDetections, letterboxPose } from './detector.js';

const FRAME = { width: 518, height: 331 };

test('a wide frame is padded above and below, never stretched', () => {
  const pose = letterboxPose(FRAME.width, FRAME.height, 384);
  assert.equal(pose.scale, 384 / 518);
  assert.equal(pose.scaledWidth, 384);
  assert.equal(pose.scaledHeight, 245);
  assert.equal(pose.padX, 0);
  assert.equal(pose.padY, 69.5);
});

test('a tall frame is padded on the sides', () => {
  const pose = letterboxPose(200, 400, 384);
  assert.equal(pose.scaledWidth, 192);
  assert.equal(pose.scaledHeight, 384);
  assert.equal(pose.padX, 96);
  assert.equal(pose.padY, 0);
});

test('a square frame needs no padding at all', () => {
  const pose = letterboxPose(512, 512, 384);
  assert.deepEqual(
    { padX: pose.padX, padY: pose.padY, scale: pose.scale },
    { padX: 0, padY: 0, scale: 384 / 512 },
  );
});

test('letterbox refuses a frame with no area', () => {
  assert.throws(() => letterboxPose(0, 100), /positive image size/);
});

test('a row is read as [batch, x1, y1, x2, y2, class, score]', () => {
  // The model answered in letterboxed pixels; y carries the 69.5 px pad.
  const output = {
    dims: [1, 2, 7],
    data: [
      0, 227.6, 208.6, 287.0, 225.2, 0, 0.842, 0, 1.0, 138.8, 10.5, 147.2, 0,
      0.294,
    ],
  };
  const found = decodeDetections(
    output,
    letterboxPose(FRAME.width, FRAME.height, 384),
    FRAME,
  );
  assert.equal(found.length, 1, 'the 0.29 row is under the floor');
  const [box] = found;
  assert.deepEqual(
    { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 },
    { x1: 307, y1: 188, x2: 387, y2: 210 },
  );
  assert.ok(Math.abs(box.score - 0.842) < 0.001);
});

test('boxes are clipped to the frame instead of escaping it', () => {
  const output = {
    dims: [1, 1, 7],
    data: [0, -40, -40, 900, 900, 0, 0.99],
  };
  const [box] = decodeDetections(
    output,
    letterboxPose(FRAME.width, FRAME.height, 384),
    FRAME,
  );
  assert.deepEqual(
    { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 },
    { x1: 0, y1: 0, x2: FRAME.width, y2: FRAME.height },
  );
});

test('an inverted box is read as a box, not as an empty one', () => {
  const output = { dims: [1, 1, 7], data: [0, 300, 200, 250, 190, 0, 0.9] };
  const [box] = decodeDetections(
    output,
    letterboxPose(FRAME.width, FRAME.height, 384),
    FRAME,
  );
  assert.ok(box.x2 > box.x1 && box.y2 > box.y1);
});

test('a degenerate box is dropped, not returned as a crop', () => {
  const output = { dims: [1, 1, 7], data: [0, 100, 100, 100.5, 100.5, 0, 0.9] };
  assert.deepEqual(
    decodeDetections(
      output,
      letterboxPose(FRAME.width, FRAME.height, 384),
      FRAME,
    ),
    [],
  );
});

test('the best boxes come first and the limit holds', () => {
  // Inside the letterboxed band: y1/y2 must survive the 69.5 px pad.
  const rows = [0.5, 0.9, 0.7].map((score) => [
    0, 10, 120, 60, 160, 0, score,
  ]);
  const found = decodeDetections(
    { dims: [1, 3, 7], data: rows.flat() },
    letterboxPose(FRAME.width, FRAME.height, 384),
    FRAME,
    { limit: 2 },
  );
  assert.deepEqual(
    found.map((box) => box.score),
    [0.9, 0.7],
  );
});

test('an output with too few columns is refused rather than misread', () => {
  assert.throws(
    () =>
      decodeDetections(
        { dims: [1, 2, 5], data: [0, 1, 2, 3, 4, 0, 1, 2, 3, 4] },
        letterboxPose(FRAME.width, FRAME.height, 384),
        FRAME,
      ),
    /expected 7/,
  );
});
