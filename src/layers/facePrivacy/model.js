/**
 * Face-privacy wording and payload checks, without a DOM or a fetch.
 *
 * The layer answers one question about one camera: which people are visible
 * in its current frame, so the operator can blur them before sharing the
 * picture. This module keeps the small amount of arithmetic and formatting
 * that answer needs, so the layer above it only talks to the source and to
 * the panel.
 * @module layers/facePrivacy/model
 */

/** Stable id: it names the panel row, the layer state token and the source. */
export const FACE_LAYER_ID = 'face-privacy';

/** Confidence shown with a face, as a whole percentage. */
export function confidencePercent(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(Math.max(value, 0), 1) * 100);
}

/**
 * One face, as the row shows it: what it is, then how sure the detector was.
 * A name is never shown — there is no roster consulted here — only a face
 * count and a confidence, because identity is a consent decision the
 * operator makes elsewhere, not something this row claims for them.
 *
 * @param {{score?:number}} face
 * @returns {string|null} `98%`, or null when there is nothing to show.
 */
export function formatFace(face) {
  const percent = confidencePercent(face?.score);
  return percent === null ? null : `${percent}%`;
}

/** True when a response carries the shape this layer renders. */
export function isFacePayload(payload) {
  return Boolean(payload) && Array.isArray(payload.faces);
}

/**
 * The faces of one response, formatted, best (highest score) first.
 *
 * The server already sorts by detector score; this keeps that order.
 *
 * @param {{faces?:Array<object>}} payload
 * @returns {number} How many faces the response saw.
 */
export function faceCount(payload) {
  if (!isFacePayload(payload)) return 0;
  return payload.faces.length;
}

/**
 * Whether a payload's faces came from the server's short-lived cache.
 *
 * The row says so: two reads a second apart see the same people because they
 * are the same answer, not because a second inference agreed.
 */
export function isCachedAnswer(payload) {
  return Boolean(payload?.cached);
}
