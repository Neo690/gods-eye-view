/**
 * Normalization for the Global disasters layer's three feeds.
 *
 * Rows share one flat shape so the layer draws, counts and answers analyst
 * questions without per-source cases:
 *
 *     { kind, source, stableId, lat, lon, name, hazard, country,
 *       alertLevel, severity, severityUnit, timeMs, url, areaHa, rings }
 *
 * `kind` is what the geometry layer points at it: an `event` (GDACS,
 * point-centred), an `activation` (Copernicus EMS, point-centred) or a
 * `fire` (EFFIS, polygon rings). `source` names the feed for cards and
 * credits; everything else is the normalized value.
 *
 * Normalizers return `null` when the document as a whole is malformed (the
 * snapshot must not replace the display) and silently drop the individual
 * unusable features. Dates upstream are published without an explicit offset;
 * GDACS documents treat them as UTC, as does the IFRC GDACS mapping.
 */

/** Parse "YYYY-MM-DDTHH:mm:ss" (or .mmm) UTF into epoch ms; null otherwise. */
export function parseIsoUtcLike(value) {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [, seconds, fraction = '0'] = match;
  const ms =
    Date.parse(`${seconds}Z`) +
    Number(String(fraction).slice(0, 3).padEnd(3, '0'));
  return Number.isFinite(ms) ? ms : null;
}

/** Parse an EFFIS "YYYY-MM-DD HH:mm:ss" timestamp into epoch ms; null otherwise. */
export function parseEffisTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse a WKT "POINT (lon lat)" centroid into {lat, lon}; null otherwise. */
export function parseWktPoint(value) {
  if (typeof value !== 'string') return null;
  const match = /^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() || null : null;
}

/** "RED"/"red" -> "Red"; null for anything else. */
function capitalizeWord(value) {
  const text = cleanText(value);
  return text
    ? text[0].toUpperCase() + text.slice(1).toLowerCase()
    : null;
}

/** GDACS publishes numeric ids (`eventid: 1001346`, `episodeid: 10`). */
function idText(value) {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Number.isFinite(Number(value)) ? String(value) : null;
  }
  return cleanText(value);
}

/**
 * Position of a GDACS feature: Point coordinates, or the centroid of a
 * Polygon/MultiPolygon outer ring when the feed ships the affected area.
 */
function gdacsPosition(feature) {
  const geometry = feature?.geometry;
  if (!geometry || typeof geometry !== 'object' || !Array.isArray(geometry.coordinates))
    return null;
  if (geometry.type === 'Point') {
    const [lon, lat] = geometry.coordinates;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }
  let outer = null;
  if (geometry.type === 'Polygon') outer = geometry.coordinates?.[0];
  else if (geometry.type === 'MultiPolygon')
    outer = geometry.coordinates?.[0]?.[0];
  if (!Array.isArray(outer) || !outer.length) return null;
  // Rings ship their closing coordinate (first == last); counting it twice
  // would pull the centroid towards the anchor vertex.
  const first = outer[0];
  const last = outer[outer.length - 1];
  const anchorRing =
    outer.length > 1 &&
    finiteNumber(first?.[0]) === finiteNumber(last?.[0]) &&
    finiteNumber(first?.[1]) === finiteNumber(last?.[1])
      ? outer.slice(0, -1)
      : outer;
  let latSum = 0;
  let lonSum = 0;
  for (const coordinate of anchorRing) {
    const lon = finiteNumber(coordinate?.[0]);
    const lat = finiteNumber(coordinate?.[1]);
    if (lat === null || lon === null) return null;
    latSum += lat;
    lonSum += lon;
  }
  const lat = latSum / anchorRing.length;
  const lon = lonSum / anchorRing.length;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Build one affected-country text ("India; Nepal" style) from the GDACS
 * `affectedcountries` webhook list and/or the single `country` string.
 */
function gdacsCountry(props) {
  const list = props.affectedcountries;
  const names = Array.isArray(list)
    ? list
        .map((entry) => cleanText(entry?.countryname))
        .filter((name) => name !== null)
    : [];
  const first = cleanText(props.country);
  if (first && !names.includes(first)) names.unshift(first);
  return names.length ? names.join('; ') : null;
}

/**
 * GDACS events are active, so an event whose window is already over by more
 * than GRACINESS_MS still shows: GDACS keeps episodes on the list while they
 * remain operationally active, and `todate` frequently trails the emergency.
 */
export const GDACS_ACTIVE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Normalize the GDACS `geteventlist` GeoJSON FeatureCollection into rows.
 * Features without a usable position are dropped; a document without a
 * features array invalidates the snapshot.
 * @returns {{rows: object[], dropped: number|null}} `dropped` is null pending
 *   validation.
 */
export function normalizeGdacsEventList(payload, { now = Date.now() } = {}) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.features)
  )
    return null;
  const rows = [];
  let dropped = 0;
  for (const feature of payload.features) {
    const props = feature?.properties ?? {};
    const eventtype = cleanText(props.eventtype)?.toUpperCase();
    if (!eventtype) {
      dropped++;
      continue;
    }
    const position = gdacsPosition(feature);
    if (!position) {
      dropped++;
      continue;
    }
    // The window is allowed to be missing: GDACS always reports one, but an
    // event is still worth giving its position while the timestamps are
    // unparsable, and the latest-known heuristic just treats it as unknown.
    const timeMs = parseIsoUtcLike(props.todate);
    const fromMs = parseIsoUtcLike(props.fromdate);
    const from = fromMs ?? timeMs;
    const eventid = idText(props.eventid) ?? idText(props.gdacsid);
    if (!eventid) {
      dropped++;
      continue;
    }
    rows.push({
      kind: 'event',
      source: 'gdacs',
      stableId: `gdacs:${eventid}:${idText(props.episodeid) ?? '0'}`,
      lat: position.lat,
      lon: position.lon,
      hazard: eventtype,
      name:
        cleanText(props.eventname) ??
        cleanText(props.name) ??
        cleanText(props.description) ??
        eventtype,
      country: gdacsCountry(props),
      alertLevel: capitalizeWord(props.alertlevel),
      severity: finiteNumber(props.severitydata?.severity),
      severityUnit: cleanText(props.severitydata?.severityunit),
      timeMs,
      url: cleanText(props.url?.report) ?? null,
      areaHa: null,
      rings: null,
      latestKnownMs: Math.max(timeMs ?? from ?? 0, from ?? 0, timeMs ?? 0),
    });
    // Active events are kept while their reported window is recent; GDACS
  }
  const cutoff = now - GDACS_ACTIVE_GRACE_MS;
  const active = rows.filter((row) => {
    const latest = row.latestKnownMs === 0 ? null : row.latestKnownMs;
    delete row.latestKnownMs;
    return latest === null || latest >= cutoff;
  });
  active.sort((left, right) => (right.timeMs ?? 0) - (left.timeMs ?? 0));
  return {
    rows: active,
    dropped,
  };
}

/** Known Copernicus EMS rapid-mapping categories kept on the layer. */
const EMS_HAZARD_BY_SLUG = new Map(
  [
    'flood',
    'earthquake',
    'volcano',
    'storm',
    'wind',
    'wildfire',
    'fire',
    'landslide',
    'drought',
    'tsunami',
    'cyclone',
    'hurricane',
    'alert',
  ].map((slug) => [slug, slug]),
);

/**
 * Copernicus EMS Rapid Mapping activations, newest first. A window is polite
 * here rather than enforced upstream: only the first pages are read and the
 * closed activations that fall outside it are cut client-side.
 */
export const EMS_ACTIVATION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Normalize the dashboard public-activations JSON (the flat list fields:
 * `code`, `eventTime`, `activationTime`, `centroid`, `category.name`,
 * `countries` string list, `closed`, `n_aois`, `n_products`).
 * @param {{now?: number, windowMs?: number}} [options]
 */
export function normalizeEmsActivationList(
  payload,
  { now = Date.now(), windowMs = EMS_ACTIVATION_WINDOW_MS } = {},
) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    (payload.results !== undefined && !Array.isArray(payload.results))
  )
    return null;
  // The dashboard answers a paginated envelope; a bare list is also valid.
  const list = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(payload)
      ? payload
      : [];
  const cutoff = now - windowMs;
  const rows = [];
  let dropped = 0;
  for (const item of list) {
    const code = cleanText(item?.code);
    if (!code) {
      dropped++;
      continue;
    }
    const position =
      parseWktPoint(item?.centroid) ?? parseWktPoint(item?.extent);
    if (!position) {
      dropped++;
      continue;
    }
    const category = item?.category;
    const slug = cleanText(
      typeof category === 'string' ? category : category?.slug,
    )?.toLowerCase();
    const hazard = slug !== null ? (EMS_HAZARD_BY_SLUG.get(slug) ?? 'other') : 'other';
    const timeMs =
      parseIsoUtcLike(item?.activationTime) ??
      parseIsoUtcLike(item?.eventTime);
    if (timeMs === null) {
      dropped++;
      continue;
    }
    if (timeMs < cutoff) continue;
    const countries = Array.isArray(item?.countries)
      ? item.countries
          .map((entry) =>
            cleanText(typeof entry === 'string' ? entry : entry?.name ?? entry?.short_name),
          )
          .filter((name) => name !== null)
      : [];
    const alertLevel = item?.closed === true ? null : 'Active';
    rows.push({
      kind: 'activation',
      source: 'ems',
      stableId: `ems:${code}`,
      lat: position.lat,
      lon: position.lon,
      hazard,
      name: cleanText(item?.name) ?? code,
      country: countries.length ? countries.join('; ') : null,
      alertLevel,
      severity: null,
      severityUnit: null,
      timeMs,
      url: cleanText(item?.reportLink) ?? null,
      areaHa: null,
      rings: null,
    });
  }
  rows.sort((left, right) => (right.timeMs ?? 0) - (left.timeMs ?? 0));
  return {
    rows,
    dropped,
  };
}

/**
 * EFFIS burnt-area perimeters (WFS GeoJSON). Geometry rings are carried on
 * the row and the drawing keeps only a bounded number of vertices per ring so
 * an unusual perimeter cannot stall the render.
 */
export const EFFIS_RING_VERTEX_CAP = 400;

function effisRings(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return null;
  const polygonGeometries =
    geometry.type === 'Polygon'
      ? [geometry]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates ?? []).map((coordinates) => ({ coordinates }))
        : null;
  if (!polygonGeometries) return null;
  const rings = [];
  for (const polygon of polygonGeometries) {
    if (!Array.isArray(polygon.coordinates)) return null;
    for (const ring of polygon.coordinates) {
      if (!Array.isArray(ring) || ring.length < 3) return null;
      const thinned = [];
      if (ring.length > EFFIS_RING_VERTEX_CAP) {
        const stride = Math.ceil(ring.length / EFFIS_RING_VERTEX_CAP);
        for (let index = 0; index < ring.length; index += stride)
          thinned.push(ring[index]);
        thinned.push(ring[ring.length - 1]);
      } else {
        thinned.push(...ring);
      }
      const points = [];
      for (const coordinate of thinned) {
        const lon = finiteNumber(coordinate?.[0]);
        const lat = finiteNumber(coordinate?.[1]);
        if (lat === null || lon === null) return null;
        points.push([lon, lat]);
      }
      rings.push(points);
    }
  }
  return rings.length ? rings : null;
}

/**
 * Normalize an EFFIS `GetFeature` GeoJSON answer. All upstream values are
 * serialized as strings, including numbers. Features without a readable area
 * or date are kept only when their perimeter is a usable polygon.
 * @param {{now?: number, windowMs?: number}} [options] A `windowMs` of 0 keeps
 *   every feature (the `week` layer is already scoped upstream).
 */
export function normalizeEffisCollection(
  payload,
  { now = Date.now(), windowMs = 8 * 24 * 60 * 60 * 1000 } = {},
) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.features)
  )
    return null;
  const rows = [];
  let dropped = 0;
  for (const feature of payload.features) {
    const props = feature?.properties ?? {};
    const id = cleanText(props.id);
    if (!id) {
      dropped++;
      continue;
    }
    const rings = effisRings(feature);
    if (!rings) {
      dropped++;
      continue;
    }
    let lat = 0;
    let lon = 0;
    let anchorCount = 0;
    // The anchor is the ring's plain centroid; skip the closing vertex when it
    // repeats the first one, or it drags the anchor towards the start corner.
    const anchorRing =
      rings[0].length > 1 &&
      rings[0][0][0] === rings[0][rings[0].length - 1][0] &&
      rings[0][0][1] === rings[0][rings[0].length - 1][1]
        ? rings[0].slice(0, -1)
        : rings[0];
    for (const point of anchorRing) {
      lat += point[1];
      lon += point[0];
      anchorCount++;
    }
    if (!anchorCount) {
      dropped++;
      continue;
    }
    lat /= anchorCount;
    lon /= anchorCount;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      dropped++;
      continue;
    }
    const timeMs = parseEffisTimestamp(props.FIREDATE ?? props.FINALDATE);
    if (timeMs === null) {
      dropped++;
      continue;
    }
    if (windowMs >= 0) {
      const cutoff = now - windowMs;
      if (timeMs < cutoff) continue;
    }
    const areaHa = finiteNumber(props.AREA_HA);
    const region = [props.PROVINCE, props.COMMUNE]
      .map(cleanText)
      .filter((part) => part !== null)
      .join(', ');
    rows.push({
      kind: 'fire',
      source: 'effis',
      stableId: `effis:${id}`,
      lat,
      lon,
      hazard: 'wildfire',
      name: cleanText(region) || cleanText(props.COUNTRY) || 'Burnt area',
      country: cleanText(props.COUNTRY),
      alertLevel: null,
      severity: areaHa,
      severityUnit: 'ha',
      timeMs,
      url: null,
      areaHa,
      rings,
    });
  }
  rows.sort(
    (left, right) => (right.timeMs ?? 0) - (left.timeMs ?? 0) ||
      (right.areaHa ?? 0) - (left.areaHa ?? 0),
  );
  return {
    rows,
    dropped,
  };
}
