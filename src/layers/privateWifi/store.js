/**
 * Where an imported WiGLE export lives: this browser, and nowhere else.
 *
 * The export is the operator's own wardrive, so it is kept out of every
 * shared surface by construction: there is no upload path in this module, the
 * layer is registered as local-only (never serialised into a share link), and
 * the payload here is read and written only through `localStorage`. A phone
 * and a desktop that import the same file keep two independent copies.
 *
 * The stored form is a compact array per network rather than an object map —
 * a real wardrive is tens of thousands of fixes and key names would double
 * the size — and a write that would not fit is refused with a reason instead
 * of silently dropping half the file.
 */

export const PRIVATE_WIFI_STORAGE_KEY = 'gev.private-wifi.v1';

/** Ceiling for the stored string; localStorage itself is around 5 MB. */
export const PRIVATE_WIFI_MAX_BYTES = 3_500_000;

/** A refusal with a machine reason the row can translate. */
export class PrivateWifiStoreError extends Error {
  /**
   * @param {'unavailable'|'too-large'|'write-failed'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'PrivateWifiStoreError';
    this.code = code;
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // A browser with storage disabled throws on the property itself.
    return null;
  }
}

/** One network as stored: [lat, lon, mac, ssid, rssi, channel, observations]. */
function packNetwork(network) {
  return [
    Number(network.lat),
    Number(network.lon),
    String(network.mac ?? ''),
    String(network.ssid ?? ''),
    Number.isFinite(network.rssi) ? network.rssi : null,
    Number.isFinite(network.channel) ? network.channel : null,
    Math.max(1, Number(network.observations) || 1),
  ];
}

function unpackNetwork(row) {
  if (!Array.isArray(row) || row.length < 4) return null;
  const [lat, lon, mac, ssid, rssi, channel, observations] = row;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    mac: String(mac ?? ''),
    ssid: String(ssid ?? ''),
    rssi: Number.isFinite(rssi) ? rssi : null,
    channel: Number.isFinite(channel) ? channel : null,
    observations: Math.max(1, Number(observations) || 1),
  };
}

/**
 * @param {object} [options]
 * @param {Storage|null} [options.storage] Injected for tests.
 * @param {() => number} [options.now]
 */
export function createPrivateWifiStore({
  storage = defaultStorage(),
  now = () => Date.now(),
} = {}) {
  return {
    /** @returns {{networks: Array<object>, importedAt: number|null, name: string}} */
    read() {
      const empty = { networks: [], importedAt: null, name: '' };
      if (!storage) return empty;
      let raw;
      try {
        raw = storage.getItem(PRIVATE_WIFI_STORAGE_KEY);
      } catch {
        return empty;
      }
      if (!raw) return empty;
      try {
        const payload = JSON.parse(raw);
        const networks = (Array.isArray(payload?.nets) ? payload.nets : [])
          .map(unpackNetwork)
          .filter(Boolean);
        return {
          networks,
          importedAt: Number.isFinite(payload?.at) ? payload.at : null,
          name: String(payload?.name ?? ''),
        };
      } catch {
        // A half-written or hand-edited value is not worth crashing a layer
        // over: treat it as "no import" and let the next import replace it.
        return empty;
      }
    },

    /**
     * Replace the stored import.
     * @param {{networks: Array<object>, name?: string}} value
     * @returns {{bytes: number, importedAt: number}}
     */
    write({ networks = [], name = '' } = {}) {
      if (!storage)
        throw new PrivateWifiStoreError(
          'unavailable',
          'This browser cannot store an import',
        );
      const importedAt = now();
      const payload = {
        v: 1,
        at: importedAt,
        name: String(name ?? ''),
        nets: networks.map(packNetwork),
      };
      let serialised;
      try {
        serialised = JSON.stringify(payload);
      } catch {
        throw new PrivateWifiStoreError(
          'write-failed',
          'That import could not be saved',
        );
      }
      const bytes = serialised.length;
      if (bytes > PRIVATE_WIFI_MAX_BYTES)
        throw new PrivateWifiStoreError(
          'too-large',
          'The import is too large for this device',
        );
      try {
        storage.setItem(PRIVATE_WIFI_STORAGE_KEY, serialised);
      } catch (error) {
        // Quota exceeded arrives as a DOMException with no useful message;
        // name the remedy instead.
        throw new PrivateWifiStoreError(
          'write-failed',
          error?.name === 'QuotaExceededError'
            ? 'The import is too large for this device'
            : 'That import could not be saved',
        );
      }
      return { bytes, importedAt };
    },

    clear() {
      if (!storage) return;
      try {
        storage.removeItem(PRIVATE_WIFI_STORAGE_KEY);
      } catch {
        // Nothing to do: the next read already treats a broken store as empty.
      }
    },
  };
}
