import { t } from '../i18n/index.js';

/**
 * Live HTTP data readout: what this app has pulled over the network, and how
 * fast. It is one dim line in the HUD's telemetry window, under the AIS row —
 * that block already reads as one set of numbers (coordinates, imaging scale,
 * AIS, traffic), and a phone shows the whole window, where a line floating
 * above the mic collided with the mic pill and had to drop its session total.
 *
 * Numbers come from two sources, because one of them cannot see the app's own
 * traffic. The browser's Resource Timing entries report bytes already on the
 * wire for everything the engine loads (tiles, images, scripts), but they
 * report `0` for a cross-origin response without Timing-Allow-Origin — which
 * is every feed the app fetches, and every `appassets` answer the Android
 * shell synthesises. So the app's own `fetch` is also tapped, once, and the
 * body it reads is counted chunk by chunk as it is consumed: nothing is
 * buffered, no response is replaced, and a measurement failure leaves the
 * request untouched. Resource Timing then skips `fetch` entries, so a byte
 * that both sources can see is counted once.
 *
 * Two limits stay honest rather than hidden: long-lived streams (audio radio,
 * WebSocket voice) are not counted, and Cesium's own tile traffic is counted
 * only where Resource Timing exposes it. The readout therefore reports the
 * app's HTTP traffic — its tiles, feeds and routes.
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
 * Count what one response delivered, preferring the declared length and
 * otherwise reading a clone chunk by chunk so nothing is kept in memory.
 * @param {Response} response
 * @param {(bytes: number) => void} onBytes
 */
function countResponseBytes(response, onBytes) {
  try {
    const declared = Number(response?.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > 0) {
      onBytes(declared);
      return;
    }
    const clone = response?.clone?.();
    const body = clone?.body;
    if (!body || typeof body.getReader !== 'function') return;
    (async () => {
      const reader = body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength ?? 0;
      }
      if (bytes > 0) onBytes(bytes);
    })().catch(() => {});
  } catch {
    // Measuring a response must never change the response being measured.
  }
}

/**
 * Count the bytes the app's own fetches read.
 *
 * The tap returns the response it was given, unchanged, and restores the
 * original `fetch` on teardown. A page whose fetch is not a function gets no
 * tap, and the Resource Timing scan then reports everything it can see.
 * @param {object} [options]
 * @param {object} [options.target] Object owning `fetch` (`globalThis`).
 * @param {(bytes: number) => void} [options.onBytes]
 * @returns {{active: boolean, restore: Function}}
 */
export function installFetchByteTap({ target = globalThis, onBytes } = {}) {
  const original = target?.fetch;
  if (typeof original !== 'function' || typeof onBytes !== 'function') {
    return { active: false, restore() {} };
  }
  const wrapped = function tappedFetch(input, init) {
    const pending = original.call(this, input, init);
    if (!pending || typeof pending.then !== 'function') return pending;
    return pending.then((response) => {
      countResponseBytes(response, onBytes);
      return response;
    });
  };
  target.fetch = wrapped;
  let restored = false;
  return {
    active: true,
    restore() {
      if (restored) return;
      restored = true;
      if (target.fetch === wrapped) target.fetch = original;
    },
  };
}

/**
 * Mount the readout in the HUD telemetry window and keep it ticking.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {Performance} [options.performanceRef]
 * @param {object} [options.fetchTarget] Object owning `fetch` (`globalThis`).
 * @param {number} [options.tickMs]
 * @param {typeof globalThis.setInterval} [options.setIntervalFn]
 * @param {typeof globalThis.clearInterval} [options.clearIntervalFn]
 * @returns {{destroy: Function}}
 */
export function createDataUsageMeter({
  documentRef = globalThis.document,
  performanceRef = globalThis.performance,
  fetchTarget = globalThis,
  tickMs = TICK_MS,
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
} = {}) {
  // The telemetry window is the host. A shell without it (an embedded panel,
  // an older layout) still gets the line above the mic, where it lived before.
  const hostFor = () =>
    documentRef?.getElementById?.('hud-data-usage') ||
    documentRef?.getElementById?.('gev-voice-control');
  const timeline =
    typeof performanceRef?.now === 'function' ? performanceRef : null;
  // A page with no place to measure from gets no readout at all; a page whose
  // host has not rendered yet is a different case — the line waits for it.
  if (!timeline || !documentRef?.createElement) {
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

  const label = documentRef.createElement('span');
  label.className = 'data-usage-label';
  // i18n-ignore: the HUD's own column label, English like MGRS/GSD/ALT beside it
  label.textContent = 'DATA:';
  readout.append(label);

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

  const seen = new Set();
  const samples = [];
  let total = 0;
  let pending = 0;
  let baseline = true;
  let timer = null;
  let destroyed = false;
  let attachedTo = null;

  /** Put the line in its host once the host exists; skip once attached. */
  const attach = () => {
    const target = hostFor();
    if (!target || target === attachedTo) return;
    target.append(readout);
    attachedTo = target;
  };
  attach();

  const tap = installFetchByteTap({
    target: fetchTarget,
    onBytes: (bytes) => {
      if (destroyed) return;
      total += bytes;
      pending += bytes;
    },
  });

  const scan = () => {
    const entries = timeline.getEntriesByType?.('resource') ?? [];
    for (const entry of entries) {
      const key = `${entry.name}|${entry.startTime}|${entry.initiatorType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // A tapped fetch already reported its bytes; counting its entry again
      // would double the same response.
      if (tap.active && entry.initiatorType === 'fetch') continue;
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
    attach();
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
      tap.restore();
      documentRef.removeEventListener?.('visibilitychange', onVisibility);
      readout.remove();
    },
  };
}
