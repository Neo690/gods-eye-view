#!/usr/bin/env node
/**
 * qa-keyless-live-layers.mjs — live-network smoke test for the keyless layers.
 *
 * Unlike qa-layer-activation-matrix.mjs, this gate does not answer /api with
 * fixtures: it enables a fixed set of layers that need no API key and reads
 * their real providers through the running app. That makes upstream weather
 * part of the signal, so every outcome is classified explicitly instead of
 * collapsing to pass/fail:
 *
 *   PASS          the layer produced at least expect.min rows.
 *   EMPTY         the provider legitimately reported an empty feed, and the
 *                 layer is declared allowEmpty (e.g. no active cyclones).
 *   UNCONFIGURED  an opt-in capability is deliberately absent: the layer's
 *                 /status probe confirmed configured=false (e.g. Overpass with
 *                 no OVERPASS_UPSTREAMS) and the layer said so cleanly.
 *   EXTERNAL      the layer failed because its declared upstream did: a scoped
 *                 /api prefix returned 429/502/503/504 or the request failed.
 *                 A bare 500 is not proof and stays FAIL. A missing or rejected
 *                 credential also stays FAIL. This is evidence-based; a matching
 *                 error string alone is not enough.
 *   FAIL          the app failed, returned a silent zero, contradicted its
 *                 capability probe, or surfaced an error with no declared
 *                 external cause.
 *   MISSING       the runtime layer registry does not contain the layer.
 *
 * Declared EMPTY, UNCONFIGURED and EXTERNAL outcomes are non-blocking by
 * default so an upstream outage does not turn the gate red. `--strict` makes
 * only PASS acceptable, which is useful when providers are known healthy.
 * A teardown failure, an uncaught page error or a FAIL/MISSING layer is always
 * blocking.
 *
 * `--keyed` swaps the keyless manifest for the credential-gated layers. The
 * caller must provide their env vars; the scheduled workflow detects them and
 * skips the keyed job when none are configured.
 *
 * Usage:
 *   node scripts/qa-keyless-live-layers.mjs --url http://127.0.0.1:4173
 *   node scripts/qa-keyless-live-layers.mjs --only earthquakes,satellites
 *   node scripts/qa-keyless-live-layers.mjs --skip osm-places
 *   node scripts/qa-keyless-live-layers.mjs --strict
 *   node scripts/qa-keyless-live-layers.mjs --list
 *   node scripts/qa-keyless-live-layers.mjs --json qa-artifacts/keyless.json
 *   node scripts/qa-keyless-live-layers.mjs --keyed --only local-firms,traffic
 *   node scripts/qa-keyless-live-layers.mjs --keyed --list
 *
 * Exit codes: 0 no app failure · 1 a layer, teardown or page failed ·
 * 2 the app or Chrome was unreachable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import {
  APPLICATION_LAYER_METADATA,
  LOCAL_ONLY_LAYER_METADATA,
} from '../src/app/constructCatalog.js';
import {
  LAYER_KEY_DECLARATIONS,
  deriveKeylessLayerIds,
} from '../src/app/layerKeyDeclarations.js';
import { KEY_SETUP_KEYS } from '../src/keySetupCore.mjs';
import { chromeExecutablePath } from './qa-chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
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

const APP_URL = String(
  opt('--url', process.env.QA_BASE_URL || 'http://127.0.0.1:4173'),
).replace(/\/+$/, '');
const APP_ORIGIN = new URL(APP_URL).origin;
const ONLY = list('--only');
const SKIP = new Set(list('--skip'));
const HEADFUL = has('--headful');
const STRICT = has('--strict');
const LIST_ONLY = has('--list');
const KEYED = has('--keyed');
const LAYER_TIMEOUT_MS = Math.max(
  5_000,
  Number(opt('--timeout', 45_000)) || 45_000,
);
const BOOT_TIMEOUT_MS = Math.max(
  30_000,
  Number(opt('--boot-timeout', 180_000)) || 180_000,
);
const JSON_OUT = opt('--json', null);
const REPORT_PATH = JSON_OUT
  ? resolve(JSON_OUT)
  : resolve(REPO_ROOT, 'qa-artifacts/keyless-live/report.json');
const POST_ENABLE_GRACE_MS = 20_000;
const LAYER_SETTLE_MS = 1_000;
const TEARDOWN_TIMEOUT_MS = 10_000;

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * The gate's contract. These 15 layers were the temporary live pass; keeping
 * them in one list makes the policy for each upstream reviewable. The list is
 * an execution policy, not the inventory: validateKeylessInventory() derives
 * the full keyless candidate set from the layers' key declarations and
 * requires every candidate to have an include or exclude decision below.
 *
 * - expect.min is the number of rows a healthy keyless source provides.
 * - externalFailure says an outage of that provider is a classified EXTERNAL
 *   outcome, not an app failure. apiPrefix scopes the evidence to the app route
 *   that proxies that provider.
 * - allowEmpty says a zero-row feed is legitimate only when the layer marks
 *   stats[statsFlag] true (it distinguishes "no storms" from "failed").
 * - unconfigured says the layer is opt-in, and names the capability probe that
 *   must confirm the omission before the outcome is accepted.
 */
export const KEYED_LAYERS = [
  {
    id: 'local-firms',
    provider: 'NASA FIRMS',
    keyId: 'firms',
    env: ['FIRMS_MAP_KEY'],
    expect: { min: 1 },
    timeoutMs: 90_000,
    externalFailure: {
      apiPrefix: '/api/firms',
      reason:
        'NASA FIRMS can rate-limit or time out; /api/firms serves its stale cache instead of returning a fresh failure.',
    },
  },
  {
    id: 'conflict-events',
    provider: 'ACLED',
    keyId: 'acled',
    env: ['ACLED_EMAIL', 'ACLED_PASSWORD'],
    expect: { min: 1 },
    timeoutMs: 90_000,
    externalFailure: {
      apiPrefix: '/api/conflicts',
      reason:
        'ACLED can fail upstream while the proxy is healthy; the layer then has no fresh conflict snapshot.',
    },
  },
  {
    id: 'fishing-effort',
    provider: 'Global Fishing Watch',
    keyId: 'global-fishing-watch',
    env: ['GFW_API_TOKEN'],
    expect: { min: 1 },
    timeoutMs: 90_000,
    externalFailure: {
      apiPrefix: '/api/fishing-effort',
      reason:
        'Global Fishing Watch can rate-limit or time out independently of the app proxy.',
    },
  },
  {
    id: 'traffic',
    provider: 'TomTom',
    keyId: 'tomtom',
    env: ['TOMTOM_API_KEY'],
    // The layer can always draw simulated traffic; only the live mode proves
    // the credential reached the server-side proxy.
    expect: { min: 1, mode: 'live' },
    view: { lat: 30.2672, lon: -97.7431, alt: 2500 },
    timeoutMs: 90_000,
    externalFailure: {
      apiPrefix: '/api/tomtom',
      reason:
        'TomTom can rate-limit or time out; the tile proxy then has no live flow to prove the key against.',
    },
  },
];

/**
 * A decision is required for EVERY layer the key declarations classify as
 * keyless. New keyless layers therefore fail the inventory gate until an
 * operator either adds a live canary policy or records why it is excluded.
 *
 * `include` decisions must have a matching KEYLESS_LAYERS entry. `exclude`
 * decisions keep the reason next to the layer instead of losing it in a
 * historical PR.
 *
 * The contract is a ratchet against a green-but-empty canary: adding a new
 * keyless layer as an exclusion would push the excluded count past 35, so it
 * must either join the live pass or deliberately change this number.
 */
export const KEYLESS_CANARY_CONTRACT = Object.freeze({
  includedMin: 15,
  excludedMax: 35,
});

export const KEYLESS_CANARY_DECISIONS = Object.freeze({
  earthquakes: Object.freeze({ decision: 'include' }),
  'emsc-seismic': Object.freeze({ decision: 'include' }),
  'global-disasters': Object.freeze({ decision: 'include' }),
  satellites: Object.freeze({ decision: 'include' }),
  'space-weather': Object.freeze({ decision: 'include' }),
  'weather-radar': Object.freeze({ decision: 'include' }),
  'weather-satellite': Object.freeze({ decision: 'include' }),
  'weather-lightning': Object.freeze({ decision: 'include' }),
  'weather-cyclones': Object.freeze({ decision: 'include' }),
  radio: Object.freeze({ decision: 'include' }),
  'osm-places': Object.freeze({ decision: 'include' }),
  flights: Object.freeze({ decision: 'include' }),
  military: Object.freeze({ decision: 'include' }),
  'fire-perimeters': Object.freeze({ decision: 'include' }),
  bikeshare: Object.freeze({ decision: 'include' }),

  'ai-agent': Object.freeze({
    decision: 'exclude',
    reason: 'Interactive assistant; it has no map provider to canary.',
  }),
  'air-quality': Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
  'alpr-cameras': Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
  'bhote-koshi-2026': Object.freeze({
    decision: 'exclude',
    reason: 'Bundled local scenario; no live provider.',
  }),
  'bhote-koshi-locator': Object.freeze({
    decision: 'exclude',
    reason: 'Bundled local scenario; no live provider.',
  }),
  'camera-advisories': Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
  cctv: Object.freeze({
    decision: 'exclude',
    reason: 'Interactive media layer; its feeds are covered by the matrix.',
  }),
  'cell-towers': Object.freeze({
    decision: 'exclude',
    reason: 'Optional OpenCelliD key; the keyless base is matrix-covered.',
  }),
  'device-sweep': Object.freeze({
    decision: 'exclude',
    reason: 'Local browser sweep; no network provider.',
  }),
  directions: Object.freeze({
    decision: 'exclude',
    reason: 'Interactive routing tools; no single layer feed to canary.',
  }),
  'face-privacy': Object.freeze({
    decision: 'exclude',
    reason: 'Local image tool; no network provider.',
  }),
  'gnss-integrity': Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
  insider: Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
  'iot-sensors': Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
  'israeli-transport': Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
  'local-adsb': Object.freeze({
    decision: 'exclude',
    reason: 'Local receiver; it is not reachable from the hosted canary.',
  }),
  'local-dams': Object.freeze({
    decision: 'exclude',
    reason: 'Bundled local catalogue; no live provider.',
  }),
  'local-datacenters': Object.freeze({
    decision: 'exclude',
    reason: 'Bundled local catalogue; no live provider.',
  }),
  'military-awareness': Object.freeze({
    decision: 'exclude',
    reason: 'Derived from other layers; matrix covers its composition.',
  }),
  'military-installations': Object.freeze({
    decision: 'exclude',
    reason: 'Bundled installation catalogue; no live provider.',
  }),
  netmon: Object.freeze({
    decision: 'exclude',
    reason: 'Operator targets are user-supplied; no public feed to canary.',
  }),
  'orbit-changes': Object.freeze({
    decision: 'exclude',
    reason: 'Derived orbit analysis; it needs two epochs before it draws.',
  }),
  'plate-reader': Object.freeze({
    decision: 'exclude',
    reason: 'Local camera tool; no network provider.',
  }),
  'private-wifi': Object.freeze({
    decision: 'exclude',
    reason: 'Local browser sweep; no network provider.',
  }),
  radiation: Object.freeze({
    decision: 'exclude',
    reason: 'Optional uRadMonitor key; the keyless base is matrix-covered.',
  }),
  'railway-stations': Object.freeze({
    decision: 'exclude',
    reason: 'Bundled station catalogue; no live provider.',
  }),
  'recent-imagery': Object.freeze({
    decision: 'exclude',
    reason: 'Interactive imagery search; no single layer feed to canary.',
  }),
  'rocket-launches': Object.freeze({
    decision: 'exclude',
    reason: 'Optional Launch Library key; the keyless base is matrix-covered.',
  }),
  's2-ghostmaps': Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
  'satellite-watch': Object.freeze({
    decision: 'exclude',
    reason:
      'Optional N2YO/Space-Track keys; the keyless base is matrix-covered.',
  }),
  'street-level': Object.freeze({
    decision: 'exclude',
    reason: 'Interactive panorama search; provider coverage is in the matrix.',
  }),
  'telegeography-submarine-cables': Object.freeze({
    decision: 'exclude',
    reason: 'Bundled cable catalogue; no live provider.',
  }),
  traffic: Object.freeze({
    decision: 'exclude',
    reason: 'Live mode is in the keyed canary; simulation is matrix-covered.',
  }),
  transit: Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
  wind: Object.freeze({
    decision: 'exclude',
    reason: 'Deterministic activation matrix covers its data path.',
  }),
});

export const KEYLESS_LAYERS = [
  {
    id: 'earthquakes',
    provider: 'USGS',
    expect: { min: 1 },
  },
  {
    id: 'emsc-seismic',
    provider: 'EMSC',
    expect: { min: 1 },
  },
  {
    id: 'global-disasters',
    provider: 'GDACS / EFFIS / Copernicus',
    expect: { min: 1 },
  },
  {
    id: 'satellites',
    provider: 'CelesTrak',
    expect: { min: 1 },
    timeoutMs: 60_000,
    externalFailure: {
      apiPrefix: '/api/celestrak/',
      reason:
        'CelesTrak regularly 502s or times out; the app surfaces "CelesTrak unreachable" and keeps its previous catalog.',
    },
  },
  {
    id: 'space-weather',
    provider: 'NOAA SWPC',
    expect: { min: 1 },
  },
  {
    id: 'weather-radar',
    provider: 'NOAA nowCOAST',
    expect: { min: 1 },
  },
  {
    id: 'weather-satellite',
    provider: 'NOAA nowCOAST',
    expect: { min: 1 },
  },
  {
    id: 'weather-lightning',
    provider: 'NOAA nowCOAST',
    expect: { min: 1 },
  },
  {
    id: 'weather-cyclones',
    provider: 'NOAA NHC / CPHC',
    expect: { min: 1 },
    allowEmpty: {
      statsFlag: 'empty',
      reason:
        'NOAA CurrentStorms.json legitimately reports activeStorms: []; the layer marks stats.empty instead of treating it as an outage.',
    },
  },
  {
    id: 'radio',
    provider: 'Radio Browser',
    expect: { min: 1 },
  },
  {
    id: 'osm-places',
    provider: 'OpenStreetMap / Overpass',
    expect: { min: 1 },
    unconfigured: {
      env: 'OVERPASS_UPSTREAMS',
      statusPath: '/api/overpass/status',
      errorPattern: 'Overpass endpoint not configured',
      reason:
        'The Overpass proxy is opt-in via OVERPASS_UPSTREAMS; with no operator upstream the layer reports unconfigured and skips the query.',
    },
  },
  {
    id: 'flights',
    provider: 'OpenSky / adsb.lol',
    expect: { min: 1 },
  },
  {
    id: 'military',
    provider: 'adsb.lol',
    expect: { min: 1 },
  },
  {
    id: 'fire-perimeters',
    provider: 'NIFC WFIGS',
    expect: { min: 1 },
  },
  {
    id: 'bikeshare',
    provider: 'GBFS',
    expect: { min: 1 },
    timeoutMs: 60_000,
  },
];

const ACTIVE_LAYERS = KEYED ? KEYED_LAYERS : KEYLESS_LAYERS;

/**
 * Validate the gate's own contract before opening a browser. This is exported
 * so the unit test can prove the policy cannot silently lose its external,
 * unconfigured or empty classification.
 */
export function validateKeylessManifest(manifest = KEYLESS_LAYERS) {
  const errors = [];
  if (!Array.isArray(manifest) || manifest.length === 0) {
    return { ok: false, errors: ['manifest must be a non-empty array'] };
  }
  const seen = new Set();
  for (const [index, entry] of manifest.entries()) {
    const label = entry?.id || `entry ${index}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: entry must be an object`);
      continue;
    }
    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      errors.push(`${label}: id must be a non-empty string`);
    } else if (seen.has(entry.id)) {
      errors.push(`${entry.id}: duplicate layer id`);
    } else {
      seen.add(entry.id);
    }
    if (typeof entry.provider !== 'string' || !entry.provider.trim()) {
      errors.push(`${label}: provider must be a non-empty string`);
    }
    if (
      !entry.expect ||
      (entry.expect.kind !== undefined && entry.expect.kind !== 'count')
    ) {
      errors.push(`${label}: expect.kind must be "count" when present`);
    }
    if (
      !Number.isFinite(Number(entry.expect?.min)) ||
      Number(entry.expect.min) <= 0
    ) {
      errors.push(`${label}: expect.min must be a positive number`);
    }
    if (
      entry.expect?.mode !== undefined &&
      (typeof entry.expect.mode !== 'string' || !entry.expect.mode.trim())
    ) {
      errors.push(`${label}: expect.mode must be a non-empty string`);
    }
    if (
      entry.timeoutMs !== undefined &&
      (!Number.isFinite(Number(entry.timeoutMs)) ||
        Number(entry.timeoutMs) <= 0)
    ) {
      errors.push(`${label}: timeoutMs must be a positive finite number`);
    }
    if (entry.externalFailure) {
      const external = entry.externalFailure;
      if (
        typeof external.apiPrefix !== 'string' ||
        !external.apiPrefix.startsWith('/api/')
      ) {
        errors.push(
          `${label}: externalFailure.apiPrefix must start with /api/`,
        );
      }
      if (typeof external.reason !== 'string' || !external.reason.trim()) {
        errors.push(`${label}: externalFailure.reason is required`);
      }
    }
    if (entry.allowEmpty) {
      if (
        typeof entry.allowEmpty.reason !== 'string' ||
        !entry.allowEmpty.reason.trim()
      ) {
        errors.push(`${label}: allowEmpty.reason is required`);
      }
      if (
        entry.allowEmpty.statsFlag !== undefined &&
        (typeof entry.allowEmpty.statsFlag !== 'string' ||
          !entry.allowEmpty.statsFlag.trim())
      ) {
        errors.push(
          `${label}: allowEmpty.statsFlag must be a non-empty string`,
        );
      }
    }
    if (entry.unconfigured) {
      const unconfigured = entry.unconfigured;
      if (typeof unconfigured.env !== 'string' || !unconfigured.env.trim()) {
        errors.push(`${label}: unconfigured.env is required`);
      }
      if (
        typeof unconfigured.statusPath !== 'string' ||
        !unconfigured.statusPath.startsWith('/api/')
      ) {
        errors.push(`${label}: unconfigured.statusPath must start with /api/`);
      }
      if (
        typeof unconfigured.errorPattern !== 'string' ||
        !unconfigured.errorPattern.trim()
      ) {
        errors.push(`${label}: unconfigured.errorPattern is required`);
      } else {
        try {
          new RegExp(unconfigured.errorPattern, 'i');
        } catch (error) {
          errors.push(
            `${label}: unconfigured.errorPattern is invalid (${error.message})`,
          );
        }
      }
      if (
        typeof unconfigured.reason !== 'string' ||
        !unconfigured.reason.trim()
      ) {
        errors.push(`${label}: unconfigured.reason is required`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Derive the keyless candidate set from the application catalog and the
 * layers' key declarations, then require an explicit canary decision for every
 * candidate. A new layer is keyless unless its declaration says a credential
 * is required, so adding one without either a key declaration or a decision is
 * a gate failure rather than a silently untested feed.
 */
export function validateKeylessInventory({
  layers = APPLICATION_LAYER_METADATA,
  localOnlyLayers = LOCAL_ONLY_LAYER_METADATA,
  declarations = LAYER_KEY_DECLARATIONS,
  decisions = KEYLESS_CANARY_DECISIONS,
  manifest = KEYLESS_LAYERS,
  keys = KEY_SETUP_KEYS,
} = {}) {
  const errors = [];
  const catalogIds = new Set(
    layers
      .map((layer) => (typeof layer === 'string' ? layer : layer?.id))
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
  const localOnlyIds = new Set(
    localOnlyLayers
      .map((layer) => (typeof layer === 'string' ? layer : layer?.id))
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
  const keysById = new Map(keys.map((entry) => [entry.id, entry]));

  for (const [id, declaration] of Object.entries(declarations)) {
    if (!catalogIds.has(id))
      errors.push(
        `${id}: key declaration names a layer outside the application catalog`,
      );
    if (typeof declaration?.required !== 'boolean')
      errors.push(`${id}: key declaration must state required: true or false`);
    if (!Array.isArray(declaration?.keys) || declaration.keys.length === 0) {
      errors.push(`${id}: key declaration must name at least one key`);
      continue;
    }
    for (const keyId of declaration.keys) {
      if (typeof keyId !== 'string' || !keysById.has(keyId))
        errors.push(`${id}: unknown key id in declaration: ${keyId}`);
    }
  }

  const keylessIds = deriveKeylessLayerIds(layers, declarations);
  const keyless = new Set(keylessIds);
  const manifestIds = manifest
    .map((entry) => entry?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
  const manifestSet = new Set(manifestIds);
  const included = Object.values(decisions).filter(
    (entry) => entry?.decision === 'include',
  ).length;
  const excluded = Object.values(decisions).filter(
    (entry) => entry?.decision === 'exclude',
  ).length;

  if (included < KEYLESS_CANARY_CONTRACT.includedMin)
    errors.push(
      `keyless canary includes ${included}, below the contract floor ${KEYLESS_CANARY_CONTRACT.includedMin}`,
    );
  if (excluded > KEYLESS_CANARY_CONTRACT.excludedMax)
    errors.push(
      `keyless canary excludes ${excluded}, above the contract ceiling ${KEYLESS_CANARY_CONTRACT.excludedMax}`,
    );

  for (const id of keylessIds) {
    if (!decisions[id])
      errors.push(
        `${id}: keyless layer has no canary decision (add it to KEYLESS_CANARY_DECISIONS, or declare a required key in LAYER_KEY_DECLARATIONS)`,
      );
  }

  for (const [id, decision] of Object.entries(decisions)) {
    if (!keyless.has(id))
      errors.push(
        `${id}: canary decision exists for a layer that is not keyless`,
      );
    if (!['include', 'exclude'].includes(decision?.decision)) {
      errors.push(`${id}: canary decision must be include or exclude`);
      continue;
    }
    if (
      decision.decision === 'exclude' &&
      (typeof decision.reason !== 'string' || !decision.reason.trim())
    ) {
      errors.push(`${id}: excluded keyless layer needs a reason`);
    }
    if (decision.decision === 'include' && !manifestSet.has(id)) {
      errors.push(
        `${id}: include decision has no KEYLESS_LAYERS canary policy`,
      );
    }
  }

  for (const id of manifestIds) {
    if (!keyless.has(id))
      errors.push(`${id}: KEYLESS_LAYERS entry is not keyless by declaration`);
    if (localOnlyIds.has(id))
      errors.push(`${id}: KEYLESS_LAYERS entry is local-only`);
    if (decisions[id]?.decision !== 'include')
      errors.push(
        `${id}: KEYLESS_LAYERS entry needs an include canary decision`,
      );
  }

  for (const entry of KEYED_LAYERS) {
    const declaration = declarations[entry.id];
    if (!declaration) {
      errors.push(`${entry.id}: keyed canary entry has no key declaration`);
      continue;
    }
    if (!declaration.keys.includes(entry.keyId)) {
      errors.push(
        `${entry.id}: keyed canary uses ${entry.keyId}, which its declaration does not name`,
      );
    }
    const key = keysById.get(entry.keyId);
    if (!key) {
      errors.push(`${entry.id}: keyed canary names unknown key ${entry.keyId}`);
    } else if (JSON.stringify(entry.env) !== JSON.stringify(key.envVars)) {
      errors.push(
        `${entry.id}: keyed canary env does not match the ${entry.keyId} registry entry`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    keylessIds,
    included,
    excluded,
    declaredKeyIds: Object.keys(declarations).sort(),
  };
}

const CREDENTIAL_FAILURE =
  /(?:\bno[_ -]?key\b|\bmissing[_ -]?key\b|\bkey required\b|\bneeds? (?:an? )?(?:api[ _-]?)?(?:key|token)\b|\bapi[ _-]?key\b|\bkey rejected\b|\binvalid (?:api[ _-]?)?key\b|\bunauthori[sz]ed\b|\bforbidden\b|\bauth\b|\btoken (?:missing|invalid|rejected|not set)\b)/i;

/** A missing/rejected credential is a configuration failure, not an outage. */
export function isCredentialFailure(error, stats = null) {
  if (stats?.keyRequired === true) return true;
  return CREDENTIAL_FAILURE.test(String(error || ''));
}

const minRows = (layer) => Number(layer.expect?.min ?? 1);

const TRANSIENT_UPSTREAM_STATUSES = new Set([429, 502, 503, 504]);

function externalEvidence(layer, evidence) {
  const prefix = layer.externalFailure?.apiPrefix || '';
  const hits = (Array.isArray(evidence) ? evidence : []).filter(
    (hit) =>
      hit &&
      String(hit.url || '').startsWith(prefix) &&
      (TRANSIENT_UPSTREAM_STATUSES.has(Number(hit.status)) ||
        Boolean(hit.error)),
  );
  return { ok: hits.length > 0, hits };
}

function evidenceLabel(hit) {
  if (hit.error) return `${hit.error} ${hit.url}`;
  return `HTTP ${hit.status} ${hit.url}`;
}

function externalVerdict(layer, evidence, { count, error }) {
  const hits = externalEvidence(layer, evidence);
  if (!hits.ok) {
    return {
      status: 'FAIL',
      reason: `${error ? `layer error ${JSON.stringify(error)}` : 'layer did not settle'} is declared external, but no 429/502/503/504 or request failure hit ${layer.externalFailure?.apiPrefix}`,
      count,
      error,
      evidence: [],
    };
  }
  return {
    status: 'EXTERNAL',
    reason: `${layer.externalFailure.reason} Evidence: ${hits.hits
      .slice(0, 3)
      .map(evidenceLabel)
      .join(', ')}`,
    count,
    error,
    evidence: hits.hits.slice(0, 20),
  };
}

/**
 * Decide one layer's outcome from its manager snapshot and the API evidence
 * collected during its activation window. Pure and exported for the unit test.
 *
 * PENDING is internal to the poller; it means the layer has not settled yet.
 */
export function classifyLayerOutcome({
  layer,
  snapshot,
  evidence = [],
  overpassConfigured = null,
  timedOut = false,
  timeoutMs = 0,
  errorOverride = null,
}) {
  if (!snapshot) {
    return { status: 'PENDING', reason: 'waiting for the layer manager' };
  }
  if (!snapshot.exists) {
    return {
      status: 'MISSING',
      reason: 'layer is not registered at runtime',
    };
  }
  if (snapshot.statsError) {
    return {
      status: 'FAIL',
      reason: `getStats() threw: ${snapshot.statsError}`,
    };
  }

  const stats = snapshot.stats ?? null;
  const error = String(
    errorOverride || stats?.error || stats?.lastError || stats?.reason || '',
  ).trim();
  const rawCount = stats?.count;
  const count = Number.isFinite(Number(rawCount)) ? Number(rawCount) : null;
  const lifecycle = snapshot.lifecycleState ?? null;
  const expected = minRows(layer);

  if (isCredentialFailure(error, stats)) {
    return {
      status: 'FAIL',
      reason: `credential failure: ${error || 'keyRequired'}`,
      count,
      error: error || 'keyRequired',
    };
  }

  if (error) {
    if (layer.unconfigured) {
      let matches = false;
      try {
        matches = new RegExp(layer.unconfigured.errorPattern, 'i').test(error);
      } catch {
        matches = false;
      }
      if (matches && overpassConfigured === false) {
        return {
          status: 'UNCONFIGURED',
          reason: `${layer.unconfigured.reason} (${error})`,
          count,
          error,
        };
      }
      if (matches) {
        return {
          status: 'FAIL',
          reason: `layer reports ${JSON.stringify(error)} but ${layer.unconfigured.statusPath} did not confirm configured=false (probe=${overpassConfigured === null ? 'unreachable' : overpassConfigured})`,
          count,
          error,
        };
      }
    }
    if (layer.externalFailure) {
      return externalVerdict(layer, evidence, { count, error });
    }
    return {
      status: 'FAIL',
      reason: `layer reports error: ${error}`,
      count,
      error,
    };
  }

  if (lifecycle && ['error', 'failed'].includes(lifecycle)) {
    if (layer.externalFailure) {
      return externalVerdict(layer, evidence, { count, error });
    }
    return {
      status: 'FAIL',
      reason: `lifecycle is ${lifecycle}`,
      count,
    };
  }

  if (layer.expect?.mode && stats?.mode !== layer.expect.mode) {
    // A keyed layer can publish its simulated/placeholder feed before the
    // live flow settles. Give it the layer's full budget before calling that
    // a failure; only the timed-out pass is terminal.
    if (!timedOut) {
      return {
        status: 'PENDING',
        reason: `mode is ${JSON.stringify(stats?.mode)}, waiting for ${JSON.stringify(layer.expect.mode)}`,
        count,
        error,
      };
    }
    return {
      status: 'FAIL',
      reason: `mode is ${JSON.stringify(stats?.mode)}, expected ${JSON.stringify(layer.expect.mode)}`,
      count,
      error,
    };
  }

  if (count !== null && count >= expected) {
    return {
      status: 'PASS',
      reason: `count ${count} >= ${expected}`,
      count,
    };
  }

  const emptyFlag = layer.allowEmpty?.statsFlag || 'empty';
  if (layer.allowEmpty && count === 0 && stats?.[emptyFlag] === true) {
    return {
      status: 'EMPTY',
      reason: layer.allowEmpty.reason,
      count,
    };
  }

  if (timedOut) {
    if (layer.externalFailure) {
      return externalVerdict(layer, evidence, { count, error });
    }
    return {
      status: 'FAIL',
      reason: `timed out after ${timeoutMs}ms with count=${count ?? 'unknown'}`,
      count,
    };
  }

  if (snapshot.enabled === false) {
    return { status: 'PENDING', reason: 'layer is still enabling', count };
  }
  return { status: 'PENDING', reason: 'waiting for live rows', count };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Read one layer's manager state with a JSON-safe stats snapshot. */
async function layerSnapshot(page, id) {
  return page.evaluate((layerId) => {
    const plain = (value, depth = 0) => {
      if (value == null) return value;
      const type = typeof value;
      if (type === 'number' || type === 'string' || type === 'boolean')
        return value;
      if (type === 'bigint') return String(value);
      if (type === 'function') return undefined;
      if (Array.isArray(value))
        return depth > 3
          ? '[array]'
          : value.slice(0, 30).map((item) => plain(item, depth + 1));
      if (depth > 3) return '[object]';
      const out = {};
      for (const [key, item] of Object.entries(value).slice(0, 40)) {
        if (typeof item === 'function') continue;
        out[key] = plain(item, depth + 1);
      }
      return out;
    };
    const manager = window.__godsEyeView?.dataManager;
    const entry = manager?.layers?.get(layerId);
    if (!entry) return { exists: false };
    let stats = null;
    let statsError = null;
    try {
      stats =
        typeof entry.module?.getStats === 'function'
          ? plain(entry.module.getStats())
          : null;
    } catch (error) {
      statsError = String(error?.message || error);
    }
    return {
      exists: true,
      enabled: entry.enabled === true,
      lifecycleState: entry.lifecycleState ?? null,
      stats,
      statsError,
    };
  }, id);
}

async function focusLayerView(page, layer) {
  if (!layer.view) return;
  await page.evaluate(async ({ lat, lon, alt }) => {
    const app = window.__godsEyeView;
    app?.viewer?.camera?.cancelFlight?.();
    app?.styleManager?.applyCameraState?.(
      { lat, lon, alt, heading: 0, pitch: -40 },
      1.2,
    );
    await new Promise((done) => setTimeout(done, 2500));
  }, layer.view);
}

async function enableLayer(page, layer, timeoutMs) {
  return page.evaluate(
    async ({ layerId, timeout }) => {
      const manager = window.__godsEyeView?.dataManager;
      if (!manager?.layers?.has(layerId)) return { missing: true };
      try {
        let timedOut = false;
        const result = await Promise.race([
          manager.setEnabled(layerId, true, { origin: 'user' }),
          new Promise((done) => {
            setTimeout(() => {
              timedOut = true;
              done('timeout');
            }, timeout);
          }),
        ]);
        return { timedOut, enabled: result !== false };
      } catch (error) {
        return { error: String(error?.message || error) };
      }
    },
    { layerId: layer.id, timeout: timeoutMs },
  );
}

/** Poll until the classifier is terminal or the layer's budget is exhausted. */
async function waitForOutcome(
  page,
  layer,
  overpassConfigured,
  apiFailures,
  evidenceStart,
  enableResult,
) {
  const budget = Number(layer.timeoutMs) || LAYER_TIMEOUT_MS;
  const started = Date.now();
  const deadline = Math.max(
    started + budget,
    Date.now() + POST_ENABLE_GRACE_MS,
  );
  // Let the layer publish its first complete snapshot; setEnabled can return
  // while a feed is still streaming rows, which would pass a partial count.
  await sleep(LAYER_SETTLE_MS);
  let snapshot = null;
  let verdict = { status: 'PENDING' };
  while (Date.now() < deadline) {
    snapshot = await layerSnapshot(page, layer.id);
    verdict = classifyLayerOutcome({
      layer,
      snapshot,
      evidence: apiFailures.slice(evidenceStart),
      overpassConfigured,
      timedOut: false,
      timeoutMs: budget,
      errorOverride: enableResult?.error || null,
    });
    if (verdict.status !== 'PENDING') break;
    await sleep(500);
  }
  if (verdict.status === 'PENDING') {
    snapshot = await layerSnapshot(page, layer.id);
    verdict = classifyLayerOutcome({
      layer,
      snapshot,
      evidence: apiFailures.slice(evidenceStart),
      overpassConfigured,
      timedOut: true,
      timeoutMs: Date.now() - started,
      errorOverride: enableResult?.error || null,
    });
  }
  return { snapshot, verdict, durationMs: Date.now() - started };
}

async function disableLayer(page, layerId) {
  const before = await layerSnapshot(page, layerId);
  if (!before.exists) return { ok: true, skipped: 'layer is not registered' };
  if (
    before.enabled === false &&
    !['enabling', 'disabling', 'initializing', 'destroying'].includes(
      before.lifecycleState,
    )
  ) {
    return { ok: true, alreadyDisabled: true };
  }
  const result = await page.evaluate(
    async ({ id, timeout }) => {
      const manager = window.__godsEyeView?.dataManager;
      if (!manager?.layers?.has(id)) return { error: 'layer disappeared' };
      try {
        await Promise.race([
          manager.setEnabled(id, false, { origin: 'qa' }),
          new Promise((done) => setTimeout(done, timeout)),
        ]);
        return {};
      } catch (error) {
        return { error: String(error?.message || error) };
      }
    },
    { id: layerId, timeout: TEARDOWN_TIMEOUT_MS },
  );
  if (result.error) return { ok: false, reason: result.error };
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < TEARDOWN_TIMEOUT_MS) {
    latest = await layerSnapshot(page, layerId);
    if (
      latest.exists &&
      latest.enabled === false &&
      !['enabling', 'disabling', 'initializing', 'destroying'].includes(
        latest.lifecycleState,
      )
    ) {
      return { ok: true };
    }
    await sleep(250);
  }
  return {
    ok: false,
    reason: `layer did not settle disabled (enabled=${latest?.enabled}, lifecycle=${latest?.lifecycleState})`,
  };
}

async function probeOverpass(appUrl) {
  try {
    const response = await fetch(new URL('/api/overpass/status', appUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        reachable: true,
        configured: null,
        status: response.status,
        error: `probe answered HTTP ${response.status}`,
      };
    }
    const body = await response.json();
    return {
      reachable: true,
      configured: body?.configured === true,
      status: response.status,
    };
  } catch (error) {
    return {
      reachable: false,
      configured: null,
      error: String(error?.message || error),
    };
  }
}

function writeReport(report) {
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    return REPORT_PATH;
  } catch (error) {
    console.error(C.yellow(`could not write report: ${error.message}`));
    return null;
  }
}

function printLayerResult(result) {
  const color =
    result.status === 'PASS'
      ? C.green
      : result.status === 'FAIL' || result.status === 'MISSING'
        ? C.red
        : C.yellow;
  const count =
    result.count === null || result.count === undefined
      ? ''
      : ` count=${result.count}`;
  console.log(
    `  ${color(result.status.padEnd(13))} ${result.id.padEnd(22)} ${result.provider.padEnd(29)}${count} ${C.dim(`${result.durationMs}ms`)}`,
  );
  if (result.status !== 'PASS') {
    console.log(`       ${C.dim(result.reason)}`);
  }
  if (!result.teardown.ok) {
    console.log(
      `       ${C.red('teardown:')} ${result.teardown.reason || 'failed'}`,
    );
  }
}

function printList(manifest) {
  console.log(
    `${C.bold(KEYED ? 'Keyed live layer manifest' : 'Keyless live layer manifest')} · ${manifest.length} layers`,
  );
  for (const layer of manifest) {
    const policies = [
      `min=${minRows(layer)}`,
      layer.externalFailure
        ? `external=${layer.externalFailure.apiPrefix}`
        : null,
      layer.allowEmpty ? 'allow-empty' : null,
      layer.unconfigured ? `unconfigured=${layer.unconfigured.env}` : null,
      layer.expect?.mode ? `mode=${layer.expect.mode}` : null,
      layer.view ? 'local-view' : null,
    ].filter(Boolean);
    console.log(
      `  ${layer.id.padEnd(22)} ${layer.provider.padEnd(29)} ${C.dim(policies.join(' · '))}`,
    );
  }
}

async function main() {
  const inventory = validateKeylessInventory();
  if (!inventory.ok) {
    console.error(C.red('keyless layer inventory is invalid:'));
    for (const error of inventory.errors) console.error(`  - ${error}`);
    return 1;
  }
  const validation = validateKeylessManifest(ACTIVE_LAYERS);
  if (!validation.ok) {
    console.error(C.red('live layer manifest is invalid:'));
    for (const error of validation.errors) console.error(`  - ${error}`);
    return 1;
  }
  if (LIST_ONLY) {
    if (!KEYED) {
      const included = Object.values(KEYLESS_CANARY_DECISIONS).filter(
        (entry) => entry.decision === 'include',
      ).length;
      console.log(
        C.dim(
          `derived keyless inventory: ${inventory.keylessIds.length} layers · ${included} canary · ${inventory.keylessIds.length - included} excluded with reason`,
        ),
      );
    }
    printList(ACTIVE_LAYERS);
    return 0;
  }
  for (const id of ONLY) {
    if (!ACTIVE_LAYERS.some((layer) => layer.id === id)) {
      console.error(C.red(`--only names an unknown layer: ${id}`));
      return 1;
    }
  }
  const selected = ACTIVE_LAYERS.filter(
    (layer) => (!ONLY.length || ONLY.includes(layer.id)) && !SKIP.has(layer.id),
  );
  if (!selected.length) {
    console.error(C.red('no live layers selected'));
    return 1;
  }

  const overpass = await probeOverpass(APP_URL);
  console.log(
    `${C.bold(KEYED ? 'Keyed live layers' : 'Keyless live layers')} · ${selected.length}/${ACTIVE_LAYERS.length} layers · ${APP_URL}`,
  );
  console.log(
    C.dim(
      `  Overpass probe: ${overpass.reachable ? (overpass.configured ? 'configured' : 'not configured') : `unreachable (${overpass.error})`} · strict=${STRICT}`,
    ),
  );

  const executablePath = chromeExecutablePath();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: !HEADFUL,
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=swiftshader',
        '--enable-unsafe-swiftshader',
        '--window-size=1440,900',
      ],
      protocolTimeout: 240_000,
    });
  } catch (error) {
    console.error(
      C.red(
        `could not launch Chrome: ${String(error?.message || error)}\nInstall one with "npx puppeteer browsers install chrome-headless-shell" or set PUPPETEER_EXECUTABLE_PATH.`,
      ),
    );
    return 2;
  }

  const pageErrors = [];
  const consoleErrors = [];
  const apiFailures = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => {
      pageErrors.push(String(error?.message || error));
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (
        /Failed to load resource|net::ERR_|WebGL|GPU stall|DevTools/i.test(text)
      ) {
        return;
      }
      consoleErrors.push(text);
    });
    page.on('response', (response) => {
      const rawUrl = response.url();
      if (!rawUrl.startsWith(APP_ORIGIN) || !rawUrl.includes('/api/')) return;
      const status = response.status();
      if (status < 500) return;
      const url = new URL(rawUrl);
      apiFailures.push({
        kind: 'http',
        status,
        url: `${url.pathname}${url.search}`,
        at: Date.now(),
      });
    });
    page.on('requestfailed', (request) => {
      const rawUrl = request.url();
      if (!rawUrl.startsWith(APP_ORIGIN) || !rawUrl.includes('/api/')) return;
      const url = new URL(rawUrl);
      apiFailures.push({
        kind: 'network',
        error: request.failure()?.errorText || 'request failed',
        url: `${url.pathname}${url.search}`,
        at: Date.now(),
      });
    });

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const target = new URL(APP_URL);
    target.searchParams.set('welcome', '0');
    try {
      await page.goto(target.href, {
        waitUntil: 'domcontentloaded',
        timeout: BOOT_TIMEOUT_MS,
      });
      await page.waitForFunction(
        () =>
          window.__godsEyeView?.dataManager &&
          window.__godsEyeView?.viewer &&
          document
            .querySelector('#loading-screen')
            ?.classList.contains('hidden'),
        { timeout: BOOT_TIMEOUT_MS, polling: 500 },
      );
    } catch (error) {
      console.error(
        C.red(
          `target did not boot at ${APP_URL}: ${String(error?.message || error)}`,
        ),
      );
      return 2;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(async () => {
      const manager = window.__godsEyeView?.dataManager;
      if (!manager) return;
      for (const [id, entry] of manager.layers) {
        if (!entry.enabled) continue;
        try {
          await manager.setEnabled(id, false, { origin: 'qa' });
        } catch {
          /* a layer that refuses to settle is caught by its own run */
        }
      }
    });
    await sleep(600);

    const runtimeIds = await page.evaluate(() =>
      Array.from(window.__godsEyeView.dataManager.layers.keys()),
    );
    console.log(C.dim(`  runtime layers: ${runtimeIds.length}`));

    const results = [];
    for (const layer of selected) {
      if (!runtimeIds.includes(layer.id)) {
        const result = {
          id: layer.id,
          provider: layer.provider,
          status: 'MISSING',
          reason: 'layer is not registered at runtime',
          count: null,
          durationMs: 0,
          stats: null,
          evidence: [],
          teardown: { ok: true, skipped: 'layer is not registered' },
        };
        results.push(result);
        printLayerResult(result);
        continue;
      }

      const started = Date.now();
      const evidenceStart = apiFailures.length;
      await focusLayerView(page, layer);
      let enableResult;
      try {
        enableResult = await enableLayer(
          page,
          layer,
          Number(layer.timeoutMs) || LAYER_TIMEOUT_MS,
        );
      } catch (error) {
        enableResult = { error: String(error?.message || error) };
      }

      let outcome;
      try {
        outcome = await waitForOutcome(
          page,
          layer,
          overpass.configured,
          apiFailures,
          evidenceStart,
          enableResult,
        );
      } catch (error) {
        outcome = {
          snapshot: null,
          verdict: {
            status: 'FAIL',
            reason: `polling threw: ${String(error?.message || error)}`,
            count: null,
          },
          durationMs: Date.now() - started,
        };
      }
      const teardown = await disableLayer(page, layer.id).catch((error) => ({
        ok: false,
        reason: String(error?.message || error),
      }));
      const result = {
        id: layer.id,
        provider: layer.provider,
        status: outcome.verdict.status,
        reason: outcome.verdict.reason,
        count: outcome.verdict.count ?? null,
        durationMs: outcome.durationMs,
        stats: outcome.snapshot?.stats ?? null,
        evidence: outcome.verdict.evidence ?? [],
        teardown,
      };
      results.push(result);
      printLayerResult(result);
    }

    const failures = results.filter((result) =>
      ['FAIL', 'MISSING'].includes(result.status),
    );
    const teardownFailures = results.filter((result) => !result.teardown.ok);
    const counts = Object.fromEntries(
      ['PASS', 'EMPTY', 'UNCONFIGURED', 'EXTERNAL', 'FAIL', 'MISSING'].map(
        (status) => [status, results.filter((r) => r.status === status).length],
      ),
    );
    const strictFailures = STRICT
      ? results.filter((result) => result.status !== 'PASS')
      : [];
    const ok =
      failures.length === 0 &&
      teardownFailures.length === 0 &&
      pageErrors.length === 0 &&
      strictFailures.length === 0 &&
      (!STRICT || consoleErrors.length === 0);

    console.log(
      `\n${C.bold('Summary')} ${counts.PASS} pass · ${counts.EMPTY} empty · ${counts.UNCONFIGURED} unconfigured · ${counts.EXTERNAL} external · ${counts.FAIL} fail · ${counts.MISSING} missing · ${teardownFailures.length} teardown · ${results.length} total`,
    );
    if (failures.length) {
      console.log(
        C.red(`Failed: ${failures.map((result) => result.id).join(', ')}`),
      );
    }
    if (strictFailures.length) {
      console.log(
        C.red(
          `Strict: non-PASS outcomes: ${strictFailures.map((result) => `${result.id}=${result.status}`).join(', ')}`,
        ),
      );
    }
    if (pageErrors.length) {
      console.log(C.red(`Uncaught page errors: ${pageErrors.length}`));
      for (const error of pageErrors.slice(0, 10))
        console.log(C.dim(`  ${error}`));
    }
    if (consoleErrors.length) {
      const color = STRICT ? C.red : C.yellow;
      console.log(color(`Console errors: ${consoleErrors.length}`));
      for (const error of consoleErrors.slice(0, 10))
        console.log(C.dim(`  ${error}`));
    }
    if (teardownFailures.length) {
      console.log(
        C.red(
          `Teardown failed: ${teardownFailures.map((r) => r.id).join(', ')}`,
        ),
      );
    }

    const report = {
      generatedAt: new Date().toISOString(),
      appUrl: APP_URL,
      mode: KEYED ? 'keyed-live' : 'keyless-live',
      ok,
      strict: STRICT,
      overpass,
      summary: {
        total: results.length,
        pass: counts.PASS,
        empty: counts.EMPTY,
        unconfigured: counts.UNCONFIGURED,
        external: counts.EXTERNAL,
        fail: counts.FAIL,
        missing: counts.MISSING,
        teardownFailures: teardownFailures.length,
        pageErrors: pageErrors.length,
        consoleErrors: consoleErrors.length,
      },
      layers: results,
      pageErrors,
      consoleErrors,
    };
    const reportPath = writeReport(report);
    if (reportPath) console.log(C.dim(`report ${reportPath}`));
    return ok ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(C.red(error?.stack || error));
      process.exitCode = 1;
    });
}
