/**
 * Letterbox geometry and YOLOv9 plate-box decoding, without any runtime.
 *
 * Ported from `open-image-models` (MIT), whose preprocessing resizes with a
 * plain bilinear filter, pads with (114,114,114) and feeds RGB/255 in CHW
 * order, and whose postprocess reads each row as
 * `[batch, x1, y1, x2, y2, class, score]` — the end2end export already has NMS
 * applied, so there is no IoU pass here. Every function in this module is pure:
 * the engine owns the pixels, this module owns the arithmetic, and the tests
 * can check the arithmetic with plain arrays.
 * @module server/alpr/detector
 */
import { ALPR_DETECTOR_SIZE } from './models.js';

/** RGB value YOLO pads with; the model was trained with it. */
export const LETTERBOX_FILL = 114;

/** One detected plate, in original-image pixels. */
export const DETECTOR_COLUMNS = 7;

/**
 * Tiles a wide frame is split into, at most.
 *
 * A tile is one detector run, so this is also the cost ceiling of one read:
 * nine tiles plus the whole-frame pass is ten runs, measured at about 0.4 s of
 * detector time for a 1280×720 frame on a workstation — a few seconds on the
 * hosted instance — against twenty runs for a 4K frame tiled one-to-one.
 */
export const TILE_MAX_COUNT = 9;

/**
 * Where the resized image sits inside the square model input.
 *
 * Mirrors the Python `letterbox`: the scale is the smaller of the two axis
 * ratios (never upscaled away from 1:1 aspect), the scaled size is rounded,
 * and the remaining space is split evenly.
 *
 * @param {number} width Source width in pixels.
 * @param {number} height Source height in pixels.
 * @param {number} [size] Square model input side.
 * @returns {{scale:number, scaledWidth:number, scaledHeight:number,
 *   padX:number, padY:number, size:number}}
 */
export function letterboxPose(width, height, size = ALPR_DETECTOR_SIZE) {
  if (!(width > 0) || !(height > 0))
    throw new TypeError('Letterbox needs a positive image size');
  const scale = Math.min(size / height, size / width);
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  return {
    scale,
    scaledWidth,
    scaledHeight,
    padX: (size - scaledWidth) / 2,
    padY: (size - scaledHeight) / 2,
    size,
  };
}

/**
 * Cover one axis with `count` tiles of the detector's own size.
 *
 * The model is trained on plates a few dozen pixels wide, so a tile is cut at
 * native resolution rather than shrunk into the input: a 1280×720 frame read
 * whole is scaled to 0.3, which erases a plate 145 m away, while the same frame
 * cut into 384 px tiles is read at 1:1. When the frame is too large for the tile
 * budget, tiles grow past the input size and are downscaled again — coverage
 * wins over resolution there, because a gap is a blind spot and a soft tile is
 * not.
 *
 * The step is even, so neighbouring tiles always overlap: the last tile ends on
 * the frame's edge, not short of it, and a plate straddling a seam is whole in
 * the tile beside it.
 */
function coverAxis(total, count, size) {
  // One tile on this axis spans it whole — including a frame taller than the
  // detector input, where the tile is downscaled into the input instead of
  // leaving a strip the reader never looks at.
  if (count <= 1) return [{ start: 0, length: total }];
  const length = Math.min(total, Math.max(size, Math.ceil(total / count)));
  const step = (total - length) / (count - 1);
  const spans = [];
  for (let index = 0; index < count; index += 1)
    spans.push({ start: Math.round(index * step), length });
  return spans;
}

/**
 * Cut a frame too large for the detector input into overlapping tiles.
 *
 * Returns an empty list for a frame that already fits: its single pass is at
 * 1:1 or better, and cutting it would only spend runs on the same pixels.
 *
 * @param {{width:number, height:number}} frame Source image size.
 * @param {{size?:number, maxTiles?:number}} [options] Detector input side and
 *   the tile budget.
 * @returns {Array<{left:number, top:number, width:number, height:number}>}
 */
export function planTiles(
  frame,
  { size = ALPR_DETECTOR_SIZE, maxTiles = TILE_MAX_COUNT } = {},
) {
  if (!(frame?.width > 0) || !(frame?.height > 0))
    throw new TypeError('Tiling needs a positive image size');
  if (frame.width <= size && frame.height <= size) return [];

  const budget = Math.max(1, Math.floor(maxTiles));
  let cols = Math.ceil(frame.width / size);
  let rows = Math.ceil(frame.height / size);
  if (cols * rows > budget) {
    const shrink = Math.sqrt(budget / (cols * rows));
    cols = Math.max(1, Math.min(cols, Math.round(cols * shrink)));
    rows = Math.max(1, Math.min(rows, Math.round(rows * shrink)));
    // Rounding can overshoot the budget by one: give the extra back to the
    // longer axis, where a wider tile loses the least detail.
    while (cols * rows > budget) {
      if (rows >= cols && rows > 1) rows -= 1;
      else if (cols > 1) cols -= 1;
      else break;
    }
  }

  // A budget of one tile lands back on the whole frame, which the reader
  // already runs: returning it would read the same pixels twice.
  if (cols === 1 && rows === 1) return [];

  const tiles = [];
  for (const row of coverAxis(frame.height, rows, size))
    for (const col of coverAxis(frame.width, cols, size))
      tiles.push({
        left: col.start,
        top: row.start,
        width: col.length,
        height: row.length,
      });
  return tiles;
}

/** Overlap of two boxes over their union; 0 when they miss each other. */
function iou(a, b) {
  const width = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const height = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (width <= 0 || height <= 0) return 0;
  const overlap = width * height;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  const union = areaA + areaB - overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * Collapse the boxes several passes found into one list, best first.
 *
 * Overlapping tiles see the same plate twice, and the whole-frame pass sees it
 * a third time; without this a row would list one car two or three times. Two
 * boxes that cover more than half of each other are the same plate — a plate
 * seen from two tiles differs by a few pixels at its edges, never by half its
 * area — so the weaker one is dropped. Distinct plates never overlap that much,
 * even parked bumper to bumper.
 *
 * A box cut by a tile edge (`truncated`) is dropped outright: the plate
 * continues into the tile beside it, and the letters that fell inside this one
 * are not a registration. Tiles overlap by more than a plate is wide, so every
 * plate narrow enough to matter is seen whole by at least one of them — the
 * fragment is never the only copy, and reporting it was how a plate on a seam
 * came out as `13C`.
 *
 * @param {Array<{x1:number,y1:number,x2:number,y2:number,score:number,
 *   truncated?:boolean}>} boxes
 * @param {{limit?:number, overlap?:number}} [options]
 * @returns {Array<object>} At most `limit` boxes, highest score first.
 */
export function mergeBoxes(boxes, { limit = 8, overlap = 0.5 } = {}) {
  const kept = [];
  for (const box of [...(boxes || [])].sort((a, b) => b.score - a.score)) {
    if (kept.length >= Math.max(1, limit)) break;
    if (box.truncated) continue;
    if (kept.some((other) => iou(box, other) > overlap)) continue;
    kept.push(box);
  }
  return kept;
}

/** Row count and stride of a `[1, n, 7]` or `[n, 7]` detector output. */
export function detectorShape(dims) {
  if (!Array.isArray(dims) || dims.length < 2)
    throw new TypeError('Detector output needs at least two dimensions');
  const stride = dims[dims.length - 1];
  const rows = dims[dims.length - 2];
  if (stride < DETECTOR_COLUMNS)
    throw new TypeError(`Detector output has ${stride} columns, expected 7`);
  return { rows, stride };
}

/** A model box, clipped back to the source image. */
function clip(value, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), max);
}

/**
 * Width to height a plate can have: one line of glyphs, and nothing else.
 *
 * A standard panel is 2:1 (a US 300×150 mm plate) to 4.7:1 (an EU 520×110), and
 * the detector's box sits a few percent wide of the panel, so the band runs
 * from 1.9 to 8. Below it is a shape whose height is two lines of text — the
 * green "Colorado / 300 ST 200" street sign that tiled reads returned as
 * `COI0T0Q00T` measured 1.8 — and above it is a strip, a caption or a run of
 * pixels along a kerb. Square motorcycle plates fall below the floor and are
 * dropped with the signs: missing one is the price of not printing a sign as a
 * car's registration.
 */
export const PLATE_BAND_ASPECT = Object.freeze({ min: 1.9, max: 8 });

/**
 * Whether a box is shaped like a plate band rather than a sign or a caption.
 *
 * @param {{x1:number,y1:number,x2:number,y2:number}} box Box in frame pixels.
 * @param {{min?:number, max?:number}} [range] Aspect bounds, replaced by the
 *   tests.
 * @returns {boolean}
 */
export function isPlateBand(
  box,
  { min = PLATE_BAND_ASPECT.min, max = PLATE_BAND_ASPECT.max } = {},
) {
  const width = Number(box?.x2) - Number(box?.x1);
  const height = Number(box?.y2) - Number(box?.y1);
  if (!(width > 0) || !(height > 0)) return false;
  const aspect = width / height;
  return aspect >= min && aspect <= max;
}

/**
 * Turn raw detector rows into boxes in original-image coordinates.
 *
 * The model answers in letterboxed pixels, so the padding comes off first and
 * the scale is undone after. Boxes are then clipped to the frame and empty ones
 * dropped: a plate half outside the shot still has a usable crop, a degenerate
 * box does not.
 *
 * @param {{data:ArrayLike<number>, dims:number[]}} output Raw session output.
 * @param {{scale:number, padX:number, padY:number}} pose From `letterboxPose`.
 * @param {{width:number, height:number}} frame Source image size.
 * @param {{threshold?:number, limit?:number}} [options] Confidence floor and
 *   how many boxes to keep, best first.
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number,score:number}>}
 */
export function decodeDetections(
  output,
  pose,
  frame,
  { threshold = 0.4, limit = 8 } = {},
) {
  const { rows, stride } = detectorShape(output.dims);
  const data = output.data;
  const found = [];
  for (let row = 0; row < rows; row += 1) {
    const base = row * stride;
    const score = Number(data[base + 6]);
    if (!Number.isFinite(score) || score < threshold) continue;
    const x1 = (Number(data[base + 1]) - pose.padX) / pose.scale;
    const y1 = (Number(data[base + 2]) - pose.padY) / pose.scale;
    const x2 = (Number(data[base + 3]) - pose.padX) / pose.scale;
    const y2 = (Number(data[base + 4]) - pose.padY) / pose.scale;
    const box = {
      x1: Math.round(clip(Math.min(x1, x2), frame.width)),
      y1: Math.round(clip(Math.min(y1, y2), frame.height)),
      x2: Math.round(clip(Math.max(x1, x2), frame.width)),
      y2: Math.round(clip(Math.max(y1, y2), frame.height)),
      score,
    };
    if (box.x2 - box.x1 < 2 || box.y2 - box.y1 < 2) continue;
    found.push(box);
  }
  found.sort((a, b) => b.score - a.score);
  return found.slice(0, Math.max(1, limit));
}
