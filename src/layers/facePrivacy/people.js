import { t, tn } from '../../i18n/index.js';

/**
 * Headcount for one CCTV frame.
 *
 * A person is counted when the SCRFD detector finds one face on the frame, so
 * the number means "people whose face is visible". Someone facing away, hooded,
 * or hidden behind another body is not counted, and a poster is. That limit is
 * part of the feature, not a footnote: the row states it rather than implying a
 * body detector this build does not have.
 *
 * What it is not: an identity. No template leaves the detector, no gallery is
 * queried, no name is attached to a box, and nothing here is written to layer
 * state — the count lives as long as the answer it came from.
 *
 * @module layers/facePrivacy/people
 */

/** How a headcount was obtained; data, translated where it is shown. */
export const PEOPLE_BASIS = 'scrfd-faces';

/** The honest sentence a surface shows next to a count. */
export const PEOPLE_LIMIT_NOTE =
  'Counted from the faces the detector sees: a person facing away or hidden is not counted.';

/**
 * Number of people visible in one analysis answer.
 * @param {{faces?: Array<object>}|null|undefined} answer
 * @returns {number} Zero when there is no answer or no face in it.
 */
export function countPeople(answer) {
  const faces = Array.isArray(answer?.faces) ? answer.faces : [];
  return faces.length;
}

/**
 * "3 personnes visibles" / "No person visible".
 * @param {number} count
 * @returns {string}
 */
export function peopleLabel(count) {
  const value = Number(count);
  const people = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return people > 0
    ? tn(people, '{count} person visible', '{count} people visible')
    : t('No person visible');
}

/**
 * One line naming the camera and its headcount.
 * @param {{cameraId?: string|null, count?: number, at?: number|null}} [result]
 * @returns {string}
 */
export function peopleSummary({ cameraId = null, count = 0 } = {}) {
  const label = peopleLabel(count);
  return cameraId ? `${cameraId} · ${label}` : label;
}
