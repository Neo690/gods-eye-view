import { t } from '../i18n/index.js';

/**
 * Live HTTP data readout: what this app has pulled over the network, and how
 * fast. It rides the globe-action strip as one dim line of text, next to the
 * window menu — telemetry, not a control, so it carries no frame and no button.
 *
 * Numbers come from the browser's own Resource Timing entries, which is the
 * only source that reports bytes already on the wire — no request is wrapped,
 * cloned or re-read, so measuring costs nothing and cannot change behaviour.
 * Two limits are honest rather than hidden: the browser withholds
 * `transferSize` for cross-origin resources without Timing-Allow-Origin (they
 * count as 0), and long-lived streams (audio radio, WebSocket voice) are not
 * Resource Timing entries at all. The readout therefore reports the app's own
 * HTTP traffic, which is what its tiles, feeds and routes spend.
 *
 * The first scan only sets the baseline: the boot bundle is added to the
 * session total, never to the per-second rate, so the line does not open on a
 * spike that happened before it existed.
 */

const TICK_MS = 1000;
const RATE_WINDOW_MS = 3000;
const UNIT_STEPS = [
  ['GB', 1e9],
  ['MB', 1e6],
  ['kB', 1e3],
];

/** Bytes an entry put on the wire, 0 when the browser withholds the figure. */
export function transferBytes(entry) {
  if (!entry) return 0;
  for (const name of ['transferSize', 'encodedBodySize', 'decodedBodySize']) {
    const size = Number(entry[name]);
    if (Number.isFinite(size) && size > 0) return size;
  }
  return 0;
}

/** Compact decimal size, in the units a network report uses. */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  for (const [unit, scale] of UNIT_STEPS) {
    if (value < scale) continue;
    const scaled = value / scale;
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')} ${unit}`;
  }
  return `${Math.round(value)} B`;
}

/** Bytes per second over the recent samples, never divided by empty time. */
export function rateFromSamples(samples, now, windowMs = RATE_WINDOW_MS) {
  if (!Array.isArray(samples) || !samples.length) return 0;
  const from = now - windowMs;
  let bytes = 0;
  let oldest = now;
  let counted = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample?.at) || sample.at < from) continue;
    bytes += Number.isFinite(sample.bytes) ? Math.max(0, sample.bytes) : 0;
    oldest = Math.min(oldest, sample.at);
    counted++;
  }
  if (!counted) return 0;
  // A window that has only just started is divided by the time it actually
  // covers, so the first second reads as a rate rather than a third of one.
  const covered = Math.min(windowMs, Math.max(now - oldest, 1000));
  return (bytes * 1000) / covered;
}

/**
 * Mount the readout in the globe-action strip and keep it ticking.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {Performance} [options.performanceRef]
 * @param {number} [options.tickMs]
 * @param {typeof globalThis.setInterval} [options.setIntervalFn]
 * @param {typeof globalThis.clearInterval} [options.clearIntervalFn]
 * @returns {{destroy: Function}}
 */
export function createDataUsageMeter({
  documentRef = globalThis.document,
  performanceRef = globalThis.performance,
  tickMs = TICK_MS,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  const host =
    documentRef?.getElementById?.('top-center-actions') ??
    documentRef?.getElementById?.('title-bar');
  const timeline =
    typeof performanceRef?.now === 'function' ? performanceRef : null;
  if (!host || !timeline || !documentRef?.createElement) {
    return { destroy() {} };
  }
  // A re-init keeps one readout: the old one is a stale measurement.
  documentRef.getElementById('data-usage')?.remove();

  const readout = documentRef.createElement('span');
  readout.id = 'data-usage';
  readout.className = 'data-usage';
  readout.setAttribute('role', 'group');
  readout.setAttribute('aria-label', t('Live data received by this app'));
  readout.title = t('Data usage');

  const value = (className, title) => {
    const node = documentRef.createElement('span');
    node.className = `data-usage-value ${className}`;
    node.title = title;
    readout.append(node);
    return node;
  };
  const rateValue = value('data-usage-rate', t('Download rate'));
  const separator = documentRef.createElement('span');
  separator.className = 'data-usage-sep';
  separator.setAttribute('aria-hidden', 'true');
  // i18n-ignore: a middot between two numbers, identical in every locale
  separator.textContent = '·';
  readout.append(separator);
  const totalValue = value('data-usage-total', t('Total received since load'));

  host.append(readout);

  const seen = new Set();
  const samples = [];
  let total = 0;
  let pending = 0;
  let baseline = true;
  let timer = null;
  let destroyed = false;

  const scan = () => {
    const entries = timeline.getEntriesByType?.('resource') ?? [];
    for (const entry of entries) {
      const key = `${entry.name}|${entry.startTime}|${entry.initiatorType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bytes = transferBytes(entry);
      if (bytes <= 0) continue;
      total += bytes;
      pending += bytes;
    }
  };

  const trim = (now) => {
    const from = now - RATE_WINDOW_MS;
    while (samples.length && samples[0].at < from) samples.shift();
  };

  const tick = () => {
    if (destroyed) return;
    scan();
    const now = timeline.now();
    if (!baseline) samples.push({ at: now, bytes: pending });
    pending = 0;
    baseline = false;
    trim(now);
    rateValue.textContent = `${formatBytes(rateFromSamples(samples, now))}/s`;
    totalValue.textContent = formatBytes(total);
  };

  const stop = () => {
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  };

  const start = () => {
    stop();
    if (destroyed || documentRef.hidden) return;
    tick();
    timer = setIntervalFn(tick, tickMs);
  };

  const onVisibility = () => {
    // A hidden tab accumulates nothing: on return the backlog is folded into
    // the total as a baseline instead of firing a spike through the rate.
    if (documentRef.hidden) {
      stop();
      return;
    }
    scan();
    pending = 0;
    samples.length = 0;
    start();
  };

  documentRef.addEventListener?.('visibilitychange', onVisibility);
  start();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      documentRef.removeEventListener?.('visibilitychange', onVisibility);
      readout.remove();
    },
  };
}
