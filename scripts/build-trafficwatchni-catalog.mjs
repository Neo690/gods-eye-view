/**
 * Build the curated TrafficWatchNI camera catalog (Northern Ireland DfI roads).
 *
 * One-time (rerun to refresh): the runtime loads `config/cctv_sources.trafficwatchni.json`
 * like the Tallinn catalog; this script is what keeps it honest:
 *
 *   1. Fetches the public cameras list page (HTML, keyless) and parses each
 *      camera fragment's id, display name, region and the image filename the
 *      page's own `addToPreview(...)` handler reveals.
 *   2. Geocodes every name with Nominatim (OSM), bounded to Northern Ireland,
 *      with a per-region city context plus up to two query refinements. Every
 *      answer (and miss) is logged in a sidecar review file.
 *   3. Writes the curated catalog only for cameras with a geocode inside NI.
 *
 * Usage:
 *   node scripts/build-trafficwatchni-catalog.mjs [--force]
 *
 * Nominatim usage: identify yourself (no key), 1 request/second, answers are
 * cached on disk so reruns never re-query. OSM data is © OpenStreetMap
 * contributors (ODbL); Nominatim results are used here as placement priors.
 * @module scripts/build-trafficwatchni-catalog
 */

import fs from 'node:fs';
import path from 'node:path';

const CAMERAS_URL = 'https://www.trafficwatchni.com/twni/cameras';
const IMAGE_ORIGIN = 'https://cctv.trafficwatchni.com';
const LIST_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const NOMINATIM_USER_AGENT =
  'gods-eye-view-cctv-catalog/1.0 (https://github.com/bilawalsidhu/gods-eye-view)';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
/** Northern Ireland viewbox, slightly generous; `bounded=1` pins answers in. */
const NI_VIEWBOX = '-8.4,55.75,-5.0,53.9';

const CACHE_FILE = path.resolve('.tmp-trafficwatchni-geocode-cache.json');
const REVIEW_FILE = path.resolve('.tmp-trafficwatchni-geocode-review.json');
const OUT_FILE = path.resolve(process.env.CCTV_TRAFFICWATCHNI_SOURCES_FILE ||
  'config/cctv_sources.trafficwatchni.json');

/** Region heading → default city context for the geocode query. */
const REGION_CITY = new Map([
  ['Greater Belfast', 'Belfast'],
  ['North West', 'Derry'],
  ['North East', ''],
  ['South East', ''],
  ['South West', ''],
]);

/** Explicit town tokens, longest first, honored over the region default. */
const TOWN_TOKENS = [
  'Newtownbreda', 'Coleraine', 'Ballymena', 'Antrim', 'Bangor',
  'Newtownards', 'Comber', 'Ballynahinch', 'Downpatrick', 'Carrickfergus',
  'Carrick', 'Larne', 'Holywood', 'Newry', 'Banbridge', 'Dromore',
  'Hillsborough', 'Carryduff', 'Lisburn', 'Moira', 'Omagh', 'Cookstown',
  'Dungannon', 'Enniskillen', 'Armagh', 'Markethill', 'Portadown',
  'Craigavon', 'Magherafelt', 'Toome', 'Randalstown', 'Templepatrick',
  'Culmore', 'Ballykelly', 'Derry',
];

const LIST_RE = /data-cctv-id="(\d+)"(.*?)(?=<div class="p-2 col-12 col-sm-6[^"]*cameraFragment"|camera-group-name|\Z)/gs;
const NAME_RE = /cctv-truncated-text">([^<]+)</;
const PREVIEW_RE =
  /addToPreview\(\d+,\s*&quot;([^&]+)&quot;,\s*&quot;[^&]*&quot;,\s*&quot;([^&]+\.jpe?g)&quot;,\s*&quot;/;
const REGION_HEADING_RE = /camera-group-name">([^<]+)<\/div>/;

/**
 * Tidy a raw upstream display name for a geocode query: decode entities,
 * expand the catalog's abbreviations and drop road-number prefixes ("A2",
 * "M1") that Nominatim does not resolve.
 * @param {string} raw
 * @returns {string}
 */
function cleanName(raw) {
  let name = String(raw || '')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\bR'?bout\b/gi, 'Roundabout')
    .replace(/\bNth\b/g, 'North')
    .replace(/\bSth\b/g, 'South')
    .replace(/\bN'ards\b/gi, 'Newtownards')
    .replace(/\bK'Breda\b/gi, 'Knockbreda')
    .replace(/\bC'way\b/gi, 'Causeway')
    .replace(/\bJct\b/gi, 'Junction')
    .replace(/\bSq\b\.?/g, 'Square')
    .replace(/\bRd\b\.?/g, 'Road')
    .replace(/\bSt\b\.?/g, 'Street')
    .replace(/\bAv\b\.?/g, 'Avenue')
    .replace(/\bFwy\b/gi, 'Feeder Way')
    .trim();
  name = name.replace(/^(?:[AM]\d{1,3})\s+(?:-\s+)?/, '');
  name = name.replace(/^(?:[AM]\d{1,3}\s*-\s*)+/, '');
  return name.replace(/\s+/g, ' ').trim();
}

/** Town token honored over the region default, if the name mentions one. */
function townToken(name) {
  const lower = name.toLowerCase();
  const hit = TOWN_TOKENS.find((town) => lower.includes(town.toLowerCase()));
  return hit && hit !== 'Carrick' ? hit : hit === 'Carrick' ? 'Carrickfergus' : '';
}

/** The road/street text before the junction separator, for the refined query. */
function firstSegment(name) {
  const segment = name.split(/\s[-–]\s|\s\/\s/)[0]?.trim() || name;
  return cleanName(segment);
}

function isInsideNi(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 53.9 &&
    lat <= 55.75 &&
    lon >= -8.4 &&
    lon <= -5.0
  );
}

async function rateLimitedWait(afterMs) {
  if (afterMs > 0) await new Promise((resolve) => setTimeout(resolve, afterMs));
}

/** One Nominatim query; answers the best match bounded to Northern Ireland. */
async function nominatimSearch(query, cache) {
  if (cache.has(query)) return cache.get(query);
  await rateLimitedWait(1100);
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '3');
  url.searchParams.set('countrycodes', 'gb');
  url.searchParams.set('viewbox', NI_VIEWBOX);
  url.searchParams.set('bounded', '1');
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const results = await response.json();
    const hit = (Array.isArray(results) ? results : []).find((row) =>
      isInsideNi(Number(row.lat), Number(row.lon)),
    );
    cache.set(
      query,
      hit
        ? {
            query,
            lat: Number(hit.lat),
            lon: Number(hit.lon),
            displayName: hit.display_name,
          }
        : null,
    );
  } catch (error) {
    console.warn(`[twni-catalog] geocode failed "${query}":`, error.message);
    cache.set(query, null);
  }
  const answer = cache.get(query);
  fs.writeFileSync(CACHE_FILE, JSON.stringify([...cache], null, 1));
  return answer;
}

async function fetchCamerasList() {
  const response = await fetch(CAMERAS_URL, {
    headers: { 'User-Agent': LIST_USER_AGENT },
  });
  if (!response.ok) throw new Error(`cameras list HTTP ${response.status}`);
  return response.text();
}

/** Parse the fragment blocks off the list page. */
function parseCameras(html) {
  const headings = [...html.matchAll(REGION_HEADING_RE)].map((match) => ({
    at: match.index,
    region: match[1].trim(),
  }));
  const cameras = [];
  const seen = new Set();
  for (const match of html.matchAll(LIST_RE)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const region = headings.filter((h) => h.at < match.index).pop()?.region;
    const name = match[2].match(NAME_RE)?.[1]?.replace(/\s+/g, ' ').trim();
    const preview = match[2].match(PREVIEW_RE);
    if (!name || !preview || !/^https?:\/\/.+/.test(preview[1])) continue;
    cameras.push({
      id,
      name,
      region: region || null,
      imageHost: preview[1].replace(/\\\//g, '/'),
      imageFile: preview[2],
    });
  }
  return cameras;
}

/**
 * Geocode one camera: whole name first (junction text often resolves), then
 * the first street segment, each with a region/city context, and a final
 * province-wide text if both miss.
 * @returns {{lat:number, lon:number, displayName:string}|null}
 */
async function geocodeCamera(camera, cache) {
  const name = cleanName(camera.name);
  const city = townToken(name) || REGION_CITY.get(camera.region ?? '') || '';
  const attempts = [
    `${name}${city ? ', ' + city : ''}, Northern Ireland`,
    `${firstSegment(name)}${city ? ', ' + city : ''}, Northern Ireland`,
    `${name}, Northern Ireland`,
  ];
  for (const query of attempts) {
    const hit = await nominatimSearch(query, cache);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const cache = fs.existsSync(CACHE_FILE)
    ? new Map(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')))
    : new Map();
  const html = await fetchCamerasList();
  const cameras = parseCameras(html);
  console.log(`[twni-catalog] parsed ${cameras.length} cameras from the list page`);
  if (!cameras.length) throw new Error('list page parse found no cameras');

  const review = [];
  const rows = [];
  for (const camera of cameras) {
    const hit = await geocodeCamera(camera, cache);
    review.push({
      id: camera.id,
      name: camera.name,
      region: camera.region,
      queryTried: hit
        ? hit.query
        : geocodeAttemptQueries(camera),
      resolved: hit ? hit.displayName : null,
    });
    if (!hit) {
      console.warn(`[twni-catalog] NO GEOCODE: ${camera.id} ${camera.name}`);
      continue;
    }
    rows.push({
      id: camera.id,
      name: camera.name,
      city: 'Northern Ireland',
      cityId: 'trafficwatchni',
      provider: 'TrafficWatchNI',
      lat: hit.lat,
      lon: hit.lon,
      headingDeg: null,
      headingConfidence: 'low',
      pitchDeg: -18,
      fovDeg: 44,
      rangeM: 145,
      mountHeightM: 8,
      feedType: 'image',
      url: `${camera.imageHost}/${camera.imageFile}`,
      snapshotUrl: `${camera.imageHost}/${camera.imageFile}`,
      sourceKind: 'trafficwatchni',
      license:
        'TrafficWatchNI (DfI NI) camera frame — reuse terms unverified, operator opt-in',
    });
    console.log(`[twni-catalog] ${camera.id} ${camera.name} -> ${hit.displayName}`);
  }
  fs.writeFileSync(REVIEW_FILE, JSON.stringify(review, null, 1));

  if (args.has('--dry-run')) {
    console.log(`[twni-catalog] dry-run; would write ${rows.length} rows to ${OUT_FILE}`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(
    `[twni-catalog] wrote ${rows.length}/${cameras.length} cameras to ${OUT_FILE}`,
  );
}

function geocodeAttemptQueries(camera) {
  const name = cleanName(camera.name);
  const city = townToken(name) || REGION_CITY.get(camera.region ?? '') || '';
  return [
    `${name}${city ? ', ' + city : ''}, Northern Ireland`,
    `${firstSegment(name)}${city ? ', ' + city : ''}, Northern Ireland`,
    `${name}, Northern Ireland`,
  ];
}

main().catch((error) => {
  console.error('[twni-catalog] build failed:', error);
  process.exit(1);
});
