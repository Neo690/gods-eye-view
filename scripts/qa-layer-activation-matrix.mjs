#!/usr/bin/env node
/**
 * qa-layer-activation-matrix.mjs — one deterministic Chrome pass over every
 * runtime layer, with the network answered by fixtures instead of the internet.
 *
 * The matrix proves four things for each layer:
 *   1. DATA     the layer reaches its fixture-backed source and publishes data
 *               (or, for an explicitly documented exception, reaches its
 *               enabled lifecycle state without an error);
 *   2. CREDIT   the attribution the layer's data requires is registered, or a
 *               specific credit exception is recorded in the manifest;
 *   3. TEARDOWN disabling the layer removes its visible Cesium objects and
 *               leaves no enabled lifecycle state behind;
 *   4. NO-API   a layer whose exception promises "no network read" makes no
 *               /api request while it is being enabled;
 *   5. COVERAGE every runtime layer appears in scripts/layer-activation-coverage
 *               .json with at least one fixture id or a reviewable exception.
 *
 * A missing fixture is never a skip: an unmatched /api request answers 503 and
 * the affected layer fails. That keeps the coverage manifest fail-closed.
 *
 * Usage:
 *   node scripts/qa-layer-activation-matrix.mjs
 *   node scripts/qa-layer-activation-matrix.mjs --url http://127.0.0.1:4173
 *   node scripts/qa-layer-activation-matrix.mjs --only flights,traffic
 *   node scripts/qa-layer-activation-matrix.mjs --self-check
 *   node scripts/qa-layer-activation-matrix.mjs --list
 *   node scripts/qa-layer-activation-matrix.mjs --json qa-artifacts/report.json
 *
 * Exit codes: 0 all checks passed · 1 a check failed · 2 the target was
 * unreachable.
 */
import puppeteer from 'puppeteer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromeExecutablePath } from './qa-chrome.mjs';
import {
  FIXTURE_ANCHOR,
  FIXTURE_IDS,
  fixtureFor,
} from './fixtures/layer-activation/network.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const MANIFEST_PATH = resolve(HERE, 'layer-activation-coverage.json');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (flag, fallback = null) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const list = (flag) =>
  String(opt(flag, '') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const APP_URL = opt('--url', 'http://127.0.0.1:4173').replace(/\/+$/, '');
const APP_ORIGIN = new URL(APP_URL).origin;
const ONLY = list('--only');
const SKIP = new Set(list('--skip'));
const HEADFUL = has('--headful');
const SELF_CHECK = has('--self-check');
const LIST_ONLY = has('--list');
const STRICT = has('--strict');
const JSON_OUT = opt('--json', null);
const ARTIFACTS = opt(
  '--artifacts',
  JSON_OUT
    ? dirname(resolve(JSON_OUT))
    : resolve(REPO_ROOT, 'qa-artifacts/layer-activation'),
);
const NO_NETWORK_EXCEPTION = /enabling it performs no network read/i;
// The HUD summary and setup status are app-session services: the browser may
// call them independently of any layer, so they are never layer-attributed.
const APP_SESSION_API_PATHS = new Set(['/api/setup/status']);
const APP_SESSION_API_PREFIXES = ['/api/openai/'];
const isAppSessionApi = (pathname) =>
  APP_SESSION_API_PATHS.has(pathname) ||
  APP_SESSION_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
// Layer-adjacent routes that are continued to the preview server because they
// have no fixture in this matrix. They still count against a no-network layer.
const PASSTHROUGH_API_PATHS = new Set([
  '/api/terrain/heights',
  '/api/local-receivers/aircraft',
  '/api/mapillary/status',
  '/api/fire-perimeters/inciweb/index',
]);
const isPassthroughApi = (pathname) =>
  isAppSessionApi(pathname) || PASSTHROUGH_API_PATHS.has(pathname);
const ENABLE_TIMEOUT_MS = Math.max(
  2000,
  Number(opt('--enable-timeout', 25_000)) || 25_000,
);
const DATA_TIMEOUT_MS = Math.max(
  1000,
  Number(opt('--data-timeout', 10_000)) || 10_000,
);
const BOOT_TIMEOUT_MS = Math.max(
  30_000,
  Number(opt('--boot-timeout', 180_000)) || 180_000,
);

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const DATA_KINDS = new Set(['count', 'updated', 'activation']);
const VIEW_HEIGHTS = {
  global: 20_000_000,
  regional: 3_000_000,
  local: 800_000,
  close: 120_000,
  street: 35_000,
};

/** Read the coverage manifest exactly as the CI run will. */
function readManifest(path = MANIFEST_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`coverage manifest cannot be read: ${error.message}`);
  }
  return parsed;
}

/**
 * Validate the manifest's shape and its fixture references. Pure, exported for
 * the self-check and for focused unit testing.
 * @param {object} manifest
 * @param {{fixtureIds?: string[], layerIds?: string[]}} [options]
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateManifestShape(manifest, options = {}) {
  const errors = [];
  const knownFixtures = new Set(options.fixtureIds ?? FIXTURE_IDS);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  if (manifest.version !== 1)
    errors.push(
      `unsupported manifest version ${JSON.stringify(manifest.version)}`,
    );
  const layers = manifest.layers;
  if (!layers || typeof layers !== 'object' || Array.isArray(layers)) {
    return {
      ok: false,
      errors: [...errors, 'manifest.layers must be an object'],
    };
  }
  // The coverage floor is part of the contract, not a printed statistic: a
  // layer moving from fixtures to an exception must be a deliberate edit of
  // this number, never a quiet trade that still looks green.
  const contract = manifest.contract;
  if (contract === undefined) {
    errors.push('manifest.contract is required');
  } else if (
    !contract ||
    typeof contract !== 'object' ||
    Array.isArray(contract)
  ) {
    errors.push('manifest.contract must be an object');
  } else {
    const { fixtureBackedMin, exceptionsMax } = contract;
    if (!Number.isInteger(fixtureBackedMin) || fixtureBackedMin < 0) {
      errors.push('contract.fixtureBackedMin must be a non-negative integer');
    }
    if (!Number.isInteger(exceptionsMax) || exceptionsMax < 0) {
      errors.push('contract.exceptionsMax must be a non-negative integer');
    }
    const entries = Object.values(layers).filter(
      (entry) => entry && typeof entry === 'object',
    );
    const fixtureBacked = entries.filter(
      (entry) => Array.isArray(entry.fixtures) && entry.fixtures.length > 0,
    ).length;
    const exceptions = entries.filter(
      (entry) =>
        !(Array.isArray(entry.fixtures) && entry.fixtures.length > 0) &&
        typeof entry.exception === 'string' &&
        entry.exception.trim().length > 0,
    ).length;
    if (
      Number.isInteger(fixtureBackedMin) &&
      fixtureBacked < fixtureBackedMin
    ) {
      errors.push(
        `fixture-backed coverage ${fixtureBacked} is below the contract floor ${fixtureBackedMin}`,
      );
    }
    if (Number.isInteger(exceptionsMax) && exceptions > exceptionsMax) {
      errors.push(
        `documented exceptions ${exceptions} exceed the contract ceiling ${exceptionsMax}`,
      );
    }
  }
  for (const [id, entry] of Object.entries(layers)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${id}: entry must be an object`);
      continue;
    }
    const hasFixtures =
      Array.isArray(entry.fixtures) && entry.fixtures.length > 0;
    const hasException =
      typeof entry.exception === 'string' && entry.exception.trim().length > 0;
    if (!hasFixtures && !hasException) {
      errors.push(
        `${id}: needs a non-empty fixtures array or a specific exception`,
      );
    }
    if (hasFixtures && hasException) {
      errors.push(`${id}: fixtures and exception are mutually exclusive`);
    }
    if (Array.isArray(entry.fixtures)) {
      for (const fixture of entry.fixtures) {
        if (typeof fixture !== 'string' || !knownFixtures.has(fixture)) {
          errors.push(`${id}: unknown fixture id ${JSON.stringify(fixture)}`);
        }
      }
    }
    if (entry.credit && entry.creditException) {
      errors.push(`${id}: credit and creditException are mutually exclusive`);
    }
    if (!entry.credit && !entry.creditException) {
      errors.push(`${id}: needs a credit regex or a creditException reason`);
    }
    if (entry.credit !== undefined) {
      if (typeof entry.credit !== 'string' || !entry.credit) {
        errors.push(`${id}: credit must be a non-empty regex string`);
      } else {
        try {
          new RegExp(entry.credit, 'i');
        } catch (error) {
          errors.push(`${id}: credit regex is invalid (${error.message})`);
        }
      }
    }
    if (
      entry.creditException !== undefined &&
      (typeof entry.creditException !== 'string' ||
        !entry.creditException.trim())
    ) {
      errors.push(`${id}: creditException must be a non-empty reason`);
    }
    const data = entry.data ?? { kind: 'count', min: 1 };
    if (!DATA_KINDS.has(data.kind))
      errors.push(`${id}: unknown data.kind ${JSON.stringify(data.kind)}`);
    if (
      data.kind === 'count' &&
      (!Number.isFinite(Number(data.min)) || Number(data.min) <= 0)
    ) {
      errors.push(`${id}: count data.min must be a finite number > 0`);
    }
    // A fixture-backed layer that only checks activation does not prove its
    // fixture shape or rows. Allow it only with a reviewed note (the one
    // current case is the first-epoch orbit baseline), never as a quiet way
    // to keep a broken fixture green.
    if (
      hasFixtures &&
      data.kind === 'activation' &&
      (typeof entry.note !== 'string' || !entry.note.trim())
    ) {
      errors.push(
        `${id}: fixture-backed activation data needs a note explaining why no rows are asserted`,
      );
    }
    if (entry.view !== undefined && !VIEW_HEIGHTS[entry.view]) {
      errors.push(`${id}: unknown view ${JSON.stringify(entry.view)}`);
    }
    if (
      entry.timeoutMs !== undefined &&
      (!Number.isFinite(Number(entry.timeoutMs)) ||
        Number(entry.timeoutMs) <= 0)
    ) {
      errors.push(`${id}: timeoutMs must be a positive finite number`);
    }
    if (entry.freshPage !== undefined && typeof entry.freshPage !== 'boolean') {
      errors.push(`${id}: freshPage must be a boolean`);
    }
  }
  if (Array.isArray(options.layerIds)) {
    const expected = new Set(options.layerIds);
    for (const id of expected) {
      if (!(id in layers))
        errors.push(
          `runtime layer ${id} is missing from the coverage manifest`,
        );
    }
    for (const id of Object.keys(layers)) {
      if (!expected.has(id))
        errors.push(`manifest entry ${id} is not a runtime layer`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Throw with every manifest error, so CI shows the whole contract at once. */
function assertManifest(manifest, options = {}) {
  const result = validateManifestShape(manifest, options);
  if (result.ok) return;
  throw new Error(
    `layer-activation coverage manifest is invalid:\n  - ${result.errors.join('\n  - ')}`,
  );
}

/** A small, serialisable view of getStats() for the report. */
const PAGE_HELPERS = `
  window.__qaPlain = (value, depth = 0) => {
    if (value == null) return value;
    const type = typeof value;
    if (type === 'number' || type === 'string' || type === 'boolean') return value;
    if (type === 'bigint') return String(value);
    if (type === 'function') return undefined;
    if (Array.isArray(value)) return depth > 3 ? '[array]' : value.slice(0, 30).map((item) => window.__qaPlain(item, depth + 1));
    if (depth > 3) return '[object]';
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (typeof item === 'function') continue;
      out[key] = window.__qaPlain(item, depth + 1);
    }
    return out;
  };
  window.__qaScene = () => {
    const viewer = window.__godsEyeView?.viewer;
    if (!viewer) return null;
    const visible = (item) => item && item.show !== false && !(typeof item.isDestroyed === 'function' && item.isDestroyed());
    return {
      dataSources: Array.from(viewer.dataSources || []).filter(visible).length,
      entities: (viewer.entities?.values || []).filter(visible).length,
      primitives: Array.from(viewer.scene?.primitives || []).filter(visible).length,
      imagery: Array.from(viewer.imageryLayers || []).filter(visible).length,
    };
  };
  window.__qaCredits = () => {
    const display = window.__godsEyeView?.viewer?.creditDisplay;
    if (!display) return '';
    const read = (credit) => String(credit?.html ?? credit?._html ?? credit?.text ?? '');
    const parts = [
      ...(display._staticCredits || []),
      ...(display._currentCredits || []),
      ...(display._perFrameCredits || []),
    ].map(read);
    parts.push(String(display._creditContainer?.textContent || ''));
    return parts.join(' ');
  };
  window.__qaSetView = (lon, lat, height) => {
    const viewer = window.__godsEyeView?.viewer;
    if (!viewer?.camera?.setView) return false;
    const a = 6378137;
    const e2 = 0.00669437999014;
    const phi = (lat * Math.PI) / 180;
    const lambda = (lon * Math.PI) / 180;
    const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const x = (n + height) * Math.cos(phi) * Math.cos(lambda);
    const y = (n + height) * Math.cos(phi) * Math.sin(lambda);
    const z = (n * (1 - e2) + height) * Math.sin(phi);
    viewer.camera.setView({
      destination: { x, y, z },
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    return true;
  };
`;

async function preparePage(page) {
  await page.evaluateOnNewDocument(PAGE_HELPERS);
  page.setDefaultTimeout(ENABLE_TIMEOUT_MS);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
}

/** Read the current layer entry and its stats without leaking Cesium objects. */
async function layerSnapshot(page, id) {
  return page.evaluate((layerId) => {
    const manager = window.__godsEyeView?.dataManager;
    const entry = manager?.layers?.get(layerId) || null;
    if (!entry) return { exists: false };
    let stats = null;
    let statsError = null;
    try {
      stats =
        typeof entry.module?.getStats === 'function'
          ? window.__qaPlain(entry.module.getStats())
          : null;
    } catch (error) {
      statsError = String(error?.message || error);
    }
    return {
      exists: true,
      enabled: entry.enabled === true,
      lifecycleState: entry.lifecycleState ?? null,
      initialized: entry.initialized === true,
      stats,
      statsError,
    };
  }, id);
}

const resolvePath = (object, path) =>
  String(path)
    .split('.')
    .reduce((value, key) => (value == null ? undefined : value[key]), object);

/** Evaluate one layer's data contract against its latest stats snapshot. */
function dataVerdict(entry, snapshot) {
  if (!snapshot?.exists)
    return { ok: false, reason: 'layer is not registered' };
  if (snapshot.statsError)
    return { ok: false, reason: `getStats() threw: ${snapshot.statsError}` };
  if (!snapshot.enabled) return { ok: false, reason: 'layer is not enabled' };
  const data = entry.data ?? { kind: 'count', min: 1 };
  const stats = snapshot.stats;
  if (data.kind === 'activation') {
    if (['error', 'failed', 'disabled'].includes(snapshot.lifecycleState)) {
      return { ok: false, reason: `lifecycle is ${snapshot.lifecycleState}` };
    }
    return { ok: true, value: snapshot.lifecycleState, kind: data.kind };
  }
  if (!stats) return { ok: false, reason: 'getStats() returned nothing' };
  if (stats.error)
    return {
      ok: false,
      reason: `layer reports error: ${String(stats.error).slice(0, 240)}`,
    };
  if (data.kind === 'count') {
    const value = Number(resolvePath(stats, data.path || 'count'));
    const min = Number(data.min ?? 1);
    if (Number.isFinite(value) && value >= min)
      return { ok: true, value, kind: 'count' };
    return {
      ok: false,
      reason: `${data.path || 'count'} is ${JSON.stringify(resolvePath(stats, data.path || 'count'))}, expected >= ${min}`,
    };
  }
  if (data.kind === 'updated') {
    const value = Number(resolvePath(stats, data.path || 'lastUpdate'));
    if (Number.isFinite(value) && value > 0)
      return { ok: true, value, kind: 'updated' };
    return {
      ok: false,
      reason: `${data.path || 'lastUpdate'} is ${JSON.stringify(resolvePath(stats, data.path || 'lastUpdate'))}, expected a timestamp`,
    };
  }
  return { ok: false, reason: 'no data contract matched' };
}

/** True when the layer has settled either enabled or disabled. */
const settled = (snapshot) =>
  snapshot?.exists &&
  !['enabling', 'disabling', 'initializing', 'destroying'].includes(
    snapshot.lifecycleState,
  );

async function waitFor(
  page,
  predicate,
  { timeoutMs, intervalMs = 200, description = 'condition' },
) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await predicate();
    if (last?.done) return last;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  return last ?? { done: false, reason: `${description} timed out` };
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Enable one layer, wait for data, check credit, then disable and check teardown. */
async function runLayer(page, id, entry, options = {}) {
  const { router, creditOverride = null, sabotageTeardown = false } = options;
  const result = {
    id,
    fixtureBacked: Array.isArray(entry.fixtures) && entry.fixtures.length > 0,
    status: 'FAIL',
    data: { ok: false },
    credit: { ok: false },
    teardown: { ok: false },
    stats: null,
    unmocked: [],
    fixtureHits: [],
    apiRequests: [],
    network: { checked: false, ok: true },
    durationMs: 0,
  };
  const startedAt = Date.now();
  const requestStart = router.events.length;
  let apiStart = router.apiEvents?.length ?? 0;

  try {
    const view = VIEW_HEIGHTS[entry.view || 'global'] ?? VIEW_HEIGHTS.global;
    await page.evaluate(
      ({ lon, lat, height }) => window.__qaSetView(lon, lat, height),
      { lon: FIXTURE_ANCHOR.lon, lat: FIXTURE_ANCHOR.lat, height: view },
    );
    await sleep(150);
    const baseline = await page.evaluate(() => window.__qaScene());
    // Count API traffic only from the moment the layer is asked to enable, so
    // boot-time app status calls cannot be attributed to this layer.
    apiStart = router.apiEvents?.length ?? 0;

    const enable = await page.evaluate(
      async ({ layerId, timeoutMs }) => {
        const manager = window.__godsEyeView?.dataManager;
        if (!manager) return { error: 'dataManager missing' };
        if (!manager.layers.has(layerId))
          return { error: 'layer missing from dataManager' };
        try {
          let timedOut = false;
          await Promise.race([
            manager.setEnabled(layerId, true, { origin: 'user' }),
            new Promise((done) => {
              setTimeout(() => {
                timedOut = true;
                done();
              }, timeoutMs);
            }),
          ]);
          return { timedOut };
        } catch (error) {
          return { error: String(error?.message || error) };
        }
      },
      { layerId: id, timeoutMs: ENABLE_TIMEOUT_MS },
    );
    if (enable?.error) {
      result.data = { ok: false, reason: `setEnabled threw: ${enable.error}` };
      result.error = enable.error;
    } else {
      const dataWait = await waitFor(
        page,
        async () => {
          const snapshot = await layerSnapshot(page, id);
          result.stats = snapshot.stats;
          const verdict = dataVerdict(entry, snapshot);
          if (verdict.ok) return { done: true, verdict, snapshot };
          return { done: false, verdict, snapshot };
        },
        {
          timeoutMs: Math.max(DATA_TIMEOUT_MS, Number(entry.timeoutMs) || 0),
          description: `data for ${id}`,
        },
      );
      result.data = dataWait.verdict ?? {
        ok: false,
        reason: 'no data verdict',
      };
      result.stats = dataWait.snapshot?.stats ?? result.stats;
    }

    if (result.data.ok) {
      let creditText;
      try {
        creditText = await page.evaluate(() => window.__qaCredits());
      } catch (error) {
        creditText = '';
        result.credit = {
          ok: false,
          reason: `credit read failed: ${error.message}`,
        };
      }
      if (!result.credit.reason) {
        if (creditOverride?.forceMissing) {
          result.credit = {
            ok: false,
            reason: 'sabotage: expected credit deliberately removed',
          };
        } else if (entry.creditException) {
          result.credit = { ok: true, exempt: entry.creditException };
        } else if (entry.credit) {
          const matched = new RegExp(entry.credit, 'i').test(creditText || '');
          result.credit = matched
            ? { ok: true, matched: entry.credit }
            : {
                ok: false,
                reason: `required credit /${entry.credit}/ is absent`,
              };
        } else {
          result.credit = { ok: false, reason: 'no credit contract' };
        }
      }
    } else {
      result.credit = {
        ok: false,
        reason: 'not evaluated because data did not load',
      };
    }

    // Teardown runs even after a data failure, so a leaking layer is still visible.
    const disable = await page.evaluate(
      async ({ layerId, timeoutMs }) => {
        const manager = window.__godsEyeView?.dataManager;
        if (!manager?.layers.has(layerId))
          return { error: 'layer missing from dataManager' };
        try {
          await Promise.race([
            manager.setEnabled(layerId, false, { origin: 'user' }),
            new Promise((done) => setTimeout(done, timeoutMs)),
          ]);
          return {};
        } catch (error) {
          return { error: String(error?.message || error) };
        }
      },
      { layerId: id, timeoutMs: ENABLE_TIMEOUT_MS },
    );
    if (disable?.error) {
      result.teardown = {
        ok: false,
        reason: `setEnabled(false) threw: ${disable.error}`,
      };
    } else {
      const disabled = await waitFor(
        page,
        async () => {
          const snapshot = await layerSnapshot(page, id);
          return {
            done:
              snapshot.exists &&
              snapshot.enabled === false &&
              settled(snapshot),
            snapshot,
          };
        },
        { timeoutMs: 8_000, description: `disable ${id}` },
      );
      if (!disabled.done) {
        result.teardown = {
          ok: false,
          reason: `layer did not settle disabled (state ${JSON.stringify(disabled.snapshot?.lifecycleState)}, enabled ${disabled.snapshot?.enabled})`,
        };
      } else {
        if (sabotageTeardown) {
          await page.evaluate(() => {
            const viewer = window.__godsEyeView?.viewer;
            viewer?.entities?.add?.({ id: 'qa-sabotage-leak', show: true });
          });
        }
        await sleep(400);
        const after = await page.evaluate(() => window.__qaScene());
        const leaks =
          baseline && after
            ? Object.fromEntries(
                Object.keys(after)
                  .filter((key) => Number(after[key]) > Number(baseline[key]))
                  .map((key) => [
                    key,
                    { before: baseline[key], after: after[key] },
                  ]),
              )
            : {};
        if (Object.keys(leaks).length) {
          // A second read distinguishes a one-frame detach from a real leak.
          await sleep(1200);
          const again = await page.evaluate(() => window.__qaScene());
          for (const key of Object.keys(leaks)) {
            if (Number(again?.[key]) <= Number(baseline[key]))
              delete leaks[key];
            else leaks[key].after = again[key];
          }
        }
        result.teardown = Object.keys(leaks).length
          ? {
              ok: false,
              reason: 'visible Cesium objects survived disable',
              leaks,
            }
          : { ok: true, scene: { baseline, after } };
      }
    }
  } catch (error) {
    result.error = String(error?.stack || error);
    if (!result.data.reason) result.data = { ok: false, reason: result.error };
  }

  result.durationMs = Date.now() - startedAt;
  const events = router.events.slice(requestStart);
  result.unmocked = [
    ...new Set(
      events
        .filter((event) => event.kind === 'unmocked')
        .map((event) => event.url),
    ),
  ];
  result.fixtureHits = [
    ...new Set(
      events
        .filter((event) => event.kind === 'fixture')
        .map((event) => event.id),
    ),
  ];
  result.requests = events
    .map((event) => `${event.kind}:${event.id ?? ''}:${event.url}`)
    .slice(0, 40);
  const apiEvents = router.apiEvents ?? [];
  const layerApiEvents = apiEvents
    .slice(apiStart)
    .filter((event) => !event.appSession);
  result.apiRequests = [
    ...new Set(apiEvents.slice(apiStart).map((event) => event.url)),
  ];
  const layerApiRequests = [
    ...new Set(layerApiEvents.map((event) => event.url)),
  ];
  result.network = NO_NETWORK_EXCEPTION.test(entry.exception ?? '')
    ? layerApiRequests.length
      ? {
          checked: true,
          ok: false,
          reason: `activation made /api request(s): ${layerApiRequests.join(', ')}`,
        }
      : { checked: true, ok: true }
    : { checked: false, ok: true };
  result.status =
    result.data.ok &&
    result.credit.ok &&
    result.teardown.ok &&
    result.network.ok
      ? 'PASS'
      : 'FAIL';
  return result;
}

/**
 * Build the request handler that keeps every browser read deterministic.
 * `omitFixture` deliberately removes one fixture from this page's registry, so
 * a negative control can prove an unmocked request fails instead of passing as
 * an empty layer.
 */
async function installRouter(
  page,
  { omitFixture = null, emptyFlights = false } = {},
) {
  const router = {
    events: [],
    unmockedCount: 0,
    externalBlocked: 0,
    apiEvents: [],
  };
  page.on('request', async (request) => {
    const record = (event) => {
      if (router.events.length < 20_000)
        router.events.push({ at: Date.now(), ...event });
    };
    const rawUrl = request.url();
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      await request.abort().catch(() => {});
      return;
    }
    const isApp = url.origin === APP_ORIGIN;
    if (isApp && url.pathname.startsWith('/api/')) {
      // Keep every API request for diagnostics, but mark app-session routes
      // so the no-network assertion cannot attribute them to a layer.
      if (router.apiEvents.length < 20_000)
        router.apiEvents.push({
          at: Date.now(),
          url: url.pathname + url.search,
          appSession: isAppSessionApi(url.pathname),
        });
    }
    if (isApp && !url.pathname.startsWith('/api/')) {
      await request.continue().catch(() => {});
      return;
    }
    let matched = fixtureFor(rawUrl);
    if (matched?.id === omitFixture) matched = null;
    if (matched) {
      const empty = emptyFlights && matched.id === 'flights';
      record({
        kind: 'fixture',
        id: matched.id,
        url: url.pathname + url.search,
        ...(empty ? { sabotage: 'empty' } : {}),
      });
      const response = empty
        ? {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
              time: Math.floor(Date.now() / 1000),
              states: [],
            }),
          }
        : matched.response;
      const headers = { ...(response.headers || {}) };
      if (response.status === 204) {
        await request.respond({ status: 204, headers }).catch(() => {});
      } else if (Buffer.isBuffer(response.body)) {
        await request
          .respond({
            status: response.status ?? 200,
            headers,
            body: response.body,
          })
          .catch(() => {});
      } else {
        await request
          .respond({
            status: response.status ?? 200,
            headers,
            body:
              typeof response.body === 'string'
                ? response.body
                : JSON.stringify(response.body ?? null),
          })
          .catch(() => {});
      }
      return;
    }
    if (isApp && isPassthroughApi(url.pathname)) {
      await request.continue().catch(() => {});
      return;
    }
    if (isApp && url.pathname.startsWith('/api/')) {
      router.unmockedCount += 1;
      record({ kind: 'unmocked', url: url.pathname + url.search, status: 503 });
      await request
        .respond({
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: 'qa_unmocked', path: url.pathname }),
        })
        .catch(() => {});
      return;
    }
    // Never let an unmatched third-party host reach the live internet.
    router.externalBlocked += 1;
    await request.abort('blockedbyclient').catch(() => {});
  });
  await page.setRequestInterception(true);
  return router;
}

/**
 * Judge the removed-fixture negative control. It passes only when the router
 * actually answered 503 and the layer surfaced that failure. A success with
 * zero rows is the silent-zero regression this check exists to reject.
 * @param {object|null} result runLayer result
 * @param {object[]} events router events from that run
 * @returns {{ok:boolean, reason:string, unmocked:object[]}}
 */
/**
 * Strict mode treats any /api request the fixtures did not answer as a
 * coverage hole. The non-strict matrix still records these for its report,
 * but only --strict makes them fail the run.
 * @param {{strict:boolean,total:number,urls:string[]}} input
 * @returns {{ok:boolean,count:number,urls:string[],reason:string}}
 */
export function strictUnmockedVerdict({ strict, total, urls }) {
  const unique = [
    ...new Set((Array.isArray(urls) ? urls : []).filter(Boolean)),
  ];
  const count = Math.max(Number(total) || 0, unique.length);
  if (!strict || count === 0) {
    return { ok: true, count, urls: unique, reason: '' };
  }
  const shown = unique.slice(0, 25);
  const suffix =
    unique.length > shown.length
      ? ` (+${unique.length - shown.length} more)`
      : '';
  return {
    ok: false,
    count,
    urls: unique,
    reason: `${count} unmocked /api request(s) without a fixture: ${shown.join(', ')}${suffix}`,
  };
}

export function missingFixtureVerdict(result, events) {
  const unmocked = (Array.isArray(events) ? events : []).filter(
    (event) =>
      event?.kind === 'unmocked' &&
      String(event.url ?? '').startsWith('/api/flights') &&
      event.status === 503,
  );
  const reason = String(result?.data?.reason || result?.stats?.error || '');
  const count = result?.stats?.count;
  const status = result?.stats?.status;
  let why = '';
  if (result?.data?.ok !== false) why = 'the layer did not fail (ok=true)';
  else if (count !== 0) why = `count is ${JSON.stringify(count)}, expected 0`;
  else if (status !== 503)
    why = `status is ${JSON.stringify(status)}, expected 503`;
  else if (!/503/.test(reason))
    why = `error does not name 503: ${JSON.stringify(reason)}`;
  else if (!unmocked.length)
    why = 'the router did not record an unmocked 503 response';
  return { ok: !why, reason: why || reason, unmocked };
}

/** Launch the installed Chrome with software WebGL, as the other QA gates do. */
async function launchBrowser() {
  return puppeteer.launch({
    headless: !HEADFUL,
    executablePath: chromeExecutablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-web-security',
      '--window-size=1440,900',
    ],
    protocolTimeout: 240_000,
  });
}

async function boot(page, errors) {
  page.on('pageerror', (error) =>
    errors.push({ type: 'pageerror', text: String(error?.message || error) }),
  );
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (
      /Failed to load resource|net::ERR_|WebGL|GPU stall|Download the React DevTools/i.test(
        text,
      )
    )
      return;
    errors.push({ type: 'console', text });
  });

  await preparePage(page);
  try {
    await page.goto(`${APP_URL}/?welcome=0`, {
      waitUntil: 'domcontentloaded',
      timeout: BOOT_TIMEOUT_MS,
    });
  } catch (error) {
    throw Object.assign(
      new Error(`target unreachable at ${APP_URL}: ${error.message}`),
      { code: 'ENV' },
    );
  }
  const ready = await waitFor(
    page,
    async () => {
      const state = await page.evaluate(() => ({
        manager: Boolean(window.__godsEyeView?.dataManager),
        viewer: Boolean(window.__godsEyeView?.viewer),
        loadingHidden: Boolean(
          document
            .querySelector('#loading-screen')
            ?.classList?.contains('hidden'),
        ),
        welcome: Boolean(
          document.querySelector('#welcome-screen:not(.hidden)'),
        ),
      }));
      return {
        done: state.manager && state.viewer && state.loadingHidden,
        state,
      };
    },
    { timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 400, description: 'app boot' },
  );
  if (!ready.done) {
    throw Object.assign(
      new Error(
        `app did not boot at ${APP_URL} (last state ${JSON.stringify(ready.state)})`,
      ),
      { code: 'ENV' },
    );
  }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);
  const runtimeIds = await page.evaluate(() =>
    Array.from(window.__godsEyeView.dataManager.layers.keys()),
  );
  return runtimeIds;
}

/** Disable anything the welcome/default preset left on before the matrix starts. */
async function disableAllLayers(page) {
  await page.evaluate(async () => {
    const manager = window.__godsEyeView?.dataManager;
    if (!manager) return;
    for (const [id, entry] of manager.layers) {
      if (!entry.enabled) continue;
      try {
        await manager.setEnabled(id, false, { origin: 'user' });
      } catch {
        /* a layer that refuses to disable will be caught by its own run */
      }
    }
  });
  await sleep(600);
}

/** Open one booted page with its router and every default layer disabled. */
async function openMatrixPage(browser, errors, routerOptions = {}) {
  const page = await browser.newPage();
  try {
    const router = await installRouter(page, routerOptions);
    const runtimeIds = await boot(page, errors);
    await disableAllLayers(page);
    return { page, router, runtimeIds };
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

function writeReport(report, name = 'report.json') {
  if (!JSON_OUT && !ARTIFACTS) return null;
  const target = JSON_OUT ? resolve(JSON_OUT) : resolve(ARTIFACTS, name);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    return target;
  } catch (error) {
    console.error(C.yellow(`could not write report: ${error.message}`));
    return null;
  }
}

function printCoverage(manifest) {
  const entries = Object.entries(manifest.layers);
  const fixtureBacked = entries.filter(
    ([, entry]) => Array.isArray(entry.fixtures) && entry.fixtures.length,
  );
  const exceptions = entries.filter(
    ([, entry]) => !entry.fixtures?.length && entry.exception,
  );
  console.log(
    `${C.bold('Layer activation coverage')} · ${entries.length} runtime entries`,
  );
  console.log(`  ${C.green('fixture-backed')} ${fixtureBacked.length}`);
  console.log(`  ${C.yellow('documented exceptions')} ${exceptions.length}`);
  console.log(`  fixture ids ${FIXTURE_IDS.length}`);
  if (exceptions.length) {
    console.log(C.dim('\nExceptions:'));
    for (const [id, entry] of exceptions)
      console.log(`  ${id}: ${entry.exception}`);
  }
}

async function runSelfCheck(browser, manifest) {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(
      `${ok ? C.green('PASS') : C.red('FAIL')}  ${name}${detail ? C.dim(` — ${detail}`) : ''}`,
    );
  };

  const base = validateManifestShape(manifest, {
    layerIds: Object.keys(manifest.layers),
  });
  record(
    'real manifest validates against its own runtime ids',
    base.ok,
    base.errors.join('; '),
  );

  const missing = JSON.parse(JSON.stringify(manifest));
  delete missing.layers.flights;
  const missingResult = validateManifestShape(missing, {
    layerIds: Object.keys(manifest.layers),
  });
  record(
    'a runtime layer missing from the manifest is rejected',
    !missingResult.ok &&
      missingResult.errors.some((e) => e.includes('flights')),
    missingResult.errors.join('; '),
  );

  const contradiction = JSON.parse(JSON.stringify(manifest));
  contradiction.layers.flights.exception = 'both';
  const contradictionResult = validateManifestShape(contradiction, {
    layerIds: Object.keys(manifest.layers),
  });
  record(
    'a layer with both fixtures and exception is rejected',
    !contradictionResult.ok &&
      contradictionResult.errors.some((e) => e.includes('mutually exclusive')),
    contradictionResult.errors.join('; '),
  );

  const unknown = JSON.parse(JSON.stringify(manifest));
  unknown.layers.flights.fixtures = ['does-not-exist'];
  const unknownResult = validateManifestShape(unknown, {
    layerIds: Object.keys(manifest.layers),
  });
  record(
    'an unknown fixture id is rejected',
    !unknownResult.ok &&
      unknownResult.errors.some((e) => e.includes('does-not-exist')),
    unknownResult.errors.join('; '),
  );

  const errors = [];
  const session = await openMatrixPage(browser, errors);
  const { page, router } = session;
  try {
    const entry = {
      fixtures: ['flights'],
      data: { kind: 'count', min: 1 },
      credit: 'OpenSky|adsb\\.lol',
      view: 'global',
    };

    const normal = await runLayer(page, 'flights', entry, { router });
    record(
      'normal flight fixture loads data, credit and teardown',
      normal.status === 'PASS',
      `${normal.data.reason || ''} ${normal.credit.reason || ''} ${normal.teardown.reason || ''}`.trim(),
    );

    // Re-enabling a layer can reuse its last good snapshot, so the empty
    // fixture is proven on a fresh page rather than against that cache.
    const emptySession = await openMatrixPage(browser, [], {
      emptyFlights: true,
    });
    try {
      const empty = await runLayer(emptySession.page, 'flights', entry, {
        router: emptySession.router,
      });
      record(
        'empty fixture is detected as missing data',
        empty.data.ok === false,
        empty.data.reason || 'data unexpectedly passed',
      );
    } finally {
      await emptySession.page.close().catch(() => {});
    }

    // A removed fixture must reach the layer as the router's real 503, not as
    // a successful zero-aircraft snapshot. A fresh page keeps a prior good
    // flight snapshot from masking the failure.
    const missingSession = await openMatrixPage(browser, [], {
      omitFixture: 'flights',
    });
    try {
      const missing = await runLayer(missingSession.page, 'flights', entry, {
        router: missingSession.router,
      });
      const verdict = missingFixtureVerdict(
        missing,
        missingSession.router.events,
      );
      record(
        'removing a fixture returns 503 and fails the layer, not a silent zero',
        verdict.ok,
        `${verdict.reason}; 503 responses=${verdict.unmocked.length}`,
      );
      // Prove the check itself is not toothless: a layer that reports success
      // with zero rows must be rejected by the same verdict, not pass as green.
      const silentZero = missingFixtureVerdict(
        { data: { ok: true }, stats: { count: 0, status: 200 } },
        missingSession.router.events,
      );
      record(
        'the missing-fixture control rejects a silent zero',
        silentZero.ok === false,
        `silent zero rejected: ${silentZero.reason}`,
      );
    } finally {
      await missingSession.page.close().catch(() => {});
    }

    const credit = await runLayer(page, 'flights', entry, {
      router,
      creditOverride: { forceMissing: true },
    });
    record(
      'missing attribution is detected',
      credit.credit.ok === false && credit.data.ok === true,
      credit.credit.reason || 'credit unexpectedly passed',
    );

    const leak = await runLayer(page, 'flights', entry, {
      router,
      sabotageTeardown: true,
    });
    record(
      'a visible object left after disable is detected',
      leak.teardown.ok === false,
      leak.teardown.reason || 'teardown unexpectedly passed',
    );

    if (STRICT && errors.length) {
      record(
        'strict console check has no uncaught page errors',
        false,
        errors.map((e) => e.text).join(' | '),
      );
    }
  } finally {
    await page.close().catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(
    `\n${failed.length ? C.red(`${failed.length} self-check(s) failed`) : C.green('self-check passed')}`,
  );
  return { ok: failed.length === 0, checks, errors };
}

async function main() {
  const manifest = readManifest();
  assertManifest(manifest);
  if (LIST_ONLY) {
    printCoverage(manifest);
    return 0;
  }

  const browser = await launchBrowser();
  let exitCode = 0;
  try {
    if (SELF_CHECK) {
      const result = await runSelfCheck(browser, manifest);
      const report = {
        generatedAt: new Date().toISOString(),
        appUrl: APP_URL,
        mode: 'self-check',
        ok: result.ok,
        checks: result.checks,
        pageErrors: result.errors,
      };
      const path = writeReport(report, 'self-check.json');
      if (path) console.log(C.dim(`report ${path}`));
      return result.ok ? 0 : 1;
    }

    const errors = [];
    let session;
    try {
      session = await openMatrixPage(browser, errors);
    } catch (error) {
      console.error(C.red(error.message));
      return error.code === 'ENV' ? 2 : 1;
    }
    const runtimeIds = session.runtimeIds;
    assertManifest(manifest, { layerIds: runtimeIds });

    const selected = runtimeIds.filter(
      (id) => (!ONLY.length || ONLY.includes(id)) && !SKIP.has(id),
    );
    if (!selected.length) {
      console.error(C.red('no runtime layers selected'));
      return 1;
    }
    console.log(
      `${C.bold('Layer activation matrix')} · ${selected.length}/${runtimeIds.length} layers · ${APP_URL}`,
    );
    console.log(
      C.dim(
        `  ${C.green('fixtures')} ${FIXTURE_IDS.length} · data budget ${DATA_TIMEOUT_MS}ms · view ${FIXTURE_ANCHOR.lat},${FIXTURE_ANCHOR.lon}`,
      ),
    );

    const results = [];
    const allUnmocked = new Set();
    let unmockedTotal = 0;
    let externalBlockedTotal = 0;
    // Every page keeps its own router. Aggregate them all: a fresh page must
    // not hide an unmocked request made before it was opened.
    const sessions = [session];
    for (const id of selected) {
      const entry = manifest.layers[id];
      // A layer that needs an untouched globe gets a page with no prior layer
      // activation. Traffic is the current case: an earlier map stack can
      // leave its surface waiting on terrain and report zero roads.
      if (entry.freshPage && results.length) {
        await session.page.close().catch(() => {});
        session = await openMatrixPage(browser, errors);
        sessions.push(session);
      }
      const result = await runLayer(session.page, id, entry, {
        router: session.router,
      });
      results.push(result);
      const badge = result.status === 'PASS' ? C.green('PASS') : C.red('FAIL');
      const source = result.fixtureBacked ? 'fixture' : 'exception';
      const data = result.data.ok
        ? C.green(
            `data=${result.data.kind === 'count' ? result.data.value : result.data.kind}`,
          )
        : C.red(`data: ${result.data.reason}`);
      const credit = result.credit.ok
        ? C.green(result.credit.exempt ? 'credit=exempt' : 'credit')
        : C.red(`credit: ${result.credit.reason}`);
      const teardown = result.teardown.ok
        ? C.green('teardown')
        : C.red(`teardown: ${result.teardown.reason}`);
      const network = result.network.checked
        ? result.network.ok
          ? C.green('no-api')
          : C.red(`network: ${result.network.reason}`)
        : null;
      console.log(
        `  ${badge} ${id.padEnd(30)} ${source.padEnd(9)} ${data} · ${credit} · ${teardown}${network ? ` · ${network}` : ''}`,
      );
      if (result.unmocked.length) {
        console.log(C.yellow(`       unmocked: ${result.unmocked.join(', ')}`));
      }
    }
    for (const { router: pageRouter } of sessions) {
      for (const event of pageRouter.events) {
        if (event.kind === 'unmocked') allUnmocked.add(event.url);
      }
      unmockedTotal += pageRouter.unmockedCount;
      externalBlockedTotal += pageRouter.externalBlocked;
    }

    const failed = results.filter((result) => result.status !== 'PASS');
    const fixtureBacked = results.filter(
      (result) => result.fixtureBacked,
    ).length;
    const exceptions = results.length - fixtureBacked;
    const noApiChecked = results.filter(
      (result) => result.network.checked,
    ).length;
    console.log(
      `\n${C.bold('Summary')} ${results.length - failed.length}/${results.length} passed · ${fixtureBacked} fixture-backed · ${exceptions} documented exceptions · ${noApiChecked} no-API activation(s) · ${unmockedTotal} unmocked API request(s)`,
    );
    if (failed.length) {
      console.log(
        C.red(`Failed: ${failed.map((result) => result.id).join(', ')}`),
      );
      exitCode = 1;
    }
    const strictUnmocked = strictUnmockedVerdict({
      strict: STRICT,
      total: unmockedTotal,
      urls: [...allUnmocked],
    });
    if (!strictUnmocked.ok) {
      console.log(C.red(`Strict: ${strictUnmocked.reason}`));
      exitCode = 1;
    }
    if (STRICT && errors.length) {
      console.log(C.red(`Uncaught page errors: ${errors.length}`));
      for (const error of errors.slice(0, 10))
        console.log(C.dim(`  ${error.type}: ${error.text}`));
      exitCode = 1;
    }

    const report = {
      generatedAt: new Date().toISOString(),
      appUrl: APP_URL,
      mode: 'matrix',
      ok: exitCode === 0,
      runtimeLayers: runtimeIds,
      selected,
      summary: {
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        fixtureBacked,
        exceptions,
        noApiActivations: noApiChecked,
        fixtures: FIXTURE_IDS.length,
        unmockedApiRequests: unmockedTotal,
        unmockedUrls: [...allUnmocked].slice(0, 25),
        blockedExternalRequests: externalBlockedTotal,
      },
      pageErrors: errors,
      layers: results,
    };
    const path = writeReport(report);
    if (path) console.log(C.dim(`report ${path}`));
  } finally {
    await browser.close().catch(() => {});
  }
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(C.red(error?.stack || error));
      process.exitCode = 1;
    });
}
