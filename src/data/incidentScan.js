/**
 * Incident scan — the alerts agent's detector.
 *
 * Reads the analyst records the live layers already hold client-side and turns
 * the handful of facts worth interrupting someone for into incidents. Pure:
 * plain arrays in, plain objects out, no Cesium, no DOM, no fetches — the
 * watcher (src/ui/alertCenter.js) owns polling, de-duplication and delivery.
 *
 * The scan only reports what a feed OBSERVED, never a conclusion:
 *  - an aircraft is "in emergency" only while this poll broadcasts a 7x00
 *    squawk or the ADS-B emergency field says so;
 *  - a fire cluster counts strong detections, not a fire front;
 *  - a GNSS "low" cell is a navigation-integrity anomaly, not jamming.
 *
 * Message text stays English data (`msg`) for the UI to translate through
 * `t()`. Params holding another message key are wrapped in `{ messageKey }`,
 * which the UI resolves before interpolation.
 *
 * @module data/incidentScan
 */
import { msg } from '../i18n/marker.js';

/** Incidents are sorted and colour-coded by these two levels. */
export const INCIDENT_SEVERITY = Object.freeze({
  critical: 'critical',
  warning: 'warning',
});

/** Layer each incident kind speaks for, so the UI can name its source. */
export const INCIDENT_LAYER = Object.freeze({
  'aircraft-emergency': 'flights',
  earthquake: 'earthquakes',
  wildfire: 'local-firms',
  cyclone: 'weather-cyclones',
  military: 'military',
  gnss: 'gnss-integrity',
});

/**
 * Detection thresholds, in one place so the panel's behaviour can be reasoned
 * about (and tested) without reading the rules below.
 *
 * Deliberately conservative: an alert centre that fires on every USGS event or
 * every military contact is noise, so quakes need M5+, fires need an intense
 * cluster, and military activity needs a concentration rather than a contact.
 */
export const INCIDENT_LIMITS = Object.freeze({
  /** A magnitude below this is routine background seismicity. */
  quakeMinMagnitude: 5,
  /** At or above this a quake is critical. */
  quakeCriticalMagnitude: 6.5,
  /** Only quakes this recent are still news. */
  quakeWindowMs: 24 * 60 * 60 * 1000,
  /** A future timestamp further than this is a clock error, not an event. */
  quakeFutureSlackMs: 5 * 60 * 1000,
  /** Radiative power (MW) below which a hotspot is not worth a cluster. */
  fireMinFrp: 100,
  /** Confidence under which a hotspot is dropped; null (unreported) is kept. */
  fireMinConfidence: 0.4,
  fireWindowMs: 24 * 60 * 60 * 1000,
  /** Cluster size in degrees; a cell is where outbreaks concentrate. */
  fireCellDeg: 10,
  /** Strong fires one cell needs before it counts as an outbreak. */
  fireClusterSize: 5,
  fireMaxCells: 4,
  /** Military contacts are counted per 5-degree cell. */
  militaryCellDeg: 5,
  militaryClusterSize: 8,
  militaryMaxCells: 2,
  /** Hurricane/typhoon force; below it a storm is a warning. */
  cycloneCriticalWindKt: 64,
  /** "Low" GNSS cells one view needs before it is reported. */
  gnssMinLowCells: 2,
  /** Upper bound on the list, highest severity first. */
  maxIncidents: 40,
});

const SQUAWK_KINDS = Object.freeze({
  7500: 'unlawful',
  7600: 'nordo',
  7700: 'general',
});

/** English keys for the transponder status; already in every catalog. */
const EMERGENCY_STATUS_KEYS = Object.freeze({
  general: msg('General emergency'),
  unlawful: msg('Unlawful interference'),
  nordo: msg('Radio failure'),
  downed: msg('Downed aircraft'),
  minfuel: msg('Minimum fuel'),
  lifeguard: msg('Lifeguard (medical priority)'),
});

/** Cyclone source codes (see layers/cyclones/index.js) as message keys. */
const CLASSIFICATION_KEYS = Object.freeze({
  PTC: msg('Potential tropical cyclone'),
  HU: msg('Hurricane'),
  TS: msg('Tropical storm'),
  TD: msg('Tropical depression'),
  SS: msg('Subtropical storm'),
  SD: msg('Subtropical depression'),
});

const numeric = (value) => (Number.isFinite(value) ? value : null);
const validPosition = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180;

/**
 * A coarse grid key for an observation, so nearby facts group without a real
 * spatial index. Longitude wraps, so ±180 fall in the same cell instead of
 * splitting the anti-meridian.
 * @param {number} lat
 * @param {number} lon
 * @param {number} cellDeg
 * @returns {string}
 */
export function incidentCellKey(lat, lon, cellDeg) {
  const latCell = Math.floor(lat / cellDeg);
  const wrapped = (((lon + 180) % 360) + 360) % 360;
  return `${latCell}:${Math.floor(wrapped / cellDeg)}`;
}

/** Group positioned rows by grid cell, dropping rows without a position. */
function groupByCell(rows, cellDeg) {
  const cells = new Map();
  for (const row of rows) {
    if (!validPosition(row?.lat, row?.lon)) continue;
    const key = incidentCellKey(row.lat, row.lon, cellDeg);
    const bucket = cells.get(key);
    if (bucket) bucket.push(row);
    else cells.set(key, [row]);
  }
  return cells;
}

/** Arithmetic centre of a non-empty row list. */
function meanPosition(rows) {
  const sum = rows.reduce(
    (acc, row) => ({ lat: acc.lat + row.lat, lon: acc.lon + row.lon }),
    { lat: 0, lon: 0 },
  );
  return { lat: sum.lat / rows.length, lon: sum.lon / rows.length };
}

/**
 * Emergency status of one analyst record, from the squawk or the ADS-B field.
 * @returns {{kind: string, source: 'squawk'|'ads-b'}|null}
 */
export function emergencyOf(row) {
  const squawk = String(row?.squawk ?? '').trim();
  const squawkKind = /^[0-7]{4}$/.test(squawk)
    ? (SQUAWK_KINDS[squawk] ?? null)
    : null;
  if (row?.emergency !== true) return null;
  const reported = String(row?.emergencyKind ?? '').trim();
  const kind = Object.hasOwn(EMERGENCY_STATUS_KEYS, reported)
    ? reported
    : squawkKind;
  if (!kind) return null;
  return {
    kind,
    source:
      row?.emergencySource === 'squawk' || squawkKind === kind
        ? 'squawk'
        : 'ads-b',
  };
}

/** Aircraft broadcasting an emergency, one incident per airframe. */
function scanAircraft(flights = [], military = []) {
  const out = [];
  const seen = new Set();
  const rows = [...flights, ...military];
  for (const row of rows) {
    const status = emergencyOf(row);
    const icao24 = String(row?.icao24 ?? '').trim();
    if (!status || !icao24 || seen.has(icao24)) continue;
    seen.add(icao24);
    const aircraft = row.callsign || row.registration || icao24;
    const squawk = String(row.squawk ?? '').trim();
    const statusKey = EMERGENCY_STATUS_KEYS[status.kind];
    out.push({
      id: `aircraft-emergency:${icao24}`,
      kind: 'aircraft-emergency',
      severity: INCIDENT_SEVERITY.critical,
      layerId: row.military === true ? 'military' : 'flights',
      lat: numeric(row.lat),
      lon: numeric(row.lon),
      atMs: numeric(row.lastContactAtMs),
      statusKey,
      title: {
        key: msg('Aircraft emergency — {aircraft}'),
        params: { aircraft },
      },
      detail:
        status.source === 'squawk' && squawk
          ? {
              key: msg('Squawk {squawk} — {status}'),
              params: { squawk, status: { messageKey: statusKey } },
            }
          : {
              key: msg('ADS-B emergency — {status}'),
              params: { status: { messageKey: statusKey } },
            },
    });
  }
  return out;
}

/** Earthquakes above the reporting magnitude, newest first. */
function scanQuakes(rows = [], { now, limits }) {
  const out = [];
  for (const row of rows) {
    const magnitude = numeric(row?.magnitude);
    const atMs = numeric(row?.timeMs);
    if (magnitude === null || magnitude < limits.quakeMinMagnitude) continue;
    if (atMs === null || now - atMs > limits.quakeWindowMs) continue;
    if (atMs - now > limits.quakeFutureSlackMs) continue;
    if (!validPosition(row.lat, row.lon)) continue;
    const place = String(row.place ?? '').trim();
    const depth = numeric(row.depthKm);
    out.push({
      id: `earthquake:${row.id}`,
      kind: 'earthquake',
      severity:
        magnitude >= limits.quakeCriticalMagnitude
          ? INCIDENT_SEVERITY.critical
          : INCIDENT_SEVERITY.warning,
      layerId: 'earthquakes',
      lat: row.lat,
      lon: row.lon,
      atMs,
      title: place
        ? {
            key: msg('Earthquake M{magnitude} — {place}'),
            params: { magnitude, place },
          }
        : { key: msg('Earthquake M{magnitude}'), params: { magnitude } },
      detail:
        depth === null
          ? null
          : { key: msg('Depth {depth} km'), params: { depth } },
    });
  }
  return out;
}

/** Intense fire clusters, one incident per grid cell. */
function scanFires(rows = [], { now, limits }) {
  const recent = rows.filter((row) => {
    const atMs = numeric(row?.acqTime);
    const frp = numeric(row?.frp);
    const confidence = numeric(row?.confidence);
    if (frp === null || frp < limits.fireMinFrp) return false;
    if (confidence !== null && confidence < limits.fireMinConfidence)
      return false;
    return atMs !== null && now - atMs <= limits.fireWindowMs;
  });
  const cells = [...groupByCell(recent, limits.fireCellDeg).values()]
    .filter((fires) => fires.length >= limits.fireClusterSize)
    .sort((a, b) => b.length - a.length)
    .slice(0, limits.fireMaxCells);
  return cells.map((fires) => {
    const strongest = fires.reduce((peak, fire) =>
      (fire.frp ?? 0) > (peak.frp ?? 0) ? fire : peak,
    );
    const atMs = fires.reduce(
      (latest, fire) => Math.max(latest, fire.acqTime ?? 0),
      0,
    );
    const centre = meanPosition(fires);
    return {
      id: `wildfire:${incidentCellKey(centre.lat, centre.lon, limits.fireCellDeg)}`,
      kind: 'wildfire',
      severity:
        fires.length >= limits.fireClusterSize * 2
          ? INCIDENT_SEVERITY.critical
          : INCIDENT_SEVERITY.warning,
      layerId: 'local-firms',
      lat: centre.lat,
      lon: centre.lon,
      atMs: atMs || null,
      title: {
        key: msg('Wildfire cluster — {count} intense fires'),
        params: { count: fires.length },
      },
      detail: {
        key: msg('Strongest detection {frp} MW'),
        params: { frp: Math.round(strongest.frp ?? 0) },
      },
    };
  });
}

/** One incident per active storm. */
function scanCyclones(rows = [], { limits }) {
  return rows
    .filter((storm) => validPosition(storm?.lat, storm?.lon) && storm?.name)
    .map((storm) => {
      const classification = String(storm.classification ?? '').trim();
      const windKt = numeric(storm.windKt);
      const pressure = numeric(storm.pressureHpa);
      const detailParams = {};
      if (windKt !== null) detailParams.wind = windKt;
      if (pressure !== null) detailParams.pressure = pressure;
      return {
        id: `cyclone:${storm.name}`,
        kind: 'cyclone',
        severity:
          windKt !== null && windKt >= limits.cycloneCriticalWindKt
            ? INCIDENT_SEVERITY.critical
            : INCIDENT_SEVERITY.warning,
        layerId: 'weather-cyclones',
        lat: storm.lat,
        lon: storm.lon,
        atMs: null,
        title: {
          key: msg('Cyclone {name} — {classification}'),
          params: {
            name: storm.name,
            classification: Object.hasOwn(CLASSIFICATION_KEYS, classification)
              ? { messageKey: CLASSIFICATION_KEYS[classification] }
              : classification || msg('Unclassified storm'),
          },
        },
        detail:
          Object.keys(detailParams).length > 0
            ? {
                key: msg('Winds {wind} kt · pressure {pressure} hPa'),
                params: detailParams,
              }
            : null,
      };
    });
}

/** Military contacts concentrated in one area (not a single transit). */
function scanMilitary(rows = [], { limits }) {
  const airborne = rows.filter(
    (row) => row?.military === true && row.onGround !== true,
  );
  return [...groupByCell(airborne, limits.militaryCellDeg).values()]
    .filter((contacts) => contacts.length >= limits.militaryClusterSize)
    .sort((a, b) => b.length - a.length)
    .slice(0, limits.militaryMaxCells)
    .map((contacts) => {
      const centre = meanPosition(contacts);
      return {
        id: `military:${incidentCellKey(centre.lat, centre.lon, limits.militaryCellDeg)}`,
        kind: 'military',
        severity: INCIDENT_SEVERITY.warning,
        layerId: 'military',
        lat: centre.lat,
        lon: centre.lon,
        atMs: null,
        title: {
          key: msg('Military air activity — {count} aircraft'),
          params: { count: contacts.length },
        },
        detail: null,
      };
    });
}

/** Degraded GNSS integrity around the sampled view (cells, not positions). */
function scanGnss(levels, { limits }) {
  const low = numeric(levels?.low) ?? 0;
  if (low < limits.gnssMinLowCells) return [];
  return [
    {
      id: 'gnss:degraded',
      kind: 'gnss',
      severity: INCIDENT_SEVERITY.warning,
      layerId: 'gnss-integrity',
      lat: null,
      lon: null,
      atMs: numeric(levels?.lastUpdate),
      title: {
        key: msg('GNSS integrity degraded — {count} cells'),
        params: { count: low },
      },
      detail: {
        key: msg('Navigation-integrity anomalies, not proof of jamming'),
        params: {},
      },
    },
  ];
}

const SEVERITY_RANK = Object.freeze({ critical: 0, warning: 1 });

/**
 * Scan every watched source once.
 * @param {object} [source]
 * @param {Array<object>} [source.flights]     flights analyst records
 * @param {Array<object>} [source.military]    military analyst records
 * @param {Array<object>} [source.earthquakes] earthquake analyst records
 * @param {Array<object>} [source.fires]       FIRMS analyst records
 * @param {Array<object>} [source.cyclones]    cyclone analyst records
 * @param {{levels?: object, lastUpdate?: number}|null} [source.gnss]
 * @param {{now?: number, limits?: object}} [options]
 * @returns {Array<object>} Incidents, most severe first, at most `maxIncidents`.
 */
export function scanIncidents(
  source = {},
  { now = Date.now(), limits = INCIDENT_LIMITS } = {},
) {
  const scope = { now, limits };
  const incidents = [
    ...scanAircraft(source.flights, source.military),
    ...scanQuakes(source.earthquakes, scope),
    ...scanFires(source.fires, scope),
    ...scanCyclones(source.cyclones, scope),
    ...scanMilitary(source.military, scope),
    ...scanGnss(source.gnss?.levels, scope),
  ];
  const unique = [
    ...new Map(incidents.map((incident) => [incident.id, incident])).values(),
  ];
  unique.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      (b.atMs ?? 0) - (a.atMs ?? 0) ||
      String(a.id).localeCompare(String(b.id)),
  );
  return unique.slice(0, limits.maxIncidents);
}
