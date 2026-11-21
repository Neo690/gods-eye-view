import { formatNumber, formatRelativeTime, msg, t } from '../../i18n/index.js';
import { missingFromLastScan } from './source.js';

/**
 * What the device sweep shows: a point's colour, its hover text and its row.
 *
 * Kept apart from the layer's wiring (index.js) because all of it is pure: the
 * same devices and place always produce the same labels, so the row can be
 * tested without a viewer, a file picker or a browser. Nothing here reads the
 * store or touches the DOM.
 */

/** Verdict colours, shared by the points, the legend and the row. */
export const DEVICE_SWEEP_COLOURS = Object.freeze({
  camera: '#ff4d5e',
  iot: '#ffb347',
  network: '#4de18e',
  unknown: '#8a94a6',
});

/**
 * A device the latest scan did not answer for. Deliberately dimmer than the
 * unknown shade, so "we have no idea what this is" and "this did not show up
 * last time" never look the same on the globe.
 */
export const DEVICE_SWEEP_MISSING_COLOUR = '#6b7482';

/** The four verdicts a marker can show, plus a device the scan no longer sees. */
export const DEVICE_SWEEP_LEGEND = Object.freeze([
  Object.freeze({
    label: msg('Camera-like'),
    color: DEVICE_SWEEP_COLOURS.camera,
  }),
  Object.freeze({ label: msg('IoT device'), color: DEVICE_SWEEP_COLOURS.iot }),
  Object.freeze({
    label: msg('Network device'),
    color: DEVICE_SWEEP_COLOURS.network,
  }),
  Object.freeze({
    label: msg('Unclassified'),
    color: DEVICE_SWEEP_COLOURS.unknown,
  }),
  Object.freeze({
    label: msg('Not in your last scan'),
    color: DEVICE_SWEEP_MISSING_COLOUR,
  }),
]);

/**
 * Colour one marker from its own verdict. A device the latest scan did not
 * answer for gets the dim shade whatever it was, because its absence is the
 * news; a row without a verdict falls back to the unknown shade rather than to
 * the theme, so a parser change cannot quietly recolour the sweep.
 */
export function deviceSweepColour(point) {
  if (point?.meta?.missing === true) return DEVICE_SWEEP_MISSING_COLOUR;
  return (
    DEVICE_SWEEP_COLOURS[point?.meta?.verdict] ?? DEVICE_SWEEP_COLOURS.unknown
  );
}

/** The verdict as a shown label. */
export function deviceVerdictLabel(verdict) {
  if (verdict === 'camera') return t('Camera-like');
  if (verdict === 'iot') return t('IoT device');
  if (verdict === 'network') return t('Network device');
  return t('Unclassified');
}

/**
 * One evidence line for a reason the classifier recorded. The code picks the
 * sentence; the detail is data (a port, a vendor) and stays as scanned.
 */
function reasonLabel(reason) {
  switch (reason?.code) {
    case 'rtsp':
      return t('RTSP video port');
    case 'recorder':
      return t('Video-recorder port {port}', { port: reason.detail });
    case 'stream':
      return t('Live-stream port');
    case 'admin':
      return t('Serves an admin page');
    case 'vendor':
      return t('Camera-maker MAC prefix');
    case 'sensor':
      return t('IoT board vendor');
    case 'hostname':
      return t('Camera-like host name');
    default:
      return '';
  }
}

/** Units an age is spoken in, largest first, each with its length in seconds. */
const AGE_UNITS = Object.freeze([
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]);

/**
 * A stored timestamp as an age: "3 days ago", "yesterday", "last month".
 *
 * A sweep from this morning and one from three days ago are not the same
 * finding, and a clock time leaves that comparison to the reader. Relative time
 * keeps the comparison in the words. Nothing under a minute is spoken — "now"
 * is not an age, and whatever just happened is already in the row.
 *
 * @param {number|null} timestamp Epoch ms, as the store writes it.
 * @param {number} [now] Injected by callers that need a fixed clock in tests.
 * @returns {string} The age, or '' when there is no time worth speaking of.
 */
export function deviceAge(timestamp, now = Date.now()) {
  const time = Number(timestamp);
  if (!Number.isFinite(time) || time <= 0) return '';
  const seconds = Math.round((Number(now) - time) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return '';
  const [unit, length] = AGE_UNITS.find(([, size]) => seconds >= size) ?? [
    'second',
    1,
  ];
  return formatRelativeTime(-Math.floor(seconds / length), unit);
}

/**
 * Hover text for one device: the evidence first, then the verdict it produced.
 * A device whose scan carried no open port says so rather than showing a blank
 * line where a port list would go. A note the operator wrote themselves comes
 * last, a device first seen in the latest import is named as new, and one the
 * latest import left out says so rather than looking merely unclassified.
 *
 * @param {object} point one normalized row (id, lat, lon, label, meta)
 * @param {{now?: number}} [options] Fixed clock for tests.
 * @returns {string} the multi-line hover text
 */
export function deviceSweepHoverTip(point, { now = Date.now() } = {}) {
  if (!point) return '';
  const meta = point.meta && typeof point.meta === 'object' ? point.meta : {};
  const name = [meta.ip || point.label || point.id, meta.hostname]
    .filter(Boolean)
    .join(' · ');
  const reasons = (Array.isArray(meta.reasons) ? meta.reasons : [])
    .map(reasonLabel)
    .filter(Boolean);
  return [
    name,
    meta.vendor ? t('Vendor: {vendor}', { vendor: meta.vendor }) : '',
    meta.ports
      ? t('Open ports: {ports}', { ports: meta.ports })
      : t('No open ports in the scan'),
    t('Verdict: {verdict}', { verdict: deviceVerdictLabel(meta.verdict) }),
    reasons.length
      ? t('Why flagged: {reasons}', { reasons: reasons.join(' · ') })
      : '',
    meta.newSinceImport ? t('New since your last scan') : '',
    meta.missing ? t('Not in your last scan') : '',
    deviceAge(meta.lastSeen, now)
      ? t('Last seen: {age}', { age: deviceAge(meta.lastSeen, now) })
      : '',
    meta.note ? t('Note: {note}', { note: meta.note }) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The row's text and the state of its chips, from the stored sweep.
 *
 * `added` is what a second import is really asked for: the devices that were
 * not in the previous one. `missing` is its other half — the devices the new
 * file left out, still drawn and still counted, so the operator learns that a
 * camera went quiet instead of finding it silently gone. The row never claims
 * to have scanned anything: every number comes from the file the operator
 * imported.
 *
 * @param {object} [state]
 * @param {Array<object>} [state.devices] Stored devices, with `firstSeen`.
 * @param {{lat:number, lon:number}|null} [state.place]
 * @param {number|null} [state.importedAt] Date of the latest import.
 * @param {number} [state.now] Fixed clock for tests.
 * @param {string} [state.feedback] One line about the last action.
 * @param {boolean} [state.pickingPlace] True while a globe click is armed.
 * @returns {{count:number, flagged:number, added:number, missing:number,
 *   summary:string,
 *   detail:string, pick:{label:string, active:boolean},
 *   clear:{disabled:boolean}, note:{disabled:boolean}}}
 */
export function deviceSweepRow({
  devices = [],
  place = null,
  importedAt = null,
  now = Date.now(),
  feedback = '',
  pickingPlace = false,
} = {}) {
  const list = Array.isArray(devices) ? devices : [];
  const count = list.length;
  const flagged = list.filter((device) => device.verdict === 'camera').length;
  const added = Number.isFinite(importedAt)
    ? list.filter((device) => device.firstSeen === importedAt).length
    : 0;
  const missing = list.filter((device) =>
    missingFromLastScan(device, importedAt),
  ).length;
  const summary = count
    ? t('{count} devices · {flagged} flagged · stays on this device', {
        count: formatNumber(count),
        flagged: formatNumber(flagged),
      })
    : t('No scan yet · your own spaces only · stays on this device');
  // How long ago the file was read, not when: a sweep from three days ago has
  // to read as old at a glance, without the reader comparing clock times.
  const importAge = deviceAge(importedAt, now);
  const withImport = importAge
    ? `${summary} · ${t('last import {age}', { age: importAge })}`
    : summary;
  const withNew = added
    ? `${withImport} · ${t('{count} new since your last scan', {
        count: formatNumber(added),
      })}`
    : withImport;
  const withMissing =
    count && missing
      ? `${withNew} · ${t('{count} not in your last scan', {
          count: formatNumber(missing),
        })}`
      : withNew;
  return {
    count,
    flagged,
    added,
    missing,
    summary: withMissing,
    detail:
      feedback ||
      (count && !place
        ? `${withMissing} · ${t('Set your place to draw the scan: MY LOCATION, PICK ON GLOBE or COORDINATES')}`
        : withMissing),
    pick: {
      label: pickingPlace ? t('CANCEL PICK') : t('PICK ON GLOBE'),
      active: pickingPlace,
    },
    clear: { disabled: count === 0 },
    note: { disabled: count === 0 },
  };
}
