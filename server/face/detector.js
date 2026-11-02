/**
 * The face detector's geometry: SCRFD decoding, deduplication and the
 * alignment warp the recognizer needs.
 *
 * Everything here is pure math over decoded pixel layouts, so the tests can
 * feed synthetic strides without weights. The onnx side that runs them lives
 * in `engine.js`.
 *
 * Reference for the decode: `insightface/model_zoo/scrfd.py` (MIT), which the
 * buffalo_s exports follow. The three strides (8/16/32) emit anchors per grid
 * cell — two per cell — as distances from the anchor centre in stride units,
 * plus five landmark offsets. `det_500m.onnx` answers 9 tensors: scores, boxes
 * and landmarks, per stride, in that order.
 * @module server/face/detector
 */

/** Highest face count returned per frame: a stadium wide shot is not the goal;
 * a widget doing privacy blur wants a bounded list. */
export const FACE_MAX_DETECTIONS = 24;

/** Stride order the model emits its tensors in. */
export const SCRFD_STRIDES = Object.freeze([8, 16, 32]);

/** Anchor count per grid cell on the fmc=3 export (det_500m). */
export const SCRFD_ANCHORS_PER_CELL = 2;

/**
 * The detector's own confidence floor. SCRFD scores are sharp: a face lands
 * above 0.7, a lampshade or a print below 0.4. The route can ask for a stricter
 * one; it cannot ask for a looser one.
 */
export const FACE_MIN_SCORE = 0.5;

/** Below this, in pixels, a "face" cannot be blurred with any certainty:
 * detector boxes 12 px across are most often lapels and chair prints. */
export const FACE_MIN_BOX_PX = 12;

/** NMS overlap above which two boxes are the same face. */
export const FACE_NMS_THRESHOLD = 0.4;

/** 5-point template ACT used by ArcFace's 112x112 crops, as [x, y] pairs. */
export const ARC_LANDMARKS = Object.freeze([
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]);

/**
 * Where the detector's grid cells sit, for one stride.
 *
 * The ONNX tensors are flattened row-major over the feature grid, x varying
 * fastest, with each cell's two anchors adjacent. Returning exactly that order
 * lets the decode index the tensors directly.
 *
 * @param {number} stride 8, 16 or 32.
 * @param {number} size Square input side the grid derives from.
 * @returns {Array<[number, number]>} Anchor centres in input coords.
 */
export function scrfdAnchors(stride, size) {
  const cells = Math.max(1, Math.min(4096, Math.floor(size / stride)));
  const anchors = [];
  for (let row = 0; row < cells; row += 1)
    for (let col = 0; col < cells; col += 1)
      for (let dup = 0; dup < SCRFD_ANCHORS_PER_CELL; dup += 1)
        anchors.push([col * stride, row * stride]);
  return anchors;
}

/**
 * Decode one stride's raw tensors into candidate faces.
 *
 * Boxes are ltrb distances from the anchor centre, in stride units: left and
 * top subtract, right and bottom add. Landmarks are offsets from the anchor,
 * also in stride units, five (x, y) pairs.
 *
 * @param {{scores: Float32Array, boxes: Float32Array, kps: Float32Array,
 *   count: number}} strideTensor
 * @param {number} stride
 * @param {{threshold:number, size:number}} options
 * @returns {Array<{score:number, box:{x1:number,y1:number,x2:number,y2:number},
 *   landmarks:{x:number,y:number}[]}>}
 */
export function decodeScrfdStride(
  { scores, boxes, kps, count },
  stride,
  { threshold = FACE_MIN_SCORE, size = 640 } = {},
) {
  const anchors = scrfdAnchors(stride, size);
  const faces = [];
  const safeCount = Math.min(
    count ?? anchors.length,
    anchors.length,
    scores.length,
  );
  for (let i = 0; i < safeCount; i += 1) {
    const score = scores[i];
    if (!(score >= threshold) || score > 1) continue;
    const [ax, ay] = anchors[i];
    const bi = i * 4;
    const box = {
      x1: ax - boxes[bi] * stride,
      y1: ay - boxes[bi + 1] * stride,
      x2: ax + boxes[bi + 2] * stride,
      y2: ay + boxes[bi + 3] * stride,
    };
    const ki = i * 10;
    const landmarks = [];
    for (let k = 0; k < 5; k += 1)
      landmarks.push({
        x: ax + kps[ki + 2 * k] * stride,
        y: ay + kps[ki + 2 * k + 1] * stride,
      });
    faces.push({ score, box, landmarks });
  }
  return faces;
}

/** @see computeIoU */
export function intersectionOverUnion(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return inter / Math.max(1e-9, areaA + areaB - inter);
}

/**
 * Keep the highest-score box and drop everything it covers.
 *
 * Three strides each find the same face and the model's own NMS never sees
 * across them, so the merge is this module's job and happens over the whole
 * frame at once.
 *
 * @param {Array<object>} faces Unsorted candidates.
 * @param {{limit:number, overlapThreshold:number, minBoxPx:number}} [options]
 */
export function keepBestFaces(
  faces,
  {
    limit = FACE_MAX_DETECTIONS,
    overlapThreshold = FACE_NMS_THRESHOLD,
    minBoxPx = FACE_MIN_BOX_PX,
  } = {},
) {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const face of sorted) {
    if (kept.length >= limit) break;
    const { x1, y1, x2, y2 } = face.box;
    if (Math.max(0, x2 - x1) < minBoxPx || Math.max(0, y2 - y1) < minBoxPx)
      continue;
    const overlapping = kept.some(
      (keptFace) =>
        intersectionOverUnion(keptFace.box, face.box) > overlapThreshold,
    );
    if (overlapping) continue;
    kept.push(face);
  }
  return kept;
}

/**
 * Map decoded coordinates back to the frame, undoing the letterbox.
 *
 * The detector sees the letterboxed square; the caller wants frame pixels.
 * `pose` is what `letterboxPose` returned for the same frame.
 *
 * @param {Array<object>} faces Faces with box/landmarks in detector coords.
 * @param {{scale:number, padX:number, padY:number}} pose
 */
export function unscaleFaces(faces, pose) {
  const { scale, padX, padY } = pose;
  return faces.map((face) => ({
    ...face,
    box: {
      x1: (face.box.x1 - padX) / scale,
      y1: (face.box.y1 - padY) / scale,
      x2: (face.box.x2 - padX) / scale,
      y2: (face.box.y2 - padY) / scale,
    },
    landmarks: face.landmarks.map((point) => ({
      x: (point.x - padX) / scale,
      y: (point.y - padY) / scale,
    })),
  }));
}

/**
 * Least-squares similarity transform (rotation + uniform scale) from `src`
 * points to `dst` points, as coefficients for the 2x2 matrix [ax ay; bx by]
 * plus translation. Closed form over the cross-covariance; 5 landmark pairs
 * are plenty and the solve is exact for them.
 *
 * @param {Array<{x:number,y:number}>} src Detector landmarks.
 * @param {Array<[number, number]>} dst Template landmarks (ARC_LANDMARKS).
 * @returns {{ax:number,ay:number,bx:number,by:number,tx:number,ty:number}}
 */
export function similarityTransform(src, dst) {
  const n = Math.min(src.length, dst.length);
  let mx = 0;
  let my = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    mx += src[i].x;
    my += src[i].y;
    dx += dst[i][0];
    dy += dst[i][1];
  }
  mx /= n;
  my /= n;
  dx /= n;
  dy /= n;
  const variance =
    src.reduce(
      (acc, point) =>
        acc + (point.x - mx) ** 2 + (point.y - my) ** 2,
      0,
    ) / n;
  let covxx = 0;
  let covxy = 0;
  let covyx = 0;
  let covyy = 0;
  for (let i = 0; i < n; i += 1) {
    const sx = src[i].x - mx;
    const sy = src[i].y - my;
    const tx = dst[i][0] - dx;
    const ty = dst[i][1] - dy;
    covxx += tx * sx;
    covxy += tx * sy;
    covyx += ty * sx;
    covyy += ty * sy;
  }
  // dst ≈ [[ax, ay],[bx, by]] src + t, with the matrix constrained to a
  // rotation times a scale: dst_x ≈ ax sx + ay sy, dst_y ≈ bx sx + by sy.
  // Both the covariance and the variance are means, so the solve does not
  // drift with the number of correspondences.
  const rotationA = (covxx + covyy) / n;
  const rotationB = (covyx - covxy) / n;
  const norm = Math.hypot(rotationA, rotationB);
  if (!norm || !variance) {
    // Degenerate landmarks (all coincident): fall through to an identity-sized
    // centre crop rather than divide by zero.
    return { ax: 1, ay: 0, bx: 0, by: 1, tx: dx - mx, ty: dy - my };
  }
  const scale = norm / variance;
  const ax = (rotationA / norm) * scale;
  const ay = (-rotationB / norm) * scale;
  const bx = (rotationB / norm) * scale;
  const by = (rotationA / norm) * scale;
  return {
    ax,
    ay,
    bx,
    by,
    tx: dx - (ax * mx + ay * my),
    ty: dy - (bx * mx + by * my),
  };
}
