/**
 * Dataset identity of a camera's hardware, when the server's catalog join
 * (server/providers/cctv/cameraDb.js) confirmed one against the bundled
 * cctv-camera-database snapshot. The ref is a dataset row id
 * ("cohu-3950-iview"); the match says how the source's own `model` string
 * reached it — 'exact' after a known brand peel, 'series' when a bare
 * numbering named the longer dataset title.
 *
 * Both live on the wire, so both are validated before the HUD renders them:
 * a malformed ref or an unknown grade behaves exactly like no confirmation.
 */
const MATCH_GRADES = new Set(['exact', 'series']);
const REF_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The camera's confirmed dataset identity.
 * @param {Object} camera - Catalog camera (see catalog.js).
 * @returns {{ref:string, match:'exact'|'series'}|null} Null when the join
 *   confirmed nothing.
 */
export function datasetModelRef(camera) {
  const { modelRef, modelMatch } = camera || {};
  if (typeof modelRef !== 'string' || typeof modelMatch !== 'string')
    return null;
  const ref = modelRef.trim().toLowerCase();
  const match = modelMatch.trim().toLowerCase();
  if (!REF_SLUG.test(ref) || !MATCH_GRADES.has(match)) return null;
  return { ref, match };
}

/**
 * HUD token naming the dataset row that confirmed the camera's hardware.
 * @param {Object} camera - Catalog camera (see catalog.js).
 * @param {(ref: string, match: 'exact'|'series') => string} [format] - Builds
 *   the token; the HUD passes a translated one.
 * @returns {string|null} e.g. 'MODEL COHU-3950-IVIEW (DATASET SERIES)', or
 *   null when no confirmation exists.
 */
export function modelRefToken(
  camera,
  format = (ref, match) => `MODEL ${ref} (DATASET ${match.toUpperCase()})`,
) {
  const found = datasetModelRef(camera);
  if (!found) return null;
  return format(found.ref.toUpperCase(), found.match);
}
