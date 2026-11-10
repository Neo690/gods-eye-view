// GhostMaps placemark severity, for the Sentinel's alert tour.
//
// S2 does not publish a severity column. Its popup tables carry the event
// type, the casualty counts and a few status fields instead, so the ranking is
// derived from what the source actually states: violent event types score
// first, and reported deaths/wounded dominate the rest. The score is only a
// sort key — the card still shows every original field.
//
// Pure: description markup is read as text (records.js), never inserted into
// the page. Only the few rows the ranking needs are decoded, so scoring a
// thousand-placemark edition costs milliseconds, not a visible stall on a
// phone.
import { fieldLabel, htmlToText } from './records.js';

/** Violent event types, most severe first. Matched in this order. */
const EVENT_WEIGHTS = Object.freeze([
  ['massstabbing', 120],
  ['vehicleramming', 120],
  ['rammingattack', 120],
  ['ukrainewarstrike', 110],
  ['missilestrike', 105],
  ['missile', 100],
  ['iedincendiary', 100],
  ['ied', 95],
  ['bombing', 95],
  ['bomb', 90],
  ['killing', 90],
  ['shooting', 85],
  ['smallarms', 75],
  ['assault', 60],
  ['arson', 55],
  ['attack', 55],
  ['riot', 45],
  ['insurgentpatrol', 35],
  ['patrol', 30],
  ['safehouse', 25],
  ['encampment', 20],
  ['vandalism', 20],
  ['protest', 10],
  ['demonstration', 10],
]);

/** Non-violent incidents that still carry real-world weight. */
const SUPPLY_WEIGHTS = Object.freeze([
  ['diseaseoutbreak', 60],
  ['industrialfire', 55],
  ['industrialesplosion', 55],
  ['industrialaccident', 45],
  ['petroleumspill', 40],
  ['explosivesproduction', 40],
  ['watertreatment', 20],
]);

const DESTROYED_STATUS = /destroyed/;

const normalize = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/**
 * The fields the score needs, read straight from the popup rows. Rows that do
 * not carry type, casualties or status are skipped before any text decoding.
 * @param {string} html
 */
function readAlertFields(html) {
  const source = String(html ?? '').replace(
    /<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  let killed = 0;
  let wounded = 0;
  let crimeType = '';
  let supplyType = '';
  let operationalStatus = '';
  for (const row of source.matchAll(
    /<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr\s*>/gi,
  )) {
    const cells = [
      ...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi),
    ].map((cell) => cell[1]);
    if (cells.length !== 2) continue;
    const label = htmlToText(cells[0]).toLowerCase();
    if (label.includes('killed')) {
      killed += casualtyCount(htmlToText(cells[1]));
    } else if (label.includes('wounded')) {
      wounded += casualtyCount(htmlToText(cells[1]));
    } else if (label === 'crimetype') {
      crimeType = htmlToText(cells[1]);
    } else if (label === 'supplytype') {
      supplyType = htmlToText(cells[1]);
    } else if (label === 'operationalstatus') {
      operationalStatus = htmlToText(cells[1]);
    }
  }
  return { killed, wounded, crimeType, supplyType, operationalStatus };
}

/** First integer in a casualty cell ("12", "1-2", "~3" → 12, 1, 3). */
function casualtyCount(value) {
  const match = /\d+/.exec(String(value ?? ''));
  if (!match) return 0;
  const count = Number.parseInt(match[0], 10);
  return Number.isFinite(count) ? Math.min(1000, Math.max(0, count)) : 0;
}

/** The strongest matching weight from one table, or 0. */
function tableWeight(key, table) {
  for (const [needle, weight] of table) {
    if (key.includes(needle)) return weight;
  }
  return 0;
}

/**
 * Score one GhostMaps feature.
 *
 * @param {{name?:string, folder?:string, description?:string}} feature
 * @returns {{score:number, severity:'info'|'warn'|'emergency', summary:string}}
 */
export function scoreGhostMapsAlert(feature = {}) {
  const { killed, wounded, crimeType, supplyType, operationalStatus } =
    readAlertFields(feature.description);

  const names = [feature.name, feature.folder, crimeType]
    .map(normalize)
    .filter(Boolean);
  let score = 0;
  let eventWeight = 0;
  for (const name of names) {
    eventWeight = Math.max(eventWeight, tableWeight(name, EVENT_WEIGHTS));
  }
  score += eventWeight;

  if (supplyType) {
    score += tableWeight(normalize(supplyType), SUPPLY_WEIGHTS);
  }

  // One death outranks any non-violent placemark; mass-casualty events climb
  // far above a single shooting without ever overflowing the sort key.
  score += Math.min(1200, killed * 40);
  score += Math.min(400, wounded * 10);

  if (DESTROYED_STATUS.test(normalize(operationalStatus))) {
    score += 25;
  }

  const label = fieldLabel(feature.name || feature.folder || '') || 'Report';
  const casualtyParts = [];
  if (killed) casualtyParts.push(`${killed} killed`);
  if (wounded) casualtyParts.push(`${wounded} wounded`);

  return {
    score,
    severity: score >= 250 ? 'emergency' : score >= 60 ? 'warn' : 'info',
    summary: [label, ...casualtyParts].join(' · '),
  };
}

/**
 * Sort scored placemarks most severe first, deterministically.
 * @param {Array<{score?:number, name?:string, product?:string, index?:number}>} alerts
 * @returns {Array<object>} the same rows, a new sorted array.
 */
export function compareGhostMapsAlerts(a, b) {
  const score = (Number(b?.score) || 0) - (Number(a?.score) || 0);
  if (score) return score;
  const name = String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
  if (name) return name;
  const product = String(a?.product ?? '').localeCompare(
    String(b?.product ?? ''),
  );
  if (product) return product;
  return (Number(a?.index) || 0) - (Number(b?.index) || 0);
}
