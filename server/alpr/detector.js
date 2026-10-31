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
