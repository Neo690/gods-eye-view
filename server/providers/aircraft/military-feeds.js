/**
 * The military aircraft feeds this project reads, and what merging them means.
 *
 * Every participant answers the same readsb/tar1090 question — a top-level `ac`
 * array of aircraft — but each one is a different set of volunteer receivers,
 * so the same minute of the sky comes back overlapping AND different: one
 * network reports an aircraft the other never heard. Merging raises coverage
 * without inventing anything, because every row in the answer was received by
 * one of the networks.
 *
 * The licences differ, so the list states them instead of hiding them behind
 * one label: adsb.lol publishes under ODbL 1.0, adsb.fi allows personal,
 * non-commercial use with a citation and a link, and ADSB Exchange is keyed and
 * forbids redistributing its data — which is why it is only read when the
 * operator configured a key of their own. DATA_SOURCES.md carries the same
 * distinctions, and every response reports which feeds answered.
 */

/** Military feeds, in merge order. `key` names the variable that enables one. */
export const MILITARY_FEEDS = [
  {
    id: 'adsb.lol',
    url: 'https://api.adsb.lol/v2/mil',
    // ODbL 1.0; a key can be requested but is not required to read it.
    key: null,
  },
  {
    id: 'adsb.fi',
    url: 'https://opendata.adsb.fi/api/v2/mil',
    // Personal, non-commercial use; cite adsb.fi and link its home page.
    key: null,
  },
  {
    id: 'adsbexchange',
    url: 'https://gateway.adsbexchange.com/api/aircraft/v2/mil',
    // Opt-in only: its acceptable-use policy forbids redistributing the data it
    // returns, so this project reads it with the operator's own key and never
    // with a key of its own.
    key: 'ADSBX_API_KEY',
    header: 'X-Api-Key',
  },
];

/**
 * The feeds this process may read: every keyless one, plus each keyed feed
 * whose own variable is set. A keyed feed with no key is left out rather than
 * requested and rejected, so a 401 never shows up as a dead source.
 * @param {Record<string, string|undefined>} [env] Environment to read.
 * @returns {Array<object>} Feeds to read, in merge order.
 */
export function configuredMilitaryFeeds(env = process.env) {
  return MILITARY_FEEDS.filter((feed) => !feed.key || Boolean(env[feed.key]));
}

/**
 * Request headers for one feed, carrying the operator's key when it needs one.
 * The User-Agent names this project so an operator of a feed can tell who is
 * reading.
 * @param {object} feed A feed from {@link MILITARY_FEEDS}.
 * @param {Record<string, string|undefined>} [env] Environment to read.
 * @returns {Record<string, string>} Headers for the upstream request.
 */
export function militaryFeedHeaders(feed, env = process.env) {
  const headers = { 'User-Agent': 'gods-eye-view-military-proxy/1.0' };
  if (feed.key && env[feed.key])
    headers[feed.header || 'X-Api-Key'] = env[feed.key];
  return headers;
}

/** A row carries a position the aircraft layers can plot. */
function positioned(row) {
  const latitude = Number(row?.lat);
  const longitude = Number(row?.lon);
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

/** Seconds since the position was observed, or null when the row omits it. */
function seenPosition(row) {
  const seconds = Number(row?.seen_pos);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Is `candidate` the better row for an ICAO24 two feeds both reported?
 *
 * A row with a position always beats one without: the aircraft layers drop a
 * positionless contact, so keeping the positionless row would delete an
 * aircraft the merge is supposed to be widening coverage for. Between two
 * positioned rows the freshest position wins, and a tie keeps the earlier feed
 * so the answer is stable between refreshes.
 */
function preferable(candidate, incumbent) {
  const candidatePositioned = positioned(candidate.row);
  const incumbentPositioned = positioned(incumbent.row);
  if (candidatePositioned !== incumbentPositioned) return candidatePositioned;
  const candidateSeen = candidate.seenPos;
  const incumbentSeen = incumbent.seenPos;
  if (candidateSeen == null) return false;
  if (incumbentSeen == null) return true;
  return candidateSeen < incumbentSeen;
}

/** The `ac` array of one body, or null when the body is not a usable answer. */
function aircraftOf(body) {
  try {
    const payload = JSON.parse(body);
    return Array.isArray(payload?.ac) ? payload.ac : null;
  } catch {
    return null;
  }
}

/**
 * Merge readsb `/v2/mil` bodies into one answer.
 *
 * Rows without an ICAO24 cannot be deduplicated, so they are kept as received:
 * dropping them would discard aircraft a network did report. Bodies that do not
 * parse contribute nothing, which is what lets one broken feed leave the rest
 * of the answer intact.
 *
 * @param {Array<{id: string, body: string}>} entries Bodies that answered.
 * @returns {{body: string, total: number, duplicates: number, sources: Array<{id: string, count: number}>}}
 *   The merged response body, its aircraft count, how many rows a second feed
 *   duplicated, and what each contributing feed reported.
 */
export function mergeMilitaryPayloads(entries) {
  const byIcao = new Map();
  const unkeyed = [];
  const sources = [];
  let reported = 0;

  for (const entry of entries) {
    const aircraft = aircraftOf(entry.body);
    if (!aircraft) continue;
    // A feed repeating an ICAO24 inside one body does not add an aircraft.
    const seen = new Set();
    let count = 0;
    for (const row of aircraft) {
      const icao =
        typeof row?.hex === 'string' ? row.hex.trim().toLowerCase() : '';
      if (!icao) {
        unkeyed.push(row);
        count += 1;
        reported += 1;
        continue;
      }
      if (seen.has(icao)) continue;
      seen.add(icao);
      count += 1;
      reported += 1;
      // The ICAO24 is the identity of a row, so the merged answer emits it in
      // one spelling: feeds disagree on case, and which one won must not decide
      // what a consumer grouping by ICAO24 sees.
      const candidate = {
        row: row.hex === icao ? row : { ...row, hex: icao },
        seenPos: seenPosition(row),
      };
      const incumbent = byIcao.get(icao);
      if (!incumbent || preferable(candidate, incumbent))
        byIcao.set(icao, candidate);
    }
    sources.push({ id: entry.id, count });
  }

  const merged = [...byIcao.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, entry]) => entry.row);
  const ac = merged.concat(unkeyed);
  return {
    body: JSON.stringify({ ac, total: ac.length, sources }),
    total: ac.length,
    duplicates: reported - ac.length,
    sources,
  };
}
