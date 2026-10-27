/**
 * Read a WiGLE CSV export into the networks this layer draws.
 *
 * WiGLE's own export is not a clean CSV: it opens with a `WigleWifi-1.4,...`
 * preamble line, the SSID column carries commas and doubled quotes, and the
 * same access point appears once per observation along a wardrive. None of
 * that is a reason to ask the operator to pre-process the file, so this
 * parser handles all three and keeps one point per network, at the strongest
 * observation — which is the position a wardrive can actually defend.
 *
 * Nothing here touches the network or the DOM: the file is read by the
 * caller, and the resulting rows never leave this device.
 */

/** Most distinct networks one import may keep. */
export const WIGLE_MAX_NETWORKS = 20000;

/** Column the header must carry for the file to be a WiGLE export. */
const REQUIRED_COLUMNS = Object.freeze(['MAC', 'CurrentLatitude']);

/**
 * Split one CSV line, honouring double quotes and `""` escapes.
 * WiGLE writes `[ESS]`-style auth modes and free-text SSIDs, so a naive
 * `split(',')` breaks on real exports.
 * @param {string} line
 * @returns {string[]}
 */
export function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ',') {
      fields.push(field);
      field = '';
      continue;
    }
    field += character;
  }
  fields.push(field);
  return fields;
}

/**
 * Locate the header row and the column index of every field this layer reads.
 * A file without one is not a WiGLE export and is refused rather than guessed
 * at by position, because a shifted column would put networks in the ocean.
 * @param {string[]} lines
 * @returns {{index: number, columns: Record<string, number>}|null}
 */
export function findWigleHeader(lines) {
  for (const [index, line] of lines.entries()) {
    if (!line.includes('MAC')) continue;
    const fields = splitCsvLine(line).map((field) => field.trim());
    if (!REQUIRED_COLUMNS.every((column) => fields.includes(column))) continue;
    const columns = {};
    fields.forEach((name, position) => {
      if (name) columns[name] = position;
    });
    return { index, columns };
  }
  return null;
}

function readField(fields, columns, name) {
  const position = columns[name];
  if (position === undefined) return '';
  return String(fields[position] ?? '').trim();
}

/** A WiGLE export can carry Bluetooth and cell rows; this layer is Wi-Fi. */
function isWifiRow(type) {
  const value = type.trim().toUpperCase();
  return value === '' || value === 'WIFI' || value === 'WIFI ';
}

/**
 * Parse a WiGLE CSV export.
 *
 * @param {string} text File contents.
 * @param {{limit?: number}} [options]
 * @returns {{
 *   networks: Array<{mac:string, ssid:string, lat:number, lon:number,
 *     rssi:number|null, channel:number|null, observations:number}>,
 *   observations: number, skipped: number, truncated: boolean,
 *   header: boolean,
 * }}
 */
export function parseWigleCsv(text, { limit = WIGLE_MAX_NETWORKS } = {}) {
  const cap =
    Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : WIGLE_MAX_NETWORKS;
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  const found = findWigleHeader(lines);
  if (!found)
    return {
      networks: [],
      observations: 0,
      skipped: 0,
      truncated: false,
      header: false,
    };
  const byKey = new Map();
  let observations = 0;
  let skipped = 0;
  let truncated = false;
  for (let index = found.index + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const fields = splitCsvLine(line);
    if (!isWifiRow(readField(fields, found.columns, 'Type'))) {
      skipped += 1;
      continue;
    }
    const lat = Number(readField(fields, found.columns, 'CurrentLatitude'));
    const lon = Number(readField(fields, found.columns, 'CurrentLongitude'));
    // WiGLE writes 0,0 for "no fix"; drawing that puts a network in the Gulf
    // of Guinea and makes the whole import look wrong.
    const placed =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180 &&
      !(lat === 0 && lon === 0);
    if (!placed) {
      skipped += 1;
      continue;
    }
    observations += 1;
    const mac = readField(fields, found.columns, 'MAC');
    const ssid = readField(fields, found.columns, 'SSID');
    const key = mac || `${ssid}@${lat.toFixed(5)},${lon.toFixed(5)}`;
    const rssiValue = Number(readField(fields, found.columns, 'RSSI'));
    const rssi = Number.isFinite(rssiValue) ? rssiValue : null;
    const channelValue = Number(readField(fields, found.columns, 'Channel'));
    const existing = byKey.get(key);
    if (existing) {
      existing.observations += 1;
      // Keep the strongest observation: the closest pass is the one whose
      // position the wardrive can stand behind.
      if (rssi !== null && (existing.rssi === null || rssi > existing.rssi)) {
        existing.lat = lat;
        existing.lon = lon;
        existing.rssi = rssi;
      }
      continue;
    }
    if (byKey.size >= cap) {
      truncated = true;
      continue;
    }
    byKey.set(key, {
      mac,
      ssid,
      lat,
      lon,
      rssi,
      channel: Number.isFinite(channelValue) ? channelValue : null,
      observations: 1,
    });
  }
  return {
    networks: [...byKey.values()],
    observations,
    skipped,
    truncated,
    header: true,
  };
}
