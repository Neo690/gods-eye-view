/**
 * Ambient dose-rate stations and space-radiation readings, as plain data.
 *
 * Shared by the server proxy (`server/providers/radiation.js`) and the layer,
 * so one decoder decides what a reading is and both ends agree on it. Pure: no
 * DOM, no i18n copy — the layer translates at its presentation boundary.
 *
 * Networks differ in what they measure:
 *  - BfS ODL publishes gamma dose rate in µSv/h, one hourly value per station.
 *  - Health Canada's FPSN publishes the same quantity in nSv/h.
 *  - Safecast publishes Geiger counts per minute (cpm), so its values are
 *    converted with the project's documented 334 cpm = 1 µSv/h and marked
 *    `estimated`, because a cpm figure is not a calibrated dose rate.
 *  - radmon.org publishes counts per minute per volunteer station together
 *    with the station owner's own cpm-to-µSv/h factor, so its rows use that
 *    factor and are still marked `estimated`.
 *  - uRADMonitor publishes the same pair (counts per minute plus the unit's
 *    factory factor) but only for the units an account owns or was granted
 *    access to, so its rows need credentials on the server side.
 * @module layers/radiation/records
 */

import { msg } from '../../i18n/marker.js';

/** Attribution travels with the data, not just the credits panel. */
export const RADIATION_NETWORKS = Object.freeze({
  bfs: Object.freeze({
    // i18n-ignore: network operator name
    label: 'BfS ODL',
    operator: 'Bundesamt für Strahlenschutz',
    coverage: 'Germany',
    scale: 'Gamma dose rate',
  }),
  canada: Object.freeze({
    // i18n-ignore: network operator name
    label: 'Health Canada FPSN',
    operator: 'Health Canada',
    coverage: 'Canada',
    scale: 'Gamma dose rate',
  }),
  safecast: Object.freeze({
    // i18n-ignore: network operator name
    label: 'Safecast',
    operator: 'Safecast',
    coverage: 'Worldwide, volunteer',
    scale: 'Geiger counts',
  }),
  radmon: Object.freeze({
    label: 'radmon.org',
    operator: 'radmon.org contributors',
    coverage: 'Worldwide, volunteer',
    scale: 'Geiger counts',
  }),
  uradmonitor: Object.freeze({
    // i18n-ignore: network operator name
    label: 'uRADMonitor',
    operator: 'uRADMonitor network',
    coverage: 'Worldwide, volunteer',
    scale: 'Geiger counts',
    /** Reads only the units of one account, so the server needs its keys. */
    requiresKey: true,
  }),
});

/**
 * Bands a station's reading is coloured by. Background on Earth is roughly
 * 0.05–0.2 µSv/h; 1 µSv/h is about ten times natural background and is where a
 * public network's own attention thresholds usually start.
 */
export const DOSE_BANDS = Object.freeze([
  Object.freeze({
    id: 'background',
    label: msg('Background'),
    max: 0.1,
    color: '#35d6a4',
  }),
  Object.freeze({
    id: 'normal',
    label: msg('Natural background'),
    max: 0.3,
    color: '#8fdc4a',
  }),
  Object.freeze({
    id: 'elevated',
    label: msg('Elevated'),
    max: 1,
    color: '#f5b53d',
  }),
  Object.freeze({
    id: 'high',
    label: msg('High'),
    max: Infinity,
    color: '#f4626a',
  }),
]);

/** Geiger counts per µSv/h for a Safecast bGeigie-style counter. */
export const SAFECAST_CPM_PER_USVH = 334;

/** A station reading older than this is not shown as current. */
export const READING_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Safecast is a volunteer archive: keep its window wider and flag the age. */
export const SAFECAST_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Bound on one snapshot's stations, whatever the networks send. */
export const MAX_STATIONS = 4000;

const isFiniteNumber = (value) => Number.isFinite(value);

/**
 * The band a dose rate falls in.
 * @param {number} usvh
 * @returns {{id: string, label: string, max: number, color: string}|null}
 */
export function doseBand(usvh) {
  if (!isFiniteNumber(usvh) || usvh < 0) return null;
  return DOSE_BANDS.find((band) => usvh < band.max) ?? DOSE_BANDS.at(-1);
}

/** ISO string for an upstream timestamp, or null when it is not one. */
function isoTime(value, { seconds = false } = {}) {
  if (isFiniteNumber(value)) {
    const ms = value > 1e12 ? value : value * (seconds ? 1000 : 1);
    const at = new Date(ms);
    return Number.isFinite(at.getTime()) ? at.toISOString() : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

function coordinate(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  return isFiniteNumber(number) ? number : null;
}

/**
 * A validated station row, or null when the source row cannot be placed or
 * dated. One malformed row must not condemn a whole network's snapshot.
 */
function station(row) {
  if (!row) return null;
  const lat = coordinate(row.lat);
  const lon = coordinate(row.lon);
  const usvh = coordinate(row.usvh);
  if (lat === null || lon === null || usvh === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || usvh < 0) return null;
  return {
    id: String(row.id || ''),
    network: row.network,
    name: typeof row.name === 'string' ? row.name.slice(0, 120) : '',
    lat,
    lon,
    usvh,
    at: row.at || null,
    ...(row.estimated ? { estimated: true } : {}),
  };
}

/**
 * BfS ODL `odlinfo_odl_1h_latest`: one hourly gamma value per station.
 * @param {object} payload GeoJSON FeatureCollection.
 * @returns {Array<object>|null} Rows, or null when the payload is not one.
 */
export function normalizeBfsSnapshot(payload) {
  const features = payload?.features;
  if (!Array.isArray(features)) return null;
  const rows = [];
  for (const feature of features) {
    if (rows.length >= MAX_STATIONS) break;
    const geometry = feature?.geometry;
    const properties = feature?.properties;
    if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates))
      continue;
    const [lon, lat] = geometry.coordinates;
    const row = station({
      id: properties?.kenn || properties?.id,
      network: 'bfs',
      name: properties?.name,
      lat,
      lon,
      usvh: properties?.value,
      at: isoTime(properties?.end_measure || properties?.start_measure),
    });
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Health Canada FPSN readings: nSv/h in `latest_value_nSvHr`.
 * @param {object} payload GeoJSON FeatureCollection.
 * @returns {Array<object>|null}
 */
export function normalizeCanadaSnapshot(payload) {
  const features = payload?.features;
  if (!Array.isArray(features)) return null;
  const rows = [];
  for (const feature of features) {
    if (rows.length >= MAX_STATIONS) break;
    const geometry = feature?.geometry;
    const properties = feature?.properties;
    if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates))
      continue;
    const [lon, lat] = geometry.coordinates;
    const nSvHr = coordinate(properties?.latest_value_nSvHr);
    if (nSvHr === null) continue;
    const row = station({
      id: properties?.location_name || properties?.OBJECTID,
      network: 'canada',
      name: properties?.location_name,
      lat,
      lon,
      usvh: nSvHr / 1000,
      at: isoTime(properties?.time),
    });
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Safecast measurements: `value` in cpm, newest first is not guaranteed, so
 * every row carries its capture time and stale rows are dropped.
 * @param {unknown} payload Array of measurement records.
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxAgeMs]
 * @returns {Array<object>|null}
 */
export function normalizeSafecastSnapshot(
  payload,
  { now = Date.now(), maxAgeMs = SAFECAST_MAX_AGE_MS } = {},
) {
  if (!Array.isArray(payload)) return null;
  const rows = [];
  for (const measurement of payload) {
    if (rows.length >= MAX_STATIONS) break;
    const value = coordinate(measurement?.value);
    if (value === null || value < 0) continue;
    const unit = String(measurement?.unit || '').toLowerCase();
    const usvh = unit === 'cpm' ? value / SAFECAST_CPM_PER_USVH : value;
    const at = isoTime(measurement?.captured_at);
    if (!at) continue;
    if (now - Date.parse(at) > maxAgeMs) continue;
    const row = station({
      id:
        measurement?.id || `${measurement?.latitude},${measurement?.longitude}`,
      network: 'safecast',
      name: measurement?.location_name || '',
      lat: measurement?.latitude,
      lon: measurement?.longitude,
      usvh,
      at,
      estimated: unit === 'cpm',
    });
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Indices in radmon.org's combined station list.
 *
 * `function=getcombinedlistjson` answers one array of parallel columns rather
 * than objects: names at 0-1, counts at 7, a status flag at 8, coordinates at
 * 10-11 and one cpm-to-µSv/h factor per station at 13.
 */
const RADMON = Object.freeze({
  users: 0,
  locations: 1,
  cpms: 7,
  statuses: 8,
  latitudes: 10,
  longitudes: 11,
  factors: 13,
  generatedAt: 14,
});

/**
 * radmon.org volunteer stations, one row per station that is reporting.
 *
 * Only stations with the `0` (normal) status flag are kept: `1` is dormant and
 * `2` is experiment mode, and a station its own owner has taken out of normal
 * service is not a background reading. Each reading is the station's count
 * rate scaled by the factor its owner published for that counter.
 * @param {unknown} payload The combined-list array.
 * @returns {Array<object>|null}
 */
export function normalizeRadmonSnapshot(payload) {
  if (!Array.isArray(payload) || payload.length <= RADMON.generatedAt)
    return null;
  const users = payload[RADMON.users];
  const locations = payload[RADMON.locations];
  const cpms = payload[RADMON.cpms];
  const statuses = payload[RADMON.statuses];
  const latitudes = payload[RADMON.latitudes];
  const longitudes = payload[RADMON.longitudes];
  const factors = payload[RADMON.factors];
  const columns = [users, cpms, statuses, latitudes, longitudes, factors];
  if (!columns.every(Array.isArray)) return null;
  const at = isoTime(payload[RADMON.generatedAt], { seconds: true });
  const names = Array.isArray(locations) ? locations : [];
  const rows = [];
  const length = Math.min(...columns.map((column) => column.length));
  for (let index = 0; index < length; index += 1) {
    if (rows.length >= MAX_STATIONS) break;
    if (String(statuses[index]) !== '0') continue;
    const cpm = coordinate(cpms[index]);
    const factor = coordinate(factors[index]);
    if (cpm === null || factor === null) continue;
    if (cpm <= 0 || factor <= 0 || factor > 1) continue;
    const row = station({
      id: users[index],
      network: 'radmon',
      name: names[index] || users[index],
      lat: latitudes[index],
      lon: longitudes[index],
      usvh: cpm * factor,
      at,
      estimated: true,
    });
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * uRADMonitor units, as `GET /api/v1/devices` returns them.
 *
 * Unlike the other volunteer networks this one is not public: the endpoint
 * answers the units an account owns or was granted access to, and refuses the
 * rest (`Access denied for this device`). So a row is only read when the answer
 * carries it, and an account with no units yields an empty list — which is a
 * real answer, not a failure.
 *
 * Each unit reports its Geiger counts in `last_cpm` and the factory factor that
 * turns them into a dose rate, exactly like radmon.org. `timelast` is when the
 * unit last uploaded, in seconds.
 * @param {unknown} payload Array of units.
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxAgeMs]
 * @returns {Array<object>|null}
 */
export function normalizeUradmonitorSnapshot(
  payload,
  { now = Date.now(), maxAgeMs = READING_MAX_AGE_MS } = {},
) {
  if (!Array.isArray(payload)) return null;
  const rows = [];
  for (const unit of payload) {
    if (rows.length >= MAX_STATIONS) break;
    if (!unit || typeof unit !== 'object') continue;
    // 1 is online; null is a unit that stopped reporting.
    if (Number(unit.status) !== 1) continue;
    const cpm = coordinate(unit.last_cpm) ?? coordinate(unit.last_cpm2) ?? null;
    const factor = coordinate(unit.factor);
    if (cpm === null || factor === null) continue;
    if (cpm <= 0 || factor <= 0 || factor > 1) continue;
    const at = isoTime(unit.timelast, { seconds: true });
    if (!at) continue;
    if (now - Date.parse(at) > maxAgeMs) continue;
    const row = station({
      id: unit.id,
      network: 'uradmonitor',
      name:
        [unit.city, unit.country]
          .map((part) => (typeof part === 'string' ? part.trim() : ''))
          .filter(Boolean)
          .join(', ') ||
        unit.note ||
        unit.id,
      lat: unit.latitude,
      lon: unit.longitude,
      usvh: cpm * factor,
      at,
      estimated: true,
    });
    if (row) rows.push(row);
  }
  return rows;
}

/** Space-radiation bands, from GOES proton flux and the planetary K index. */
export const SPACE_BANDS = Object.freeze({
  calm: Object.freeze({ id: 'calm', label: msg('Quiet') }),
  elevated: Object.freeze({ id: 'elevated', label: msg('Elevated') }),
  storm: Object.freeze({ id: 'storm', label: msg('Storm') }),
});

const latestBy = (rows, key) =>
  rows.reduce(
    (latest, row) =>
      !latest || Date.parse(row[key]) > Date.parse(latest[key]) ? row : latest,
    null,
  );

/**
 * The newest ≥10 MeV proton flux and planetary K index.
 *
 * Thresholds follow NOAA's own scale use: proton flux at 10 pfu marks a solar
 * radiation storm (S1), and Kp 5 a geomagnetic storm (G1).
 * @param {object} payload
 * @param {Array<object>} [payload.protons] GOES integral protons.
 * @param {Array<object>} [payload.kp] Planetary K index, one-minute rows.
 * @returns {object|null}
 */
export function normalizeSpaceReadings({ protons, kp } = {}) {
  const protonRows = Array.isArray(protons)
    ? protons
        .filter((row) => /10\s*MeV/.test(String(row?.energy || '')))
        .map((row) => ({
          flux: coordinate(row?.flux),
          at: isoTime(row?.time_tag),
        }))
        .filter((row) => row.flux !== null && row.flux >= 0 && row.at)
    : [];
  const kpRows = Array.isArray(kp)
    ? kp
        .map((row) => ({
          kp: coordinate(row?.kp_index),
          at: isoTime(row?.time_tag),
        }))
        .filter((row) => row.kp !== null && row.at)
    : [];
  const proton = latestBy(protonRows, 'at');
  const kpRow = latestBy(kpRows, 'at');
  if (!proton && !kpRow) return null;
  return {
    protonFlux: proton ? proton.flux : null,
    protonAt: proton?.at || null,
    kp: kpRow ? kpRow.kp : null,
    kpAt: kpRow?.at || null,
    band:
      (proton && proton.flux >= 10) || (kpRow && kpRow.kp >= 5)
        ? 'storm'
        : (proton && proton.flux >= 1) || (kpRow && kpRow.kp >= 4)
          ? 'elevated'
          : 'calm',
  };
}

/**
 * Validate the server's answer before it may replace displayed stations.
 * @param {unknown} payload
 * @returns {{stations: Array<object>, space: object|null, sources: Array<object>, fetchedAt: number}|null}
 */
export function normalizeRadiationSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const stations = Array.isArray(payload.stations) ? payload.stations : [];
  const rows = [];
  for (const raw of stations) {
    if (rows.length >= MAX_STATIONS) break;
    const row = station(raw);
    if (row && RADIATION_NETWORKS[row.network]) rows.push(row);
  }
  const fetchedAt = isFiniteNumber(payload.fetchedAt)
    ? payload.fetchedAt
    : Date.parse(payload.fetchedAt);
  if (!isFiniteNumber(fetchedAt)) return null;
  return {
    stations: rows,
    space:
      payload.space && typeof payload.space === 'object' ? payload.space : null,
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    fetchedAt,
  };
}

/** Stations inside a lon/lat rectangle, worst first, for the readout list. */
export function readingsInView(stations, rectangle, limit = 5) {
  if (!Array.isArray(stations) || !stations.length) return [];
  const inside = rectangle
    ? stations.filter(
        (row) =>
          row.lon >= rectangle.west &&
          row.lon <= rectangle.east &&
          row.lat >= rectangle.south &&
          row.lat <= rectangle.north,
      )
    : stations;
  return inside
    .slice()
    .sort((a, b) => b.usvh - a.usvh)
    .slice(0, Math.max(1, Math.floor(limit)));
}

/** µSv/h with enough precision to separate background from a real elevation. */
export function formatDose(usvh) {
  if (!isFiniteNumber(usvh)) return '—';
  if (usvh >= 10) return usvh.toFixed(0);
  if (usvh >= 1) return usvh.toFixed(1);
  return usvh.toFixed(3);
}
