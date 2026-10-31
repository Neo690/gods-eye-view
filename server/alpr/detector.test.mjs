import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeDetections,
  letterboxPose,
  mergeBoxes,
  planTiles,
} from './detector.js';

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

/* The tile plan decides what a wide camera is worth reading at. */

/** Whether every tile sits inside the frame. */
function insideFrame(tiles, frame) {
  return tiles.every(
    (tile) =>
      tile.left >= 0 &&
      tile.top >= 0 &&
      tile.left + tile.width <= frame.width &&
      tile.top + tile.height <= frame.height,
  );
}

/** The furthest pixel any tile reaches, on each axis. */
function reached(tiles) {
  return {
    x: Math.max(...tiles.map((tile) => tile.left + tile.width)),
    y: Math.max(...tiles.map((tile) => tile.top + tile.height)),
  };
}

test('a 1280x720 camera is read in 1:1 tiles, not shrunk into one input', () => {
  const frame = { width: 1280, height: 720 };
  const tiles = planTiles(frame);
  assert.equal(tiles.length, 8, 'four columns, two rows');
  assert.ok(insideFrame(tiles, frame));
  assert.deepEqual(reached(tiles), { x: frame.width, y: frame.height });
  // Every tile fits the detector input, so each is read without a downscale:
  // the whole frame would have been scaled to 0.3 and lost the plate.
  assert.ok(tiles.every((tile) => tile.width <= 384 && tile.height <= 384));
  assert.deepEqual(tiles[0], { left: 0, top: 0, width: 384, height: 384 });
});

test('neighbouring tiles overlap, so no plate falls in a seam', () => {
  const frame = { width: 1280, height: 720 };
  const [first, second] = planTiles(frame);
  assert.ok(second.left < first.left + first.width, 'columns overlap');
  const sameColumn = planTiles(frame).find((tile) => tile.top > 0);
  assert.ok(sameColumn.top < first.top + first.height, 'rows overlap');
});

test('a frame that already fits the detector input is read in one pass', () => {
  assert.deepEqual(planTiles({ width: 352, height: 288 }), []);
  assert.deepEqual(planTiles({ width: 384, height: 384 }), []);
  assert.deepEqual(planTiles({ width: 300, height: 384 }), []);
  // Taller than the input on one axis is not "fits": its single pass still
  // loses a third of the picture's resolution, so it is cut into two.
  assert.equal(planTiles({ width: 300, height: 600 }).length, 2);
});

test('the tile budget caps the runs without leaving the frame uncovered', () => {
  for (const frame of [
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
    { width: 800, height: 600 },
    { width: 4096, height: 512 },
  ]) {
    const tiles = planTiles(frame, { maxTiles: 9 });
    assert.ok(tiles.length <= 9, `${frame.width}x${frame.height}: ${tiles.length}`);
    assert.ok(insideFrame(tiles, frame));
    assert.deepEqual(reached(tiles), { x: frame.width, y: frame.height });
  }
});

test('a tile plan needs a frame with area', () => {
  assert.throws(() => planTiles({ width: 0, height: 100 }), /positive image size/);
  assert.throws(() => planTiles(undefined), /positive image size/);
});

test('the same plate seen by two tiles is reported once, best score first', () => {
  const merged = mergeBoxes([
    { x1: 900, y1: 400, x2: 970, y2: 424, score: 0.91 },
    // The neighbouring tile found it a couple of pixels off.
    { x1: 902, y1: 401, x2: 968, y2: 423, score: 0.88 },
    { x1: 100, y1: 100, x2: 170, y2: 124, score: 0.6 },
  ]);
  assert.deepEqual(
    merged.map((box) => box.score),
    [0.91, 0.6],
  );
});

test('a plate cut by a tile edge is never reported as a plate', () => {
  // What the tile beside the seam read: three letters of a longer plate.
  const merged = mergeBoxes([
    { x1: 0, y1: 400, x2: 39, y2: 436, score: 0.79, truncated: true },
    { x1: 900, y1: 100, x2: 970, y2: 124, score: 0.6 },
  ]);
  assert.deepEqual(
    merged.map((box) => box.x1),
    [900],
  );
});

test('two plates parked bumper to bumper stay two plates', () => {
  const merged = mergeBoxes([
    { x1: 100, y1: 100, x2: 160, y2: 124, score: 0.9 },
    { x1: 164, y1: 100, x2: 224, y2: 124, score: 0.8 },
  ]);
  assert.equal(merged.length, 2);
});

test('the merged list keeps the requested number of plates', () => {
  const boxes = [0.9, 0.8, 0.7].map((score, index) => ({
    x1: index * 100,
    y1: 0,
    x2: index * 100 + 60,
    y2: 24,
    score,
  }));
  assert.deepEqual(
    mergeBoxes(boxes, { limit: 2 }).map((box) => box.score),
    [0.9, 0.8],
  );
  assert.deepEqual(mergeBoxes([], { limit: 2 }), []);
});
