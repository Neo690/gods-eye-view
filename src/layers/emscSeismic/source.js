import { normalizeEmscEarthquakeSnapshot } from './records.js';

const FDSN_QUERY_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_MAGNITUDE = 2.5;
// The RTS and reviewed catalogues are dense at M2.5+; keep the worst-case read
// bounded so a busy global day stays one request and one payload.
const MAX_EVENTS = 1500;

/** Format an FDSN `starttime`/`endtime` moment (no ms, no offset). */
export function fdsnFormatInstant(date) {
  return date.toISOString().replace(/\.\d+Z$/, '');
}

/** Build the 24-hour M2.5+ FDSN read for the moment it is requested. */
export function buildEmscQueryUrl({
  now = new Date(),
  windowMs = WINDOW_MS,
} = {}) {
  const end = new Date(Number(now));
  const start = new Date(Number(end) - windowMs);
  const params = new URLSearchParams({
    format: 'json',
    starttime: fdsnFormatInstant(start),
    endtime: fdsnFormatInstant(end),
    minmagnitude: String(MIN_MAGNITUDE),
    limit: String(MAX_EVENTS),
  });
  return `${FDSN_QUERY_URL}?${params}`;
}

/** Request and validate a complete EMSC snapshot before it can replace the display. */
export function createEmscEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => new Date(),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const url = buildEmscQueryUrl({ now: now() });
      const response = await fetchImpl(url, { signal });
      // An FDSN service answering 204 means "no events in the window", a real
      // (empty) snapshot rather than a failure.
      if (response.status === 204) return [];
      if (!response.ok) throw new Error(`EMSC HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeEmscEarthquakeSnapshot(payload);
      if (!rows) throw new Error('Malformed EMSC response');
      return rows;
    },
  };
}
