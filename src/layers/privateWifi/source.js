import { MAX_POINTS } from '../viewportPoints/records.js';

/**
 * The browser-side source for the private Wi-Fi layer.
 *
 * It reads the imported export out of local storage and answers with the
 * networks inside the current view — the same `getSnapshot({ bounds })`
 * contract the network-backed layers use, so the layer draws, caps and
 * labels itself exactly like Radio Sites does. The difference is the whole
 * point of the layer: there is no fetch here, no route, and no key. A query
 * for a place the wardrive never covered is simply empty.
 *
 * @param {object} options
 * @param {{read: Function}} options.store
 */

/**
 * Networks inside a view, capped the way every point layer caps.
 * @param {Array<object>} networks
 * @param {{west:number,south:number,east:number,north:number}} bounds
 * @param {number} [limit]
 * @returns {{rows: Array<object>, matched: number, truncated: boolean}}
 */
export function networksInBounds(networks, bounds, limit = MAX_POINTS) {
  const rows = [];
  let matched = 0;
  if (!bounds) return { rows, matched, truncated: false };
  for (const network of Array.isArray(networks) ? networks : []) {
    const lat = Number(network?.lat);
    const lon = Number(network?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < bounds.south || lat > bounds.north) continue;
    if (lon < bounds.west || lon > bounds.east) continue;
    matched += 1;
    if (rows.length >= limit) continue;
    rows.push({
      id: network.mac || `net-${matched}`,
      lat,
      lon,
      // A hidden SSID still has a MAC worth reading; never invent a name.
      label: network.ssid || network.mac || String(matched),
      meta: {
        mac: network.mac || null,
        ssid: network.ssid || null,
        rssi: network.rssi,
        channel: network.channel,
        observations: network.observations,
        // Nothing here came from a provider: it is the operator's own file.
        local: true,
      },
    });
  }
  return { rows, matched, truncated: matched > rows.length };
}

export function createPrivateWifiSource({ store } = {}) {
  if (typeof store?.read !== 'function')
    throw new TypeError('Private Wi-Fi layer requires a store');
  return {
    async getSnapshot({ bounds } = {}) {
      const { networks } = store.read();
      if (!networks.length) return { rows: [], truncated: false };
      const { rows, truncated } = networksInBounds(networks, bounds);
      return { rows, truncated };
    },
  };
}
