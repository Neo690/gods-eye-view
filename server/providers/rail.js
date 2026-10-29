/**
 * Station departure boards for the Railway Stations layer.
 *
 *   GET /api/rail/departures?lat=..&lon=..
 *     → { station, departures, fetchedAt, staleness }
 *
 * The browser names a position, never a URL: both upstream addresses are
 * constants here, on the server. Two datasets are joined — the operator's
 * static GTFS (which says where a station is and what its last stop is called)
 * and the GTFS-Realtime TripUpdates feed (which says when the train now expects
 * to leave). The static index is held for half a day because a station does not
 * move; the realtime snapshot for under a minute, because a departure does.
 *
 * Nothing here invents a train: a station with no TripUpdates entry reports an
 * empty board, and a station the static index does not know is a 404 rather
 * than the nearest large city.
 */

import { inflateRawSync } from 'node:zlib';
import { readResponseBytesCapped } from '../../src/sources/httpBody.js';
import { decodeTripUpdates } from '../../src/data/gtfsRealtime.js';
import {
  RAIL_BOARD_LIMIT,
  RAIL_STATION_MATCH_KM,
  buildStationBoard,
  nearestStation,
  parseGtfsStops,
} from '../../src/data/railDepartures.js';

/** The SNCF open GTFS, 5.3 MB zipped; stops.txt is the only entry read. */
export const RAIL_GTFS_URL =
  'https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip';
/** The SNCF realtime timetable, ~1.3 MB protobuf. */
export const RAIL_TRIP_UPDATES_URL =
  'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates';

const GTFS_MAX_BYTES = 24 * 1024 * 1024;
const TRIP_UPDATES_MAX_BYTES = 8 * 1024 * 1024;
/** stops.txt is 744 KB of the archive. */
const STOPS_MAX_BYTES = 8 * 1024 * 1024;
const GTFS_TIMEOUT_MS = 20_000;
const TRIP_UPDATES_TIMEOUT_MS = 12_000;
/** A station index is stable for a feed day; the timetable is not. */
export const RAIL_STATIC_TTL_MS = 12 * 60 * 60 * 1000;
export const RAIL_REALTIME_TTL_MS = 45 * 1000;
/** A last-known board this old is labelled rather than served as live. */
export const RAIL_STALE_AFTER_MS = 10 * 60 * 1000;

const LICENCE = {
  name: 'SNCF GTFS and GTFS-RT',
  licence: 'Open Database License 1.0 (ODbL)',
  href: 'https://transport.data.gouv.fr/datasets/horaires-sncf',
  attribution: 'SNCF — horaires et temps réel, ODbL',
};

/**
 * Read one named entry out of a zip archive (stored or deflated).
 *
 * The archive is parsed here rather than with a dependency: one entry is
 * needed, and the repo already reads zips this way for its admin packs.
 *
 * @param {Uint8Array} buffer
 * @param {string} wanted Entry name.
 * @returns {Uint8Array|null}
 */
export function readZipEntry(buffer, wanted) {
  const bytes = Buffer.from(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  let eocd = bytes.length - 22;
  while (eocd >= 0 && bytes.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error('rail gtfs: not a zip archive');
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('rail gtfs: bad central directory');
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const dataStart =
        local +
        30 +
        bytes.readUInt16LE(local + 26) +
        bytes.readUInt16LE(local + 28);
      const data = bytes.subarray(dataStart, dataStart + compressed);
      if (method === 0) return data;
      if (method === 8)
        return inflateRawSync(data, { maxOutputLength: STOPS_MAX_BYTES });
      throw new Error(`rail gtfs: unsupported compression ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * Build the station index from a raw GTFS archive.
 * @param {Uint8Array} archive
 * @returns {{ areas: object[], areaStops: Map<string, string[]>,
 *   areaById: Map<string, object>, stopArea: Map<string, string>,
 *   truncated: boolean }}
 */
export function buildStationIndex(archive) {
  const stops = readZipEntry(archive, 'stops.txt');
  if (!stops) throw new Error('rail gtfs: stops.txt is missing');
  const parsed = parseGtfsStops(Buffer.from(stops).toString('utf8'));
  const stopArea = new Map();
  for (const area of parsed.areas) stopArea.set(area.id, area.id);
  for (const [areaId, stopIds] of parsed.areaStops) {
    for (const stopId of stopIds) stopArea.set(stopId, areaId);
  }
  return { ...parsed, stopArea };
}

const reply = (status, body, headers = {}) => ({
  status,
  headers: new Map(
    Object.entries({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    }),
  ),
  body,
  async text() {
    return body;
  },
});

const errorBody = (error, extra = {}) => JSON.stringify({ error, ...extra });

/**
 * Create the rail board service.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 */
export function createRailService({ fetchImpl = fetch, now = Date.now } = {}) {
  let staticIndex = null;
  let staticAt = 0;
  let realtime = null;
  let realtimeAt = 0;
  let realtimeError = null;
  let inFlightRealtime = null;
  let inFlightStatic = null;
  let closed = false;

  async function fetchBytes(url, maxBytes, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: '*/*' },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`upstream HTTP ${response.status}`), {
          upstreamStatus: response.status,
        });
      }
      return await readResponseBytesCapped(
        response,
        maxBytes,
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function loadStatic() {
    if (staticIndex && now() - staticAt < RAIL_STATIC_TTL_MS) {
      return Promise.resolve(staticIndex);
    }
    if (inFlightStatic) return inFlightStatic;
    inFlightStatic = (async () => {
      const archive = await fetchBytes(
        RAIL_GTFS_URL,
        GTFS_MAX_BYTES,
        GTFS_TIMEOUT_MS,
      );
      const index = buildStationIndex(archive);
      staticIndex = index;
      staticAt = now();
      return index;
    })().finally(() => {
      inFlightStatic = null;
    });
    return inFlightStatic;
  }

  function loadRealtime() {
    if (realtime && now() - realtimeAt < RAIL_REALTIME_TTL_MS) {
      return Promise.resolve(realtime);
    }
    if (inFlightRealtime) return inFlightRealtime;
    inFlightRealtime = (async () => {
      try {
        const bytes = await fetchBytes(
          RAIL_TRIP_UPDATES_URL,
          TRIP_UPDATES_MAX_BYTES,
          TRIP_UPDATES_TIMEOUT_MS,
        );
        const snapshot = decodeTripUpdates(bytes);
        realtime = snapshot;
        realtimeAt = now();
        realtimeError = null;
        return snapshot;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        realtimeError = error instanceof Error ? error.message : 'unavailable';
        // A board served from a snapshot minutes old is labelled, not claimed
        // live: the caller decides how to say so.
        if (realtime && now() - realtimeAt < RAIL_STALE_AFTER_MS)
          return realtime;
        throw error;
      }
    })().finally(() => {
      inFlightRealtime = null;
    });
    return inFlightRealtime;
  }

  async function departures(lat, lon, limit) {
    const index = await loadStatic();
    const nearest = nearestStation(
      index.areas,
      lat,
      lon,
      RAIL_STATION_MATCH_KM,
    );
    if (!nearest) {
      return {
        status: 404,
        body: errorBody('No railway station within walking distance', {
          radiusKm: RAIL_STATION_MATCH_KM,
        }),
      };
    }
    const snapshot = await loadRealtime();
    const nowS = Math.floor(now() / 1000);
    const board = buildStationBoard({
      trips: snapshot.trips,
      areaId: nearest.area.id,
      areaStops: index.areaStops,
      areaById: index.areaById,
      stopArea: index.stopArea,
      now: nowS,
      limit,
    });
    const ageMs = now() - realtimeAt;
    return {
      status: 200,
      body: JSON.stringify({
        station: {
          id: nearest.area.id,
          name: nearest.area.name,
          distanceM: Math.round(nearest.distanceKm * 1000),
        },
        departures: board.departures,
        considered: board.considered,
        truncated: board.truncated,
        fetchedAt: new Date(realtimeAt).toISOString(),
        staleness: {
          ageSeconds: Math.round(ageMs / 1000),
          stale: ageMs > RAIL_STALE_AFTER_MS,
          error: realtimeError,
        },
        licence: LICENCE,
      }),
    };
  }

  async function handle(incoming) {
    if (closed)
      return reply(503, errorBody('Rail board closed'), {
        'Retry-After': '30',
      });
    let url;
    try {
      url = new URL(incoming.url, 'http://localhost');
    } catch {
      return reply(400, errorBody('Bad request'));
    }
    if (!url.pathname.startsWith('/api/rail/'))
      return reply(404, errorBody('Unknown rail route'));
    if (incoming.method !== 'GET')
      return reply(405, errorBody('Method Not Allowed'));
    if (url.pathname !== '/api/rail/departures')
      return reply(404, errorBody('Unknown rail route'));
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      return reply(400, errorBody('A numerical lat and lon are required'));
    }
    const requested = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(requested)
      ? Math.min(RAIL_BOARD_LIMIT, Math.max(1, Math.floor(requested)))
      : RAIL_BOARD_LIMIT;
    try {
      const result = await departures(lat, lon, limit);
      return reply(result.status, result.body, {
        'Cache-Control': 'no-store',
      });
    } catch (error) {
      const upstream = error?.upstreamStatus;
      return reply(
        upstream === 404 ? 404 : 503,
        errorBody(
          upstream
            ? 'The SNCF feed answered with an error'
            : 'The SNCF feed is unreachable',
          { retryable: true },
        ),
        { 'Retry-After': '30' },
      );
    }
  }

  return {
    handle,
    close() {
      closed = true;
      staticIndex = null;
      realtime = null;
    },
    /** Test seam: the parsed index without waiting for a request. */
    _loadStatic: loadStatic,
  };
}

/** Vite plugin: mount the rail board at `/api/rail`. */
export function railProxy(options = {}) {
  const service = createRailService(options);
  function install(server) {
    server.middlewares.use('/api/rail', async (req, res) => {
      const response = await service.handle({
        url: `http://localhost/api/rail${req.url || '/'}`,
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'rail-proxy',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}

/** Name used by the local provider list. */
export const railwayBoardProxy = railProxy;
