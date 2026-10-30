/**
 * Presentation rules for the solar-storm layer: ids, accents, label cards and
 * the two fiches (a flare, and the geomagnetic condition).
 *
 * Pure: no Cesium, no DOM. Positions arrive as whatever the caller's engine
 * uses, so the same card builders serve the globe and tests.
 * @module layers/spaceWeather/policy
 */
import { msg } from '../../i18n/index.js';
import { flareClassScore, geomagneticLevel } from './records.js';

export const LAYER_ID = 'space-weather';
export const ENTITY_PREFIX = `${LAYER_ID}:`;
export const FLARE_ENTITY_PREFIX = `${ENTITY_PREFIX}flare:`;
export const ALERT_ENTITY_ID = `${ENTITY_PREFIX}alert`;
export const OVERLAY_SOURCE_ID = LAYER_ID;
export const SELECTED_OVERLAY_SOURCE_ID = `${LAYER_ID}:selected`;

/** Labels kept on the globe at once; the alert always outranks them. */
export const CARD_COHORT_LIMIT = 10;

/** Accent per X-ray class letter, strongest first. */
export const FLARE_COLORS = Object.freeze({
  X: '#FF4D6D',
  M: '#FF9F45',
  C: '#FFD166',
  B: '#8CE99A',
  A: '#A5D8FF',
});

/** Accent per G grade: quiet grey through the magenta of an extreme storm. */
export const ALERT_COLORS = Object.freeze([
  '#8B99A6',
  '#FFE066',
  '#FFB020',
  '#FF6B4A',
  '#E63946',
  '#B5179E',
]);

/** The oval's base colour; alpha carries the probability. */
export const AURORA_COLOR = '#4DE2A8';

/** Card words, kept in English until a locale translates them. */
const CARD_TEXT = Object.freeze({
  flareKind: msg('GOES X-ray flare'),
  flareTitle: msg('solar flare'),
  begin: msg('Begin'),
  peak: msg('Peak'),
  end: msg('End'),
  inProgress: msg('in progress'),
  subsolar: msg('Subsolar impact'),
  quiet: msg('Quiet field · no storm'),
  storm: msg('Geomagnetic storm'),
  kp: msg('Planetary K index'),
  kpUnavailable: msg('K index unavailable'),
  aurora: msg('Aurora'),
  strongestFlare: msg('Strongest flare (24 h)'),
});

/** Entity id for one flare marker. */
export function flareEntityId(flareId) {
  return `${FLARE_ENTITY_PREFIX}${flareId}`;
}

/** The flare id behind a picked entity, or null for anything else. */
export function flareIdFromPick(pickedId) {
  const text = String(pickedId ?? '');
  return text.startsWith(FLARE_ENTITY_PREFIX)
    ? text.slice(FLARE_ENTITY_PREFIX.length) || null
    : null;
}

/** Whether a picked entity is the geomagnetic alert marker. */
export function isAlertPick(pickedId) {
  return String(pickedId ?? '') === ALERT_ENTITY_ID;
}

/** The class letter of a flare, defaulting to the weakest accent. */
export function flareLetter(flare) {
  const letter = String(flare?.maxClass ?? '')
    .trim()
    .charAt(0)
    .toUpperCase();
  return Object.hasOwn(FLARE_COLORS, letter) ? letter : 'A';
}

/** A flare's accent. */
export function flareColor(flare) {
  return FLARE_COLORS[flareLetter(flare)];
}

/** The accent of a G grade. */
export function alertColor(grade) {
  const index = Math.max(
    0,
    Math.min(ALERT_COLORS.length - 1, Math.floor(Number(grade) || 0)),
  );
  return ALERT_COLORS[index];
}

/** Marker size: a bigger burst gets a bigger dot. */
export function flarePixelSize(flare) {
  const score = flareClassScore(flare?.maxClass);
  return Math.round(7 + Math.max(0, Math.min(score, 49)) * 0.2);
}

/** Opacity for one oval cell, 0.18 at the threshold up to 0.72. */
export function auroraAlpha(probability) {
  const value = Number(probability);
  if (!Number.isFinite(value)) return 0.18;
  return Math.min(0.72, 0.18 + (Math.max(0, value) / 100) * 0.54);
}

/** `HH:MM UTC` — the flare log's own time base, never a local guess. */
export function formatUtcTime(ms) {
  // `Number(null)` is 0, which would print midnight for a missing time.
  const raw = typeof ms === 'string' ? ms.trim() : ms;
  if (raw == null || raw === '') return '';
  const value = Number(raw);
  if (!Number.isFinite(value)) return '';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** `21°S 12°W` — hemispheres spelled, so no sign is misread. */
export function formatLatLon(lat, lon) {
  // `Number(null)` is 0: a missing coordinate must not read as the equator.
  const toNumber = (value) => {
    const raw = typeof value === 'string' ? value.trim() : value;
    if (raw == null || raw === '') return null;
    return Number.isFinite(Number(raw)) ? Number(raw) : null;
  };
  const phi = toNumber(lat);
  const lambda = toNumber(lon);
  if (phi == null || lambda == null) return '';
  const ns = phi >= 0 ? 'N' : 'S';
  const ew = lambda >= 0 ? 'E' : 'W';
  return `${Math.abs(phi).toFixed(0)}°${ns} ${Math.abs(lambda).toFixed(0)}°${ew}`;
}

/** Trim a line for a card that has one row to say it in. */
export function clampLine(value, max = 64) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

/**
 * A flare fiche: the class, when it happened, and the point it is drawn on.
 * @param {object} flare A record plus `subsolar: {lat, lon}`.
 * @param {function(string):string} translate The i18n `t`.
 * @returns {{title: string, details: string[]}}
 */
export function buildFlareCard(flare, translate = (text) => text) {
  if (!flare) return { title: '', details: [] };
  const span = [`${translate(CARD_TEXT.peak)} ${formatUtcTime(flare.maxTime)}`];
  if (Number.isFinite(Number(flare.beginTime)))
    span.unshift(
      `${translate(CARD_TEXT.begin)} ${formatUtcTime(flare.beginTime)}`,
    );
  span.push(
    flare.endTime
      ? `${translate(CARD_TEXT.end)} ${formatUtcTime(flare.endTime)}`
      : translate(CARD_TEXT.inProgress),
  );
  const lines = [
    translate(CARD_TEXT.flareKind),
    span.join(' · '),
    `${translate(CARD_TEXT.subsolar)} ${formatLatLon(flare.subsolar?.lat, flare.subsolar?.lon)}`,
    'NOAA SWPC · services.swpc.noaa.gov',
  ]
    .map((line) => clampLine(line))
    .filter(Boolean);
  return {
    title: clampLine(
      `${flare.maxClass} · ${translate(CARD_TEXT.flareTitle)}`,
      52,
    ),
    details: [...new Set(lines)],
  };
}

/**
 * The geomagnetic fiche: G level from Kp, the oval at its thickest, and the
 * strongest flare in the window.
 * @param {object} summary From `summarizeSpaceWeather`.
 * @param {function(string):string} translate The i18n `t`.
 * @returns {{title: string, details: string[]}}
 */
export function buildAlertCard(summary, translate = (text) => text) {
  if (!summary) return { title: '', details: [] };
  const level = geomagneticLevel(summary.kp);
  const kpText =
    level.kp == null
      ? translate(CARD_TEXT.kpUnavailable)
      : `Kp ${level.kp.toFixed(1)}`;
  const storm =
    level.grade === 0
      ? translate(CARD_TEXT.quiet)
      : `${translate(CARD_TEXT.storm)} ${level.code}`;
  const peak = summary.auroraPeak ?? {};
  const aurora = Number.isFinite(Number(peak.probability))
    ? `${translate(CARD_TEXT.aurora)} ${Math.round(Number(peak.probability))}% · ${formatLatLon(peak.lat, peak.lon)}`
    : '';
  const flare = summary.strongestFlare
    ? `${translate(CARD_TEXT.strongestFlare)} ${summary.strongestFlare.maxClass}`
    : '';
  const lines = [
    storm,
    `${translate(CARD_TEXT.kp)} · ${kpText}`,
    aurora,
    flare,
    'NOAA SWPC · ovation_aurora_latest',
  ]
    .map((line) => clampLine(line))
    .filter(Boolean);
  return {
    title: clampLine(`${level.code} · ${kpText}`, 52),
    details: [...new Set(lines)],
  };
}

/**
 * One ambient label for a flare, ranked by class so a busy 24 h keeps the
 * strong ones.
 * @param {object} flare
 * @param {{x: number, y: number, z: number}} position
 * @returns {object}
 */
export function createFlareOverlayEntry(flare, position) {
  return {
    id: String(flare.id),
    position,
    variant: 'label',
    title: String(flare.maxClass ?? ''),
    accent: flareColor(flare),
    priority: 100 + Math.max(0, Math.round(flareClassScore(flare.maxClass))),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * The G-level label at the oval's thickest cell. It outranks every flare, so
 * the condition stays readable when the log is empty of labels.
 * @param {object} summary
 * @param {{x: number, y: number, z: number}} position
 * @returns {object}
 */
export function createAlertOverlayEntry(summary, position) {
  const level = geomagneticLevel(summary?.kp);
  const kpText = level.kp == null ? '' : ` · Kp ${level.kp.toFixed(1)}`;
  return {
    id: 'alert',
    position,
    variant: 'label',
    title: `${level.code}${kpText}`,
    accent: alertColor(level.grade),
    priority: Number.MAX_SAFE_INTEGER,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 16,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Keep the most important labels with a stable tie-break.
 * @param {object[]} entries
 * @param {number} [limit]
 * @returns {object[]}
 */
export function selectLabelCohort(entries, limit = CARD_COHORT_LIMIT) {
  const cap = Math.max(
    0,
    Math.min(CARD_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * The selected fiche: protected, always on top.
 * @param {string} id
 * @param {{x: number, y: number, z: number}} position
 * @param {{title: string, details: string[]}} copy
 * @param {string} accent
 * @returns {object|null}
 */
export function createSelectedCardEntry(id, position, copy, accent) {
  if (!id || !position || !copy?.title) return null;
  return {
    id: String(id),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: copy.title,
    details: Array.isArray(copy.details) ? copy.details : [],
    accent,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}
