#!/usr/bin/env node
/**
 * Deterministic browser gate for the Sentinel's static-site rotation.
 *
 * Two independent pages each enable one static layer and the Sentinel. Fixed
 * request fixtures answer the layer's API, so the test does not depend on the
 * network or a particular viewport. The gate watches the Sentinel's own scan
 * state and asserts that two successive scans visit two different sites, in a
 * fixed order, at the fixture's exact coordinates and provider ids.
 *
 * After the first scan the page is really reloaded. The same tab keeps its
 * sessionStorage, so the next scan must visit the other site instead of
 * returning to the one already recorded; a lost memory would pick the nearest
 * site again. Radio Sites covers the ANFR fixture; Mapped Installations covers
 * Creil and Villacoublay. The camera starts near the first site in each case
 * so the sequence is deterministic rather than decided by a floating-point
 * tie.
 *
 * Run (server up): npm run qa:sentinel-rotation -- --url http://localhost:4173
 * A failure saves the page, console and network evidence under
 * `qa-artifacts/sentinel-rotation/`.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import puppeteer from 'puppeteer';

import { saveFailureArtifacts, watchPage } from './qa-browserEvidence.mjs';
import { chromeExecutablePath } from './qa-chrome.mjs';

const COORDINATE_TOLERANCE = 1e-6;
const MEMORY_KEY = 'gev:sentinel:visited-sites';
const EMPTY_MILITARY_NAMES = Object.freeze({
  release: 'qa-fixture',
  snapshots: [],
  classes: [],
  records: [],
});

const CASES = Object.freeze([
  {
    name: 'radio-sites',
    label: 'Radio Sites',
    layerId: 'cell-towers',
    camera: { lat: 48.855, lon: 2.355 },
    sites: [
      { id: 'qa-site-a', label: 'qa-site-a', lat: 48.85, lon: 2.35 },
      { id: 'qa-site-b', label: 'qa-site-b', lat: 48.9, lon: 2.4 },
    ],
    fixture: {
      urlPattern: '*/api/cell-towers*',
      body: {
        points: [
          {
            id: 'qa-site-a',
            label: 'qa-site-a',
            lat: 48.85,
            lon: 2.35,
          },
          {
            id: 'qa-site-b',
            label: 'qa-site-b',
            lat: 48.9,
            lon: 2.4,
          },
        ],
        matched: 2,
        source: 'anfr',
        attribution: {
          label: 'ANFR',
          licence: 'Licence Ouverte 2.0',
        },
      },
    },
  },
  {
    name: 'military-bases',
    label: 'Mapped Installations',
    layerId: 'military-installations',
    // Near Creil, so the first pick is unambiguous and the second is
    // Villacoublay rather than a tie.
    camera: { lat: 49.225, lon: 2.475 },
    sites: [
      {
        id: 'osm:node:91001',
        label: 'Creil',
        lat: 49.253,
        lon: 2.519,
      },
      {
        id: 'osm:node:91002',
        label: 'Villacoublay',
        lat: 48.774,
        lon: 2.191,
      },
    ],
    fixture: {
      urlPattern: '*/api/military-installations*',
      // The layer also loads a bundled worldwide names pack. It is real data,
      // not network data, so it would add bases around Paris after a reload;
      // answer that pack with an empty fixture to keep this gate hermetic.
      stubs: [
        {
          match: 'osm_military_names',
          urlPattern: '*osm_military_names*',
          body: EMPTY_MILITARY_NAMES,
        },
        {
          match: '/assets/names-',
          urlPattern: '*/assets/names-*',
          body: EMPTY_MILITARY_NAMES,
        },
      ],
      body: {
        elements: [
          {
            type: 'node',
            id: 91001,
            lat: 49.253,
            lon: 2.519,
            tags: { military: 'airfield', name: 'Creil' },
          },
          {
            type: 'node',
            id: 91002,
            lat: 48.774,
            lon: 2.191,
            tags: { military: 'airfield', name: 'Villacoublay' },
          },
        ],
        status: 'ready',
        retrievedAt: '2026-01-01T00:00:00Z',
      },
    },
  },
]);

const siteAt = (sites, lat, lon) =>
  sites.find(
    (site) =>
      Math.abs(site.lat - lat) < COORDINATE_TOLERANCE &&
      Math.abs(site.lon - lon) < COORDINATE_TOLERANCE,
  ) ?? null;

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = (
  urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173'
).replace(/\/$/, '');

/** Wait for the shell and the viewer after a navigation or reload. */
async function waitForApp(page) {
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 120_000,
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.boot === 'ready',
    { timeout: 120_000 },
  );
  // The welcome flight would overwrite a view set while it is still running.
  await new Promise((resolve) => setTimeout(resolve, 8000));
}

/** Set the fixture's view, leave only the case layer enabled, and show it. */
async function prepareLayer(page, spec) {
  await page.evaluate(
    async ({ layerId, camera }) => {
      const viewer = window.__godsEyeView.viewer;
      viewer.camera.cancelFlight?.();
      const C = viewer.camera.positionCartographic.constructor;
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian(
          C.fromDegrees(camera.lon, camera.lat, 200_000),
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      for (const entry of document.querySelectorAll(
        '#data-toggles [data-layer-id]',
      )) {
        const button = entry.querySelector('.data-toggle-btn');
        if (button?.textContent?.trim() === 'ON') button.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      document
        .querySelector(
          `#data-toggles [data-layer-id="${layerId}"] .data-toggle-btn`,
        )
        ?.click();
    },
    { layerId: spec.layerId, camera: spec.camera },
  );

  await page.evaluate(
    async ({ layerId, count, label }) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const module =
          window.__godsEyeView.dataManager.layers.get(layerId)?.module;
        if ((module?.getStats?.().count ?? 0) >= count) return;
        await sleep(500);
      }
      throw new Error(`${label} fixture did not reach the layer`);
    },
    { layerId: spec.layerId, count: spec.sites.length, label: spec.label },
  );

  const layerSites = await page.evaluate((layerId) => {
    const module = window.__godsEyeView.dataManager.layers.get(layerId)?.module;
    return module?.getPatrolSites?.(10) ?? [];
  }, spec.layerId);
  const uniqueSites = new Map(layerSites.map((site) => [site.id, site]));
  assert.equal(
    uniqueSites.size,
    spec.sites.length,
    `${spec.label} holds both fixture sites`,
  );
  for (const expected of spec.sites) {
    const row = uniqueSites.get(expected.id);
    assert.ok(row, `${spec.label} exposes ${expected.id}`);
    assert.equal(
      row.label,
      expected.label,
      `${spec.label} exposes ${expected.id}'s label`,
    );
    assert.ok(
      Math.abs(row.latitude - expected.lat) < COORDINATE_TOLERANCE &&
        Math.abs(row.longitude - expected.lon) < COORDINATE_TOLERANCE,
      `${expected.id} keeps its fixture coordinates: ${JSON.stringify(row)}`,
    );
  }
}

/** Start the Sentinel without an extra fixed sleep: walk time is part of it. */
async function enableSentinel(page) {
  await page.evaluate(() => {
    document
      .querySelector(
        '#data-toggles [data-layer-id="ai-agent"] .data-toggle-btn',
      )
      ?.click();
  });
}

/** Watch scan starts; return each target and the coordinates it stands on. */
async function observeScans(page, count) {
  return page.evaluate(async (wanted) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const module = () =>
      window.__godsEyeView.dataManager.layers.get('ai-agent')?.module;
    const out = [];
    let wasScanning = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && out.length < wanted) {
      const stats = module()?.getStats?.();
      if (stats?.scanning && !wasScanning) {
        out.push({
          target: stats.target,
          targetKind: stats.targetKind,
          lat: stats.latDeg,
          lon: stats.lonDeg,
        });
      }
      wasScanning = Boolean(stats?.scanning);
      await sleep(100);
    }
    return out;
  }, count);
}

/** The scan is recorded in sessionStorage just before `scanning` goes false. */
async function waitForScanEnd(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const module = () =>
      window.__godsEyeView.dataManager.layers.get('ai-agent')?.module;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!module()?.getStats?.().scanning) return;
      await sleep(100);
    }
    throw new Error('the Sentinel scan did not finish before the reload');
  });
}

async function readMemory(page) {
  return page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version,
      count: Object.keys(parsed.sites || {}).length,
    };
  }, MEMORY_KEY);
}

async function runCase(browser, spec, errors, monitors) {
  const page = await browser.newPage();
  monitors.push(
    watchPage(page, { name: `sentinel-rotation-${spec.name}`, errors }),
  );

  // Every read of this layer is the fixture: the layer is real, the data is
  // fixed, and the Sentinel's rotation is the only variable under test.
  const cdp = await page.createCDPSession();
  const stubs = spec.fixture.stubs ?? [];
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: spec.fixture.urlPattern },
      ...stubs.map((stub) => ({ urlPattern: stub.urlPattern })),
    ],
  });
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    const stub = stubs.find((candidate) =>
      request.url.includes(candidate.match),
    );
    cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(
          JSON.stringify(stub?.body ?? spec.fixture.body),
        ).toString('base64'),
      })
      .catch(() => {});
  });

  await page.goto(`${url}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await prepareLayer(page, spec);
  await enableSentinel(page);

  const before = await observeScans(page, 1);
  assert.equal(before.length, 1, `${spec.label}: first scan starts`);
  await waitForScanEnd(page);
  const memoryBefore = await readMemory(page);
  assert.equal(memoryBefore?.version, 2, 'the tab has a versioned memory');
  assert.ok(memoryBefore.count >= 1, 'the first scan was remembered');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await prepareLayer(page, spec);
  await enableSentinel(page);

  const after = await observeScans(page, 2);

  for (const [phase, scans] of [
    ['before reload', before],
    ['after reload', after],
  ]) {
    assert.equal(
      scans.length,
      phase === 'before reload' ? 1 : 2,
      `${spec.label}: ${phase} completed the expected scans`,
    );
    for (const scan of scans) {
      assert.equal(scan.target, spec.layerId);
      assert.equal(
        scan.targetKind,
        null,
        `${spec.label} scans inspect the static layer, not a GhostMaps alert`,
      );
    }
  }

  const beforeSites = before.map((scan) =>
    siteAt(spec.sites, scan.lat, scan.lon),
  );
  const afterSites = after.map((scan) =>
    siteAt(spec.sites, scan.lat, scan.lon),
  );
  assert.ok(
    [...beforeSites, ...afterSites].every(Boolean),
    `every ${spec.label} scan stands exactly on a fixture site`,
  );
  assert.equal(
    beforeSites[0].id,
    spec.sites[0].id,
    `${spec.label}: the first scan visits the nearest site`,
  );
  assert.deepEqual(
    afterSites.map((site) => site.id),
    [spec.sites[1].id, spec.sites[0].id],
    `${spec.label}: after reload, the Sentinel skips the remembered site and rotates`,
  );
  assert.notEqual(
    beforeSites[0].id,
    afterSites[0].id,
    `${spec.label}: sessionStorage prevented scanning the same site again`,
  );

  console.log(
    `[${spec.name}] before reload: ${beforeSites[0].id} (${before[0].lat.toFixed(5)}, ${before[0].lon.toFixed(5)})`,
  );
  for (const [index, scan] of after.entries()) {
    const site = afterSites[index];
    console.log(
      `[${spec.name}] after reload scan ${index + 1}: ${site.id} (${scan.lat.toFixed(5)}, ${scan.lon.toFixed(5)})`,
    );
  }
  console.log(
    `RESULT ${spec.label}: ${beforeSites[0].id} survived reload through sessionStorage; then ${afterSites.map((site) => site.id).join(' then ')}`,
  );
  await page.close();
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromeExecutablePath(),
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const errors = [];
  const monitors = [];
  try {
    for (const spec of CASES) await runCase(browser, spec, errors, monitors);
    assert.deepEqual(errors, []);
    console.log(
      'RESULT: each static layer rotated to a new site after a real reload',
    );
  } catch (error) {
    const dir = await saveFailureArtifacts({
      dir: 'qa-artifacts/sentinel-rotation',
      browser,
      monitors,
      error,
    }).catch(() => null);
    if (dir) console.error(`failure evidence saved in ${dir}/`);
    throw error;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
