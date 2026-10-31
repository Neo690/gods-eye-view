/**
 * Plate-reader wording and payload checks, without a DOM or a fetch.
 *
 * The reader answers one question about one camera: what plates are visible in
 * its current frame. This module keeps the small amount of arithmetic and
 * formatting that answer needs, so the layer above it only talks to the source
 * and to the panel.
 * @module layers/alprReader/model
 */

/** Stable id: it names the panel row, the layer state token and the source. */
export const PLATE_READER_LAYER_ID = 'plate-reader';

/** Confidence shown with the text, as a whole percentage. */
export function confidencePercent(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(Math.max(value, 0), 1) * 100);
}

/**
 * One plate, as the row shows it: the text, then how sure the OCR was.
 *
 * @param {{text?:string, confidence?:number}} plate
 * @returns {string|null} `AB-123-CD · 98%`, or null when there is no text.
 */
export function formatPlate(plate) {
  const text = typeof plate?.text === 'string' ? plate.text.trim() : '';
  if (!text) return null;
  const percent = confidencePercent(plate.confidence);
  return percent === null ? text : `${text} · ${percent}%`;
}

/** True when a response carries the shape this layer renders. */
export function isPlatePayload(payload) {
  return Boolean(payload) && Array.isArray(payload.plates);
}

/**
 * The plates of one response, formatted, best first.
 *
 * The server already sorts by detector score; this keeps that order and drops
 * anything that decoded to nothing.
 *
 * @param {{plates?:Array<object>}} payload
 * @returns {string[]} Formatted plates, possibly empty.
 */
export function plateLines(payload) {
  if (!isPlatePayload(payload)) return [];
  return payload.plates.map(formatPlate).filter(Boolean);
}

/**
 * Whether a payload's plates came from the server's short-lived cache.
 *
 * The row says so: two reads a second apart show the same text because they
 * are the same answer, not because a second inference agreed.
 */
export function isCachedAnswer(payload) {
  return Boolean(payload?.cached);
}
