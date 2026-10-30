/**
 * Pure rules for the Israeli transport-activity layer: identity, colours, the
 * overlay cards it publishes and the copy on a selected site.
 *
 * No Cesium and no DOM, so the card copy and the pick resolution can be tested
 * directly.
 *
 * @module layers/israeliTransport/policy
 */
import { msg } from '../../i18n/index.js';

/** Catalog id; also the overlay source id of the ambient cards. */
export const LAYER_ID = 'israeli-transport';

/** Entity ids are namespaced so a click can be attributed without guessing. */
export const ENTITY_PREFIX = `${LAYER_ID}:`;

/** One accent for the marker; the sector gives each card its own. */
export const ACTIVITY_COLOR = '#E6E9EF';

export const ACTIVITY_PIXEL_SIZE = 7;
export const ACTIVITY_SELECTED_PIXEL_SIZE = 11;
export const ACTIVITY_SELECTED_COLOR = '#FFFFFF';

/** Ambient cards and the single site card are separate overlay sources. */
export const ACTIVITY_OVERLAY_SOURCE_ID = LAYER_ID;
export const ACTIVITY_SELECTED_OVERLAY_SOURCE_ID = `${LAYER_ID}:selected`;

/** Never paint more ambient cards than this, whatever the dataset grows to. */
export const CARD_COHORT_LIMIT = 24;

const STATUS_KEYS = Object.freeze({
  operating: msg('Operating'),
  completed: msg('Completed'),
  'under-construction': msg('Under construction'),
  announced: msg('Announced'),
  global: msg('Global network'),
});

const SECTOR_KEYS = Object.freeze({
  port: msg('Port'),
  airport: msg('Airport'),
  road: msg('Road'),
  bridge: msg('Bridge'),
  shipping: msg('Shipping'),
  logistics: msg('Logistics'),
});

/**
 * The translated word for a stored status, falling back to the raw value so a
 * record added without a translation still says something.
 * @param {string} status
 * @param {function(string):string} translate
 * @returns {string}
 */
export function statusLabel(status, translate) {
  const key = STATUS_KEYS[status];
  return key ? translate(key) : String(status || '');
}

/**
 * The translated word for a sector.
 * @param {string} sector
 * @param {function(string):string} translate
 * @returns {string}
 */
export function sectorLabel(sector, translate) {
  const key = SECTOR_KEYS[sector];
  return key ? translate(key) : String(sector || '');
}

/** Shorten one card line; the card itself is a single line per detail. */
export function clampLine(value, max = 64) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

/** The host of a source link, without the `www.` prefix the eye ignores. */
export function sourceHost(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The site card: what the company does there, where, and how current it is.
 *
 * The first line names the company and the sector, so a card read alone still
 * answers "who and what" before "where" is visible on the globe.
 *
 * @param {object} record One dataset record.
 * @param {function(string):string} translate The i18n `t`.
 * @returns {{title: string, details: string[]}}
 */
export function buildActivityCard(record, translate = (text) => text) {
  if (!record) return { title: '', details: [] };
  const lines = [
    `${record.company} · ${sectorLabel(record.sector, translate)}`,
    record.project,
    record.role,
    `${statusLabel(record.status, translate)} · ${record.period}`,
    `${record.country} · ${sourceHost(record.source?.url)}`,
  ]
    .map((line) => clampLine(line))
    .filter(Boolean);
  return {
    title: clampLine(record.place, 58),
    details: [...new Set(lines)],
  };
}

/** A stable importance score, so a crowded globe keeps the major sites. */
export function activityPriority(record) {
  const sectorWeight = {
    port: 50,
    airport: 50,
    road: 40,
    bridge: 30,
    shipping: 20,
    logistics: 25,
  };
  const statusWeight = {
    operating: 20,
    'under-construction': 15,
    completed: 10,
    announced: 5,
    global: 0,
  };
  return (
    (sectorWeight[record?.sector] || 0) + (statusWeight[record?.status] || 0)
  );
}

/**
 * One ambient label card for a site.
 * @param {object} record
 * @param {{x:number,y:number,z:number}} position
 * @param {object} [Cesium] Injected in tests; defaults to the module's Cesium.
 * @returns {object}
 */
export function createActivityOverlayEntry(record, position) {
  return {
    id: String(record.id),
    position,
    variant: 'label',
    title: String(record.company || record.place),
    accent: ACTIVITY_COLOR,
    priority: activityPriority(record),
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
 * The selected site card: protected, always on top, reading as one fiche.
 * @param {object} record
 * @param {{x:number,y:number,z:number}} position
 * @param {{title:string, details:string[]}} copy
 * @returns {object|null}
 */
export function createSelectedActivityEntry(record, position, copy) {
  if (!record?.id || !position || !copy?.title) return null;
  return {
    id: String(record.id),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: copy.title,
    details: Array.isArray(copy.details) ? copy.details : [],
    accent: ACTIVITY_SELECTED_COLOR,
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

/**
 * Keep the most significant labels, with a stable tie-break.
 * @param {object[]} entries
 * @param {number} [limit=CARD_COHORT_LIMIT]
 * @returns {object[]}
 */
export function selectActivityCohort(entries, limit = CARD_COHORT_LIMIT) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
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
 * The activity id behind a picked entity id, or null when the pick belongs to
 * another layer.
 * @param {string|null|undefined} pickedId
 * @returns {string|null}
 */
export function activityIdFromPick(pickedId) {
  const id = typeof pickedId === 'string' ? pickedId : '';
  if (!id.startsWith(ENTITY_PREFIX)) return null;
  const rest = id.slice(ENTITY_PREFIX.length);
  return rest || null;
}
