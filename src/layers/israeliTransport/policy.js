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

/**
 * Company hubs out-rank every site, so an unbounded hub cohort would crowd
 * every site label out of the painter. A registered hub shares one budgeted
 * slice of the cohort and the rest of the room goes to its sites.
 */
export const HUB_COHORT_LIMIT = 8;

/**
 * Company nodes ride the same entity namespace as sites, under their own
 * marker, so one pick resolver can tell a hub from a site without a second
 * registry.
 */
export const COMPANY_ENTITY_MARKER = 'company:';

/** Hubs sit above the site markers and are drawn larger. */
export const COMPANY_COLOR = '#7FD1FF';
export const COMPANY_HUB_PIXEL_SIZE = 10;
export const COMPANY_HUB_SELECTED_PIXEL_SIZE = 14;

/** The hub label weight: every site card loses to it, and it only rises. */
export const COMPANY_HUB_PRIORITY = 1000;

/** Card words, kept in English until a locale translates them. */
const CARD_TEXT = Object.freeze({
  headquarters: msg('Headquarters'),
  subsidiaries: msg('Subsidiaries'),
  noSite: msg('No site in this layer'),
  site: msg('site'),
  sites: msg('sites'),
  country: msg('country'),
  countries: msg('countries'),
});

/** The link from a hub to one of its sites. */
export const COMPANY_LINK_COLOR = '#7FD1FF';
export const COMPANY_LINK_WIDTH = 1.2;

const STATUS_KEYS = Object.freeze({
  operating: msg('Operating'),
  completed: msg('Completed'),
  'under-construction': msg('Under construction'),
  announced: msg('Announced'),
  global: msg('Global network'),
});

const SECTOR_KEYS = Object.freeze({
  port: msg('Port'),
  rail: msg('Rail'),
  airport: msg('Airport'),
  road: msg('Road'),
  bridge: msg('Bridge'),
  shipping: msg('Shipping'),
  // The transit word is the one the transit layer already uses, so a sector
  // and a layer name that mean the same thing stay translated together.
  transit: msg('Transit'),
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
    rail: 45,
    airport: 50,
    road: 40,
    bridge: 30,
    shipping: 20,
    transit: 35,
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
 *
 * Company hubs always outrank sites, so the hub cohort is budgeted to
 * `hubLimit` and the remaining room goes to the sites: with the company
 * registry in the dataset, an unbounded selection would make every ambient
 * label read as a company and hide the sites the layer exists to show.
 *
 * @param {object[]} entries
 * @param {number} [limit=CARD_COHORT_LIMIT]
 * @param {number} [hubLimit=HUB_COHORT_LIMIT]
 * @returns {object[]}
 */
export function selectActivityCohort(
  entries,
  limit = CARD_COHORT_LIMIT,
  hubLimit = HUB_COHORT_LIMIT,
) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (!Array.isArray(entries) || cap === 0) return [];
  const rank = (a, b) =>
    b.priority - a.priority || String(a.id).localeCompare(String(b.id));
  const isHub = (entry) => String(entry?.id || '').startsWith('company-');
  const hubCap = Math.max(0, Math.floor(Number(hubLimit) || 0));
  const hubs = [];
  const sites = [];
  for (const entry of entries.slice().sort(rank)) {
    (isHub(entry) ? hubs : sites).push(entry);
  }
  const hubShare = Math.min(hubs.length, hubCap);
  return hubs
    .slice(0, hubShare)
    .concat(sites.slice(0, cap - hubShare))
    .sort(rank);
}

/**
 * The company key behind a picked entity id, or null when the pick is a site.
 * @param {string|null|undefined} pickedId
 * @returns {string|null}
 */
export function companyKeyFromPick(pickedId) {
  const id = typeof pickedId === 'string' ? pickedId : '';
  if (!id.startsWith(ENTITY_PREFIX)) return null;
  const rest = id.slice(ENTITY_PREFIX.length);
  if (!rest.startsWith(COMPANY_ENTITY_MARKER)) return null;
  // A link carries its site after the key (`company:zim:link:ashdod`); the
  // pick still selects the company the link belongs to.
  return rest.slice(COMPANY_ENTITY_MARKER.length).split(':')[0] || null;
}

/** Entity id of a company hub. */
export function companyEntityId(key) {
  return `${ENTITY_PREFIX}${COMPANY_ENTITY_MARKER}${key}`;
}

/** Entity id of one hub-to-site link. */
export function companyLinkEntityId(key, activityId) {
  return `${companyEntityId(key)}:link:${activityId}`;
}

/**
 * The company fiche: what it does, where it sits, and what the layer shows it
 * operating. Counts come from the dataset itself, so the card can never claim
 * more sites than the map draws.
 *
 * @param {object} company One entry of `COMPANIES`.
 * @param {ReadonlyArray<object>} sites The records attributed to that company.
 * @param {function(string):string} translate The i18n `t`.
 * @param {(key:string, vars?:object)=>string} [plural] The i18n `tn`, for counts.
 * @returns {{title: string, details: string[]}}
 */
export function buildCompanyCard(
  company,
  sites,
  translate = (text) => text,
  plural,
) {
  if (!company) return { title: '', details: [] };
  const list = Array.isArray(sites) ? sites : [];
  const countries = [
    ...new Set(list.map((site) => site.country).filter(Boolean)),
  ];
  const sectors = [
    ...new Set(
      list.map((site) => sectorLabel(site.sector, translate)).filter(Boolean),
    ),
  ];
  const count = (n, one, many) =>
    plural ? plural(n, one, many) : `${n} ${n === 1 ? one : many}`;
  const lines = [
    company.business,
    `${translate(CARD_TEXT.headquarters)}: ${company.hq.place}, ${company.hq.country}`,
    list.length
      ? `${count(list.length, CARD_TEXT.site, CARD_TEXT.sites)} · ${count(
          countries.length,
          CARD_TEXT.country,
          CARD_TEXT.countries,
        )}`
      : translate(CARD_TEXT.noSite),
    sectors.length ? sectors.join(' · ') : '',
    company.subsidiaries.length
      ? `${translate(CARD_TEXT.subsidiaries)}: ${company.subsidiaries.join(' · ')}`
      : '',
    sourceHost(company.source?.url),
  ]
    .map((line) => clampLine(line, 88))
    .filter(Boolean);
  return { title: clampLine(company.name, 58), details: [...new Set(lines)] };
}

/**
 * The hub weight grows with the sites it is credited on, so the biggest
 * constellation claims a hub label slot ahead of a three-site entity.
 * @param {object} company
 * @param {{x:number,y:number,z:number}} position
 * @param {number} [siteCount=0]
 * @returns {object}
 */
export function createCompanyOverlayEntry(company, position, siteCount = 0) {
  return {
    id: `company-${company.key}`,
    position,
    variant: 'label',
    title: String(company.name),
    accent: COMPANY_COLOR,
    priority: COMPANY_HUB_PRIORITY + Math.min(99, Number(siteCount) || 0),
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
 * The activity id behind a picked entity id, or null when the pick belongs to
 * another layer.
 * @param {string|null|undefined} pickedId
 * @returns {string|null}
 */
export function activityIdFromPick(pickedId) {
  const id = typeof pickedId === 'string' ? pickedId : '';
  if (!id.startsWith(ENTITY_PREFIX)) return null;
  const rest = id.slice(ENTITY_PREFIX.length);
  // A hub and its links are not sites; they answer to companyKeyFromPick.
  if (!rest || rest.startsWith(COMPANY_ENTITY_MARKER)) return null;
  return rest;
}
