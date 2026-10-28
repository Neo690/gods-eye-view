/**
 * The NHC cyclone snapshot, built inside the page.
 *
 * The server does this in `server/providers/cyclones.js`: it reads
 * `CurrentStorms.json`, then the NHC's published GIS layers, and hands the
 * client a storm list with its forecast track and cone. A standalone APK has no
 * server, and the shell's read-through can only fetch bodies — it cannot run
 * that builder — so the same steps live here.
 *
 * This is a deliberate copy, not a second design: `cycloneParity.test.mjs` runs
 * the server's own `parseCycloneStatus` and `attachCycloneGeometry` over the
 * same fixtures and fails when the two answers drift apart.
 */

const STATUS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const GIS =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
const HOUR = 3600_000;
/** Data, not UI copy: the layer translates its own messages. */
const COVERAGE =
  'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.';
const SOURCE = 'NOAA NHC / CPHC';
const ATTRIBUTION =
  'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center';
const UNAVAILABLE = 'Cyclone data unavailable';
const STALE_REASON = 'Cached cyclone advisory; upstream unavailable';
/** NHC stamps an advisory with its nominal time and publishes it early. */
const EARLY_ADVISORY_MS = 90 * 60_000;

export const CYCLONE_GIS_LAYERS = [
  { id: 5, cap: 512 * 1024, count: 500, kind: 'points' },
  { id: 6, cap: 512 * 1024, count: 32, kind: 'track' },
  { id: 7, cap: 2 * 1024 * 1024, count: 32, kind: 'cone' },
];

const invalid = () => new Error('invalid_cyclone_data');

function text(value, max = 80) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f<>]/.test(value)
  ) {
    throw invalid();
  }
  return value.trim();
}

function advisory(value) {
  if (typeof value !== 'string' || !/^\d{1,3}[A-Z]?$/i.test(value)) {
    throw invalid();
  }
  return value.replace(/^0+(?=\d)/, '').toUpperCase();
}

function number(value, min, max) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !['string', 'number'].includes(typeof value)
  ) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// CurrentStorms.json reports movementSpeed in miles per hour (intensity is in
// knots); convert so `speedKt` means what it says, as the server does.
function knotsFromMph(mph) {
  return mph === null ? null : Math.round(mph * 0.868976);
}

function iso(value, now) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  ) {
    throw invalid();
  }
  const n = Date.parse(value);
  if (
    !Number.isFinite(n) ||
    n > now + EARLY_ADVISORY_MS ||
    now - n > 12 * HOUR ||
    new Date(n).toISOString().replace('.000Z', 'Z') !==
      value.replace('.000Z', 'Z')
  ) {
    throw invalid();
  }
  return new Date(n).toISOString();
}

function position(coordinates) {
  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    Math.abs(coordinates[0]) > 180 ||
    Math.abs(coordinates[1]) > 90
  ) {
    throw invalid();
  }
  return { longitude: coordinates[0], latitude: coordinates[1] };
}

function officialLink(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.nhc.noaa.gov' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/text\/[A-Z0-9]+\.shtml$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * `CurrentStorms.json` → the storm list, before any geometry is attached.
 * @param {object} payload
 * @param {number} [now]
 * @returns {Array<object>}
 */
export function parseCycloneStatus(payload, now = Date.now()) {
  if (
    !Array.isArray(payload?.activeStorms) ||
    payload.activeStorms.length > 32
  ) {
    throw invalid();
  }
  const seen = new Set();
  return payload.activeStorms.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      !/^(?:al|ep|cp)\d{6}$/.test(raw.id) ||
      seen.has(raw.id)
    ) {
      throw invalid();
    }
    seen.add(raw.id);
    const forecast = raw.forecastAdvisory;
    return {
      id: raw.id,
      name: text(raw.name),
      classification: text(raw.classification, 16),
      basin: raw.id.slice(0, 2).toUpperCase(),
      position: position([raw.longitudeNumeric, raw.latitudeNumeric]),
      positionAt: iso(raw.lastUpdate, now),
      advisoryNumber: advisory(forecast?.advNum),
      issuedAt: iso(forecast?.issuance, now),
      windKt: number(raw.intensity, 0, 300),
      pressureHpa: number(raw.pressure, 800, 1100),
      movement: {
        directionDegrees: number(raw.movementDir, 0, 360),
        speedKt: knotsFromMph(number(raw.movementSpeed, 0, 200)),
      },
      advisoryUrl: officialLink(forecast.url),
      outlookUrl: raw.id.startsWith('al')
        ? 'https://www.nhc.noaa.gov/gtwo.php?basin=atlc&fdays=7'
        : raw.id.startsWith('cp')
          ? 'https://www.nhc.noaa.gov/gtwo.php?basin=cpac&fdays=7'
          : 'https://www.nhc.noaa.gov/gtwo.php?basin=epac&fdays=7',
      geometryStatus: 'pending',
      geometryAdvisoryNumber: null,
      forecastPoints: [],
      track: null,
      cone: null,
    };
  });
}

function geometry(raw, kind, budget) {
  const types =
    kind === 'points'
      ? ['Point']
      : kind === 'track'
        ? ['LineString', 'MultiLineString']
        : ['Polygon', 'MultiPolygon'];
  if (!types.includes(raw?.type)) throw invalid();
  const point = (value) => {
    position(value);
    if (++budget.count > 25_000) throw invalid();
    return [...value];
  };
  const line = (value, ring = false) => {
    if (
      !Array.isArray(value) ||
      value.length < (ring ? 4 : 2) ||
      value.length > 10_000
    ) {
      throw invalid();
    }
    const result = value.map(point);
    if (
      ring &&
      (result[0][0] !== result.at(-1)[0] || result[0][1] !== result.at(-1)[1])
    ) {
      throw invalid();
    }
    return result;
  };
  const list = (value, read) => {
    if (!Array.isArray(value) || !value.length || value.length > 128) {
      throw invalid();
    }
    return value.map(read);
  };
  const polygon = (value) => list(value, (ring) => line(ring, true));
  const coordinates =
    raw.type === 'Point'
      ? point(raw.coordinates)
      : raw.type === 'LineString'
        ? line(raw.coordinates)
        : raw.type === 'MultiLineString'
          ? list(raw.coordinates, (part) => line(part))
          : raw.type === 'Polygon'
            ? polygon(raw.coordinates)
            : list(raw.coordinates, polygon);
  return { type: raw.type, coordinates };
}

/**
 * Attach the forecast points, track and cone of the storm's own advisory.
 * Never relabel earlier GIS geometry with a newer status advisory.
 * @param {Array<object>} storms
 * @param {Array<object>} collections - points, track, cone FeatureCollections.
 * @returns {Array<object>}
 */
export function attachCycloneGeometry(storms, collections) {
  const budget = { count: 0 };
  const parsed = CYCLONE_GIS_LAYERS.map((spec, index) => {
    const payload = collections[index];
    if (
      payload?.type !== 'FeatureCollection' ||
      payload.exceededTransferLimit ||
      !Array.isArray(payload.features) ||
      payload.features.length > spec.count
    ) {
      throw invalid();
    }
    return payload.features.map((feature) => {
      if (feature?.type !== 'Feature') throw invalid();
      const p = feature.properties;
      const source =
        typeof p?.idp_source === 'string' &&
        p.idp_source.match(
          /^((?:al|ep|cp)\d{6})-(\d{1,3}[a-z]?)_5day_(pts|lin|pgn)$/i,
        );
      if (!source || source[3].toLowerCase() !== ['pts', 'lin', 'pgn'][index]) {
        throw invalid();
      }
      const adv = advisory(p.advisnum);
      if (adv !== advisory(source[2])) throw invalid();
      return {
        id: source[1].toLowerCase(),
        advisoryNumber: adv,
        geometry: geometry(feature.geometry, spec.kind, budget),
        tauHours: number(p.tau, 0, 168),
        windKt: number(p.maxwind, 0, 300),
        gustKt: number(p.gust, 0, 350),
      };
    });
  });
  return storms.map((storm) => {
    const groups = parsed.map((items) =>
      items.filter(
        (item) =>
          item.id === storm.id && item.advisoryNumber === storm.advisoryNumber,
      ),
    );
    if (groups[1].length > 1 || groups[2].length > 1) throw invalid();
    if (!groups[0].length || groups[1].length !== 1 || groups[2].length !== 1) {
      return storm;
    }
    const taus = new Set();
    const forecastPoints = groups[0]
      .map((item) => {
        if (item.tauHours === null || taus.has(item.tauHours)) throw invalid();
        taus.add(item.tauHours);
        return {
          position: position(item.geometry.coordinates),
          tauHours: item.tauHours,
          windKt: item.windKt,
          gustKt: item.gustKt,
        };
      })
      .sort((a, b) => a.tauHours - b.tauHours);
    return {
      ...storm,
      geometryStatus: 'current',
      geometryAdvisoryNumber: storm.advisoryNumber,
      forecastPoints,
      track: groups[1][0].geometry,
      cone: groups[2][0].geometry,
    };
  });
}

/**
 * The document `/api/cyclones` serves, in the shape the layer validates.
 * @param {{storms: Array<object>, fetchedAt: number, stale?: boolean}} value
 * @returns {object}
 */
export function describeCycloneSnapshot(value, stale = false) {
  return {
    schemaVersion: 1,
    source: SOURCE,
    attribution: ATTRIBUTION,
    coverage: COVERAGE,
    fetchedAt: value?.fetchedAt ?? null,
    stale: stale || !value,
    unavailable: !value,
    reason: !value ? UNAVAILABLE : stale ? STALE_REASON : null,
    storms: value?.storms ?? [],
  };
}

/**
 * The GIS query URLs, in `CYCLONE_GIS_LAYERS` order.
 * @returns {string[]}
 */
export function cycloneGeometryUrls() {
  return CYCLONE_GIS_LAYERS.map((spec) => {
    const url = new URL(`${GIS}/${spec.id}/query`);
    url.search = new URLSearchParams({
      where: '1=1',
      outFields:
        spec.kind === 'points'
          ? 'idp_source,advisnum,tau,maxwind,gust'
          : 'idp_source,advisnum',
      outSR: '4326',
      resultRecordCount: String(spec.count),
      geometryPrecision: '4',
      f: 'geojson',
    }).toString();
    return url.href;
  });
}

/** The upstream status document. */
export const CYCLONE_STATUS_URL = STATUS_URL;
