import { MAX_POINTS } from '../viewportPoints/records.js';

/**
 * The browser-side source for the device-sweep layer.
 *
 * A LAN device has no geography: nmap reports addresses, not coordinates. The
 * layer therefore draws the operator's own declared place, with one device per
 * slot on a small ring around it — a legible stand-in for the flat, never a
 * claim about which wall a device sits on. The ring is ordered by verdict, so
 * the flagged devices sit nearest the centre and survive the point cap, and a
 * device the latest scan did not answer for keeps its slot at the back of the
 * ring, flagged `missing` so the presentation can grey it instead of dropping
 * something the operator may still be looking for.
 *
 * Like Private Wi-Fi, there is no fetch here and no route: the answer comes
 * from the operator's own stored file, and a view that does not contain the
 * declared place is simply empty.
 */

/** Radius step between ring slots, in degrees (~10 m at the equator). */
export const SWEEP_RING_STEP_DEG = 0.00009;

/** Golden angle, so consecutive slots spread instead of lining up. */
const GOLDEN_ANGLE = 2.399963229728653;

const VERDICT_ORDER = Object.freeze({
  camera: 0,
  iot: 1,
  network: 2,
  unknown: 3,
});

function priorFor(device) {
  return VERDICT_ORDER[device?.verdict] ?? 3;
}

/**
 * True when the latest import did not answer for this device: it was stored by
 * an earlier scan and the new file left it out. A store written before
 * `lastSeen` existed dates every device by its own import, so an upgraded
 * browser greys nothing until the next import moves on.
 *
 * @param {{lastSeen?: number}} device
 * @param {number|null} importedAt
 * @returns {boolean}
 */
export function missingFromLastScan(device, importedAt) {
  const last = Number(device?.lastSeen);
  return (
    Number.isFinite(importedAt) && Number.isFinite(last) && last < importedAt
  );
}

/**
 * Where one device is drawn: a slot on the ring around the declared place.
 * @param {{lat:number, lon:number}} place
 * @param {number} index slot number, 0 nearest the centre
 * @returns {{lat:number, lon:number}}
 */
export function sweepPointFor(place, index) {
  const slot = Math.max(0, Math.floor(Number(index) || 0));
  const radius = SWEEP_RING_STEP_DEG * Math.sqrt(slot + 1);
  const angle = slot * GOLDEN_ANGLE;
  const lat = place.lat + radius * Math.cos(angle);
  const cos = Math.cos((place.lat * Math.PI) / 180);
  const lon =
    place.lon + (radius * Math.sin(angle)) / Math.max(0.02, Math.abs(cos));
  return {
    lat: Math.max(-90, Math.min(90, lat)),
    lon: Math.max(-180, Math.min(180, lon)),
  };
}

function portSummary(device) {
  return (Array.isArray(device?.ports) ? device.ports : [])
    .map((port) => `${port.port}/${port.protocol}`)
    .join(', ');
}

/**
 * Devices inside a view, capped the way every point layer caps.
 *
 * @param {Array<object>} devices classified devices
 * @param {{lat:number, lon:number}|null} place
 * @param {{west:number,south:number,east:number,north:number}} bounds
 * @param {{importedAt?: number|null}} [options] `importedAt` dates the import,
 *   so a device first seen in it can be shown as new and one last seen before
 *   it can be shown as missing from the scan.
 * @returns {{rows: Array<object>, matched: number, truncated: boolean}}
 */
export function devicesInBounds(
  devices,
  place,
  bounds,
  { importedAt = null } = {},
) {
  const rows = [];
  let matched = 0;
  if (!place || !bounds) return { rows, matched, truncated: false };
  const ordered = (Array.isArray(devices) ? devices : [])
    .slice()
    .sort(
      (a, b) =>
        Number(missingFromLastScan(a, importedAt)) -
          Number(missingFromLastScan(b, importedAt)) ||
        priorFor(a) - priorFor(b) ||
        Number(b?.score ?? 0) - Number(a?.score ?? 0) ||
        String(a?.ip ?? '').localeCompare(String(b?.ip ?? '')),
    );
  for (const [index, device] of ordered.entries()) {
    const point = sweepPointFor(place, index);
    if (point.lat < bounds.south || point.lat > bounds.north) continue;
    if (point.lon < bounds.west || point.lon > bounds.east) continue;
    matched += 1;
    if (rows.length >= MAX_POINTS) continue;
    rows.push({
      id: device.mac || device.ip || `device-${index}`,
      lat: point.lat,
      lon: point.lon,
      // The address is what the operator can act on; a host name is a hint.
      label: device.ip || device.hostname || `device-${index}`,
      meta: {
        ip: device.ip || null,
        mac: device.mac || null,
        vendor: device.vendor || null,
        hostname: device.hostname || null,
        ports: portSummary(device),
        verdict: device.verdict ?? 'unknown',
        score: Number(device.score) || 0,
        reasons: Array.isArray(device.reasons) ? device.reasons : [],
        firstSeen: Number.isFinite(device.firstSeen) ? device.firstSeen : null,
        lastSeen: Number.isFinite(device.lastSeen) ? device.lastSeen : null,
        newSinceImport:
          Number.isFinite(importedAt) && device.firstSeen === importedAt,
        missing: missingFromLastScan(device, importedAt),
        note: device.note || null,
        local: true,
      },
    });
  }
  return { rows, matched, truncated: matched > rows.length };
}

export function createDeviceSweepSource({ store } = {}) {
  if (typeof store?.read !== 'function')
    throw new TypeError('Device sweep layer requires a store');
  return {
    async getSnapshot({ bounds } = {}) {
      const { devices, place, importedAt } = store.read();
      if (!devices.length || !place) return { rows: [], truncated: false };
      const { rows, truncated } = devicesInBounds(devices, place, bounds, {
        importedAt,
      });
      return { rows, truncated };
    },
  };
}
