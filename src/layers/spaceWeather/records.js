/**
 * NOAA SWPC space-weather readings, normalized for the solar-storm layer.
 *
 * Three products drive the layer, all read through this project's
 * `/api/space-weather` route so one place talks to SWPC:
 *
 *  - GOES X-ray flares (`xray-flares-7-day.json`): the eruption log.
 *  - Planetary K index (`planetary_k_index_1m.json` for now,
 *    `noaa-planetary-k-index.json` for the three-hourly series).
 *  - OVATION aurora (`ovation_aurora_latest.json`): a 1°×1° probability grid
 *    for the auroral oval.
 *
 * Everything here is pure — payload in, plain rows out — with no Cesium, no
 * i18n and no clock but an injected one. The layer draws what this returns;
 * the server route answers exactly this shape.
 * @module layers/spaceWeather/records
 */

/**
 * The NOAA geomagnetic (G) scale, quiet included: a storm starts at Kp 5.
 * @type {ReadonlyArray<{code: string, minKp: number}>}
 */
export const GEOMAGNETIC_SCALE = Object.freeze([
  Object.freeze({ code: 'G0', minKp: 0 }),
  Object.freeze({ code: 'G1', minKp: 5 }),
  Object.freeze({ code: 'G2', minKp: 6 }),
  Object.freeze({ code: 'G3', minKp: 7 }),
  Object.freeze({ code: 'G4', minKp: 8 }),
  Object.freeze({ code: 'G5', minKp: 9 }),
]);

/** The weakest OVATION cell worth drawing, in percent. */
export const AURORA_VISIBLE_PROBABILITY = 10;
/**
 * Cap on drawn cells. The oval is a band, so a decimated band reads the same
 * while keeping a storm-time globe (the grid has 65 160 cells) light.
 */
export const AURORA_MAX_POINTS = 4000;
/** A flare older than this is history, not a live event. */
export const FLARE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many three-hourly Kp readings the series keeps for the card. */
export const KP_SERIES_LENGTH = 56;

/** GOES flare letters in ascending strength; `rank` orders them. */
const FLARE_RANKS = Object.freeze({ A: 0, B: 1, C: 2, M: 3, X: 4 });

const ISO_WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse an SWPC timestamp as UTC milliseconds.
 *
 * SWPC mixes both forms: flare rows carry a `Z`, the K-index rows do not —
 * but every one of them is UTC, so a zone-less stamp is read as UTC rather
 * than local time. `Unk` and empty values are not a time.
 * @param {unknown} text
 * @returns {number|null}
 */
export function parseUtcMs(text) {
  const raw = String(text ?? '').trim();
  if (!raw || /^unk$/i.test(raw)) return null;
  const withZone = ISO_WITH_ZONE.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(withZone.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Split an X-ray class (`X1.2`, `M5`, `B6.4`) into its letter and magnitude.
 * @param {unknown} text
 * @returns {{letter: string, magnitude: number, rank: number}|null}
 */
export function parseFlareClass(text) {
  const match = /^([ABCMX])\s*(\d+(?:\.\d+)?)$/i.exec(
    String(text ?? '').trim(),
  );
  if (!match) return null;
  const letter = match[1].toUpperCase();
  return {
    letter,
    magnitude: Number(match[2]),
    rank: FLARE_RANKS[letter],
  };
}

/**
 * An orderable score for a flare class: `X1.0` > `M9.9` > `C9.9`.
 *
 * The letter dominates and the magnitude breaks ties, so this sorts flares
 * for the card and the label cohort. It is not the physical X-ray flux.
 * @param {unknown} text
 * @returns {number} -1 when the class cannot be read.
 */
export function flareClassScore(text) {
  const parsed = parseFlareClass(text);
  if (!parsed) return -1;
  return parsed.rank * 10 + Math.min(parsed.magnitude, 9.9);
}

/** Normalize a longitude from SWPC's 0–359 into ±180. */
export function wrapLongitude(lon) {
  const value = Number(lon);
  if (!Number.isFinite(value)) return null;
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

/**
 * The flare log, newest first, limited to the live window.
 *
 * SWPC's seven-day list is chronological; a flare with no end time is still
 * in progress, which the card says instead of inventing an end.
 * @param {unknown} payload `xray-flares-7-day.json`
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowMs]
 * @returns {Array<object>}
 */
export function normalizeFlareRecords(
  payload,
  { now = Date.now(), windowMs = FLARE_WINDOW_MS } = {},
) {
  if (!Array.isArray(payload)) return [];
  const horizon = now - Math.max(0, Number(windowMs) || 0);
  const flares = [];
  for (const row of payload) {
    if (!row || typeof row !== 'object') continue;
    const beginTime = parseUtcMs(row.begin_time);
    const maxTime = parseUtcMs(row.max_time) ?? beginTime;
    if (maxTime == null || maxTime < horizon) continue;
    const endTime = parseUtcMs(row.end_time);
    const beginClass = parseFlareClass(row.begin_class);
    const maxClass = parseFlareClass(row.max_class);
    if (!maxClass) continue;
    flares.push({
      id: `flare-${new Date(beginTime ?? maxTime).toISOString()}`,
      beginTime: beginTime ?? maxTime,
      maxTime,
      endTime,
      beginClass: beginClass ? row.begin_class.trim() : null,
      maxClass: `${maxClass.letter}${row.max_class.trim().slice(1)}`,
      currentClass: parseFlareClass(row.current_class)
        ? row.current_class.trim()
        : null,
      satellite: Number.isFinite(Number(row.satellite))
        ? Number(row.satellite)
        : null,
      score: flareClassScore(row.max_class),
      active: endTime == null,
    });
  }
  return flares.sort((a, b) => b.maxTime - a.maxTime);
}

/**
 * The current planetary K index from the one-minute estimate.
 *
 * NOAA publishes the integer `kp_index` and a fractional `estimated_kp`; the
 * estimated one is what the G scale is read against, so it wins when present.
 * @param {unknown} payload `planetary_k_index_1m.json`
 * @returns {{at: number|null, kp: number|null, observedKp: number|null}|null}
 */
export function normalizeKpReading(payload) {
  if (!Array.isArray(payload) || !payload.length) return null;
  const row = payload[payload.length - 1];
  const estimated = Number(row?.estimated_kp);
  const observed = Number(row?.kp_index);
  const kp = Number.isFinite(estimated)
    ? estimated
    : Number.isFinite(observed)
      ? observed
      : null;
  if (kp == null) return null;
  return {
    at: parseUtcMs(row?.time_tag),
    kp,
    observedKp: Number.isFinite(observed) ? observed : null,
  };
}

/**
 * The three-hourly Kp series, oldest first, capped to the recent tail.
 * @param {unknown} payload `noaa-planetary-k-index.json`
 * @param {number} [limit]
 * @returns {Array<{at: number, kp: number}>}
 */
export function normalizeKpSeries(payload, limit = KP_SERIES_LENGTH) {
  if (!Array.isArray(payload)) return [];
  const rows = [];
  for (const row of payload) {
    const at = parseUtcMs(row?.time_tag);
    const kp = Number(row?.Kp ?? row?.kp);
    if (at == null || !Number.isFinite(kp)) continue;
    rows.push({ at, kp });
  }
  rows.sort((a, b) => a.at - b.at);
  const cap = Math.max(1, Math.floor(Number(limit) || 0));
  return rows.slice(-cap);
}

/**
 * The G level a Kp value sits at, G0 (quiet) through G5.
 * @param {unknown} kp
 * @returns {{grade: number, code: string, kp: number|null}}
 */
export function geomagneticLevel(kp) {
  // `Number(null)` and `Number('')` are 0, which would read as a real Kp: a
  // missing reading is a missing reading, not a quiet field.
  const raw = typeof kp === 'string' ? kp.trim() : kp;
  if (raw == null || raw === '') return { grade: 0, code: 'G0', kp: null };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { grade: 0, code: 'G0', kp: null };
  let grade = 0;
  for (let index = GEOMAGNETIC_SCALE.length - 1; index > 0; index -= 1) {
    if (value >= GEOMAGNETIC_SCALE[index].minKp) {
      grade = index;
      break;
    }
  }
  return { grade, code: GEOMAGNETIC_SCALE[grade].code, kp: value };
}

/**
 * The auroral oval as drawn cells, with the strongest cell kept aside.
 *
 * Every cell at or above `threshold` becomes `[lon, lat, probability]` with
 * the longitude wrapped for Cesium. When that is more cells than `maxPoints`,
 * a fixed stride keeps every nth one in the upstream's own order, so the same
 * payload always yields the same band.
 * @param {unknown} payload `ovation_aurora_latest.json`
 * @param {object} [options]
 * @param {number} [options.threshold]
 * @param {number} [options.maxPoints]
 * @returns {{observedAt: number|null, forecastAt: number|null,
 *   peak: {lon: number|null, lat: number|null, probability: number},
 *   points: Array<[number, number, number]>}|null}
 */
export function normalizeAuroraGrid(
  payload,
  {
    threshold = AURORA_VISIBLE_PROBABILITY,
    maxPoints = AURORA_MAX_POINTS,
  } = {},
) {
  const rows = Array.isArray(payload?.coordinates) ? payload.coordinates : null;
  if (!rows) return null;
  const floor = Number.isFinite(Number(threshold)) ? Number(threshold) : 0;
  const peak = { lon: null, lat: null, probability: 0 };
  const visible = [];
  for (const cell of rows) {
    if (!Array.isArray(cell) || cell.length < 3) continue;
    const lon = wrapLongitude(cell[0]);
    const lat = Number(cell[1]);
    const probability = Number(cell[2]);
    if (lon == null || !Number.isFinite(lat) || !Number.isFinite(probability))
      continue;
    if (probability > peak.probability) {
      peak.lon = lon;
      peak.lat = lat;
      peak.probability = probability;
    }
    if (probability >= floor) visible.push([lon, lat, probability]);
  }
  const limit = Math.max(1, Math.floor(Number(maxPoints) || 0));
  const stride = Math.max(1, Math.ceil(visible.length / limit));
  return {
    observedAt: parseUtcMs(payload['Observation Time']),
    forecastAt: parseUtcMs(payload['Forecast Time']),
    peak,
    points: stride === 1 ? visible : visible.filter((_, i) => i % stride === 0),
  };
}

/**
 * Validate one `/api/space-weather` answer before it can replace the globe.
 * @param {unknown} payload
 * @returns {object|null} The snapshot, or null when nothing usable is in it.
 */
export function normalizeSpaceWeatherSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const kp = payload.kp && typeof payload.kp === 'object' ? payload.kp : null;
  const flares = Array.isArray(payload.flares) ? payload.flares : [];
  const aurora =
    payload.aurora && Array.isArray(payload.aurora.points)
      ? payload.aurora
      : null;
  if (!kp && !flares.length && !aurora) return null;
  return {
    fetchedAt: Number.isFinite(Number(payload.fetchedAt))
      ? Number(payload.fetchedAt)
      : null,
    kp: kp
      ? {
          value: Number.isFinite(Number(kp.value)) ? Number(kp.value) : null,
          at: Number.isFinite(Number(kp.at)) ? Number(kp.at) : null,
          observedKp: Number.isFinite(Number(kp.observedKp))
            ? Number(kp.observedKp)
            : null,
          series: Array.isArray(kp.series)
            ? kp.series
                .map((row) => ({
                  at: Number(row?.at),
                  kp: Number(row?.kp),
                }))
                .filter(
                  (row) => Number.isFinite(row.at) && Number.isFinite(row.kp),
                )
            : [],
        }
      : null,
    flares: flares.filter((flare) => flare && typeof flare.id === 'string'),
    aurora: aurora
      ? {
          observedAt: Number.isFinite(Number(aurora.observedAt))
            ? Number(aurora.observedAt)
            : null,
          forecastAt: Number.isFinite(Number(aurora.forecastAt))
            ? Number(aurora.forecastAt)
            : null,
          peak: aurora.peak ?? { lon: null, lat: null, probability: 0 },
          points: aurora.points.filter(
            (cell) =>
              Array.isArray(cell) &&
              cell.length >= 3 &&
              cell.every((value) => Number.isFinite(Number(value))),
          ),
        }
      : null,
  };
}

/**
 * The layer's one-line condition: current G level, the strongest flare in the
 * window, and where the oval is thickest.
 * @param {object} snapshot A normalized snapshot.
 * @returns {{grade: number, code: string, kp: number|null,
 *   kpAt: number|null, strongestFlare: object|null,
 *   auroraPeak: {lon: number|null, lat: number|null, probability: number}}}
 */
export function summarizeSpaceWeather(snapshot) {
  const level = geomagneticLevel(snapshot?.kp?.value);
  const flares = Array.isArray(snapshot?.flares) ? snapshot.flares : [];
  const strongestFlare =
    flares
      .slice()
      .sort(
        (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.maxTime - a.maxTime,
      )
      .at(0) ?? null;
  return {
    grade: level.grade,
    code: level.code,
    kp: level.kp,
    kpAt: snapshot?.kp?.at ?? null,
    strongestFlare,
    auroraPeak: snapshot?.aurora?.peak ?? {
      lon: null,
      lat: null,
      probability: 0,
    },
  };
}
